/**
 * The airline homepage's rollout panel: one headline number, one stacked bar
 * that splits it by fleet segment, and a 12-week install sparkline. It
 * replaces four donut charts, one of which grouped by manufacturer while
 * claiming to group by type.
 */
import type React from "react";
import type { ContentStats } from "../../airlines/content";
import { excludeMassWriteDays } from "../../utils/install-rate";
import { StatInline, fmt, pct } from "../layout";
import { Meter } from "../ui/meter";

export interface RolloutSegment {
  label: string;
  n: number;
  total: number;
}

const DAY_MS = 86_400_000;

/**
 * Installs per rolling 7-day window, oldest first, ending today (UTC). Rolling
 * windows rather than calendar weeks so the last point is never a partial week
 * that reads as a slowdown. Bulk-import days are dropped, as on /install-rate.
 */
export function weeklyInstalls(
  daily: { day: string; installs: number }[],
  nowMs: number,
  weeks = 12
): number[] {
  const { kept } = excludeMassWriteDays(daily);
  const today = Math.floor(nowMs / DAY_MS);
  const out = new Array<number>(weeks).fill(0);
  for (const d of kept) {
    const age = today - Math.floor(Date.parse(`${d.day}T00:00:00Z`) / DAY_MS);
    if (age < 0 || Number.isNaN(age)) continue;
    const bucket = weeks - 1 - Math.floor(age / 7);
    if (bucket >= 0) out[bucket] += d.installs;
  }
  return out;
}

// Segment fills: the accent, then the accent at reduced strength. Labels carry
// the numbers, so the split never depends on telling two tints apart.
const SEGMENT_FILL = ["bg-[var(--color-accent)]", "bg-accent/50", "bg-accent/30"];

function StackedBar({ segments, total }: { segments: RolloutSegment[]; total: number }) {
  const label = segments.map((s) => `${s.label} ${fmt(s.n)}`).join(", ");
  return (
    <Meter
      size="lg"
      label={`${label}, of ${fmt(total)} aircraft`}
      segments={segments.map((s, i) => ({
        key: s.label,
        share: total > 0 ? s.n / total : 0,
        className: `${SEGMENT_FILL[i % SEGMENT_FILL.length]} ${i > 0 ? "border-l-2 border-surface" : ""}`,
      }))}
    />
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const W = 240;
  const H = 48;
  const max = Math.max(...values);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - 4 - (v / max) * (H - 8)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <figure className="w-full sm:w-72">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-12 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Aircraft added per week, last ${values.length} weeks: ${values.join(", ")}`}
      >
        <polygon points={`0,${H} ${line} ${W},${H}`} fill="var(--color-accent)" opacity="0.12" />
        <polyline
          points={line}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="mt-1 text-xs text-muted">
        Added per week, last {values.length} weeks ·{" "}
        <span className="tabular-nums">{fmt(last)}</span> in the last 7 days
      </figcaption>
    </figure>
  );
}

export function RolloutPanel({
  stats,
  segments,
  noun = "aircraft",
  children,
}: {
  stats: ContentStats;
  segments: RolloutSegment[];
  /** "United aircraft" etc. */
  noun?: string;
  /** The citable stat sentence and any footnote. */
  children?: React.ReactNode;
}) {
  const { starlinkCount: n, totalCount: total, installs30d, weeklyInstalls: weekly } = stats;
  return (
    <section
      aria-label="Rollout progress"
      className="relative mx-auto mb-8 w-full max-w-3xl rounded-lg border border-subtle bg-surface p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-display text-4xl text-primary tabular-nums">
            {fmt(n)}{" "}
            <span className="text-xl text-secondary">
              of {fmt(total)} {noun}
            </span>
          </p>
          <p className="mt-1 text-sm text-secondary">
            <StatInline>{pct(n, total)}</StatInline> have Starlink
            {installs30d ? (
              <>
                {" · "}
                <StatInline>+{fmt(installs30d)}</StatInline> in the last 30 days
              </>
            ) : null}
          </p>
        </div>
        {weekly && <Sparkline values={weekly} />}
      </div>
      <div className="mt-5">
        <StackedBar segments={segments} total={total} />
        <ul className="mt-3 flex flex-col gap-1 text-sm text-secondary sm:flex-row sm:flex-wrap sm:gap-x-6">
          {segments.map((s, i) => (
            <li key={s.label} className="flex items-center gap-2">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-sm ${SEGMENT_FILL[i % SEGMENT_FILL.length]}`}
                aria-hidden="true"
              />
              {s.label}: <StatInline n={s.n} /> of {fmt(s.total)} ({pct(s.n, s.total)})
            </li>
          ))}
          <li className="flex items-center gap-2 text-muted">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm bg-surface-elevated"
              aria-hidden="true"
            />
            Not yet: {fmt(Math.max(0, total - segments.reduce((a, s) => a + s.n, 0)))}
          </li>
        </ul>
      </div>
      {children && <div className="mt-4 border-t border-subtle pt-4">{children}</div>}
    </section>
  );
}

/** Top airports by Starlink departures, as bars scaled to the busiest. One
 * column where the list sits in a sidebar (/routes), two on the homepage. */
export function AirportBars({
  rows,
  limit = 12,
  columns = 2,
}: {
  rows: { airport: string; count: number }[];
  limit?: number;
  columns?: 1 | 2;
}) {
  const top = rows.slice(0, limit);
  if (top.length === 0) return null;
  const max = top[0].count;
  return (
    <ol className={columns === 2 ? "grid gap-x-8 sm:grid-cols-2" : ""}>
      {top.map((r) => (
        <li
          key={r.airport}
          className="grid grid-cols-[3rem_1fr_3.5rem] items-center gap-3 py-1.5 text-sm"
        >
          <span className="font-mono text-primary">{r.airport}</span>
          <Meter
            share={max > 0 ? r.count / max : 0}
            label={`${r.airport}: ${fmt(r.count)} Starlink departures`}
          />
          <span className="text-right text-secondary tabular-nums">{fmt(r.count)}</span>
        </li>
      ))}
    </ol>
  );
}
