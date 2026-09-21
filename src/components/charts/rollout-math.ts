/**
 * The pure half of the rollout charts: the cumulative series, required paces,
 * the pace window's wording, and the scales CumulativeInstallsChart draws on.
 * No JSX, so tests and copy can use the same numbers the chart plots.
 */
import { type TimelineMilestone, formatFactDate } from "../../airlines/rollout-facts";
import type { InstallRateStats, TargetProjection } from "../../utils/install-rate";
import { fmt, monthYear } from "../ui/format";

const DAY_MS = 86_400_000;
const MONTH_MS = 30.4375 * DAY_MS;

/** Noon UTC of an ISO day; a month-precision date lands mid-month. */
export function isoMs(iso: string): number {
  const day = iso.length === 7 ? `${iso}-15` : iso.slice(0, 10);
  return Date.parse(`${day}T12:00:00Z`);
}

function monthStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** Installs a month needed from now to meet a target on its deadline; null
 * once it is met, past due, or the inputs disagree. */
export function requiredMonthlyPace(p: TargetProjection, nowMs: number): number | null {
  if (p.verdict === "reached" || p.rosterDisagrees || p.remaining <= 0) return null;
  const months = (isoMs(p.target.deadline) - nowMs) / MONTH_MS;
  if (months <= 0) return null;
  return p.remaining / months;
}

/** The nearest open target with its required pace — what a headline compares
 * the observed pace against. */
export function nearestPaceGap(
  stats: InstallRateStats
): { target: TargetProjection; needed: number; actual: number } | null {
  if (stats.paceMonthly === null) return null;
  for (const p of [...stats.projections].sort((a, b) =>
    a.target.deadline.localeCompare(b.target.deadline)
  )) {
    const needed = requiredMonthlyPace(p, stats.asOfMs);
    if (needed !== null) return { target: p, needed, actual: stats.paceMonthly };
  }
  return null;
}

