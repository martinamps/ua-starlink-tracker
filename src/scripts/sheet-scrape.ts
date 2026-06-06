/**
 * Hourly UA spreadsheet scrape cycle: roster replace + the airline-agnostic
 * maintenance phases (fleet sync, contradiction sweep, consensus + type
 * reconcile, precision gauges). A refused roster replace skips ONLY the
 * replace — the maintenance phases don't depend on the just-parsed roster
 * and must keep healing on stale data.
 */

import type { Database } from "bun:sqlite";
import {
  reconcileConsensus,
  reconcileTypeDeterministicFleets,
  syncSpreadsheetToFleet,
  updateDatabase,
} from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag, withSpan } from "../observability";
import type { JobRunContext } from "../utils/job-runner";
import { info, error as logError } from "../utils/logger";
import { fetchAllSheets, updateSpreadsheetCache } from "../utils/utils";
import { computePrecision, emitPrecisionGauges } from "./precision-backtest";
import { computeSurfaceContradictions, emitSweepGauges } from "./surface-sweep";

export interface SheetScrapeResult {
  outcome: "success" | "refused" | "error" | "abandoned";
  refusal?: string;
  total: number;
  starlinkCount: number;
}

export async function runSheetScrape(
  db: Database,
  fetchSheets: typeof fetchAllSheets = fetchAllSheets,
  ctx?: JobRunContext
): Promise<SheetScrapeResult> {
  return withSpan(
    "scraper.update_data",
    async (span): Promise<SheetScrapeResult> => {
      span.setTag("job.type", "background");
      try {
        const { totalAircraftCount, starlinkAircraft, fleetStats } = await fetchSheets();
        // A run the job runner has abandoned (stuck escape) can still have its
        // sheet fetch resolve minutes later. Its DELETE/re-INSERT + lastUpdated
        // stamp would silently regress the successor's roster under a fresh
        // freshness gauge — log and discard before any write.
        if (ctx && !ctx.isCurrent()) {
          info("sheet-scrape: run was abandoned mid-fetch; discarding results, no writes");
          span.setTag("result", "abandoned");
          return { outcome: "abandoned", total: 0, starlinkCount: 0 };
        }
        const refusal = updateDatabase(db, totalAircraftCount, starlinkAircraft, fleetStats);
        if (refusal) {
          // Roster sanity floor tripped (e.g. 200-with-HTML parsed to ~0 rows)
          // — same observable shape as fleet-sync's aborted path.
          span.setTag("error", true);
          span.setTag("abort_reason", refusal);
          metrics.increment(COUNTERS.SCRAPER_SYNC, {
            source: "sheet",
            airline: normalizeAirlineTag("UA"),
            status: "aborted",
          });
        } else {
          updateSpreadsheetCache(
            starlinkAircraft
              .map((a) => a.TailNumber)
              .filter((t): t is string => typeof t === "string" && t.length > 0)
          );
          metrics.increment(COUNTERS.SCRAPER_SYNC, {
            source: "sheet",
            airline: normalizeAirlineTag("UA"),
            status: "success",
          });
          span.setTag("total_aircraft", totalAircraftCount);
          span.setTag("starlink_count", starlinkAircraft.length);
          info(
            `Updated data: ${starlinkAircraft.length} Starlink aircraft out of ${totalAircraftCount} total`
          );
        }

        const synced = syncSpreadsheetToFleet(db);
        if (synced > 0) {
          info(`Synced ${synced} new planes to united_fleet`);
          span.setTag("synced_to_fleet", synced);
        }

        // Sweep before the healers so the gauge measures pre-heal drift, not 0.
        const sweep = computeSurfaceContradictions(db);
        emitSweepGauges(sweep);
        span.setTag("surface_contradictions", sweep.contradictions.length);
        if (sweep.contradictions.length > 0) {
          info(
            `Surface contradictions: ${sweep.contradictions.length} tails — ${sweep.contradictions
              .slice(0, 5)
              .map((c) => c.tail)
              .join(", ")}${sweep.contradictions.length > 5 ? "…" : ""}`
          );
        }

        const healed = reconcileConsensus(db);
        if (healed > 0) {
          info(`Consensus reconciliation healed ${healed} tails`);
          span.setTag("consensus_healed", healed);
        }

        const typeReconciled = reconcileTypeDeterministicFleets(db);
        if (typeReconciled > 0) span.setTag("type_reconciled", typeReconciled);

        const precision = computePrecision(db, 14);
        emitPrecisionGauges(precision);
        span.setTag("precision_yes_14d", precision.yes.precision);
        span.setTag("precision_no_14d", precision.no.precision);
        info(
          `Firm-call precision (14d): YES=${(precision.yes.precision * 100).toFixed(1)}% n=${precision.yes.n} · NO=${(precision.no.precision * 100).toFixed(1)}% n=${precision.no.n}`
        );

        if (refusal) {
          return { outcome: "refused", refusal, total: 0, starlinkCount: 0 };
        }
        return {
          outcome: "success",
          total: totalAircraftCount,
          starlinkCount: starlinkAircraft.length,
        };
      } catch (err) {
        logError("Error updating starlink data", err);
        span.setTag("error", true);
        return { outcome: "error", total: 0, starlinkCount: 0 };
      }
    },
    { "job.type": "background" }
  );
}
