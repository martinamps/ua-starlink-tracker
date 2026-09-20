import type { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import { FR24_UPCOMING_CAP } from "../api/flightradar24-api";
import { GAUGES, metrics, normalizeAirlineTag } from "../observability/metrics";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError } from "../utils/logger";
import { type ProgressRollup, emitFleetProgressCounts } from "./fleet-progress";

const EMIT_INTERVAL_MS = 5 * 60 * 1000;

// Per-job freshness anchor: the newest timestamp that proves the pipeline
// actually wrote data, grouped by airline. Skips airlines with no rows so an
// airline that has never used a path doesn't emit a forever-stale gauge.
// The fixed-airline QR anchor exists only while QR is enabled — a deliberately
// disabled airline must go quiet, not page forever.
export function buildFreshnessQueries(qrEnabled = AIRLINES.QR.enabled): Record<string, string> {
  const queries: Record<string, string> = {
    flight_updater: `
    SELECT airline, MAX(last_updated) AS ts
    FROM upcoming_flights
    GROUP BY airline`,
    // Any log row counts: the gauge answers "is the verifier checking?", not
    // "is it extracting wifi?". Filtering on has_starlink muted the gauge
    // forever for backends whose checks legitimately log NULL wifi (alaska-json
    // without type-table coverage) — a no-op verifier was invisible. Result
    // quality is the verdict pipeline's concern, not freshness's.
    verifier: `
    SELECT airline, MAX(checked_at) AS ts
    FROM starlink_verification_log
    GROUP BY airline`,
    departures: `
    SELECT airline, MAX(departed_at) AS ts
    FROM departure_log
    GROUP BY airline`,
    // MIN over per-segment maxima: one segment failing to refresh must age the
    // gauge even while the other segments keep writing.
    fleet_progress: `
    SELECT airline, MIN(seg_ts) AS ts FROM (
      SELECT airline, MAX(fetched_at) AS seg_ts
      FROM fleet_progress GROUP BY airline, segment
    ) GROUP BY airline`,
    // faa_registry has no airline column (national registry); attribute to UA.
    faa_registry: `
    SELECT 'UA' AS airline, MAX(last_refreshed) AS ts
    FROM faa_registry`,
    adsb_sweep: `
    SELECT 'UA' AS airline, MAX(swept_at) AS ts
    FROM adsb_sweeps`,
  };
  // QR writes none of the airline-column tables — only qatar_schedule, whose
  // last_updated is touched solely on successful upserts. Without this gauge
  // a dead ingester is invisible until the prune drains the table (~48h).
  if (qrEnabled) {
    queries.qatar_ingester = `
    SELECT 'QR' AS airline, MAX(last_updated) AS ts
    FROM qatar_schedule`;
  }
  queries.residential_sync = residentialSyncQuery(qrEnabled);
  return queries;
}

// FlyerTalk is fetched from a laptop (FlyerTalk 403s the prod ASN), so nothing
// on prod notices when it stops: the AS oracle was dead May→Sept behind a warn.
// The airline list is fixed rather than read from meta so a missing or
// unparseable stamp emits as maximally stale instead of going mute.
function residentialSyncQuery(qrEnabled: boolean): string {
  const airlines = residentialSyncAirlines(qrEnabled)
    .map((a) => `SELECT '${a}' AS airline`)
    .join(" UNION ALL ");
  return `
    SELECT a.airline, CAST(strftime('%s', m.value) AS INTEGER) AS ts
    FROM (${airlines}) a
    LEFT JOIN meta m ON m.key = a.airline || ':residentialSyncAt'`;
}

function residentialSyncAirlines(qrEnabled: boolean, afEnabled = AIRLINES.AF.enabled): string[] {
  return ["AS", ...(qrEnabled ? ["QR"] : []), ...(afEnabled ? ["AF"] : [])];
}

export const FRESHNESS_QUERIES = buildFreshnessQueries();

// Which airlines each job's query can report on: GROUP BY queries cover the
// airlines whose pipelines write that table; fixed-airline queries name their
// owner. tests/jobs.test.ts asserts every enabled airline appears somewhere
// here, so a new airline without a freshness anchor fails loudly.
export function buildFreshnessCoverage(
  qrEnabled = AIRLINES.QR.enabled
): Record<string, readonly string[]> {
  const coverage: Record<string, readonly string[]> = {
    flight_updater: ["UA", "HA", "AS", "AF"],
    verifier: ["UA", "HA", "AS"],
    departures: ["UA", "HA", "AS"],
    fleet_progress: ["UA"],
    faa_registry: ["UA"],
    adsb_sweep: ["UA"],
  };
  if (qrEnabled) coverage.qatar_ingester = ["QR"];
  coverage.residential_sync = residentialSyncAirlines(qrEnabled);
  return coverage;
}

