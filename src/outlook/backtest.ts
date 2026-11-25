/**
 * Replays the outlook on past days: at each cutoff, project from the installs
 * dated on or before it, then compare with the installs that followed. Pure;
 * `bun run outlook-backtest` feeds it from a database or the public tail CSV.
 *
 * What a cutoff can and cannot see: installs are the listing dates of tails
 * equipped today, and totals are today's roster. A tail listed then and
 * removed since, or a roster that grew, is invisible to the replay. Both are
 * small for UA (a few tails), and the report says so.
 */

import { DAY_SEC } from "../database/sql/windows";
import { FLEET, MONTH_DAYS, type PaceWindowDays, projectionRate } from "./pace";

export interface DatedInstall {
  family: string;
  installedAt: number;
}

export interface BacktestCase {
  family: string;
  cutoff: number;
  horizonDays: number;
  windowDays: PaceWindowDays;
  equippedAtCutoff: number;
  /** null when the window had too few installs to give a rate. */
  projected: number | null;
  actual: number;
}

export interface BacktestSummary {
  family: string;
  horizonDays: number;
  windowDays: PaceWindowDays;
  /** Cases with a rate. */
  cases: number;
  /** Cases the window was too thin for. */
  noPace: number;
  /** Median |projected − actual|, in tails. */
  medianAbsError: number | null;
  /** Median |projected − actual| / max(actual, 1). */
  medianRelError: number | null;
  /** Σ|projected − actual| / Σ actual: the error per install that happened. */
  wape: number | null;
  /** Mean projected − actual: > 0 means the method runs ahead of reality. */
  bias: number | null;
  /** Share of cases where actual fell inside projected × (1 ± band). */
  bandHits: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Every `stepDays` from `from` while cutoff + horizon <= now. */
export function cutoffs(from: number, now: number, horizonDays: number, stepDays = 15): number[] {
  const out: number[] = [];
  for (let t = from; t + horizonDays * DAY_SEC <= now; t += stepDays * DAY_SEC) out.push(t);
  return out;
}

export function backtestCases(opts: {
  installs: readonly DatedInstall[];
  /** Today's programme total per family; FLEET for the whole airline. */
  totals: ReadonlyMap<string, number>;
  cutoffs: readonly number[];
  horizonDays: number;
  windowDays: PaceWindowDays;
}): BacktestCase[] {
  const byFamily = new Map<string, number[]>();
  for (const i of opts.installs) {
    for (const key of [i.family, FLEET]) {
      const list = byFamily.get(key) ?? [];
      list.push(i.installedAt);
      byFamily.set(key, list);
    }
  }
  const out: BacktestCase[] = [];
  for (const [family, total] of opts.totals) {
    const dates = byFamily.get(family) ?? [];
    for (const cutoff of opts.cutoffs) {
      const end = cutoff + opts.horizonDays * DAY_SEC;
      const before = dates.filter((t) => t <= cutoff);
      const equippedAtCutoff = before.length;
      const remaining = Math.max(0, total - equippedAtCutoff);
      if (remaining === 0) continue;
      const rate = projectionRate(before, cutoff, opts.windowDays);
      out.push({
        family,
        cutoff,
        horizonDays: opts.horizonDays,
        windowDays: opts.windowDays,
        equippedAtCutoff,
        projected:
          rate === null ? null : Math.min(remaining, (rate * opts.horizonDays) / MONTH_DAYS),
        actual: dates.filter((t) => t > cutoff && t <= end).length,
      });
    }
  }
  return out;
}

export function summarize(cases: readonly BacktestCase[], band: number): BacktestSummary[] {
  const groups = new Map<string, BacktestCase[]>();
  for (const c of cases) {
    const key = `${c.family}|${c.horizonDays}|${c.windowDays}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()].map((g) => {
    const rated = g.filter((c): c is BacktestCase & { projected: number } => c.projected !== null);
    const abs = rated.map((c) => Math.abs(c.projected - c.actual));
    const rel = rated.map((c) => Math.abs(c.projected - c.actual) / Math.max(c.actual, 1));
    const hits = rated.filter(
      (c) => c.actual >= c.projected * (1 - band) && c.actual <= c.projected * (1 + band)
    ).length;
    return {
      family: g[0].family,
      horizonDays: g[0].horizonDays,
      windowDays: g[0].windowDays,
      cases: rated.length,
      noPace: g.length - rated.length,
      medianAbsError: median(abs),
      medianRelError: median(rel),
      wape: rated.length
        ? abs.reduce((a, b) => a + b, 0) /
          Math.max(
            1,
            rated.reduce((a, c) => a + c.actual, 0)
          )
        : null,
      bias: rated.length
        ? rated.reduce((s, c) => s + (c.projected - c.actual), 0) / rated.length
        : null,
      bandHits: rated.length ? hits / rated.length : null,
    };
  });
}

/**
 * A route's Starlink share is its type mix times each type's equipped share.
 * Replayed with today's mix held fixed: the error this measures is the type
 * projection's error as a route rider feels it, not a change of aircraft on
 * the route (the 90-day flight draws in production are the check for that).
 */
export function backtestMixShare(opts: {
  mix: ReadonlyArray<{ family: string; weight: number }>;
  installs: readonly DatedInstall[];
  totals: ReadonlyMap<string, number>;
  cutoff: number;
  horizonDays: number;
  windowDays: PaceWindowDays;
}): { atCutoff: number; projected: number; actual: number } {
  const end = opts.cutoff + opts.horizonDays * DAY_SEC;
  let atCutoff = 0;
  let projected = 0;
  let actual = 0;
  const weightSum = opts.mix.reduce((s, m) => s + m.weight, 0) || 1;
  for (const { family, weight } of opts.mix) {
    const total = opts.totals.get(family) ?? 0;
    if (total === 0) continue;
    const dates = opts.installs.filter((i) => i.family === family).map((i) => i.installedAt);
    const before = dates.filter((t) => t <= opts.cutoff);
    const after = dates.filter((t) => t <= end).length;
    const w = weight / weightSum;
    atCutoff += (w * before.length) / total;
    actual += (w * after) / total;
    const remaining = Math.max(0, total - before.length);
    const rate = projectionRate(before, opts.cutoff, opts.windowDays);
    // A type with no rate projects no change, which is what the page would say.
    const gain =
      remaining === 0 ? 0 : Math.min(remaining, ((rate ?? 0) * opts.horizonDays) / MONTH_DAYS);
    projected += (w * (before.length + gain)) / total;
  }
  return { atCutoff, projected, actual };
}

/**
 * The route check that needs real departures: for each month after the first,
 * take the type mix flown before it began, project each type's equipped share
 * to mid-month from the installs dated before it began, and compare with the
 * share the month's departures actually had. Runs where the 90-day ADS-B draws
 * exist (production), and says nothing where they don't.
 */
export function backtestRouteMonths(opts: {
  departures: ReadonlyArray<{ departedAt: number; family: string; starlink: boolean }>;
  installs: readonly DatedInstall[];
  totals: ReadonlyMap<string, number>;
  months: readonly string[];
  windowDays: PaceWindowDays;
  minDepartures: number;
}): Array<{ month: string; departures: number; projected: number; actual: number }> {
  const out: Array<{ month: string; departures: number; projected: number; actual: number }> = [];
  for (let i = 1; i < opts.months.length; i++) {
    const start = Date.parse(`${opts.months[i]}-01T00:00:00Z`) / 1000;
    const prev = Date.parse(`${opts.months[i - 1]}-01T00:00:00Z`) / 1000;
    const before = opts.departures.filter((d) => d.departedAt >= prev && d.departedAt < start);
    const during = opts.departures.filter(
      (d) => new Date(d.departedAt * 1000).toISOString().slice(0, 7) === opts.months[i]
    );
    if (before.length < opts.minDepartures || during.length < opts.minDepartures) continue;
    const weights = new Map<string, number>();
    for (const d of before) weights.set(d.family, (weights.get(d.family) ?? 0) + 1);
    const { projected } = backtestMixShare({
      mix: [...weights].map(([family, weight]) => ({ family, weight })),
      installs: opts.installs,
      totals: opts.totals,
      cutoff: start,
      horizonDays: 15,
      windowDays: opts.windowDays,
    });
    out.push({
      month: opts.months[i],
      departures: during.length,
      projected,
      actual: during.filter((d) => d.starlink).length / during.length,
    });
  }
  return out;
}
