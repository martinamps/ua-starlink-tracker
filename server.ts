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
import { type JobHandle, type JobRunContext, startJob } from "./src/utils/job-runner";
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

async function updateStarlinkData(ctx?: JobRunContext) {
  const result = await runSheetScrape(db, undefined, ctx);
  // A refused roster replace still scanned/healed; only a hard error (sheet
  // fetch threw) or an abandoned (stuck-escaped) run skips the discovery pass.
  if (result.outcome === "success" || result.outcome === "refused") {
    await checkNewPlanes(db).catch((err) => logError("Error checking new planes", err));
  }
  return result;
}

const jobs: JobHandle[] = [];
const track = (handle?: JobHandle) => {
  if (handle) jobs.push(handle);
};

if (JOBS_ENABLED) {
  // updateStarlinkData (Google Sheets scrape) is UA-only — no other airline has
  // a community sheet. updateDatabase() is airline-scoped so HA rows survive.
  track(
    startJob({
      name: "sheet_scrape",
      intervalMs: 60 * 60 * 1000,
      initialDelayMs: 0,
      run: async (ctx) => {
        info("Running scheduled update...");
        await updateStarlinkData(ctx);
      },
    })
  );

  track(startFlightUpdater());
  // United verifier + discovery: UA-only Playwright path.
  track(startStarlinkVerifier());
  track(startFleetDiscovery("maintenance"));
  // alaska-json verifier: serves HA (type-deterministic confirmation) and AS
  // (tail/type oracle until alaskaair.com exposes per-tail wifi).
  track(startAlaskaVerifier());
  // Qatar schedule ingester: pulls per-flight equipment from QR's flight-status
  // API for top routes; populates qatar_schedule which /api/check-flight reads.
  track(startQatarScheduleIngester());
  // Fleet sync iterates enabledAirlines() internally.
  track(startFleetSync());

  // Data-freshness gauges: derived from MAX(timestamp) in the DB, not a
  // ran-at heartbeat — catches "loop alive but writes nothing" silent failures.
  track(startFreshnessEmitter(db));

  track(
    startJob({
      name: "archive_departures",
      intervalMs: 5 * 60 * 1000,
      run: () => archivePastDepartures(db),
    })
  );

  // Daily UA ship→tail sheet sync. (FlyerTalk QR/AS scrapes run via
  // residential-sync from a non-OVH IP — prod gets 403.)
  track(
    startJob({
      name: "ship_number_sync",
      intervalMs: 24 * 3600 * 1000,
      initialDelayMs: 10 * 60 * 1000,
      run: () => syncShipNumbers(),
    })
  );

  // Daily prune of subprocess-crash log rows (no observation, just noise).
  track(
    startJob({
      name: "prune_crash_rows",
      intervalMs: 24 * 3600 * 1000,
      run: () => {
        const n = pruneCrashRows(db);
        if (n > 0) info(`Pruned ${n} stale crash rows from verification log`);
      },
    })
  );
} else {
  info("Background jobs disabled (DISABLE_JOBS=1)");
}

// Container deploys send SIGTERM: clear all job timers (in-flight runs aren't
// awaited — they're cut with the process) and exit cleanly.
const shutdown = (signal: string) => {
  info(`${signal} received — stopping ${jobs.length} background jobs and exiting`);
  for (const job of jobs) job.stop();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

info(`Server running at http://localhost:${PORT}`);
