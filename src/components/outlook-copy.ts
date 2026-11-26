/**
 * The rollout outlook's sentences, shared by the flight, route and per-type
 * pages so the three never word one figure three ways. Rules and the backtest
 * behind them: reports/rollout-outlook.md. Two are load-bearing: no finish
 * date of ours is ever stated (the backtest never checked one, and the last
 * tails of a type come slower), and a type with nothing true to add says
 * nothing.
 */

import { DAY_SEC } from "../database/sql/windows";
import type { PublishedTargetPace, TypeOutlook } from "../outlook/pace";
import {
  MIN_MONTH_DEPARTURES,
  type RouteDirection,
  type RouteMonth,
  type RouteOutlook,
} from "../outlook/route";
import { fmt, monthYear, shortDate } from "./ui/format";

/** One type's outlook as a page needs it: its display name and its page. */
export interface TypeOutlookRef {
  /** "United": the airline as a sentence names it. */
  airline: string;
  /** "737 MAX 9": the type page's own short name. */
  short: string;
  /** /fleet/{slug} when this host serves it. */
  href: string | null;
  outlook: TypeOutlook;
  /** The clock the outlook was computed at (unix seconds). */
  now: number;
}

export interface RouteOutlookView {
  /** Months with enough departures to state a share, oldest first: full
   * months, then the current one (`complete` false) so far. */
  months: RouteMonth[];
  direction: RouteDirection;
  changePoints: number | null;
  /** The first and last full month the direction compares; null with under two. */
  span: { from: string; to: string } | null;
  /** The types that fly most of the route, largest first. */
  types: Array<TypeOutlookRef & { share: number }>;
}

/** A type flying less of a route than this isn't what a rider there gets. */
const MIN_ROUTE_TYPE_SHARE = 0.25;
const MAX_ROUTE_TYPES = 2;
const ROUTE_MONTHS_SHOWN = 3;

/** A line that opened longer ago than this didn't "begin" recently. */
const BEGAN_WITHIN_DAYS = 120;

const installs = (o: TypeOutlook, days: number) =>
  o.pace.find((w) => w.days === days)?.installs ?? 0;

/** With fewer aircraft than this left, a pace has nothing to say about them. */
const MIN_REMAINING = 3;

/**
 * Whether a page says anything about the type. Not once it's all but complete,
 * and not where many equipped tails carry no listing date: the pace would be counting
 * a fraction of the installs and calling it the rate.
 */
export function hasTypeOutlook(o: TypeOutlook): boolean {
  return o.remaining >= MIN_REMAINING && o.undated * 5 <= o.equipped;
}

const were = (n: number) => (n === 1 ? "was" : "were");

/** "21 Starlink 737 MAX 9s were found in the last 30 days." */
export function foundSentence(o: TypeOutlook, short: string): string {
  const i30 = installs(o, 30);
  const i90 = installs(o, 90);
  if (i30 > 0) {
    const older = o.status === "no_pace" && i90 > i30 ? `, and ${fmt(i90)} in the last 90` : "";
    return `${fmt(i30)} Starlink ${short}${i30 === 1 ? "" : "s"} ${were(i30)} found in the last 30 days${older}.`;
  }
  if (i90 > 0)
    return `No Starlink ${short}s were found in the last 30 days, and ${fmt(i90)} in the last 90.`;
  return `No ${short} installs were found in the last 90 days.`;
}

/** "61 of 190 United 737 MAX 9s have Starlink, and 21 were found in the last
 * 30 days." `subject` is "United 737 MAX 9s", or empty beside the type's name. */
export function countSentence(o: TypeOutlook, subject: string): string {
  const of = subject ? ` ${subject}` : "";
  const i30 = installs(o, 30);
  const i90 = installs(o, 90);
  const count = `${fmt(o.equipped)} of ${fmt(o.total)}${of} have Starlink`;
  if (i30 > 0) return `${count}, and ${fmt(i30)} ${were(i30)} found in the last 30 days.`;
  if (i90 > 0)
    return `${count}: ${fmt(i90)} ${were(i90)} found in the last 90 days, none in the last 30.`;
  return `${count}, and none were found in the last 90 days.`;
}

/**
 * What the pace says about the next two months: the backtested range for a
 * running line, "too new" for one just opening, nothing otherwise.
 */
