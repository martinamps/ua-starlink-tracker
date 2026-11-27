/**
 * The airline homepage's rollout panel: one headline number, one stacked bar
 * that splits it by fleet segment, and a 12-week install sparkline.
 */
import { Fragment } from "react";
import type { ContentStats } from "../../airlines/content";
import {
  BY_TYPE_TAB_NOTE,
  leadCount,
  ownCountAsOf,
  rosterDiffSentence,
  statsParts,
  unnamedSentence,
} from "../../airlines/published-count";
import type { AirlineConfig } from "../../airlines/registry";
import { airportPlaceName } from "../../utils/airport-names";
import { excludeMassWriteDays } from "../../utils/install-rate";
import { Sparkline } from "../charts/sparkline";
import { LINK, Panel, SECTION_WIDE, StatInline } from "../layout";
import { fmt, pct } from "../ui/format";
import { Meter } from "../ui/meter";

interface RolloutSegment {
  label: string;
  n: number;
  total: number;
  /** A partner's aircraft known by aircraft type: no share, and said so. */
  byType?: boolean;
}

const DAY_MS = 86_400_000;

/** Whole days since the epoch of the Monday that starts `dayIndex`'s week (UTC). */
const mondayOf = (dayIndex: number) => dayIndex - ((dayIndex + 3) % 7);

/**
 * Installs per calendar week (Monday start, UTC), oldest first, the last one
 * the current partial week: the same buckets as /fleet's install-pace bars.
 * Bulk-import days are dropped, as on /install-rate.
 */
export function weeklyInstalls(
  daily: { day: string; installs: number }[],
  nowMs: number,
  weeks = 12
): number[] {
  const { kept } = excludeMassWriteDays(daily);
  const thisWeek = mondayOf(Math.floor(nowMs / DAY_MS));
  const out = new Array<number>(weeks).fill(0);
  for (const d of kept) {
    const day = Math.floor(Date.parse(`${d.day}T00:00:00Z`) / DAY_MS);
    if (Number.isNaN(day)) continue;
    const bucket = weeks - 1 - (thisWeek - mondayOf(day)) / 7;
    if (bucket >= 0 && bucket < weeks) out[bucket] += d.installs;
  }
  return out;
}

// Segment fills: the accent, then the accent at reduced strength. Labels carry
// the numbers, so the split never depends on telling two tints apart.
const SEGMENT_FILL = ["bg-[var(--color-accent)]", "bg-accent/50", "bg-accent/30"];

function StackedBar({ segments, total }: { segments: RolloutSegment[]; total: number }) {
  const label = segments
    .map((s) => `${s.label} ${fmt(s.n)}${s.byType ? ` ${BY_TYPE_TAB_NOTE}` : ""}`)
    .join(", ");
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

function WeeklySparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const last = values[values.length - 1];
  return (
    <figure className="w-full sm:w-72">
      <Sparkline
        values={values}
        label={`Aircraft added per week, last ${values.length} weeks: ${values.join(", ")}`}
      />{" "}
      <figcaption className="mt-1 text-xs text-muted">
        Added per week, last {values.length} weeks ·{" "}
        <span className="tabular-nums">{fmt(last)}</span> this week so far
      </figcaption>
    </figure>
  );
}

/**
 * The headline block carries id="starlink-stat": the count llms.txt and
 * /methodology tell people to cite, dated by the page's "Data last updated" line.
 */
