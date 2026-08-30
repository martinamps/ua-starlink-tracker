import type { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import { GAUGES, metrics, normalizeAirlineTag } from "../observability/metrics";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError } from "../utils/logger";

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
  return queries;
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
    flight_updater: ["UA", "HA", "AS"],
    verifier: ["UA", "HA", "AS"],
    departures: ["UA", "HA", "AS"],
    fleet_progress: ["UA"],
    faa_registry: ["UA"],
    adsb_sweep: ["UA"],
  };
  if (qrEnabled) coverage.qatar_ingester = ["QR"];
  return coverage;
}

export const FRESHNESS_COVERAGE = buildFreshnessCoverage();

const DAY = 86_400;

// Worst healthy write gap actually observed per (job, airline), measured over
// the 90 days of production data ending 2026-08-29. These are the numbers the
// budgets below must clear; WORST_HEALTHY_GAP_SEC is exported so
// tests/jobs.test.ts can assert budget > gap instead of checking the table
// against itself. Re-measure with:
//   LAG(ts) OVER (PARTITION BY airline ORDER BY ts) on each anchor column.
// Note what the anchor measures: MAX(ts) over ALL of an airline's rows, i.e.
// the fleet-wide newest write — NOT any single tail's re-check interval. A
// per-tail defer only shows up here when it is long enough that the whole
// roster goes quiet between passes, which is exactly what the alaska-json
// verifier's small queues do.
export const WORST_HEALTHY_GAP_SEC: Record<string, Record<string, number>> = {
  // alaska-json round-robin: AS 328,533s (3.8 d), HA 535,605s (6.2 d) — small
  // rosters plus the ~7-day inconclusive defer leave the whole airline quiet
  // for days. UA's united.com verifier: 4,140s (69 min).
  verifier: { UA: 4_140, AS: 328_533, HA: 535_605 },
  // departure_log archives on a 5-min sweep; gaps are just quiet flight banks.
  departures: { UA: 10_920, HA: 13_500, AS: 31_320, QR: 7_800 },
};

// Deadman budgets: the age (seconds) past which a pipeline's silence means the
// LOOP IS DEAD, not merely between healthy writes. Deliberately generous — a
// freshness SLO belongs to per-dataset monitors; this exists so one monitor on
// freshness_ratio > 1 catches any dead pipeline. The verifier budget is keyed
// off the registry's verifierBackend, not off airline codes: every airline on
// the alaska-json backend shares one round-robin and one ~7-day inconclusive
// defer (src/scripts/alaska-verifier.ts), so they must share a budget. Keying
// it per-airline is how AS previously ended up on the 24h default and read
// > 1 for ~38% of a healthy 90 days. tests/jobs.test.ts pins both that every
// query has a budget and that each budget clears WORST_HEALTHY_GAP_SEC.
const VERIFIER_BUDGET_BY_BACKEND: Record<string, number> = {
  united: DAY,
  // 14 d ≈ 2.3x the worst measured alaska-json gap (HA, 6.2 d).
  "alaska-json": 14 * DAY,
  "qatar-fltstatus": DAY,
};

function verifierBudgetSec(airline: string): number {
  const backend = AIRLINES[airline]?.verifierBackend;
  return (backend && VERIFIER_BUDGET_BY_BACKEND[backend]) ?? DAY;
}

const DEADMAN_BUDGET_SEC: Record<
  string,
  { default: number; byAirline?: (airline: string) => number }
> = {
  flight_updater: { default: DAY },
  verifier: { default: DAY, byAirline: verifierBudgetSec },
  departures: { default: 2 * DAY },
  fleet_progress: { default: 3 * DAY },
  faa_registry: { default: 3 * DAY },
  adsb_sweep: { default: DAY },
  qatar_ingester: { default: DAY },
};

export function deadmanBudgetSec(job: string, airline: string): number | null {
  const entry = DEADMAN_BUDGET_SEC[job];
  if (!entry) return null;
  return entry.byAirline?.(airline) ?? entry.default;
}

/** Test seam: asserts stay in sync with the queries without exporting the table. */
export function deadmanJobs(): string[] {
  return Object.keys(DEADMAN_BUDGET_SEC);
}

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
          else if (job === "faa_registry" || job === "adsb_sweep") ts = 0;
          else continue;
        }
        const ageSec = Math.max(0, now - ts);
        // dataset mirrors job: DD monitors/dashboards group this gauge by
        // dataset, which read N/A while only job was emitted. job stays so
        // existing series and queries keep working.
        const tags = { job, dataset: job, airline: normalizeAirlineTag(row.airline) };
        metrics.gauge(GAUGES.DATA_FRESHNESS_SECONDS, ageSec, tags);
        // Cadence-normalized deadman: >1 means the pipeline is past its
        // budget. Lets a single monitor cover airlines whose healthy write
        // cadences differ by two orders of magnitude (UA's verifier writes
        // every ~69 min at worst; the alaska-json airlines go quiet for days).
        const budget = deadmanBudgetSec(job, row.airline);
        if (budget !== null) {
          metrics.gauge(GAUGES.DATA_FRESHNESS_RATIO, ageSec / budget, tags);
        }
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
