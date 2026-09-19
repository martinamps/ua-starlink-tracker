#!/usr/bin/env bun
/**
 * Qatar observed-type history backtest + equipment-swap study.
 *
 * For every (flight number, operating day d) in qatar_equipment_history,
 * rebuild the answer the hub would have given `lead` days earlier — only
 * chains with service_date < d, from the history window as it stood then —
 * and score it against d's final class. A 787-9 day counts as a miss (we
 * can't vouch for it); `excluding789` drops those days instead.
 *
 * The swap study buckets class-changing swaps (first_equipment_code →
 * equipment_code) by how far ahead the first sighting was.
 *
 *   bun run qatar-backtest -- --db=path/to/copy.sqlite --lead=8
 *   bun run qatar-backtest -- --flown-only
 */

import { Database } from "bun:sqlite";
import { qatarEquipmentClass } from "../api/qatar-status";
import {
  QATAR_HISTORY_WINDOW_DAYS,
  addDaysISO,
  qatarHistoryStats,
  qatarOperatingDays,
} from "../api/qatar-verdict";
import type { QatarHistoryRow } from "../database/database";

const BADGE_THRESHOLD = 0.8;
const PUBLISHED_DAYS = 6;
// Types that must never be badged: a single day on one is disqualifying.
const NEVER_BADGE_CODES = new Set(["388", "320", "333", "21N"]);
const FLOWN = new Set(["ARRIVED", "DEPARTED", "LANDED", "ENRT", "AIRBORNE", "DIVERTED"]);

export interface BacktestResult {
  scored: number;
  badged: number;
  badgedYes: number;
  precision: number | null;
  badgeShare: number;
  brier: number | null;
  excluding789: { badged: number; badgedYes: number; precision: number | null };
  rollingTargets: number;
  gateViolations: { mixedOver7pct: string[]; neverBadgeTypes: string[] };
}

type Row = Pick<
  QatarHistoryRow,
  | "flight_number"
  | "departure_airport"
  | "arrival_airport"
  | "departure_time"
  | "service_date"
  | "equipment_code"
  | "flight_status"
>;

export function backtestQatarHistory(
  rows: readonly Row[],
  opts: { lead: number; flownOnly?: boolean }
): BacktestResult {
  const byFlight = new Map<string, Row[]>();
  for (const r of rows) {
    if ((r.flight_status ?? "").toUpperCase() === "CANCELLED") continue;
    const list = byFlight.get(r.flight_number) ?? [];
    list.push(r);
    byFlight.set(r.flight_number, list);
  }

  let scored = 0;
  let badged = 0;
  let badgedYes = 0;
  let brierSum = 0;
  let brierN = 0;
  let rollingTargets = 0;
  let ex789Badged = 0;
  let ex789Yes = 0;
  const mixedOver7pct = new Set<string>();
  const neverBadgeTypes = new Set<string>();

  for (const [fn, legs] of byFlight) {
    const chains = qatarOperatingDays(legs);
    const nonYesShare = chains.filter((c) => c.klass !== "yes").length / chains.length;
    const flewNever = legs.some((l) =>
      NEVER_BADGE_CODES.has((l.equipment_code ?? "").toUpperCase())
    );
    for (const target of chains) {
      if (opts.flownOnly && !target.flown) continue;
      const d = target.serviceDate;
      const today = addDaysISO(d, -opts.lead);
      const since = addDaysISO(today, -QATAR_HISTORY_WINDOW_DAYS);
      const until = addDaysISO(today, PUBLISHED_DAYS);
      const prior = legs.filter(
        (l) => l.service_date >= since && l.service_date <= until && l.service_date < d
      );
      const stats = qatarHistoryStats(prior, d, today);
      if (stats.nDays === 0) continue;
      scored++;
      const yes = target.klass === "yes";
      if (target.klass === "rolling") rollingTargets++;
      const point = (stats.yesDays + 1) / (stats.nDays + 2);
      brierSum += (point - (yes ? 1 : 0)) ** 2;
      brierN++;
      const isBadged =
        stats.probability !== null && stats.probability >= BADGE_THRESHOLD && stats.grade !== "low";
      if (!isBadged) continue;
      badged++;
      if (yes) badgedYes++;
      if (target.klass !== "rolling") {
        ex789Badged++;
        if (yes) ex789Yes++;
      }
      if (nonYesShare > 0.07) mixedOver7pct.add(fn);
      if (flewNever) neverBadgeTypes.add(fn);
    }
  }

  return {
    scored,
    badged,
    badgedYes,
    precision: badged ? badgedYes / badged : null,
    badgeShare: scored ? badged / scored : 0,
    brier: brierN ? brierSum / brierN : null,
    excluding789: {
      badged: ex789Badged,
      badgedYes: ex789Yes,
      precision: ex789Badged ? ex789Yes / ex789Badged : null,
    },
    rollingTargets,
    gateViolations: { mixedOver7pct: [...mixedOver7pct], neverBadgeTypes: [...neverBadgeTypes] },
  };
}

export interface SwapBucket {
  observed: number;
  classChanging: number;
  b788to789: number;
}

/** Class-changing equipment swaps by first-sighting lead time (days). */
export function qatarSwapStudy(
  rows: ReadonlyArray<
    Pick<QatarHistoryRow, "first_equipment_code" | "equipment_code" | "first_seen_lead_sec">
  >
): Record<"0-1" | "2-3" | "4-6", SwapBucket> {
  const out = {
    "0-1": { observed: 0, classChanging: 0, b788to789: 0 },
    "2-3": { observed: 0, classChanging: 0, b788to789: 0 },
    "4-6": { observed: 0, classChanging: 0, b788to789: 0 },
  };
  for (const r of rows) {
    const days = r.first_seen_lead_sec / 86400;
    if (days < 0) continue;
    const bucket = days < 2 ? out["0-1"] : days < 4 ? out["2-3"] : out["4-6"];
    bucket.observed++;
    if (qatarEquipmentClass(r.first_equipment_code) !== qatarEquipmentClass(r.equipment_code)) {
      bucket.classChanging++;
    }
    if (r.first_equipment_code === "788" && r.equipment_code === "789") bucket.b788to789++;
  }
  return out;
}

if (import.meta.main) {
  const arg = (name: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? null;
  const path = arg("db") ?? process.env.DB_PATH ?? "plane-data.sqlite";
  const lead = Number(arg("lead") ?? 8);
  const db = new Database(path, { readonly: true });
  const rows = db
    .query("SELECT * FROM qatar_equipment_history WHERE stale_at IS NULL")
    .all() as QatarHistoryRow[];
  const result = backtestQatarHistory(rows, {
    lead,
    flownOnly: process.argv.includes("--flown-only"),
  });
  const flown = rows.filter((r) => FLOWN.has((r.flight_status ?? "").toUpperCase()));
  console.log(
    JSON.stringify(
      { db: path, lead, rows: rows.length, ...result, swaps: qatarSwapStudy(flown) },
      null,
      2
    )
  );
  db.close();
}
