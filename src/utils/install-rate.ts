/**
 * Install Rate Index math — pure and clock-injected so the page's claims are
 * unit-testable. Input is the organic DAILY install series (self-labelling bulk
 * writers already excluded upstream by INSTALL_FILTER); output is the pace and
 * the per-target projection with an honest-abstention verdict when the series
 * is too thin to extrapolate.
 */

import type { RolloutTargetDef } from "../airlines/targets";

export interface DailyInstalls {
  /** YYYY-MM-DD */
  day: string;
  installs: number;
}

export interface MonthlyInstalls {
  /** YYYY-MM */
  month: string;
  installs: number;
}

export type TargetVerdict = "reached" | "on_track" | "behind" | "no_data";

export interface TargetProjection {
  target: RolloutTargetDef;
  /** Absolute count the target resolves to. */
  targetCount: number;
  /** True when targetCount is this tracker's arithmetic (a share of the tracked
   * roster) rather than a figure the airline stated. The page must not
   * attribute a derived count to the cited press release. */
  derived: boolean;
  /** Roster the fraction was taken of; null for a stated absolute count. */
  derivedFrom: number | null;
  remaining: number;
  verdict: TargetVerdict;
  /** YYYY-MM straight-line arrival month; null when the pace can't honestly
   * be extrapolated (verdict no_data, or beyond the 4-year noise horizon). */
  projectedMonth: string | null;
}

export interface InstallRateStats {
  equipped: number;
  total: number;
  /** Zero-filled from the first organic month through the current month. */
  months: MonthlyInstalls[];
  /** Average installs/month over the last complete months (up to PACE_WINDOW);
   * null when fewer than MIN_COMPLETE_MONTHS complete months exist. */
  paceMonthly: number | null;
  projections: TargetProjection[];
  /** Same-day mass writes dropped before charting and pacing — surfaced so the
   * page can say it excluded them instead of silently disagreeing with itself. */
  excludedDays: DailyInstalls[];
}

/** Complete months averaged for the current pace. */
const PACE_WINDOW = 3;
/** Below this much history a pace is an anecdote, not a rate. */
const MIN_COMPLETE_MONTHS = 2;
/** A straight line further out than this is noise, not a projection. */
const MAX_PROJECTION_MONTHS = 48;

/**
 * A single calendar day can hold at most this many organic installs before we
 * treat it as an import rather than a rollout. Absolute floor AND a multiple of
 * the busiest ordinary day, so the rule scales with the programme instead of
 * flagging a genuinely busy week once installs accelerate.
 *
 * Calibrated on the real UA series (207 organic days): the day-count histogram
 * runs 1,2,3…13,16 and then jumps straight to 121 — a Google-Sheets tab import
 * (sheet_gid '13', 2025-12-03) that INSTALL_FILTER cannot see because a numeric
 * tab id doesn't look like a seed. 16 stays; 121 goes.
 */
const MASS_DAY_MIN = 20;
const MASS_DAY_MULTIPLE = 4;
/** Percentile of the other days the multiple is taken of — the busy end of
 * normal, not the median, so a lumpy-but-real day is never mistaken for one. */
const MASS_DAY_PERCENTILE = 0.9;

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Percentile of `sorted` with the element at `removeAt` taken out. Excluding
 * the day under test matters most at tiny series sizes: a tenant whose entire
 * organic history is one 90-tail import would otherwise set its own threshold
 * and pass. */
function percentileExcluding(sorted: number[], removeAt: number, p: number): number {
  const n = sorted.length - 1;
  if (n <= 0) return 0;
  const i = Math.min(n - 1, Math.floor(p * (n - 1)));
  return i < removeAt ? sorted[i] : sorted[i + 1];
}

/**
 * Split the daily series into real installs and same-day mass writes.
 *
 * This is the honesty guard behind the page's own footnote: INSTALL_FILTER only
 * excludes bulk writers that name themselves (`*_seed`, `type_deterministic`,
 * `flyertalk_*`). A sheet-tab import carries an ordinary gid, so the only
 * evidence it leaves is its shape — one day holding more installs than the
 * programme could physically perform.
 */