export function RolloutPanel({
  stats,
  segments,
  noun = "aircraft",
  airline,
}: {
  stats: ContentStats;
  segments: RolloutSegment[];
  /** "United aircraft" etc. */
  noun?: string;
  /** Names the airline's own chart figure, where stats carries one. */
  airline?: AirlineConfig;
}) {
  const { starlinkCount: n, totalCount: total, installs30d, weeklyInstalls: weekly } = stats;
  // Two honest numbers: the airline's own dated chart and the tails named
  // here. Each is labelled with whose it is; neither is added to the other.
  const chart = airline ? (stats.airlineCount ?? null) : null;
  const lead = leadCount({ ...stats, airlineCount: chart });
  // A headline that adds a partner's by-type aircraft to the airline's own
  // says its two parts apart, and gives no share of the whole.
  const parts = airline ? statsParts(airline, stats) : null;
  const chartLink = chart && airline && (
    <a href={chart.url} className={LINK} rel="noopener">
      {airline.shortName}'s own count
    </a>
  );
  const added = installs30d ? (
    <>
      {" · "}
      <StatInline>+{fmt(installs30d)}</StatInline> in the last 30 days
    </>
  ) : null;
  return (
    <Panel as="section" aria-label="Rollout progress" className={SECTION_WIDE}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div id="starlink-stat">
          <p className="font-display text-4xl text-primary tabular-nums">
            {fmt(lead.n)}{" "}
            <span className="text-xl text-secondary">
              of {fmt(lead.total)} {noun}
            </span>
          </p>{" "}
          {lead.own ? (
            <p className="mt-1 text-sm text-secondary">
              have Starlink, by {chartLink} {ownCountAsOf(lead.own)}
            </p>
          ) : (
            <p className="mt-1 text-sm text-secondary">
              {!parts && (
                <>
                  <StatInline>{pct(n, total)}</StatInline>{" "}
                </>
              )}
              have Starlink{added}
            </p>
          )}{" "}
          {parts && !lead.own && (
            <p className="mt-1 text-sm text-secondary text-pretty">That is {parts.text}.</p>
          )}{" "}
          {chart && airline && (
            <p className="mt-1 text-sm text-secondary text-pretty">
              {lead.own && parts ? (
                <>
                  We count <StatInline n={n} /> of them, out of {fmt(total)} on our fleet list
                  {added}: {parts.text}.
                </>
              ) : lead.own ? (
                <>
                  We can name <StatInline n={n} /> of them by tail, out of {fmt(total)} on our fleet
                  list{added}.
                </>
              ) : (
                <>
                  {chartLink} is <StatInline n={chart.connected} /> of {fmt(chart.total)}{" "}
                  {ownCountAsOf(chart)}.
                </>
              )}{" "}
              {[unnamedSentence(airline, chart), rosterDiffSentence(airline, chart)]
                .filter(Boolean)
                .join(" ")}
            </p>
          )}
        </div>{" "}
        {weekly && <WeeklySparkline values={weekly} />}
      </div>{" "}
      <div className="mt-5">
        {chart && (
          <p className="mb-2 text-xs text-muted">
            {parts ? "On our fleet list" : "Named by tail"}: {fmt(n)} of {fmt(total)}
            {parts ? "" : " on our fleet list"}
          </p>
        )}{" "}
        <StackedBar segments={segments} total={total} />{" "}
        <ul className="mt-3 flex flex-col gap-1 text-sm text-secondary sm:flex-row sm:flex-wrap sm:gap-x-6">
          {segments.map((s, i) => (
            <Fragment key={s.label}>
              <li className="flex items-center gap-2">
                <span
                  className={`inline-block h-2.5 w-2.5 rounded-sm ${SEGMENT_FILL[i % SEGMENT_FILL.length]}`}
                  aria-hidden="true"
                />
                {s.label}: <StatInline n={s.n} /> of {fmt(s.total)}
                {s.byType ? `, ${BY_TYPE_TAB_NOTE}` : ` (${pct(s.n, s.total)})`}
              </li>{" "}
            </Fragment>
          ))}
          <li className="flex items-center gap-2 text-muted">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm border border-muted bg-surface-elevated"
              aria-hidden="true"
            />
            {chart ? "Not named" : "Not yet"}:{" "}
            {fmt(Math.max(0, total - segments.reduce((a, s) => a + s.n, 0)))}
          </li>
        </ul>
      </div>
    </Panel>
  );
}

/** Top airports by Starlink departures, as bars scaled to the busiest. One
 * column where the list sits in a sidebar (/routes), two on the homepage.
 * `airportHref` links a code to its airport page where that page indexes;
 * any other code is plain text. */
export function AirportBars({
  rows,
  limit = 12,
  columns = 2,
  airportHref,
}: {
  rows: { airport: string; count: number }[];
  limit?: number;
  columns?: 1 | 2;
  airportHref?: (airport: string) => string | null;
}) {
  const top = rows.slice(0, limit);
  if (top.length === 0) return null;
  const max = top[0].count;
  return (
    <ol className={columns === 2 ? "grid gap-x-8 sm:grid-cols-2" : ""}>
      {top.map((r) => {
        const place = airportPlaceName(r.airport);
        const href = airportHref?.(r.airport);
        return (
          <Fragment key={r.airport}>
            <li className="py-1.5 text-sm">
              <div className="flex items-baseline gap-2">
                {href ? (
                  <a
                    href={href}
                    className="font-mono text-primary hover:text-accent transition-colors"
                  >
                    {r.airport}
                  </a>
                ) : (
                  <span className="font-mono text-primary">{r.airport}</span>
                )}{" "}
                {place && <span className="min-w-0 text-xs text-secondary">{place}</span>}{" "}
                <span className="ml-auto shrink-0 text-secondary tabular-nums">{fmt(r.count)}</span>
              </div>{" "}
              <Meter
                share={max > 0 ? r.count / max : 0}
                label={`${r.airport}: ${fmt(r.count)} Starlink departures`}
                className="mt-1.5"
              />
            </li>{" "}
          </Fragment>
        );
      })}
    </ol>
  );
}