/** "Jun–Aug 2026": the full months paceMonthly was averaged over; "" when none. */
export function paceWindowSpan(stats: InstallRateStats): string {
  const n = stats.paceWindowMonths;
  const current = monthKey(stats.asOfMs);
  const window = stats.months.filter((m) => m.month < current).slice(-n);
  if (n === 0 || window.length === 0) return "";
  const short = (m: string) =>
    new Date(isoMs(`${m}-15`)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const first = window[0].month;
  const last = window[window.length - 1].month;
  return first === last
    ? monthYear(last)
    : first.slice(0, 4) === last.slice(0, 4)
      ? `${short(first)}–${short(last)} ${last.slice(0, 4)}`
      : `${monthYear(first)}–${monthYear(last)}`;
}

/** "the last three full months (Jun–Aug 2026)" — the window paceMonthly was
 * actually averaged over, measured rather than assumed. */
export function paceWindowText(stats: InstallRateStats): string {
  const span = paceWindowSpan(stats);
  if (!span) return "";
  const n = stats.paceWindowMonths;
  const word = ["zero", "one", "two", "three", "four", "five", "six"][n] ?? String(n);
  return n === 1 ? `the last full month (${span})` : `the last ${word} full months (${span})`;
}

export type Point = [ms: number, value: number];

export interface Series {
  start: number;
  actual: Point[][];
  imports: Array<{ ms: number; from: number; to: number; installs: number }>;
  now: Point;
}

/**
 * Running total by install day. Aircraft already equipped before the first
 * dated install (seed rows) form the starting level, so the line ends on the
 * live equipped count. An import day is a jump in the total but not a rate, so
 * it is drawn as its own dashed step instead of as part of the line.
 */
export function cumulativeSeries(stats: InstallRateStats): Series | null {
  const events = [
    ...stats.days.map((d) => ({ ...d, imported: false })),
    ...stats.excludedDays.map((d) => ({ ...d, imported: true })),
  ].sort((a, b) => a.day.localeCompare(b.day));
  if (events.length === 0) return null;
  const dated = events.reduce((s, e) => s + e.installs, 0);
  let value = Math.max(0, stats.equipped - dated);
  const start = monthStartMs(isoMs(events[0].day));
  const actual: Point[][] = [[[start, value]]];
  const imports: Series["imports"] = [];
  for (const e of events) {
    const ms = isoMs(e.day);
    const current = actual[actual.length - 1];
    if (e.imported) {
      current.push([ms, value]);
      imports.push({ ms, from: value, to: value + e.installs, installs: e.installs });
      value += e.installs;
      actual.push([[ms, value]]);
    } else {
      value += e.installs;
      current.push([ms, value]);
    }
  }
  const nowMs = Math.max(stats.asOfMs, isoMs(events[events.length - 1].day));
  actual[actual.length - 1].push([nowMs, value]);
  return { start, actual, imports, now: [nowMs, value] };
}

function niceMax(max: number): number {
  for (const step of [10, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) {
    if ((max * 1.08) / step <= 5) return Math.ceil((max * 1.08) / step) * step;
  }
  return Math.ceil(max * 1.08);
}

function niceStep(yMax: number): number {
  for (const step of [5, 10, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) {
    if (yMax / step <= 5) return step;
  }
  return yMax / 4;
}

export interface ChartTarget {
  p: TargetProjection;
  ms: number;
}

/** Everything the cumulative chart positions: its time and value ranges as
 * percent scales, gridlines, year ticks, targets, milestones and projection. */
export interface ChartModel {
  series: Series;
  pace: number | null;
  targets: ChartTarget[];
  projection: Point[] | null;
  gridValues: number[];
  years: number[];
  halfYears: number[];
  milestones: Array<{ m: TimelineMilestone; ms: number }>;
  xPct: (ms: number) => number;
  yPct: (v: number) => number;
}

export function chartModel(
  stats: InstallRateStats,
  milestones: TimelineMilestone[] = []
): ChartModel | null {
  const series = cumulativeSeries(stats);
  if (!series || stats.months.length < 2) return null;
  const [nowMs, nowValue] = series.now;
  const pace = stats.paceMonthly !== null && stats.paceMonthly >= 0.5 ? stats.paceMonthly : null;

  const targets = stats.rosterDisagrees
    ? []
    : stats.projections
        .filter((p) => !p.rosterDisagrees)
        .map((p) => ({ p, ms: isoMs(p.target.deadline) }))
        .filter((t) => t.ms > series.start);
  const end = Math.max(nowMs + 45 * DAY_MS, ...targets.map((t) => t.ms + 25 * DAY_MS));
  const ceiling = stats.rosterDisagrees ? Number.POSITIVE_INFINITY : stats.total;

  let projection: Point[] | null = null;
  if (pace !== null && nowValue < ceiling) {
    const endValue = nowValue + pace * ((end - nowMs) / MONTH_MS);
    projection =
      endValue <= ceiling
        ? [series.now, [end, endValue]]
        : [series.now, [nowMs + ((ceiling - nowValue) / pace) * MONTH_MS, ceiling]];
  }

  const yMax = niceMax(
    Math.max(nowValue, ...targets.map((t) => t.p.targetCount), projection?.[1][1] ?? 0, 1)
  );
  const step = niceStep(yMax);
  const gridValues: number[] = [];
  for (let v = 0; v <= yMax + 0.001; v += step) gridValues.push(v);

  const years: number[] = [];
  const halfYears: number[] = [];
  for (
    let y = new Date(series.start).getUTCFullYear();
    y <= new Date(end).getUTCFullYear() + 1;
    y++
  ) {
    const jan = Date.UTC(y, 0, 1);
    const jul = Date.UTC(y, 6, 1);
    if (jan > series.start && jan < end) years.push(jan);
    if (jul > series.start && jul < end) halfYears.push(jul);
  }

  return {
    series,
    pace,
    targets,
    projection,
    gridValues,
    years,
    halfYears,
    milestones: milestones
      .map((m) => ({ m, ms: isoMs(m.date) }))
      .filter((x) => x.ms >= series.start && x.ms <= end),
    xPct: (ms) => ((ms - series.start) / (end - series.start)) * 100,
    yPct: (v) => 100 - (v / yMax) * 100,
  };
}

/** The chart's spoken summary: the line, any import, and each target at the current pace. */
export function chartDescription(model: ChartModel, airlineName: string): string {
  const { series, pace, targets } = model;
  const [nowMs, nowValue] = series.now;
  return [
    `${airlineName} aircraft with Starlink since ${monthYear(monthKey(series.start))}: ${fmt(nowValue)} as of ${monthYear(monthKey(nowMs))}.`,
    ...series.imports.map(
      (i) =>
        `${fmt(i.installs)} aircraft were added by a one-day data import on ${formatFactDate(new Date(i.ms).toISOString().slice(0, 10))}.`
    ),
    pace !== null ? `At the current pace of about ${fmt(pace)} a month:` : "",
    ...targets.map(
      ({ p }) =>
        `${fmt(p.targetCount)} targeted by ${formatFactDate(p.target.deadline)}${
          p.verdict === "reached"
            ? ", reached"
            : p.projectedMonth
              ? `, reached around ${monthYear(p.projectedMonth)}`
              : ""
        }.`
    ),
  ]
    .filter(Boolean)
    .join(" ");
}
