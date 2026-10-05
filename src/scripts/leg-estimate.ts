/**
 * The per-leg Starlink estimate: a recency-weighted rate over one leg's draws,
 * smoothed toward the share of the aircraft types it drew. Pure, so the
 * backtest and the tests price exactly what the board, scoped check-flight,
 * the planner and MCP serve (they all reach it through predictLeg).
 */

const DAY = 86400;

/** One departure on a leg: a logged assignment, or an ADS-B sighting matched
 * to the leg's time of day. `equipped` is the tail's status now. */
export interface LegDraw {
  t: number;
  tail: string;
  equipped: boolean;
  family: string;
  type: string;
  source: "log" | "adsb";
}

export interface LegWeighting {
  /** Exponential decay by draw age; null weights every draw in the window equally. */
  halfLifeDays: number | null;
  /** Pseudo-draws of the type-share prior. */
  priorStrength: number;
  /** Draws older than this are dropped. */
  windowDays: number;
}

/**
 * Chosen by `starlink-predictor --leg-backtest` (every ADS-B draw in a
 * held-out fortnight, priced from the leg's draws before its day): 7d beat
 * 10/14/21d, the previous 30d, an equal-weight 60d window and a last-14d rate
 * on Brier and log-loss in each fortnight to Oct 5 2026 (10d tied it on the
 * final week). A route's mix moves in weeks when it changes metal (UA2278
 * SFO-ORD: 757s out, A321neos in), and 30d read the old mix for a month.
 * α 5-8 scored slightly better still; left at 3 pending its own sweep.
 */
export const LEG_WEIGHTING: LegWeighting = { halfLifeDays: 7, priorStrength: 3, windowDays: 90 };

/** Below this many draws on the leg, its odds are the share of its aircraft types. */
export const LEG_MIN_DRAWS = 3;

export interface LegEstimate {
  /** Null when there are too few draws and no known type to fall back on. */
  probability: number | null;
  /** The leg's own draws carry the number (else it is the type share). */
  enough: boolean;
  /** Kish effective sample size of the weighted draws: what "N flights" means. */
  effective: number;
  /** Draws inside the window. */
  count: number;
}

export function drawWeight(ageSec: number, w: LegWeighting): number {
  if (w.halfLifeDays === null) return 1;
  return 0.5 ** (Math.max(0, ageSec) / DAY / w.halfLifeDays);
}

export function legEstimate(
  draws: readonly LegDraw[],
  familyShare: (family: string) => number | undefined,
  nowSec: number,
  w: LegWeighting = LEG_WEIGHTING
): LegEstimate {
  const since = nowSec - w.windowDays * DAY;
  let s = 0;
  let n = 0;
  let n2 = 0;
  let mixWeight = 0;
  let mixShare = 0;
  let count = 0;
  for (const d of draws) {
    if (d.t < since || d.t > nowSec) continue;
    count++;
    const wt = drawWeight(nowSec - d.t, w);
    s += d.equipped ? wt : 0;
    n += wt;
    n2 += wt * wt;
    const share = familyShare(d.family);
    if (share !== undefined) {
      mixWeight += wt;
      mixShare += wt * share;
    }
  }
  const prior = mixWeight > 0 ? mixShare / mixWeight : null;
  const enough = count >= LEG_MIN_DRAWS;
  const effective = n2 > 0 ? (n * n) / n2 : 0;
  if (!enough) return { probability: prior, enough, effective, count };
  const a = w.priorStrength;
  return { probability: (s + a * (prior ?? s / n)) / (n + a), enough, effective, count };
}

/** The recent rate against the window's, compared only past these sizes. */
export const TREND_RECENT_DAYS = 14;
export const TREND_MIN_POINTS = 0.15;
const TREND_MIN_RECENT = 6;
const TREND_MIN_OLDER = 6;

export type LegTrend = "up" | "down" | null;

/**
 * "up"/"down" when the last two weeks' Starlink rate is 15+ points off the
 * whole window's, both counted plainly, with enough draws on each side for
 * the gap not to be noise.
 */
export function legTrend(
  draws: readonly LegDraw[],
  nowSec: number,
  w: LegWeighting = LEG_WEIGHTING
): LegTrend {
  const since = nowSec - w.windowDays * DAY;
  const recentSince = nowSec - TREND_RECENT_DAYS * DAY;
  const all = draws.filter((d) => d.t >= since && d.t <= nowSec);
  const recent = all.filter((d) => d.t > recentSince);
  if (recent.length < TREND_MIN_RECENT || all.length - recent.length < TREND_MIN_OLDER) return null;
  const rate = (xs: readonly LegDraw[]) => xs.filter((d) => d.equipped).length / xs.length;
  const gap = rate(recent) - rate(all);
  if (Math.abs(gap) < TREND_MIN_POINTS) return null;
  return gap > 0 ? "up" : "down";
}
