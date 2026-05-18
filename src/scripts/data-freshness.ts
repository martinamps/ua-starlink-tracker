import type { Database } from "bun:sqlite";
import { GAUGES, metrics, normalizeAirlineTag } from "../observability/metrics";
import { info, error as logError } from "../utils/logger";

const EMIT_INTERVAL_MS = 5 * 60 * 1000;

type FreshnessJob = "flight_updater" | "verifier" | "departures";

// Per-job freshness anchor: the newest timestamp that proves the pipeline
// actually wrote data, grouped by airline. Skips airlines with no rows so an
// airline that has never used a path doesn't emit a forever-stale gauge.
const FRESHNESS_QUERIES: Record<FreshnessJob, string> = {
  flight_updater: `
    SELECT airline, MAX(last_updated) AS ts
    FROM upcoming_flights
    GROUP BY airline`,
  // has_starlink IS NOT NULL filters out crash/error rows — a verifier that
  // runs but only logs failures should still read as stale.
  verifier: `
    SELECT airline, MAX(checked_at) AS ts
    FROM starlink_verification_log
    WHERE has_starlink IS NOT NULL
    GROUP BY airline`,
  departures: `
    SELECT airline, MAX(departed_at) AS ts
    FROM departure_log
    GROUP BY airline`,
};

// Tables sampled by the row-count gauge. flight_routes/qatar_schedule have no
// airline column — those report under airline:all.
const ROW_COUNT_TABLES: Array<{ table: string; hasAirline: boolean }> = [
  { table: "upcoming_flights", hasAirline: true },
  { table: "starlink_verification_log", hasAirline: true },
  { table: "departure_log", hasAirline: true },
  { table: "flight_routes", hasAirline: false },
  { table: "qatar_schedule", hasAirline: false },
];

function emitRowCounts(db: Database): void {
  for (const { table, hasAirline } of ROW_COUNT_TABLES) {
    try {
      if (hasAirline) {
        const rows = db
          .query(`SELECT airline, COUNT(*) AS cnt FROM ${table} GROUP BY airline`)
          .all() as Array<{ airline: string; cnt: number }>;
        for (const row of rows) {
          metrics.gauge(GAUGES.DB_TABLE_ROWS, row.cnt, {
            table,
            airline: normalizeAirlineTag(row.airline),
          });
        }
      } else {
        const row = db.query(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number };
        metrics.gauge(GAUGES.DB_TABLE_ROWS, row.cnt, { table, airline: "all" });
      }
    } catch (err) {
      logError(`Row count query failed for table=${table}`, err);
    }
  }
}

export function emitDataFreshness(db: Database): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [job, sql] of Object.entries(FRESHNESS_QUERIES)) {
    try {
      const rows = db.query(sql).all() as Array<{ airline: string; ts: number | null }>;
      for (const row of rows) {
        if (row.ts == null) continue;
        const ageSec = Math.max(0, now - row.ts);
        metrics.gauge(GAUGES.DATA_FRESHNESS_SECONDS, ageSec, {
          job,
          airline: normalizeAirlineTag(row.airline),
        });
      }
    } catch (err) {
      logError(`Freshness query failed for job=${job}`, err);
    }
  }
  emitRowCounts(db);
}

export function startFreshnessEmitter(db: Database): void {
  info(`Starting data freshness emitter (every ${EMIT_INTERVAL_MS / 60000} min)`);
  emitDataFreshness(db);
  setInterval(() => emitDataFreshness(db), EMIT_INTERVAL_MS);
}
