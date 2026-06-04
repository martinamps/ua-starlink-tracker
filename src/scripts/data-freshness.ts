import type { Database } from "bun:sqlite";
import { GAUGES, metrics, normalizeAirlineTag } from "../observability/metrics";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError } from "../utils/logger";

const EMIT_INTERVAL_MS = 5 * 60 * 1000;

type FreshnessJob = "flight_updater" | "verifier" | "departures" | "qatar_ingester";

// Per-job freshness anchor: the newest timestamp that proves the pipeline
// actually wrote data, grouped by airline. Skips airlines with no rows so an
// airline that has never used a path doesn't emit a forever-stale gauge.
export const FRESHNESS_QUERIES: Record<FreshnessJob, string> = {
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
  // QR writes none of the airline-column tables — only qatar_schedule, whose
  // last_updated is touched solely on successful upserts. Without this gauge
  // a dead ingester is invisible until the prune drains the table (~48h).
  qatar_ingester: `
    SELECT 'QR' AS airline, MAX(last_updated) AS ts
    FROM qatar_schedule`,
};

// Which airlines each job's query can report on: GROUP BY queries cover the
// airlines whose pipelines write that table; fixed-airline queries name their
// owner. tests/jobs.test.ts asserts every enabled airline appears somewhere
// here, so a new airline without a freshness anchor fails loudly.
export const FRESHNESS_COVERAGE: Record<FreshnessJob, readonly string[]> = {
  flight_updater: ["UA", "HA", "AS"],
  verifier: ["UA", "HA", "AS"],
  departures: ["UA", "HA", "AS"],
  qatar_ingester: ["QR"],
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

// Namespaced meta lastUpdated as epoch seconds. Deliberately not getMeta():
// its bare-key fallback would leak UA's legacy stamp into other airlines.
function metaLastUpdatedEpoch(db: Database, airline: string): number | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(`${airline}:lastUpdated`) as {
    value: string;
  } | null;
  if (!row?.value) return null;
  const ms = Date.parse(row.value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function emitDataFreshness(db: Database): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [job, sql] of Object.entries(FRESHNESS_QUERIES)) {
    try {
      const rows = db.query(sql).all() as Array<{ airline: string; ts: number | null }>;
      for (const row of rows) {
        let ts = row.ts;
        if (ts == null) {
          // GROUP BY queries skip airlines with no rows. The fixed-airline QR
          // query instead returns a null MAX on an empty table — the maximally
          // stale state must still emit: fall back to the meta stamp, else
          // epoch 0 so the monitor definitely fires.
          if (job !== "qatar_ingester") continue;
          ts = metaLastUpdatedEpoch(db, row.airline) ?? 0;
        }
        const ageSec = Math.max(0, now - ts);
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

export function startFreshnessEmitter(db: Database): JobHandle {
  info(`Starting data freshness emitter (every ${EMIT_INTERVAL_MS / 60000} min)`);
  return startJob({
    name: "data_freshness",
    intervalMs: EMIT_INTERVAL_MS,
    initialDelayMs: 0,
    run: () => emitDataFreshness(db),
  });
}
