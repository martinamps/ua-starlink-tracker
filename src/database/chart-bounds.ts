/**
 * The bounds an airline's own chart must sit inside before it is stored, and
 * before it may stand in a headline.
 *
 * The chart is a page we scrape. One bad parse, or one odd edit on the
 * airline's side, would otherwise print a false count as the site's lead
 * figure: a cell reading 930 for 93 once made the title "988 of 1,215", and a
 * chart dated 2099 led with that date. Nothing here knows a count: the chart is
 * held against the calendar and against the fleet list in the database.
 */

import {
  COUNTERS,
  metrics,
  normalizeAirlineTag,
  normalizeChartRejectReason,
} from "../observability";
import { warn } from "../utils/logger";

/** No airline flies a thousand of one type: a longer cell is a misprint. */
export const CHART_MAX_CELL = 999;

/** A chart refreshed monthly that reads a year old carries a misprinted year,
 * not a late refresh: it is refused at the parse. */
export const CHART_MAX_STORE_AGE_DAYS = 366;

/** Three missed monthly refreshes. Past that the chart no longer describes a
 * rollout that moves every week, so it leaves the headline. */
export const CHART_MAX_HEADLINE_AGE_DAYS = 92;

/**
 * How far a type's fleet size on the chart may sit from the fleet list's:
 * 3 aircraft, or 5% of the type where that is more (5 for 93 E175s). On
 * 2026-11-25 the two lists differed by one 787 and agreed exactly on the other
 * seven types, so this leaves room for a month of deliveries and retirements
 * and none for a slipped digit.
 */
export function typeSizeTolerance(listed: number): number {
  return Math.max(3, Math.ceil(listed * 0.05));
}

/**
 * How many listed aircraft may belong to types the chart leaves out: 5, or 5%
 * of the list where that is more. Alaska's chart leaves out the 737-700s (11
 * of 390 that day, under 3%); a chart missing a whole row of a type it should
 * carry (59 737-800s) is a half-read chart with a false total.
 */
export function leftOutTolerance(listed: number): number {
  return Math.max(5, Math.ceil(listed * 0.05));
}

export type ChartRejectReason =
  | "date_invalid"
  | "date_future"
  | "date_old"
  | "count_invalid"
  | "type_size"
  | "types_left_out";

export interface ChartProblem {
  reason: ChartRejectReason;
  detail: string;
}

/** Raised by the parse for a chart that is readable and impossible. */
export class ChartRejected extends Error {
  constructor(readonly problem: ChartProblem) {
    super(`chart rejected (${problem.reason}): ${problem.detail}`);
  }
}

export function utcDay(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** YYYY-MM-DD that names a day on the calendar: "2026-02-31" does not. */
export function isCalendarDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && utcDay(t) === iso;
}

/**
 * A chart date is a real day, not after `today` and not older than
 * `maxAgeDays`. No slack for time zones: the airline's local day is never
 * ahead of the UTC day by more than hours it has not published in yet.
 */
export function chartDateProblem(
  asOf: string,
  today: string,
  maxAgeDays: number
): ChartProblem | null {
  if (!isCalendarDay(asOf)) return { reason: "date_invalid", detail: JSON.stringify(asOf) };
  if (asOf > today) return { reason: "date_future", detail: `${asOf} is after ${today}` };
  const age = Math.round((Date.parse(today) - Date.parse(asOf)) / 86400_000);
  return age > maxAgeDays
    ? { reason: "date_old", detail: `${asOf} is ${age} days before ${today}` }
    : null;
}

export interface ChartTypeSize {
  family: string;
  connected: number;
  total: number;
}

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= CHART_MAX_CELL * 2;

/** Every count is a whole number in range and no type connects more than it has. */
export function chartCountProblem(types: readonly ChartTypeSize[]): ChartProblem | null {
  const bad = types.find(
    (t) => !isCount(t.connected) || !isCount(t.total) || t.connected > t.total
  );
  return bad
    ? { reason: "count_invalid", detail: `${bad.family} ${bad.connected} of ${bad.total}` }
    : null;
}

/**
 * The chart against the fleet list, type by type and in all. A type on the
 * chart must be near the listed size of that type, and the listed aircraft of
 * types the chart leaves out must be few.
 */
export function chartRosterProblem(
  types: readonly ChartTypeSize[],
  listed: ReadonlyMap<string, { total: number }>
): ChartProblem | null {
  for (const t of types) {
    const ours = listed.get(t.family)?.total ?? 0;
    if (Math.abs(t.total - ours) > typeSizeTolerance(ours)) {
      return {
        reason: "type_size",
        detail: `${t.family}: chart ${t.total}, fleet list ${ours}`,
      };
    }
  }
  const charted = new Set(types.map((t) => t.family));
  let all = 0;
  let leftOut = 0;
  for (const [family, o] of listed) {
    all += o.total;
    if (!charted.has(family)) leftOut += o.total;
  }
  return leftOut > leftOutTolerance(all)
    ? {
        reason: "types_left_out",
        detail: `${leftOut} of ${all} listed aircraft are of types off the chart`,
      }
    : null;
}

const HOUR_MS = 3600_000;
const lastReported = new Map<string, number>();

/**
 * Count and log a chart that failed its bounds. The read path runs on every
 * page view, so one failure reports once an hour there, not once a request.
 * "settle" is the daily job declining to name a complete type's tails from a
 * chart refused at "sync": it counts when that chart called any type complete.
 */
export function reportChartRejected(
  airline: string,
  stage: "parse" | "sync" | "settle" | "read",
  problem: ChartProblem,
  now = Date.now()
): void {
  const key = `${airline}:${stage}:${problem.reason}`;
  if (stage === "read" && now - (lastReported.get(key) ?? 0) < HOUR_MS) return;
  lastReported.set(key, now);
  metrics.increment(COUNTERS.CHART_REJECTED, {
    airline: normalizeAirlineTag(airline),
    stage,
    reason: normalizeChartRejectReason(problem.reason),
  });
  warn(`chart bounds: ${airline} chart refused at ${stage} (${problem.reason}): ${problem.detail}`);
}