export function forecastSentence(o: TypeOutlook, now: number): string | null {
  if (o.status === "projected" && o.next60Days) {
    const { low, high } = o.next60Days;
    // A range reaching the last tail would be a finish date in disguise.
    if (high >= o.remaining) return `${fmt(o.remaining)} are left.`;
    return low === high
      ? `About ${fmt(high)} more are likely in the next two months.`
      : `About ${fmt(low)} to ${fmt(high)} more are likely in the next two months.`;
  }
  if (o.status === "starting") {
    const began =
      o.firstInstalledAt !== null && now - o.firstInstalledAt <= BEGAN_WITHIN_DAYS * DAY_SEC
        ? `began in ${monthYear(new Date(o.firstInstalledAt * 1000).toISOString().slice(0, 7))}`
        : "picked up in the last 30 days";
    const faster = o.trend === "speeding_up" ? " and are speeding up" : "";
    return `Installs on this type ${began}${faster}, too new to forecast.`;
  }
  return null;
}

/** The airline's nearest stated date that still needs a countable pace. */
function bindingTarget(o: TypeOutlook): PublishedTargetPace | null {
  return (
    o.published
      .filter((t) => t.says && t.requiredPerMonth !== null && Math.round(t.requiredPerMonth) >= 1)
      .sort((a, b) => a.deadline.localeCompare(b.deadline))[0] ?? null
  );
}

/** "United's target is every aircraft by the end of 2027 (stated Apr 21, 2026); from
 * here that needs about 8 a month." Arithmetic on the airline's date, never a
 * prediction that it will be met or missed. */
export function targetSentence(o: TypeOutlook, airline: string): string | null {
  const t = bindingTarget(o);
  if (!t || t.requiredPerMonth === null) return null;
  return `${airline}'s target is ${t.says} (stated ${shortDate(t.statedOn)}); from here that needs about ${fmt(Math.round(t.requiredPerMonth))} a month.`;
}

/** The second sentence beside a count: the forecast where there is one, else
 * the airline's own date. */
export function followSentence(o: TypeOutlook, airline: string, now: number): string | null {
  return forecastSentence(o, now) ?? targetSentence(o, airline);
}

/** The last 90 days as three 30-day blocks, oldest first, for the pace bars. */
export function paceBlocks(o: TypeOutlook): Array<{ label: string; installs: number }> {
  const i30 = installs(o, 30);
  const i60 = installs(o, 60);
  const i90 = installs(o, 90);
  return [
    { label: "61–90 days ago", installs: i90 - i60 },
    { label: "31–60 days ago", installs: i60 - i30 },
    { label: "Last 30 days", installs: i30 },
  ];
}

/**
 * A route's outlook as its page shows it, or null where the departures we saw
 * are too few to state any month's share.
 */
export function routeOutlookView(
  route: RouteOutlook,
  typeRef: (family: string) => TypeOutlookRef | null
): RouteOutlookView | null {
  // The months routeDirection read, so the sentence names what it compared.
  const full = route.months.filter((m) => m.complete && m.departures >= MIN_MONTH_DEPARTURES);
  // The month so far fills a free row, marked as such; a month cut short by
  // the history we keep never shows.
  const current = route.months[route.months.length - 1];
  const months = [
    ...full,
    ...(!current.complete && current.departures >= MIN_MONTH_DEPARTURES ? [current] : []),
  ].slice(0, ROUTE_MONTHS_SHOWN);
  if (full.length === 0) return null;
  const types = route.types
    .filter((t) => t.share >= MIN_ROUTE_TYPE_SHARE)
    .flatMap((t) => {
      const ref = typeRef(t.family);
      return ref ? [{ ...ref, share: t.share }] : [];
    })
    .slice(0, MAX_ROUTE_TYPES);
  return {
    months,
    direction: route.direction,
    changePoints: route.changePoints,
    span: full.length >= 2 ? { from: full[0].month, to: full[full.length - 1].month } : null,
    types,
  };
}

/** "Up 12 points from Aug 2026 to Oct 2026." Null with under two usable months. */
export function directionSentence(view: RouteOutlookView): string | null {
  if (view.direction === "too_few" || view.changePoints === null || !view.span) return null;
  const span = `from ${monthYear(view.span.from)} to ${monthYear(view.span.to)}`;
  if (view.direction === "flat") return `About level ${span}.`;
  const points = Math.round(Math.abs(view.changePoints));
  return `${view.direction === "rising" ? "Up" : "Down"} ${fmt(points)} points ${span}.`;
}
