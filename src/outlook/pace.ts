/**
 * Install pace and a "when is this type done?" outlook, as pure functions over
 * dated installs. Callers bring the counts: equipped and total from
 * programmeRoster (src/database/roster.ts), install dates from the equipped
 * tails' listing dates. Nothing here reads a clock or a database, so the
 * backtest can replay any past day exactly as the live reader runs today.
 *
 * The error bands are not guesses: OUTLOOK_BACKTEST holds what the backtest in
 * src/outlook/backtest.ts measured on our own install history (method and
 * figures in reports/rollout-outlook.md). Re-run `bun run outlook-backtest`
 * and update it when the history has grown.
 */

import { DAY_SEC } from "../database/sql/windows";

export const MONTH_DAYS = 30.44;

/** The family key of the whole-airline outlook. */
export const FLEET = "ALL";
const MONTH_SEC = MONTH_DAYS * DAY_SEC;

export const PACE_WINDOWS_DAYS = [30, 60, 90] as const;
export type PaceWindowDays = (typeof PACE_WINDOWS_DAYS)[number];

/** The window the projection reads: the backtest's least-error window for the
 * whole airline at every horizon tried, and for types pooled (reports/
 * rollout-outlook.md, "Which window"). Installs come in bursts as a type's
 * line opens, so the latest month says more than the quarter. */
export const PROJECTION_WINDOW_DAYS: PaceWindowDays = 30;

/** Below this many installs in the projection window there is no install line
 * running for the type, and a rate would be one stray listing. */
export const MIN_INSTALLS_FOR_PACE = 6;

/**
 * Measured by the backtest of 2026-11-24 (UA, 723 dated installs, cutoffs
 * every 15 days from 2026-03-01, horizons 30 to 90 days, 30-day window).
 * Error per install = Σ|projected − actual| / Σ actual. Types pooled: 31–37%;
 * the whole airline: 25–34%. That checks how many tails come next, which is
 * what `next60Days` states.
 *
 * A completion date is a different claim, and none has been checked: no type
 * finished inside the dated history after the method could see it, and the
 * ones near the end (A321, CRJ-550) slowed well below their pace for the last
 * tails. `maxStatableMonths` stays 0, so no projected completion date is
 * stated, until a backtest checks one.
 */
export const OUTLOOK_BACKTEST = {
  measuredOn: "2026-11-24",
  relativeError: 0.4,
  fleetRelativeError: 0.35,
  maxStatableMonths: 0,
} as const;

/** The horizon `next60Days` states, inside the backtest's checked span. */
export const NEXT_DAYS = 60;

export interface PaceWindow {
  days: PaceWindowDays;
  installs: number;
  /** Installs per 30.44 days over the window. */
  perMonth: number;
}

/** Installs dated in each trailing window ending at `now` (unix seconds). */
export function paceWindows(installedAt: readonly number[], now: number): PaceWindow[] {
  return PACE_WINDOWS_DAYS.map((days) => {
    const from = now - days * DAY_SEC;
    const installs = installedAt.filter((t) => t > from && t <= now).length;
    return { days, installs, perMonth: installs / (days / MONTH_DAYS) };
  });
}

export type PaceTrend = "speeding_up" | "steady" | "slowing" | "none";

/**
 * The last 30 days against the 90-day rate. Within ±35% is "steady": the
 * month-to-month noise of a type's installs (reports/rollout-outlook.md) is
 * about that wide, so a smaller move is not a change of pace.
 */
export function paceTrend(windows: readonly PaceWindow[]): PaceTrend {
  const w30 = windows.find((w) => w.days === 30);
  const w90 = windows.find((w) => w.days === 90);
  if (!w30 || !w90 || w90.installs < MIN_INSTALLS_FOR_PACE) return "none";
  const ratio = w30.perMonth / w90.perMonth;
  if (ratio > 1.35) return "speeding_up";
  if (ratio < 0.65) return "slowing";
  return "steady";
}

/** A date the airline itself published, carried beside our projection. */
export interface PublishedTarget {
  label: string;
  /** YYYY-MM-DD, end of the stated period. */
  deadline: string;
  /** The airline's own aircraft count, when the statement gives one; else the
   * target is every tail of the scope. */
  count?: number;
  statedOn: string;
  /** The statement as a clause after "{Airline}'s target is": "every aircraft by the
   * end of 2027". Absent where the deadline has no plain reading, and then no
   * page sentence is built on it. */
  says?: string;
  source: { title: string; url: string };
}

export interface PublishedTargetPace extends PublishedTarget {
  /** Installs a month still needed to meet it, from `now`; null once the
   * deadline has passed. Arithmetic, not a forecast. */
  requiredPerMonth: number | null;
  /** Observed rate (projection window) at or above the required one; null
   * when there is no rate or no time left. */
  onPace: boolean | null;
}

/**
 * "starting": installs are running (enough in the projection window) but the
 * line opened inside the last 90 days. The backtest's worst misses were these:
 * the 737 MAX 9 went 10, then 29, then 21 a month, so its first months
 * projected 20 where 50 came, and 29 where 21 came.
 */
