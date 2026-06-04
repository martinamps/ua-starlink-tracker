// Tracer must be imported FIRST before any other imports
import "./src/observability/tracer";
import "dotenv/config";

import { checkNewPlanes, startFlightUpdater } from "./src/api/flight-updater";
import { archivePastDepartures, initializeDatabase, pruneCrashRows } from "./src/database/database";
import { startAlaskaVerifier } from "./src/scripts/alaska-verifier";
import { startFreshnessEmitter } from "./src/scripts/data-freshness";
import { startFleetDiscovery } from "./src/scripts/fleet-discovery";
import { startFleetSync } from "./src/scripts/fleet-sync";
import { startQatarScheduleIngester } from "./src/scripts/qatar-schedule-ingester";
import { runSheetScrape } from "./src/scripts/sheet-scrape";
import { startStarlinkVerifier } from "./src/scripts/starlink-verifier";
import { syncShipNumbers } from "./src/scripts/sync-ship-numbers";
import { createApp } from "./src/server/app";
import { info, error as logError } from "./src/utils/logger";

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
  const result = await runSheetScrape(db);
  // A refused roster replace still scanned/healed; only a hard error (sheet
  // fetch threw) skips the discovery pass.
  if (result.outcome !== "error") {
    await checkNewPlanes().catch((err) => logError("Error checking new planes", err));
  }
  return result;
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

  setInterval(
    () => {
      try {
        archivePastDepartures(db);
      } catch (e) {
        logError("archivePastDepartures failed", e);
      }
    },
    5 * 60 * 1000
  );

  // Daily UA ship→tail sheet sync. (FlyerTalk QR/AS scrapes run via
  // residential-sync from a non-OVH IP — prod gets 403.)
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
