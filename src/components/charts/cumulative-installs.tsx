/**
 * Rollout charts shared by /install-rate and /timeline: cumulative equipped
 * aircraft against stated targets, the pace each target needs, and installs
 * per month. Server-rendered HTML + SVG, no client script; the numbers come
 * from rollout-math.ts.
 *
 * The plot SVG stretches to its box (preserveAspectRatio="none") so it fills a
 * phone as well as a desktop column; everything that must stay legible —
 * labels, markers — is HTML positioned by percentage on top of it.
 */
import type React from "react";
import { type TimelineMilestone, formatFactDate } from "../../airlines/rollout-facts";
import type { InstallRateStats, TargetProjection } from "../../utils/install-rate";
import { fmt, monthYear } from "../ui/format";
import {
  type ChartModel,
  type Point,
  chartDescription,
  chartModel,
  monthKey,
  requiredMonthlyPace,
} from "./rollout-math";
import { pathOf } from "./sparkline";

const VIEW_W = 1000;
const VIEW_H = 400;
const HAIRLINE = { stroke: "var(--color-border)" };

/** The SVG layer: gridlines, year rules, import steps, the line and its projection. */
function PlotLines({ model, accent }: { model: ChartModel; accent: string }) {
  const { series, projection, gridValues, years, xPct, yPct } = model;
  const x = (ms: number) => (xPct(ms) / 100) * VIEW_W;
  const y = (v: number) => (yPct(v) / 100) * VIEW_H;
  const svgPt = ([ms, v]: Point): [number, number] => [x(ms), y(v)];
  return (
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
          y1={y(v)}
          y2={y(v)}
          style={HAIRLINE}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {years.map((ms) => (
        <line
          key={ms}
          x1={x(ms)}
          x2={x(ms)}
          y1={0}
          y2={VIEW_H}
          style={HAIRLINE}
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
  );
}

/** HTML over the plot: axis labels, milestone ticks, target and "now" markers. */
function PlotOverlay({ model, accent }: { model: ChartModel; accent: string }) {
  const { series, targets, gridValues, years, halfYears, milestones, xPct, yPct } = model;
  const [nowMs, nowValue] = series.now;
  return (
    <>
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
      {milestones.map(({ m, ms }) => (
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
    </>
  );
}

function PlotLegend({ model, accent }: { model: ChartModel; accent: string }) {
  return (
    <figcaption className="mt-8 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
      <LegendItem label="Aircraft with Starlink">
        <span className="block h-0.5 w-5 rounded-full" style={{ background: accent }} />
      </LegendItem>
      {model.projection && (
        <LegendItem label="At the current pace">
          <span className="block w-5 border-t-2 border-dashed" style={{ borderColor: accent }} />
        </LegendItem>
      )}
      {model.targets.length > 0 && (
        <LegendItem label="Stated target">
          <span
            className="block h-2.5 w-2.5 rounded-full border-2"
            style={{ borderColor: "var(--color-text-primary)" }}
          />
        </LegendItem>
      )}
      {model.milestones.length > 0 && (
        <LegendItem label="Milestone">
          <span className="block h-2.5 w-0.5 bg-[var(--color-text-secondary)]" />
        </LegendItem>
      )}
      {model.series.imports.length > 0 && (
        <LegendItem label="Data import">
          <span
            className="block h-3 border-l-2 border-dashed"
            style={{ borderColor: "var(--color-text-muted)" }}
          />
        </LegendItem>
      )}
    </figcaption>
  );
}

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
  const model = chartModel(stats, milestones);
  if (!model) return null;
  return (
    <figure className="m-0" role="img" aria-label={chartDescription(model, airlineName)}>
      <div className="relative ml-11 mr-1 mt-5 h-56 sm:h-72">
        <PlotLines model={model} accent={accent} />
        <PlotOverlay model={model} accent={accent} />
      </div>
      <PlotLegend model={model} accent={accent} />
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
