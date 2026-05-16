// Tracer must be imported FIRST before any other imports
import "./src/observability/tracer";
import "dotenv/config";

import { checkNewPlanes, startFlightUpdater } from "./src/api/flight-updater";
import {
  initializeDatabase,
  pruneCrashRows,
  reconcileConsensus,
  syncSpreadsheetToFleet,
  updateDatabase,
} from "./src/database/database";
import { withSpan } from "./src/observability";
import { startAlaskaVerifier } from "./src/scripts/alaska-verifier";
import { startFreshnessEmitter } from "./src/scripts/data-freshness";
import { startFleetDiscovery } from "./src/scripts/fleet-discovery";
import { startFleetSync } from "./src/scripts/fleet-sync";
import { computePrecision, emitPrecisionGauges } from "./src/scripts/precision-backtest";
import { startQatarScheduleIngester } from "./src/scripts/qatar-schedule-ingester";
import { startStarlinkVerifier } from "./src/scripts/starlink-verifier";
import { computeSurfaceContradictions, emitSweepGauges } from "./src/scripts/surface-sweep";
import { syncShipNumbers } from "./src/scripts/sync-ship-numbers";
import { createApp } from "./src/server/app";
import { info, error as logError } from "./src/utils/logger";
import { fetchAllSheets } from "./src/utils/utils";

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError("Unhandled Rejection", err);
});
process.on("uncaughtException", (err) => logError("Uncaught Exception", err));

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
const JOBS_ENABLED = process.env.DISABLE_JOBS !== "1";

const db = initializeDatabase();
const app = createApp(db);

info(`Server starting on port ${PORT}. Environment: ${process.env.NODE_ENV || "development"}`);

Bun.serve({
  port: PORT,
  fetch: app.dispatch,
});

// ─────────────────────────────────────────────────────────────────────────────
// Background jobs (raw db; not request-scoped)
// ─────────────────────────────────────────────────────────────────────────────

async function updateStarlinkData() {
  return withSpan(
    "scraper.update_data",
    async (span) => {
      span.setTag("job.type", "background");
      try {
        const { totalAircraftCount, starlinkAircraft, fleetStats } = await fetchAllSheets();
        updateDatabase(db, totalAircraftCount, starlinkAircraft, fleetStats);

        const synced = syncSpreadsheetToFleet(db);
        if (synced > 0) {
          info(`Synced ${synced} new planes to united_fleet`);
          span.setTag("synced_to_fleet", synced);
        }

        const healed = reconcileConsensus(db);
        if (healed > 0) {
          info(`Consensus reconciliation healed ${healed} tails`);
          span.setTag("consensus_healed", healed);
        }

        const precision = computePrecision(db, 14);
        emitPrecisionGauges(precision);
        span.setTag("precision_yes_14d", precision.yes.precision);
        span.setTag("precision_no_14d", precision.no.precision);
        info(
          `Firm-call precision (14d): YES=${(precision.yes.precision * 100).toFixed(1)}% n=${precision.yes.n} · NO=${(precision.no.precision * 100).toFixed(1)}% n=${precision.no.n}`
        );

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

        span.setTag("total_aircraft", totalAircraftCount);
        span.setTag("starlink_count", starlinkAircraft.length);
        info(
          `Updated data: ${starlinkAircraft.length} Starlink aircraft out of ${totalAircraftCount} total`
        );

        await checkNewPlanes();
        return { total: totalAircraftCount, starlinkCount: starlinkAircraft.length };
      } catch (err) {
        logError("Error updating starlink data", err);
        span.setTag("error", true);
        return { total: 0, starlinkCount: 0 };
      }
    },
    { "job.type": "background" }
  );
}

if (JOBS_ENABLED) {
  info("Checking for new planes...");
  checkNewPlanes().catch((err) => logError("Error checking new planes on startup", err));

  // updateStarlinkData (Google Sheets scrape) is UA-only — no other airline has
  // a community sheet. updateDatabase() is airline-scoped so HA rows survive.
  updateStarlinkData();
  setInterval(
    () => {
      info("Running scheduled update...");
      updateStarlinkData();
    },
    60 * 60 * 1000
  );

  startFlightUpdater();
  // United verifier + discovery: UA-only Playwright path.
  startStarlinkVerifier();
  startFleetDiscovery("maintenance");
  // alaska-json verifier: serves HA (type-deterministic confirmation) and AS
  // (tail/type oracle until alaskaair.com exposes per-tail wifi).
  startAlaskaVerifier();
  // Qatar schedule ingester: pulls per-flight equipment from QR's flight-status
  // API for top routes; populates qatar_schedule which /api/check-flight reads.
  startQatarScheduleIngester();
  // Fleet sync iterates enabledAirlines() internally.
  startFleetSync();

  // Data-freshness gauges: derived from MAX(timestamp) in the DB, not a
  // ran-at heartbeat — catches "loop alive but writes nothing" silent failures.
  startFreshnessEmitter(db);

  // Ship-number resolution is UA-specific (United's ship→tail Google Sheet).
  setTimeout(
    () => {
      syncShipNumbers().catch((e) => logError("Ship number sync failed", e));
      setInterval(
        () => syncShipNumbers().catch((e) => logError("Ship number sync failed", e)),
        24 * 3600 * 1000
      );
    },
    10 * 60 * 1000
  );

  // Daily prune of subprocess-crash log rows (no observation, just noise).
  setInterval(
    () => {
      const n = pruneCrashRows(db);
      if (n > 0) info(`Pruned ${n} stale crash rows from verification log`);
    },
    24 * 3600 * 1000
  );
} else {
  info("Background jobs disabled (DISABLE_JOBS=1)");
}

info(`Server running at http://localhost:${PORT}`);
