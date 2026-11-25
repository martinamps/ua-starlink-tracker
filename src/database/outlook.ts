/**
 * Readers behind the rollout outlook (src/outlook/). Counts come from
 * programmeRoster and the one equipped definition; install dates are the
 * listing dates (starlink_planes.DateFound) of the tails equipped today;
 * a route's departures are the ADS-B flight draws on the flight numbers that
 * fly only that pair. Every reader takes `now`, so the backtest and tests pin
 * the clock.
 */

import type { Database } from "bun:sqlite";
import { slotFlightKey } from "../airlines/flight-number";
import { FLEET, OUTLOOK_BACKTEST, type TypeOutlook, typeOutlook } from "../outlook/pace";
import { publishedTargets } from "../outlook/published";
import { type RouteDeparture, type RouteOutlook, monthKeys, routeOutlook } from "../outlook/route";
import { fleetRoster, programmeRoster } from "./roster";
import { placeholders } from "./sql/fragments";

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

/** 'YYYY-MM-DD…' → unix seconds at 00:00 UTC; anything else is undated. */
export function listingTime(dateFound: string | null): number | null {
  const m = dateFound?.match(ISO_DAY);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T00:00:00Z`);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/** Earliest listing date per tail for one airline. */
export function listingTimes(db: Database, airline: string): Map<string, number | null> {
  const rows = db
    .query(
      `SELECT TailNumber AS tail, MIN(DateFound) AS found FROM starlink_planes
       WHERE airline = ? GROUP BY TailNumber`
    )
    .all(airline) as Array<{ tail: string; found: string | null }>;
  return new Map(rows.map((r) => [r.tail, listingTime(r.found)]));
}

export interface AirlineOutlook {
  airline: string;
  now: number;
  fleet: TypeOutlook;
  /** Largest fleet first. */
  families: TypeOutlook[];
}

export function airlineOutlook(db: Database, airline: string, now: number): AirlineOutlook {
  const roster = programmeRoster(db, airline);
  const listed = listingTimes(db, airline);
  const groups = new Map<string, typeof roster>();
  for (const t of roster) groups.set(t.family, [...(groups.get(t.family) ?? []), t]);

  const build = (family: string, tails: typeof roster) => {
    const equipped = tails.filter((t) => t.equipped);
    return typeOutlook({
      relativeError: family === FLEET ? OUTLOOK_BACKTEST.fleetRelativeError : undefined,
      family,
      equipped: equipped.length,
      total: tails.length,
      installedAt: equipped.map((t) => listed.get(t.tail_number) ?? null),
      now,
      published: publishedTargets(airline, family),
    });
  };

  const families = [...groups]
    .map(([family, tails]) => build(family, tails))
    .sort((a, b) => b.total - a.total || a.family.localeCompare(b.family));
  return { airline, now, fleet: build(FLEET, roster), families };
}

/** Departures older than this many calendar months are not read. */
const ROUTE_MONTHS = 4;

export interface RouteOutlookResult extends RouteOutlook {
  /** Marketing numbers counted: those seen only on this pair in the window. */
  flightNumbers: string[];
  /** Numbers also seen on another pair (through flights), left out. */
  excludedFlightNumbers: string[];
}

/**
 * The route's outlook, or null where we hold no unbiased departure history:
 * the ADS-B draws exist for UA flight numbers only.
 */
export function routeOutlookFor(
  db: Database,
  airline: string,
  origin: string,
  destination: string,
  now: number,
  outlook: AirlineOutlook = airlineOutlook(db, airline, now)
): RouteOutlookResult | null {
  if (airline !== "UA") return null;
  const windowStart = Date.parse(`${monthKeys(now, ROUTE_MONTHS)[0]}-01T00:00:00Z`) / 1000;

  const pairsByKey = new Map<string, Set<string>>();
  const rows = db
    .query(
      `SELECT flight_number, origin, destination FROM flight_routes
       WHERE last_seen_at >= ? AND flight_number IN (
         SELECT flight_number FROM flight_routes WHERE origin = ? AND destination = ?)`
    )
    .all(windowStart, origin, destination) as Array<{
    flight_number: string;
    origin: string;
    destination: string;
  }>;
  for (const r of rows) {
    const key = slotFlightKey(r.flight_number, airline);
    if (!key?.startsWith(airline)) continue;
    const pairs = pairsByKey.get(key) ?? new Set<string>();
    pairs.add(`${r.origin}-${r.destination}`);
    pairsByKey.set(key, pairs);
  }
  const pair = `${origin}-${destination}`;
  const flightNumbers: string[] = [];
  const excludedFlightNumbers: string[] = [];
  for (const [key, pairs] of pairsByKey) {
    if (!pairs.has(pair)) continue;
    (pairs.size === 1 ? flightNumbers : excludedFlightNumbers).push(key);
  }
  flightNumbers.sort();
  excludedFlightNumbers.sort();

  const departures: RouteDeparture[] = [];
  if (flightNumbers.length > 0) {
    const tails = new Map(fleetRoster(db, airline).map((t) => [t.tail_number, t]));
    const listed = listingTimes(db, airline);
    const draws = db
      .query(
        `SELECT tail_number, first_seen FROM adsb_flight_draws
         WHERE first_seen >= ? AND first_seen <= ?
           AND flight_number IN (${placeholders(flightNumbers)})`
      )
      .all(windowStart, now, ...flightNumbers) as Array<{
      tail_number: string;
      first_seen: number;
    }>;
    for (const d of draws) {
      const t = tails.get(d.tail_number);
      departures.push({
        departedAt: d.first_seen,
        tail: d.tail_number,
        family: t?.family ?? "unknown",
        // Equipped with no listing date: nothing to place it by, so it counts
        // as equipped across the whole window.
        equippedSince: t?.equipped ? (listed.get(d.tail_number) ?? 0) : null,
      });
    }
  }

  const outlooks = new Map(outlook.families.map((f) => [f.family, f]));
  return {
    ...routeOutlook({
      origin,
      destination,
      departures,
      outlooks,
      now,
      monthsBack: ROUTE_MONTHS,
    }),
    flightNumbers,
    excludedFlightNumbers,
  };
}
