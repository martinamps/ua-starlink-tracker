/**
 * Fleet Sync Script
 * Syncs United Airlines fleet from FlightRadar24 and spreadsheet to united_fleet table
 */

import {
  AIRLINES,
  type AirlineConfig,
  enabledAirlines,
  lastUpdatedOwner,
} from "../airlines/registry";
import {
  initializeDatabase,
  refreshFleetMeta,
  syncSpreadsheetToFleet,
  upsertFleetAircraft,
} from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag, withSpan } from "../observability";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError } from "../utils/logger";
import { launchFR24Browser, scrapeFlightRadar24Fleet } from "./flightradar24-scraper";

export interface RosterSource {
  /** Regional pages carry their configured subfleet; the primary page none. */
  subfleet?: string;
  aircraft: { registration: string; aircraftType: string }[];
}

export interface RosterEntry {
  registration: string;
  aircraftType: string;
  subfleet: string;
  /** Set only for tails sourced from a regional carrier's own roster page.
   * null otherwise, so upsert's COALESCE preserves any existing operated_by —
   * SkyWest-operated AS E175s must not become "Horizon Air" by type. */
  operator: string | null;
}

/** FR24 pages to scrape for an airline: primary livery page first (fleet-sync
 * treats its failure as fatal), then regional-carrier pages. */
export function rosterSources(cfg: AirlineConfig): Array<{ slug: string; subfleet?: string }> {
  if (!cfg.fr24Slug) return [];
  return [
    { slug: cfg.fr24Slug },
    ...(cfg.regionalCarriers ?? []).map((r) => ({ slug: r.fr24Slug, subfleet: r.subfleet })),
  ];
}

/**
 * Dedupe FR24 source pages into one roster. The primary livery page lists
 * regional tails too (as-asa includes Horizon E175s), so tails dedupe by
 * registration — the overlap can't double-count or inflate the minFleetSanity
 * input. A source page's configured subfleet beats the type classifier;
 * operator is asserted only where the source page proves it.
 */
export function buildRoster(cfg: AirlineConfig, sources: RosterSource[]): RosterEntry[] {
  const byTail = new Map<string, RosterEntry>();
  for (const src of sources) {
    for (const a of src.aircraft) {
      if (byTail.has(a.registration)) continue;
      const subfleet = src.subfleet ?? cfg.classifyFleet?.(a.aircraftType) ?? "mainline";
      const operator = src.subfleet
        ? (cfg.regionalCarriers?.find((r) => r.subfleet === src.subfleet)?.name ?? null)
        : null;
      byTail.set(a.registration, {
        registration: a.registration,
        aircraftType: a.aircraftType,
        subfleet,
        operator,
      });
    }
  }
  return [...byTail.values()];
}

/**
 * Sync fleet from FlightRadar24 to united_fleet table for one airline.
 */
