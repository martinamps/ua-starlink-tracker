/**
 * Install Rate Index math — pure and clock-injected so the page's claims are
 * unit-testable. Input is the organic monthly install series (bulk seeds
 * already excluded upstream by INSTALL_FILTER); output is the pace and the
 * per-target projection with an honest-abstention verdict when the series is
 * too thin to extrapolate.
 */

import type { RolloutTargetDef } from "../airlines/targets";

export interface MonthlyInstalls {
  /** YYYY-MM */
  month: string;
  installs: number;
}

export type TargetVerdict = "reached" | "on_track" | "behind" | "no_data";

export interface TargetProjection {
  target: RolloutTargetDef;
  /** Absolute count the target resolves to against the tracked fleet. */
  targetCount: number;
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
}

/** Complete months averaged for the current pace. */
const PACE_WINDOW = 3;
/** Below this much history a pace is an anecdote, not a rate. */
const MIN_COMPLETE_MONTHS = 2;
/** A straight line further out than this is noise, not a projection. */
const MAX_PROJECTION_MONTHS = 48;

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
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
  monthly: MonthlyInstalls[];
  equipped: number;
  total: number;
  targets: RolloutTargetDef[];
  nowMs: number;
}): InstallRateStats {
  const { equipped, total, targets, nowMs } = opts;
  const months = zeroFillMonths(opts.monthly, nowMs);

  const currentMonth = monthOf(nowMs);
  const complete = months.filter((m) => m.month < currentMonth);
  const window = complete.slice(-PACE_WINDOW);
  const paceMonthly =
    complete.length >= MIN_COMPLETE_MONTHS
      ? Math.round((window.reduce((s, m) => s + m.installs, 0) / window.length) * 10) / 10
      : null;

  const projections: TargetProjection[] = targets.map((target) => {
    const targetCount =
      target.count ?? Math.ceil((target.fractionOfTracked ?? 1) * Math.max(total, 0));
    const remaining = Math.max(0, targetCount - equipped);
    if (remaining === 0) {
      return { target, targetCount, remaining, verdict: "reached", projectedMonth: null };
    }
    // Honest abstention: no rate below half an aircraft a month, or with under
    // two complete months of organic history.
    if (paceMonthly === null || paceMonthly < 0.5) {
      return { target, targetCount, remaining, verdict: "no_data", projectedMonth: null };
    }
    const monthsLeft = remaining / paceMonthly;
    if (monthsLeft > MAX_PROJECTION_MONTHS) {
      return { target, targetCount, remaining, verdict: "behind", projectedMonth: null };
    }
    const projectedMonth = addMonths(currentMonth, Math.ceil(monthsLeft));
    const verdict: TargetVerdict =
      projectedMonth <= target.deadline.slice(0, 7) ? "on_track" : "behind";
    return { target, targetCount, remaining, verdict, projectedMonth };
  });

  return { equipped, total, months, paceMonthly, projections };
}
