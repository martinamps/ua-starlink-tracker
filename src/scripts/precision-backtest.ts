#!/usr/bin/env bun
/**
 * Firm-call precision harness.
 *
 * Measures: when check_flight returns a firm YES/NO (flight assigned to a tail
 * with a settled wifi status), how often does the passenger actually get what
 * we said?
 *
 * Method: each starlink_verification_log row is a real-world observation of a
 * flight's wifi via united.com. For each observation, reconstruct what our firm
 * call would have been by looking at the most recent PRIOR tail-confirmed
 * observation of the same tail. Score the new observation against that belief.
 * Point-in-time correct — no dependency on current united_fleet state.
 *
 *   bun run precision                      # 30d window on default DB
 *   bun run precision -- --days=7
 *   bun run precision -- --db=/tmp/ua-test.sqlite --emit
 */

import { Database } from "bun:sqlite";
import { GAUGES, metrics, normalizeAirlineTag } from "../observability/metrics";
import { info } from "../utils/logger";

interface CallBucket {
  n: number;
  correct: number;
  precision: number;
  swapMisses: number;
  staleMisses: number;
  unattributedMisses: number;
}

interface Row {
  id: number;
  tail_number: string;
  flight_number: string | null;
  checked_at: number;
  has_starlink: number;
  tail_confirmed: number | null;
  prior_belief: number | null;
  prior_confirmed: number | null;
}

export interface PrecisionResult {
  windowDays: number;
  anchor: number;
  yes: CallBucket;
  no: CallBucket;
  noFirmCall: number;
  legacyPriorPct: number;
}

export function computePrecision(db: Database, windowDays = 30): PrecisionResult {
  const anchor =
    (
      db
        .query(
          "SELECT MAX(checked_at) as m FROM starlink_verification_log WHERE source='united' AND error IS NULL"
        )
        .get() as { m: number | null }
    ).m ?? Math.floor(Date.now() / 1000);
  const windowStart = anchor - windowDays * 86400;

  const rows = db
    .query(`
      SELECT
        v.id, v.tail_number, v.flight_number, v.checked_at, v.has_starlink, v.tail_confirmed,
        (SELECT p.has_starlink
           FROM starlink_verification_log p
          WHERE p.tail_number = v.tail_number
            AND p.source = 'united'
            AND p.error IS NULL
            AND p.has_starlink IS NOT NULL
            AND (p.tail_confirmed = 1 OR p.tail_confirmed IS NULL)
            AND p.checked_at < v.checked_at
          ORDER BY p.checked_at DESC
          LIMIT 1) AS prior_belief,
        (SELECT p.tail_confirmed
           FROM starlink_verification_log p
          WHERE p.tail_number = v.tail_number
            AND p.source = 'united'
            AND p.error IS NULL
            AND p.has_starlink IS NOT NULL
            AND (p.tail_confirmed = 1 OR p.tail_confirmed IS NULL)
            AND p.checked_at < v.checked_at
          ORDER BY p.checked_at DESC
          LIMIT 1) AS prior_confirmed
      FROM starlink_verification_log v
      WHERE v.source = 'united'
        AND v.error IS NULL
        AND v.has_starlink IS NOT NULL
        AND v.checked_at > ?
      ORDER BY v.checked_at
    `)
    .all(windowStart) as Row[];

  const mk = (): CallBucket => ({
    n: 0,
    correct: 0,
    precision: 0,
    swapMisses: 0,
    staleMisses: 0,
    unattributedMisses: 0,
  });
  const yes = mk();
  const no = mk();
  let noFirmCall = 0;
  let legacyPriors = 0;
  let totalPriors = 0;

  for (const r of rows) {
    if (r.prior_belief === null) {
      noFirmCall++;
      continue;
    }
    totalPriors++;
    if (r.prior_confirmed === null) legacyPriors++;
    const bucket = r.prior_belief === 1 ? yes : no;
    bucket.n++;
    if (r.has_starlink === r.prior_belief) {
      bucket.correct++;
    } else if (r.tail_confirmed === 0) {
      bucket.swapMisses++;
    } else if (r.tail_confirmed === 1) {
      bucket.staleMisses++;
    } else {
      bucket.unattributedMisses++;
    }
  }

  yes.precision = yes.n > 0 ? yes.correct / yes.n : 0;
  no.precision = no.n > 0 ? no.correct / no.n : 0;
  const legacyPriorPct = totalPriors > 0 ? legacyPriors / totalPriors : 0;

  return { windowDays, anchor, yes, no, noFirmCall, legacyPriorPct };
}

export function emitPrecisionGauges(r: PrecisionResult) {
  const base = { airline: normalizeAirlineTag("UA"), window: `${r.windowDays}d` };
  for (const [call, b] of [
    ["yes", r.yes],
    ["no", r.no],
  ] as const) {
    metrics.gauge(GAUGES.PRECISION_FIRM_CALL, b.precision, { ...base, call });
    metrics.gauge(GAUGES.PRECISION_FIRM_CALL_N, b.n, { ...base, call });
    metrics.gauge(GAUGES.PRECISION_FIRM_CALL_MISS, b.swapMisses, { ...base, call, cause: "swap" });
    metrics.gauge(GAUGES.PRECISION_FIRM_CALL_MISS, b.staleMisses, {
      ...base,
      call,
      cause: "stale",
    });
    metrics.gauge(GAUGES.PRECISION_FIRM_CALL_MISS, b.unattributedMisses, {
      ...base,
      call,
      cause: "unattributed",
    });
  }
  metrics.gauge(GAUGES.PRECISION_LEGACY_PRIOR_PCT, r.legacyPriorPct, base);
}

function fmt(b: CallBucket, label: string) {
  const pct = (b.precision * 100).toFixed(2);
  const miss = b.n - b.correct;
  return `  ${label.padEnd(4)} n=${String(b.n).padStart(5)}  precision=${pct}%  misses=${miss} (swap=${b.swapMisses} stale=${b.staleMisses} unattributed=${b.unattributedMisses})`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dbPath =
    args.find((a) => a.startsWith("--db="))?.slice(5) ?? process.env.DB_PATH ?? "plane-data.sqlite";
  const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7) ?? 30);
  const emit = args.includes("--emit");

  const db = new Database(dbPath, { readonly: true });
  const r = computePrecision(db, days);
  db.close();

  const anchorIso = new Date(r.anchor * 1000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`\n=== Firm-call precision · ${days}d window ending ${anchorIso} ===`);
  console.log(fmt(r.yes, "YES"));
  console.log(fmt(r.no, "NO"));
  console.log(`  (no firm call possible: ${r.noFirmCall} obs — first sighting of tail)`);
  if (r.legacyPriorPct > 0.05) {
    console.log(
      `  ⚠ ${(r.legacyPriorPct * 100).toFixed(0)}% of prior beliefs from legacy (tail_confirmed=NULL) rows — number is swap-contaminated until log fills`
    );
  }

  const bar = r.yes.precision >= 0.95 ? "PASS" : "FAIL";
  console.log(`\n  North-star bar (YES ≥95%): ${bar}\n`);

  if (emit) {
    emitPrecisionGauges(r);
    info(
      `precision gauges emitted: yes=${r.yes.precision.toFixed(4)} no=${r.no.precision.toFixed(4)}`
    );
  }
}
