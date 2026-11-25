/**
 * A route's Starlink share by month, from observed departures, and the types
 * that fly it. Pure: src/database/outlook.ts reads the departures (ADS-B flight
 * draws on the route's flight numbers) and each tail's equipped state.
 *
 * A departure counts as Starlink when its tail is equipped today and was
 * listed on or before the departure. Listing lags the install by days, so a
 * month's share reads slightly low, never high.
 */

import { DAY_SEC } from "../database/sql/windows";
import type { TypeOutlook } from "./pace";

export interface RouteDeparture {
  departedAt: number;
  tail: string;
  family: string;
  /** Listing time of an equipped tail; null when the tail is not equipped. */
  equippedSince: number | null;
}

export interface RouteMonth {
  /** YYYY-MM (UTC). */
  month: string;
  departures: number;
  starlink: number;
  share: number;
  /** False for the current month, which is still filling. */
  complete: boolean;
}

export type RouteDirection = "rising" | "flat" | "falling" | "too_few";

export interface RouteTypeShare {
  family: string;
  departures: number;
  /** This type's share of the route's departures in the window. */
  share: number;
  outlook: TypeOutlook | null;
}

export interface RouteOutlook {
  origin: string;
  destination: string;
  months: RouteMonth[];
  direction: RouteDirection;
  /** Change in share, first complete month to last, in points (0–100). */
  changePoints: number | null;
  types: RouteTypeShare[];
}

/** A month with fewer departures than this says nothing about the route. */
export const MIN_MONTH_DEPARTURES = 20;
/** A change smaller than this, in points over the window, is "flat". */
export const FLAT_POINTS = 5;

function monthKey(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 7);
}

/** The `count` calendar months ending with `now`'s month, oldest first. */
export function monthKeys(now: number, count: number): string[] {
  const d = new Date(now * 1000);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.toISOString().slice(0, 7));
  }
  return out;
}

export function isStarlinkDeparture(d: RouteDeparture): boolean {
  return d.equippedSince !== null && d.equippedSince <= d.departedAt;
}

export function routeMonths(
  departures: readonly RouteDeparture[],
  now: number,
  count = 4
): RouteMonth[] {
  const keys = monthKeys(now, count);
  const current = monthKey(now);
  return keys.map((month) => {
    const inMonth = departures.filter((d) => monthKey(d.departedAt) === month);
    const starlink = inMonth.filter(isStarlinkDeparture).length;
    return {
      month,
      departures: inMonth.length,
      starlink,
      share: inMonth.length ? starlink / inMonth.length : 0,
      complete: month !== current,
    };
  });
}

/** First to last complete month with enough departures; "too_few" under two. */
export function routeDirection(months: readonly RouteMonth[]): {
  direction: RouteDirection;
  changePoints: number | null;
} {
  const usable = months.filter((m) => m.complete && m.departures >= MIN_MONTH_DEPARTURES);
  if (usable.length < 2) return { direction: "too_few", changePoints: null };
  const change = (usable[usable.length - 1].share - usable[0].share) * 100;
  if (change >= FLAT_POINTS) return { direction: "rising", changePoints: change };
  if (change <= -FLAT_POINTS) return { direction: "falling", changePoints: change };
  return { direction: "flat", changePoints: change };
}

export function routeTypes(
  departures: readonly RouteDeparture[],
  outlooks: ReadonlyMap<string, TypeOutlook>
): RouteTypeShare[] {
  const counts = new Map<string, number>();
  for (const d of departures) counts.set(d.family, (counts.get(d.family) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([family, n]) => ({
      family,
      departures: n,
      share: n / departures.length,
      outlook: outlooks.get(family) ?? null,
    }));
}

export function routeOutlook(opts: {
  origin: string;
  destination: string;
  departures: readonly RouteDeparture[];
  outlooks: ReadonlyMap<string, TypeOutlook>;
  now: number;
  monthsBack?: number;
}): RouteOutlook {
  const months = routeMonths(opts.departures, opts.now, opts.monthsBack ?? 4);
  const windowStart = Date.parse(`${months[0].month}-01T00:00:00Z`) / 1000;
  const inWindow = opts.departures.filter(
    (d) => d.departedAt >= windowStart && d.departedAt <= opts.now + DAY_SEC
  );
  return {
    origin: opts.origin,
    destination: opts.destination,
    months,
    ...routeDirection(months),
    types: routeTypes(inWindow, opts.outlooks),
  };
}
