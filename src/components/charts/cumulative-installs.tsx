/**
 * Rollout charts shared by /install-rate and /timeline: cumulative equipped
 * aircraft against stated targets, the pace each target needs, and installs
 * per month. Server-rendered HTML + SVG, no client script.
 *
 * The plot SVG stretches to its box (preserveAspectRatio="none") so it fills a
 * phone as well as a desktop column; everything that must stay legible —
 * labels, markers — is HTML positioned by percentage on top of it.
 */
import type React from "react";
import { type TimelineMilestone, formatFactDate } from "../../airlines/rollout-facts";
import type { InstallRateStats, TargetProjection } from "../../utils/install-rate";
import { fmt, monthYear } from "../ui/format";

const DAY_MS = 86_400_000;
const MONTH_MS = 30.4375 * DAY_MS;
const VIEW_W = 1000;
const VIEW_H = 400;

/** Noon UTC of an ISO day; a month-precision date lands mid-month. */
function isoMs(iso: string): number {
  const day = iso.length === 7 ? `${iso}-15` : iso.slice(0, 10);
  return Date.parse(`${day}T12:00:00Z`);
}

function monthStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);

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

/** "the last three full months (Jun–Aug 2026)" — the window paceMonthly was
 * actually averaged over, measured rather than assumed. */