export const FRESHNESS_COVERAGE = buildFreshnessCoverage();

// Tables sampled by the row-count gauge. flight_routes and the qatar_* tables
// have no airline column — those report under airline:all.
const ROW_COUNT_TABLES: Array<{ table: string; hasAirline: boolean }> = [
  { table: "upcoming_flights", hasAirline: true },
  { table: "starlink_verification_log", hasAirline: true },
  { table: "departure_log", hasAirline: true },
  { table: "flight_routes", hasAirline: false },
  { table: "qatar_schedule", hasAirline: false },
  { table: "qatar_equipment_history", hasAirline: false },
  { table: "qatar_fetch_coverage", hasAirline: false },
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

export function emitDataFreshness(db: Database, queries = FRESHNESS_QUERIES): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [job, sql] of Object.entries(queries)) {
    try {
      const rows = db.query(sql).all() as Array<{ airline: string; ts: number | null }>;
      for (const row of rows) {
        let ts = row.ts;
        if (ts == null) {
          // GROUP BY queries skip airlines with no rows. Fixed-airline queries
          // return a null MAX on an empty table — the maximally stale state must
          // still emit so the monitor can fire (epoch 0 / meta-stamp fallback).
          if (job === "qatar_ingester") ts = metaLastUpdatedEpoch(db, row.airline) ?? 0;
          else if (job === "faa_registry" || job === "adsb_sweep" || job === "residential_sync")
            ts = 0;
          else continue;
        }
        const ageSec = Math.max(0, now - ts);
        // dataset mirrors job: DD monitors/dashboards group this gauge by
        // dataset, which read N/A while only job was emitted. job stays so
        // existing series and queries keep working.
        metrics.gauge(GAUGES.DATA_FRESHNESS_SECONDS, ageSec, {
          job,
          dataset: job,
          airline: normalizeAirlineTag(row.airline),
        });
      }
    } catch (err) {
      logError(`Freshness query failed for job=${job}`, err);
    }
  }
  emitRowCounts(db);
  emitCappedFutureShare(db);
  emitStoredFleetProgress(db);
}

function emitStoredFleetProgress(db: Database): void {
  try {
    const rows = db
      .query(
        `SELECT airline, segment, total, starlink_complete, in_mod, verification_needed
         FROM fleet_progress WHERE type_code = 'Totals'`
      )
      .all() as Array<ProgressRollup & { airline: string }>;
    for (const row of rows) emitFleetProgressCounts(row.airline, [row]);
  } catch (err) {
    logError("Fleet-progress re-emit failed", err);
  }
}

/** Past any overnight park, so a tail refreshed at the gate for its first
 * morning departure doesn't count. A 1h threshold swung AS 0→64% every night
 * (Datadog 2026-09-20); simulated refreshes at every ground moment in the
 * 2026-08-29 schedules flag 4.4% of UA at 12h vs 70% at 1h. */
export const CAPPED_FUTURE_GAP_SEC = 12 * 3600;

/** Per airline: share of tails sitting exactly at the row cap whose first row
 * departs more than an overnight park after their refresh. 34% of UA tails
 * (193/561) before the nearest-first cap fix (prod snapshot 2026-08-29); a rise
 * means the cap is dropping near-term legs again. */
export function cappedFutureShareByAirline(
  db: Database,
  cap = FR24_UPCOMING_CAP
): Array<{ airline: string; share: number }> {
  return db
    .query(
      `SELECT airline, AVG(CASE WHEN n = ? AND first_dep > refreshed + ${CAPPED_FUTURE_GAP_SEC} THEN 1.0 ELSE 0 END) AS share
       FROM (
         SELECT airline, tail_number, COUNT(*) AS n, MIN(departure_time) AS first_dep,
                MAX(last_updated) AS refreshed
         FROM upcoming_flights GROUP BY airline, tail_number
       ) GROUP BY airline`
    )
    .all(cap) as Array<{ airline: string; share: number }>;
}

function emitCappedFutureShare(db: Database): void {
  try {
    for (const row of cappedFutureShareByAirline(db)) {
      metrics.gauge(GAUGES.UPCOMING_CAPPED_FUTURE_SHARE, row.share, {
        airline: normalizeAirlineTag(row.airline),
      });
    }
  } catch (err) {
    logError("Capped-future-share query failed", err);
  }
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