export type TypeOutlookStatus = "complete" | "projected" | "starting" | "no_pace";

/** A line counts as running, not starting, with this many installs in 90 days. */
export const MIN_INSTALLS_RUNNING = 3 * MIN_INSTALLS_FOR_PACE;

export interface CompletionRange {
  /** YYYY-MM-DD at the window's rate. */
  likely: string;
  /** The rate's measured error either side: 1 ± relativeError. */
  earliest: string;
  /** null when the slow end of the band has no finite date. */
  latest: string | null;
  months: number;
}

export interface TypeOutlook {
  family: string;
  equipped: number;
  total: number;
  remaining: number;
  /** equipped / total, 0 when total is 0. */
  share: number;
  /** Equipped tails with no install date: counted, but not in the pace. */
  undated: number;
  /** Earliest dated install (unix seconds); null when none is dated. */
  firstInstalledAt: number | null;
  pace: PaceWindow[];
  trend: PaceTrend;
  status: TypeOutlookStatus;
  /** Present when status is "projected". */
  projection: CompletionRange | null;
  /** Installs expected over the next NEXT_DAYS at the window's rate, ±
   * the measured error, capped at what remains. Present when "projected". */
  next60Days: { low: number; likely: number; high: number } | null;
  /** True only where the backtest says a completion date at this horizon has
   * held. False everywhere while OUTLOOK_BACKTEST.maxStatableMonths is 0. */
  dateStatable: boolean;
  published: PublishedTargetPace[];
}

export interface TypeOutlookInput {
  family: string;
  equipped: number;
  total: number;
  /** Install time (unix seconds) of each equipped tail; null when undated. */
  installedAt: readonly (number | null)[];
  now: number;
  published?: readonly PublishedTarget[];
  relativeError?: number;
}

function isoDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/** Installs per month at `windowDays`, or null when the window is too thin or
 * the line is still starting. */
export function projectionRate(
  installedAt: readonly number[],
  now: number,
  windowDays: PaceWindowDays = PROJECTION_WINDOW_DAYS
): number | null {
  const windows = paceWindows(installedAt, now);
  const w = windows.find((p) => p.days === windowDays)!;
  const quarter = windows.find((p) => p.days === 90)!;
  if (w.installs < MIN_INSTALLS_FOR_PACE || quarter.installs < MIN_INSTALLS_RUNNING) return null;
  return w.perMonth;
}

function lineStarting(installedAt: readonly number[], now: number): boolean {
  const w = paceWindows(installedAt, now).find((p) => p.days === PROJECTION_WINDOW_DAYS)!;
  return w.installs >= MIN_INSTALLS_FOR_PACE;
}

export function typeOutlook(input: TypeOutlookInput): TypeOutlook {
  const { family, equipped, total, now } = input;
  const relErr = input.relativeError ?? OUTLOOK_BACKTEST.relativeError;
  const dated = input.installedAt.filter((t): t is number => t !== null);
  const remaining = Math.max(0, total - equipped);
  const pace = paceWindows(dated, now);
  const rate = projectionRate(dated, now);

  let status: TypeOutlookStatus;
  let projection: CompletionRange | null = null;
  if (total > 0 && remaining === 0) status = "complete";
  else if (rate === null) status = lineStarting(dated, now) ? "starting" : "no_pace";
  else {
    status = "projected";
    const months = remaining / rate;
    const at = (m: number) => isoDate(Math.round(now + m * MONTH_SEC));
    projection = {
      months,
      likely: at(months),
      earliest: at(remaining / (rate * (1 + relErr))),
      latest: relErr < 1 ? at(remaining / (rate * (1 - relErr))) : null,
    };
  }

  return {
    family,
    equipped,
    total,
    remaining,
    share: total > 0 ? equipped / total : 0,
    undated: input.installedAt.length - dated.length,
    firstInstalledAt: dated.length > 0 ? dated.reduce((a, b) => Math.min(a, b)) : null,
    pace,
    trend: paceTrend(pace),
    status,
    projection,
    next60Days:
      rate === null || status !== "projected"
        ? null
        : (() => {
            const likely = (rate * NEXT_DAYS) / MONTH_DAYS;
            const cap = (x: number) => Math.min(remaining, Math.round(x));
            return {
              low: cap(likely * (1 - relErr)),
              likely: cap(likely),
              high: cap(likely * (1 + relErr)),
            };
          })(),
    dateStatable:
      projection !== null &&
      projection.latest !== null &&
      projection.months <= OUTLOOK_BACKTEST.maxStatableMonths,
    published: (input.published ?? []).map((t) => {
      const monthsLeft = (Date.parse(`${t.deadline}T23:59:59Z`) / 1000 - now) / MONTH_SEC;
      const needed = Math.max(0, (t.count ?? total) - equipped);
      const requiredPerMonth = monthsLeft > 0 ? needed / monthsLeft : null;
      return {
        ...t,
        requiredPerMonth,
        onPace: requiredPerMonth === null || rate === null ? null : rate >= requiredPerMonth,
      };
    }),
  };
}
