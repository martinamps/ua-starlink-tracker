/**
 * How often fleet discovery looks again at a tail it last read as non-Starlink.
 *
 * The old answer was 14 days for every tail. Measured over 30 days (Nov 2026),
 * about a third of those re-checks went to families with no Starlink reading
 * at all (A319, A320, 757, 767, 737-700, CRJ-200, ERJ-145) while the families
 * being retrofitted waited the same two weeks. This spends the same number of
 * checks where an install is likelier.
 *
 * The budget is the invariant: the interval plan and the ground-gap checks
 * together never ask for more checks a day than "every negative tail once per
 * BASELINE_RECHECK_DAYS" did. united.com and FR24 see one request per check, so
 * their rate cannot rise.
 */

export const BASELINE_RECHECK_DAYS = 14;
/** The verifier's own cadence for listed tails; an unlisted one earns no more. */
export const MIN_RECHECK_DAYS = 3;
/** The longest a first install in a quiet family can go unseen by our own checks. */
export const MAX_RECHECK_DAYS = 28;

/**
 * Installs assumed per family before any are seen. Keeps a family with none
 * finite, and stops one lone install from reading as a programme.
 */
const INSTALL_PRIOR = 0.5;

export interface CadenceGroup {
  key: string;
  /** Tails in the group currently settled non-Starlink. */
  tails: number;
  /** Installs found in the group over the trailing window. */
  installs: number;
}

function clampDays(days: number): number {
  return Math.min(MAX_RECHECK_DAYS, Math.max(MIN_RECHECK_DAYS, days));
}

function dailyChecks(groups: readonly CadenceGroup[], days: (g: CadenceGroup) => number): number {
  return groups.reduce((sum, g) => sum + g.tails / days(g), 0);
}

/**
 * Re-check interval, in days, for each group.
 *
 * An install is found on average half an interval late, so total lag is
 * sum(installRate * interval) while the cost is sum(tails / interval).
 * Minimizing the first under a fixed second gives interval ∝ sqrt(tails /
 * installRate): a family twice as likely per tail is checked about 1.4 times as
 * often, not twice, which keeps the quiet families from being starved.
 *
 * The scale is bisected so the clamped plan lands on the budget from below.
 * With one group, or equal rates, every interval is the baseline divided by
 * `budgetShare` (the part of the old budget this plan may spend).
 */
export function solveRecheckDays(
  groups: readonly CadenceGroup[],
  budgetShare = 1
): Map<string, number> {
  const live = groups.filter((g) => g.tails > 0);
  const out = new Map<string, number>();
  if (live.length === 0) return out;

  const shape = new Map(
    live.map((g) => [g.key, Math.sqrt(g.tails / (Math.max(0, g.installs) + INSTALL_PRIOR))])
  );
  const budget = budgetShare * dailyChecks(live, () => BASELINE_RECHECK_DAYS);
  const at = (scale: number) => (g: CadenceGroup) => clampDays(scale * (shape.get(g.key) ?? 1));

  // Spend falls as the scale grows; `hi` always satisfies the budget because
  // every interval at MAX costs half the baseline, under any share this file uses.
  let lo = 1e-6;
  let hi = 1e6;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (dailyChecks(live, at(mid)) <= budget) hi = mid;
    else lo = mid;
  }
  for (const g of live) out.set(g.key, at(hi)(g));
  return out;
}

/** Checks a day the plan asks for; the tests hold it at or under its share of the baseline. */
export function plannedDailyChecks(
  groups: readonly CadenceGroup[],
  plan: ReadonlyMap<string, number>
): number {
  return dailyChecks(
    groups.filter((g) => g.tails > 0),
    (g) => plan.get(g.key) ?? BASELINE_RECHECK_DAYS
  );
}

export function baselineDailyChecks(groups: readonly CadenceGroup[]): number {
  return dailyChecks(
    groups.filter((g) => g.tails > 0),
    () => BASELINE_RECHECK_DAYS
  );
}

// ── Return from a ground gap ────────────────────────────────────────────────

/**
 * A tail the ADS-B sweep has not seen airborne for this long, then sees again,
 * has been somewhere a retrofit could happen.
 */
export const GROUND_GAP_SECS = 36 * 3600;

/**
 * The part of the old budget held back for checking a tail the moment it flies
 * again after a ground gap. The interval plan spends the rest, so the two
 * together stay inside the old budget on every day, not only on average: a
 * pulled-forward check is paid for before it is spent.
 */
export const GAP_BUDGET_SHARE = 0.1;
export const INTERVAL_BUDGET_SHARE = 1 - GAP_BUDGET_SHARE;

/** Ground-gap checks allowed per rolling day for a fleet with this many negative tails. */
export function gapChecksPerDay(negativeTails: number): number {
  return Math.floor((GAP_BUDGET_SHARE * negativeTails) / BASELINE_RECHECK_DAYS);
}

/**
 * Whether enough sweeps ran during a silence to call it the aircraft's and
 * not ours. An aggregator outage or a stopped job makes the whole fleet
 * "return" at once; half the expected sweeps is the floor because any revenue
 * flight spans several of them.
 */
export function sweepsCoverGap(
  sweeps: number,
  gapSecs: number,
  sweepIntervalSecs: number
): boolean {
  return sweeps >= gapSecs / (2 * sweepIntervalSecs);
}