export function paceWindowText(stats: InstallRateStats): string {
  const n = stats.paceWindowMonths;
  const current = monthKey(stats.asOfMs);
  const window = stats.months.filter((m) => m.month < current).slice(-n);
  if (n === 0 || window.length === 0) return "";
  const word = ["zero", "one", "two", "three", "four", "five", "six"][n] ?? String(n);
  const short = (m: string) =>
    new Date(isoMs(`${m}-15`)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const first = window[0].month;
  const last = window[window.length - 1].month;
  const span =
    first === last
      ? monthYear(last)
      : first.slice(0, 4) === last.slice(0, 4)
        ? `${short(first)}–${short(last)} ${last.slice(0, 4)}`
        : `${monthYear(first)}–${monthYear(last)}`;
  return n === 1 ? `the last full month (${span})` : `the last ${word} full months (${span})`;
}

type Point = [ms: number, value: number];

interface Series {
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

const pathOf = (pts: Array<[number, number]>) =>
  pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

export function CumulativeInstallsChart({
  stats,
  accent,
  airlineName,
  milestones = [],
}: {
  stats: InstallRateStats;
  accent: string;
  airlineName: string;
  milestones?: TimelineMilestone[];
}) {
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
    const monthsToEnd = (end - nowMs) / MONTH_MS;
    const endValue = nowValue + pace * monthsToEnd;
    projection =
      endValue <= ceiling
        ? [series.now, [end, endValue]]
        : [series.now, [nowMs + ((ceiling - nowValue) / pace) * MONTH_MS, ceiling]];
  }

  const yMax = niceMax(
    Math.max(nowValue, ...targets.map((t) => t.p.targetCount), projection?.[1][1] ?? 0, 1)
  );
  const step = niceStep(yMax);
  const xPct = (ms: number) => ((ms - series.start) / (end - series.start)) * 100;
  const yPct = (v: number) => 100 - (v / yMax) * 100;
  const svgPt = ([ms, v]: Point): [number, number] => [
    (xPct(ms) / 100) * VIEW_W,
    (yPct(v) / 100) * VIEW_H,
  ];

  const gridValues: number[] = [];
  for (let v = 0; v <= yMax + 0.001; v += step) gridValues.push(v);

  const years: number[] = [];
  const halfYears: number[] = [];
  const firstYear = new Date(series.start).getUTCFullYear();
  const lastYear = new Date(end).getUTCFullYear();
  for (let y = firstYear; y <= lastYear + 1; y++) {
    const jan = Date.UTC(y, 0, 1);
    const jul = Date.UTC(y, 6, 1);
    if (jan > series.start && jan < end) years.push(jan);
    if (jul > series.start && jul < end) halfYears.push(jul);
  }

  const shownMilestones = milestones
    .map((m) => ({ m, ms: isoMs(m.date) }))
    .filter((x) => x.ms >= series.start && x.ms <= end);

  const description = [
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

  return (
    <figure className="m-0" role="img" aria-label={description}>
      <div className="relative ml-11 mr-1 mt-5 h-56 sm:h-72">
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {gridValues.map((v) => (
            <line
              key={v}
              x1={0}
              x2={VIEW_W}
              y1={(yPct(v) / 100) * VIEW_H}
              y2={(yPct(v) / 100) * VIEW_H}
              style={{ stroke: "var(--color-border)" }}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {years.map((ms) => (
            <line
              key={ms}
              x1={(xPct(ms) / 100) * VIEW_W}
              x2={(xPct(ms) / 100) * VIEW_W}
              y1={0}
              y2={VIEW_H}
              style={{ stroke: "var(--color-border)" }}
              strokeWidth={1}
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {series.imports.map((i) => (
            <path
              key={i.ms}
              d={pathOf([svgPt([i.ms, i.from]), svgPt([i.ms, i.to])])}
              fill="none"
              style={{ stroke: "var(--color-text-muted)" }}
              strokeWidth={2}
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {series.actual.map((seg) => (
            <path
              key={seg[0][0]}
              d={pathOf(seg.map(svgPt))}
              fill="none"
              style={{ stroke: accent }}
              strokeWidth={2.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {projection && (
            <path
              d={pathOf(projection.map(svgPt))}
              fill="none"
              style={{ stroke: accent }}
              strokeWidth={2}
              strokeDasharray="6 5"
              opacity={0.7}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {gridValues.map((v) => (
          <span
            key={v}
            className="absolute right-full -translate-y-1/2 pr-2 text-xs text-muted tabular-nums"
            style={{ top: `${yPct(v)}%` }}
          >
            {fmt(v)}
          </span>
        ))}
        {years.map((ms) => (
          <span
            key={ms}
            className="absolute top-full -translate-x-1/2 pt-1.5 text-xs text-muted tabular-nums"
            style={{ left: `${xPct(ms)}%` }}
          >
            {new Date(ms).getUTCFullYear()}
          </span>
        ))}
        {halfYears.map((ms) => (
          <span
            key={ms}
            className="absolute top-full hidden -translate-x-1/2 pt-1.5 text-xs text-muted sm:block"
            style={{ left: `${xPct(ms)}%` }}
          >
            Jul
          </span>
        ))}
        {shownMilestones.map(({ m, ms }) => (
          <span
            key={m.date}
            title={`${formatFactDate(m.date)}: ${m.title}`}
            className="absolute bottom-0 h-2.5 w-0.5 -translate-x-1/2 bg-[var(--color-text-secondary)]"
            style={{ left: `${xPct(ms)}%` }}
          />
        ))}

        {targets.map(({ p, ms }) => (
          <div
            key={p.target.deadline}
            className="absolute"
            style={{ left: `${xPct(ms)}%`, top: `${yPct(p.targetCount)}%` }}
          >
            <span
              className="absolute block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-base"
              style={{ borderColor: "var(--color-text-primary)" }}
            />
            <span className="absolute bottom-2 right-1 whitespace-nowrap text-right text-xs text-secondary">
              <strong className="font-semibold text-primary tabular-nums">
                {fmt(p.targetCount)}
              </strong>{" "}
              by {monthYear(monthKey(ms))}
            </span>
          </div>
        ))}

        <div className="absolute" style={{ left: `${xPct(nowMs)}%`, top: `${yPct(nowValue)}%` }}>
          <span
            className="absolute block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: accent }}
          />
          <span className="absolute bottom-2 right-1 whitespace-nowrap text-xs text-secondary">
            <strong className="font-semibold text-primary tabular-nums">{fmt(nowValue)}</strong> now
          </span>
        </div>
      </div>

      <figcaption className="mt-8 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
        <LegendItem label="Aircraft with Starlink">
          <span className="block h-0.5 w-5 rounded-full" style={{ background: accent }} />
        </LegendItem>
        {projection && (
          <LegendItem label="At the current pace">
            <span className="block w-5 border-t-2 border-dashed" style={{ borderColor: accent }} />
          </LegendItem>
        )}
        {targets.length > 0 && (
          <LegendItem label="Stated target">
            <span
              className="block h-2.5 w-2.5 rounded-full border-2"
              style={{ borderColor: "var(--color-text-primary)" }}
            />
          </LegendItem>
        )}
        {shownMilestones.length > 0 && (
          <LegendItem label="Milestone">
            <span className="block h-2.5 w-0.5 bg-[var(--color-text-secondary)]" />
          </LegendItem>
        )}
        {series.imports.length > 0 && (
          <LegendItem label="Data import">
            <span
              className="block h-3 border-l-2 border-dashed"
              style={{ borderColor: "var(--color-text-muted)" }}
            />
          </LegendItem>
        )}
      </figcaption>
    </figure>
  );
}

function LegendItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex h-4 w-5 items-center justify-center" aria-hidden="true">
        {children}
      </span>
      {label}
    </span>
  );
}

/** Observed pace against the pace each open target needs. */
export function PaceBullets({ stats, accent }: { stats: InstallRateStats; accent: string }) {
  const actual = stats.paceMonthly;
  if (actual === null) return null;
  const rows = stats.projections
    .map((p) => ({ p, needed: requiredMonthlyPace(p, stats.asOfMs) }))
    .filter((r): r is { p: TargetProjection; needed: number } => r.needed !== null);
  if (rows.length === 0) return null;
  const scale = Math.max(actual, ...rows.map((r) => r.needed)) * 1.1;
  return (
    <ul className="space-y-4">
      {rows.map(({ p, needed }) => {
        const label = `${fmt(p.targetCount)} by ${formatFactDate(p.target.deadline)}`;
        return (
          <li key={p.target.deadline}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="text-secondary">{label}</span>
              <span className="text-muted">
                <strong className="font-semibold text-primary tabular-nums">{fmt(needed)}</strong> a
                month needed
              </span>
            </div>
            <div
              className="relative mt-2 h-3 rounded-full bg-surface-elevated"
              role="img"
              aria-label={`${label}: about ${fmt(actual)} installs a month now, ${fmt(needed)} a month needed.`}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${(actual / scale) * 100}%`, background: accent }}
              />
              <div
                className="absolute -top-1 h-5 w-0.5 -translate-x-1/2 rounded-full bg-[var(--color-text-primary)]"
                style={{ left: `${(needed / scale) * 100}%` }}
              />
            </div>
          </li>
        );
      })}
      <li className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="block h-2 w-4 rounded-full" style={{ background: accent }} />
          Now: about {fmt(actual)} a month
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="block h-3 w-0.5 rounded-full bg-[var(--color-text-primary)]" />
          Needed to hit the target
        </span>
      </li>
    </ul>
  );
}

/** Installs per calendar month from the first install, the current month
 * marked as partial so a half month never reads as a slowdown. */
export function MonthlyInstallsBars({
  stats,
  accent,
}: { stats: InstallRateStats; accent: string }) {
  const months = stats.months;
  if (months.length < 2) return null;
  const current = monthKey(stats.asOfMs);
  const max = Math.max(1, ...months.map((m) => m.installs));
  const label = monthYear;
  const last = months[months.length - 1];
  const description = `Installs per month: ${months
    .map((m) => `${label(m.month)} ${fmt(m.installs)}${m.month === current ? " (so far)" : ""}`)
    .join(", ")}.`;
  return (
    <figure className="m-0" role="img" aria-label={description}>
      <div className="flex h-28 items-end gap-[3px]" aria-hidden="true">
        {months.map((m) => {
          const partial = m.month === current;
          return (
            <div key={m.month} className="flex h-full flex-1 flex-col justify-end">
              <span className="mb-0.5 hidden text-center text-xs text-muted tabular-nums sm:block">
                {m.installs > 0 ? fmt(m.installs) : ""}
              </span>
              <div
                className="rounded-t-sm"
                title={`${label(m.month)}${partial ? " so far" : ""}: ${fmt(m.installs)}`}
                style={{
                  height: `${Math.max(2, (m.installs / max) * 80)}%`,
                  background:
                    m.installs === 0
                      ? "var(--color-border)"
                      : partial
                        ? `repeating-linear-gradient(135deg, ${accent} 0 3px, transparent 3px 6px)`
                        : accent,
                  boxShadow: partial ? `inset 0 0 0 1px ${accent}` : undefined,
                }}
              />
            </div>
          );
        })}
      </div>
      <figcaption className="mt-1.5 flex justify-between text-xs text-muted">
        <span>{label(months[0].month)}</span>
        <span>
          {label(last.month)}
          {last.month === current ? " (so far)" : ""}
        </span>
      </figcaption>
    </figure>
  );
}