export async function syncFleetFromFR24(
  cfg: AirlineConfig = AIRLINES.UA,
  sharedBrowser?: import("playwright").Browser
): Promise<{
  airline: string;
  success: boolean;
  total: number;
  new: number;
  updated: number;
  error?: string;
}> {
  const airlineTag = normalizeAirlineTag(cfg.code);
  return withSpan("fleet_sync.fr24", async (span) => {
    span.setTag("airline", airlineTag);
    const result = {
      airline: cfg.code,
      success: false,
      total: 0,
      new: 0,
      updated: 0,
      error: undefined as string | undefined,
    };

    if (!cfg.fr24Slug) {
      result.error = `${cfg.code}: no fr24Slug configured`;
      return result;
    }

    const sources = rosterSources(cfg);

    try {
      const scraped: RosterSource[] = [];
      for (const [i, src] of sources.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 5000));
        info(`Starting FR24 fleet sync for ${cfg.code} (${src.slug})...`);
        const scrapeResult = await scrapeFlightRadar24Fleet(src.slug, sharedBrowser);
        if (!scrapeResult.success) {
          const err = scrapeResult.error || "FR24 scrape failed";
          logError(`FR24 scrape failed (${cfg.code}/${src.slug})`, err);
          if (i === 0) {
            // Only mainline failure is a full-span error — regional gaps are partial.
            span.setTag("error", true);
            result.error = err;
            metrics.increment(COUNTERS.SCRAPER_SYNC, {
              source: "fr24",
              airline: airlineTag,
              status: "error",
            });
            return result;
          }
          result.error = `partial: ${src.slug} ${err}`;
          span.setTag("partial", true);
          continue;
        }
        info(`FR24 returned ${scrapeResult.aircraft.length} aircraft for ${cfg.code}/${src.slug}`);
        scraped.push({ subfleet: src.subfleet, aircraft: scrapeResult.aircraft });
      }

      const allAircraft = buildRoster(cfg, scraped);

      if (allAircraft.length < cfg.minFleetSanity) {
        result.error = `Suspiciously low aircraft count: ${allAircraft.length} (expected ${cfg.minFleetSanity}+)`;
        logError(`FR24 sync aborted (${cfg.code})`, result.error);
        span.setTag("error", true);
        span.setTag("abort_reason", result.error);
        metrics.increment(COUNTERS.SCRAPER_SYNC, {
          source: "fr24",
          airline: airlineTag,
          status: "aborted",
        });
        return result;
      }

      span.setTag("aircraft.count", allAircraft.length);

      const db = initializeDatabase();

      try {
        const existingTails = new Set(
          (
            db.query("SELECT tail_number FROM united_fleet WHERE airline = ?").all(cfg.code) as {
              tail_number: string;
            }[]
          ).map((r) => r.tail_number)
        );

        for (const aircraft of allAircraft) {
          const isNew = !existingTails.has(aircraft.registration);
          upsertFleetAircraft(
            db,
            aircraft.registration,
            aircraft.aircraftType,
            "fr24",
            aircraft.subfleet,
            aircraft.operator,
            cfg.code
          );
          if (isNew) {
            result.new++;
            metrics.increment(COUNTERS.PLANES_DISCOVERED, { source: "fr24", airline: airlineTag });
          } else {
            result.updated++;
          }
        }

        result.total = allAircraft.length;
        result.success = true;

        // Meta totals follow the lastUpdated owner: the sheet scrape owns
        // UA's; for everyone else FR24 is the roster of record, so refresh
        // meta here or it goes stale. (refreshFleetMeta itself only stamps
        // lastUpdated for fleet-meta-owned airlines — QR's stays with the
        // schedule ingester.)
        if (lastUpdatedOwner(cfg.code) !== "sheet-scrape") refreshFleetMeta(db, cfg.code);

        span.setTag("planes.new", result.new);
        span.setTag("planes.updated", result.updated);
        metrics.increment(COUNTERS.SCRAPER_SYNC, {
          source: "fr24",
          airline: airlineTag,
          status: result.error ? "partial" : "success",
        });

        info(`FR24 sync complete (${cfg.code}): ${result.new} new, ${result.updated} updated`);
      } finally {
        db.close();
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      logError(`FR24 sync error (${cfg.code})`, result.error);
      span.setTag("error", true);
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "fr24",
        airline: airlineTag,
        status: "error",
      });
    }

    return result;
  });
}

/**
 * Sync spreadsheet planes to united_fleet table
 */