export function excludeMassWriteDays(daily: DailyInstalls[]): {
  kept: DailyInstalls[];
  excluded: DailyInstalls[];
} {
  if (daily.length === 0) return { kept: [], excluded: [] };
  const sorted = daily.map((d) => d.installs).sort((a, b) => a - b);
  const firstIndex = new Map<number, number>();
  sorted.forEach((v, i) => {
    if (!firstIndex.has(v)) firstIndex.set(v, i);
  });

  const kept: DailyInstalls[] = [];
  const excluded: DailyInstalls[] = [];
  for (const d of daily) {
    const busyNormal = percentileExcluding(
      sorted,
      firstIndex.get(d.installs) as number,
      MASS_DAY_PERCENTILE
    );
    const threshold = Math.max(MASS_DAY_MIN, MASS_DAY_MULTIPLE * busyNormal);
    if (d.installs >= threshold) excluded.push(d);
    else kept.push(d);
  }
  return { kept, excluded };
}

/** Roll a daily series up to calendar months. */
export function monthsFromDays(daily: DailyInstalls[]): MonthlyInstalls[] {
  const byMonth = new Map<string, number>();
  for (const d of daily) {
    const m = d.day.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + d.installs);
  }
  return [...byMonth.entries()]
    .map(([month, installs]) => ({ month, installs }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Fill gaps so zero-install months are visible instead of silently skipped. */
export function zeroFillMonths(monthly: MonthlyInstalls[], nowMs: number): MonthlyInstalls[] {
  if (monthly.length === 0) return [];
  const byMonth = new Map(monthly.map((m) => [m.month, m.installs]));
  const first = [...byMonth.keys()].sort()[0];
  const out: MonthlyInstalls[] = [];
  const last = monthOf(nowMs);
  for (let m = first; m <= last; m = addMonths(m, 1)) {
    out.push({ month: m, installs: byMonth.get(m) ?? 0 });
    if (out.length > 600) break; // corrupt input guard, not a real limit
  }
  return out;
}

export function computeInstallRate(opts: {
  daily: DailyInstalls[];
  equipped: number;
  total: number;
  targets: RolloutTargetDef[];
  /** Roster each target's fraction is taken of, keyed by target label. Falls
   * back to `total` — a target that spans several tenants (AS+HA) resolves
   * against their summed rosters, never one tenant's. */
  fractionBase?: (target: RolloutTargetDef) => number;
  nowMs: number;
}): InstallRateStats {
  const { equipped, total, targets, nowMs } = opts;
  const { kept, excluded } = excludeMassWriteDays(opts.daily);
  const months = zeroFillMonths(monthsFromDays(kept), nowMs);

  const currentMonth = monthOf(nowMs);
  const complete = months.filter((m) => m.month < currentMonth);
  const window = complete.slice(-PACE_WINDOW);
  const paceMonthly =
    complete.length >= MIN_COMPLETE_MONTHS
      ? Math.round((window.reduce((s, m) => s + m.installs, 0) / window.length) * 10) / 10
      : null;

  const projections: TargetProjection[] = targets.map((target) => {
    const base = opts.fractionBase?.(target) ?? total;
    const derived = target.count === undefined;
    const targetCount =
      target.count ?? Math.ceil((target.fractionOfTracked ?? 1) * Math.max(base, 0));
    const derivedFrom = derived ? base : null;
    const remaining = Math.max(0, targetCount - equipped);
    const common = { target, targetCount, derived, derivedFrom, remaining };
    if (remaining === 0) {
      return { ...common, verdict: "reached", projectedMonth: null };
    }
    // Honest abstention: no rate below half an aircraft a month, or with under
    // two complete months of organic history.
    if (paceMonthly === null || paceMonthly < 0.5) {
      return { ...common, verdict: "no_data", projectedMonth: null };
    }
    const monthsLeft = remaining / paceMonthly;
    if (monthsLeft > MAX_PROJECTION_MONTHS) {
      return { ...common, verdict: "behind", projectedMonth: null };
    }
    const projectedMonth = addMonths(currentMonth, Math.ceil(monthsLeft));
    const verdict: TargetVerdict =
      projectedMonth <= target.deadline.slice(0, 7) ? "on_track" : "behind";
    return { ...common, verdict, projectedMonth };
  });

  return { equipped, total, months, paceMonthly, projections, excludedDays: excluded };
}

/**
 * Does this tenant have enough observed history for an Install Rate Index?
 *
 * The page's title asks "will they hit the target"; without any dated organic
 * install month there is no pace to answer with, and the body degrades to a
 * stat line plus "too early to call" — a soft 404. Sitemap, llms.txt and the
 * handler all consult this, so an advertised URL always serves.
 */
export function hasInstallRateContent(stats: InstallRateStats): boolean {
  return stats.months.length > 0;
}
