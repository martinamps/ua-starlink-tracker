/**
 * Readers behind the rollout outlook (src/outlook/). Counts come from
 * programmeRoster and the one equipped definition; install dates are the
 * listing dates (starlink_planes.DateFound) of the tails equipped today;
 * a route's departures are the ADS-B flight draws on the flight numbers that
 * fly only that pair, which no page shows yet (ROUTE_DEPARTURES_PLACED_BY_PAIR).
 * Every reader takes `now`, so the backtest and tests pin the clock.
 */

import type { Database } from "bun:sqlite";
import { slotFlightKey } from "../airlines/flight-number";
import { FLEET, OUTLOOK_BACKTEST, type TypeOutlook, typeOutlook } from "../outlook/pace";
import { publishedTargets } from "../outlook/published";
import { type RouteDeparture, type RouteOutlook, monthKeys, routeOutlook } from "../outlook/route";
import { ADSB_FLIGHT_DRAW_RETENTION_DAYS } from "./adsb-flight-draws";
import { fleetRoster, programmeRoster } from "./roster";
import { placeholders } from "./sql/fragments";
import { DAY_SEC } from "./sql/windows";

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

/**
 * Airlines whose install dates the backtest replayed (reports/
 * rollout-outlook.md). A page states an outlook for these only: elsewhere a
 * listing date can be a whole type settling on one day, which is not a pace.
 */
const BACKTESTED_AIRLINES: ReadonlySet<string> = new Set(["UA"]);

export const hasBacktestedOutlook = (airline: string) => BACKTESTED_AIRLINES.has(airline);

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

/**
 * Whether a flight draw can be put on the airport pair it flew. It can't: a
 * draw is a flight number and a tail, and flight_routes learns a pair only
 * from a tracked (Starlink) tail or a lookup. United reuses a number on other
 * pairs on other days; when untracked aircraft fly those, the number still
 * looks single-pair and their departures are counted here, so the share reads
 * low and the count high by an amount nothing stored can bound. Pages show no
 * route share until draws carry their airports; routeOutlookFor stays for the
 * backtest script, which is how the shares get checked against production.
 */
export const ROUTE_DEPARTURES_PLACED_BY_PAIR: boolean = false;

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
 * the ADS-B draws exist for UA flight numbers only. Not for a page while
 * ROUTE_DEPARTURES_PLACED_BY_PAIR is false: readers go through
 * ScopedReader.getRouteOutlook, which holds that gate.
 */
export function routeOutlookFor(
  db: Database,
  airline: string,
  origin: string,
  destination: string,
  now: number,
  outlook: AirlineOutlook = airlineOutlook(db, airline, now)
): RouteOutlookResult | null {
  if (!hasBacktestedOutlook(airline)) return null;
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
      // The draws are pruned past the retention, so the oldest month read is
      // usually a few days of departures, not a month.
      historyFrom: now - ADSB_FLIGHT_DRAW_RETENTION_DAYS * DAY_SEC,
    }),
    flightNumbers,
    excludedFlightNumbers,
  };
}