export async function syncFromSpreadsheet(): Promise<{
  success: boolean;
  synced: number;
  error?: string;
}> {
  const result = { success: false, synced: 0, error: undefined as string | undefined };

  try {
    info("Starting spreadsheet sync to united_fleet...");

    const db = initializeDatabase();

    try {
      result.synced = syncSpreadsheetToFleet(db);
      result.success = true;
      info(`Spreadsheet sync complete: ${result.synced} new planes added to united_fleet`);
    } finally {
      db.close();
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logError("Spreadsheet sync error", result.error);
  }

  return result;
}

/**
 * Full fleet sync: FR24 (per enabled airline) + spreadsheet (UA-only)
 */
export async function syncFullFleet(): Promise<{
  fr24: Array<{
    airline: string;
    success: boolean;
    total: number;
    new: number;
    updated: number;
    error?: string;
  }>;
  spreadsheet: { success: boolean; synced: number; error?: string };
}> {
  const fr24: Awaited<ReturnType<typeof syncFleetFromFR24>>[] = [];
  const browser = await launchFR24Browser();
  try {
    for (const [i, cfg] of enabledAirlines().entries()) {
      if (!cfg.fr24Slug) continue;
      if (i > 0) await new Promise((r) => setTimeout(r, 5000));
      fr24.push(await syncFleetFromFR24(cfg, browser));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Spreadsheet sync remains UA-only — no other airline has a community sheet.
  const spreadsheetResult = await syncFromSpreadsheet();

  return { fr24, spreadsheet: spreadsheetResult };
}

/**
 * Start automatic daily fleet sync
 * Runs FR24 sync once per day to keep united_fleet populated
 */
export function startFleetSync(): JobHandle {
  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes after startup

  const runSync = async () => {
    try {
      await withSpan(
        "fleet_sync.run",
        async (span) => {
          span.setTag("job.type", "background");

          info("Starting scheduled FR24 fleet sync...");
          const result = await syncFullFleet();

          for (const r of result.fr24) {
            span.setTag(`fr24.${r.airline}.success`, r.success ? 1 : 0);
            span.setTag(`fr24.${r.airline}.total`, r.total);
            span.setTag(`fr24.${r.airline}.new`, r.new);
            if (r.success) {
              info(
                `Scheduled fleet sync (${r.airline}): ${r.total} aircraft (${r.new} new, ${r.updated} updated)`
              );
            } else {
              logError(`Scheduled FR24 sync failed (${r.airline})`, r.error);
            }
          }

          if (result.spreadsheet.success) {
            info(`Spreadsheet sync: ${result.spreadsheet.synced} new planes added to fleet`);
          }
        },
        { "job.type": "background" }
      );
    } catch (err) {
      logError("Scheduled fleet sync error", err);
    }
  };

  const handle = startJob({
    name: "fleet_sync",
    intervalMs: SYNC_INTERVAL_MS,
    // Initial sync after 5 minutes (give server time to stabilize)
    initialDelayMs: INITIAL_DELAY_MS,
    run: runSync,
  });

  info(
    `Fleet sync scheduled (every ${SYNC_INTERVAL_MS / 1000 / 3600}h, first run in ${INITIAL_DELAY_MS / 1000 / 60}min)`
  );
  return handle;
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args[0] || "full";

  console.log(`Fleet sync mode: ${mode}\n`);

  if (mode === "fr24") {
    syncFleetFromFR24()
      .then((result) => {
        console.log("\n=== FR24 Sync Results ===");
        console.log(`Success: ${result.success}`);
        console.log(`Total aircraft: ${result.total}`);
        console.log(`New: ${result.new}`);
        console.log(`Updated: ${result.updated}`);
        if (result.error) console.log(`Error: ${result.error}`);
      })
      .catch((err) => {
        console.error("FR24 sync failed:", err);
        process.exit(1);
      });
  } else if (mode === "spreadsheet") {
    syncFromSpreadsheet()
      .then((result) => {
        console.log("\n=== Spreadsheet Sync Results ===");
        console.log(`Success: ${result.success}`);
        console.log(`Synced: ${result.synced}`);
        if (result.error) console.log(`Error: ${result.error}`);
      })
      .catch((err) => {
        console.error("Spreadsheet sync failed:", err);
        process.exit(1);
      });
  } else {
    syncFullFleet()
      .then((result) => {
        console.log("\n=== Full Fleet Sync Results ===");
        for (const r of result.fr24) {
          console.log(`\nFR24 (${r.airline}):`);
          console.log(`  Success: ${r.success}`);
          console.log(`  Total: ${r.total}`);
          console.log(`  New: ${r.new}`);
          console.log(`  Updated: ${r.updated}`);
          if (r.error) console.log(`  Error: ${r.error}`);
        }
        console.log("\nSpreadsheet:");
        console.log(`  Success: ${result.spreadsheet.success}`);
        console.log(`  Synced: ${result.spreadsheet.synced}`);
        if (result.spreadsheet.error) console.log(`  Error: ${result.spreadsheet.error}`);
      })
      .catch((err) => {
        console.error("Full fleet sync failed:", err);
        process.exit(1);
      });
  }
}
