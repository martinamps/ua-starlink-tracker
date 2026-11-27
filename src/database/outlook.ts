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
import { type DatedInstall, backtestRouteMonths } from "../outlook/backtest";
import {
  FLEET,
  OUTLOOK_BACKTEST,
  PROJECTION_WINDOW_DAYS,
  type TypeOutlook,
  typeOutlook,
} from "../outlook/pace";
import { publishedTargets } from "../outlook/published";
import {
  MIN_MONTH_DEPARTURES,
  type RouteDeparture,
  type RouteMonth,
  type RouteOutlook,
  isStarlinkDeparture,
  monthKeys,
  routeMonths,
  routeOutlook,
  routeTypes,
} from "../outlook/route";
import { ADSB_FLIGHT_DRAW_RETENTION_DAYS, getAdsbFlightDrawsOnPair } from "./adsb-flight-draws";
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
 * Whether the route reader places a flight draw on the airport pair it flew.
 * It doesn't yet. routeOutlookFor below takes every draw of the flight numbers
 * that flight_routes shows on one pair only, and flight_routes learns a pair
 * only from a tracked (Starlink) tail or a lookup. United reuses a number on
 * other pairs on other days; when untracked aircraft fly those, the number
 * still looks single-pair and their departures are counted here, so the share
 * reads low and the count high by an amount nothing stored can bound.
 *
 * Draws written since the sweep began recording ground sightings carry their
 * own origin and destination (adsb-flight-draws.ts); older rows have neither.
 * Pages show no route share until a reader counts by those columns and enough
 * placed days are in; routeOutlookFor stays for the backtest script.
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

  const { flightNumbers, excludedFlightNumbers } = singlePairNumbers(
    db,
    airline,
    origin,
    destination,
    windowStart
  );
  const departures = drawsAsDepartures(
    db,
    airline,
    numberDraws(db, flightNumbers, windowStart, now)
  );

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

interface DrawRow {
  tail_number: string;
  first_seen: number;
}

/** Marketing numbers flight_routes shows on this pair since `since`: those
 * seen on no other pair, and the through numbers that also fly elsewhere. */
function singlePairNumbers(
  db: Database,
  airline: string,
  origin: string,
  destination: string,
  since: number
): { flightNumbers: string[]; excludedFlightNumbers: string[] } {
  const pairsByKey = new Map<string, Set<string>>();
  const rows = db
    .query(
      `SELECT flight_number, origin, destination FROM flight_routes
       WHERE last_seen_at >= ? AND flight_number IN (
         SELECT flight_number FROM flight_routes WHERE origin = ? AND destination = ?)`
    )
    .all(since, origin, destination) as Array<{
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
  return {
    flightNumbers: flightNumbers.sort(),
    excludedFlightNumbers: excludedFlightNumbers.sort(),
  };
}

function numberDraws(db: Database, flightNumbers: string[], from: number, to: number): DrawRow[] {
  if (flightNumbers.length === 0) return [];
  return db
    .query(
      `SELECT tail_number, first_seen FROM adsb_flight_draws
       WHERE first_seen >= ? AND first_seen <= ?
         AND flight_number IN (${placeholders(flightNumbers)})`
    )
    .all(from, to, ...flightNumbers) as DrawRow[];
}

function drawsAsDepartures(db: Database, airline: string, draws: DrawRow[]): RouteDeparture[] {
  if (draws.length === 0) return [];
  const tails = new Map(fleetRoster(db, airline).map((t) => [t.tail_number, t]));
  const listed = listingTimes(db, airline);
  return draws.map((d) => {
    const t = tails.get(d.tail_number);
    return {
      departedAt: d.first_seen,
      tail: d.tail_number,
      family: t?.family ?? "unknown",
      // Equipped with no listing date: nothing to place it by, so it counts
      // as equipped across the whole window.
      equippedSince: t?.equipped ? (listed.get(d.tail_number) ?? 0) : null,
    };
  });
}

/**
 * Routes whose outlook is replayed against their own departures every day
 * (src/scripts/route-backtest.ts), so the error a route page would carry is
 * read from production without database access. A fixed sample: one route
 * each for the 787, the transcon mix, a Guam 737 MAX 8 and a 737/A321 trunk.
 */
export const ROUTE_BACKTEST_SAMPLE: ReadonlyArray<readonly [string, string]> = [
  ["SFO", "SIN"],
  ["SFO", "EWR"],
  ["EWR", "SFO"],
  ["GUM", "NRT"],
  ["NRT", "GUM"],
  ["ORD", "LAX"],
  ["LAX", "ORD"],
  ["DEN", "ORD"],
];

/**
 * How a route's departures are found. `numbers`: draws of the numbers
 * flight_routes shows on this pair alone, which routeOutlookFor reads (and
 * which can count another pair's flights; ROUTE_DEPARTURES_PLACED_BY_PAIR).
 * `placed`: draws seen on the ground at both of the route's airports, which
 * only the draws written since the sweep placed them have.
 */
export type RouteDrawSource = "numbers" | "placed";

export interface RouteBacktest {
  origin: string;
  destination: string;
  source: RouteDrawSource;
  months: RouteMonth[];
  types: Array<{ family: string; share: number }>;
  /** Each month whose share was projected from the month before it. */
  checks: Array<{ month: string; departures: number; projected: number; actual: number }>;
  /** Mean |projected − actual| over the checks, in points (0–100). */
  meanAbsErrorPoints: number | null;
}

/** The outlook's route-month replay for one pair, by both ways of finding its
 * departures. Installs are the listing dates of the tails equipped today, as
 * the type outlook reads them. */
export function routeBacktests(
  db: Database,
  airline: string,
  origin: string,
  destination: string,
  now: number
): RouteBacktest[] {
  if (!hasBacktestedOutlook(airline)) return [];
  const months = monthKeys(now, ROUTE_MONTHS);
  const windowStart = Date.parse(`${months[0]}-01T00:00:00Z`) / 1000;
  const roster = programmeRoster(db, airline);
  const listed = listingTimes(db, airline);
  const totals = new Map<string, number>();
  const installs: DatedInstall[] = [];
  for (const t of roster) {
    totals.set(t.family, (totals.get(t.family) ?? 0) + 1);
    const at = t.equipped ? listed.get(t.tail_number) : null;
    if (at != null && at <= now) installs.push({ family: t.family, installedAt: at });
  }

  const { flightNumbers } = singlePairNumbers(db, airline, origin, destination, windowStart);
  const byNumbers = numberDraws(db, flightNumbers, windowStart, now);
  const placed = getAdsbFlightDrawsOnPair(db, origin, destination, windowStart).filter(
    (d) => d.first_seen <= now && slotFlightKey(d.flight_number, airline)?.startsWith(airline)
  );

  const historyFrom = now - ADSB_FLIGHT_DRAW_RETENTION_DAYS * DAY_SEC;
  const build = (source: RouteDrawSource, draws: DrawRow[]): RouteBacktest => {
    const departures = drawsAsDepartures(db, airline, draws);
    const checks = backtestRouteMonths({
      departures: departures.map((d) => ({
        departedAt: d.departedAt,
        family: d.family,
        starlink: isStarlinkDeparture(d),
      })),
      installs,
      totals,
      months,
      windowDays: PROJECTION_WINDOW_DAYS,
      minDepartures: MIN_MONTH_DEPARTURES,
    });
    return {
      origin,
      destination,
      source,
      months: routeMonths(departures, now, ROUTE_MONTHS, historyFrom),
      types: routeTypes(departures, new Map()).map((t) => ({ family: t.family, share: t.share })),
      checks,
      meanAbsErrorPoints: checks.length
        ? (checks.reduce((s, c) => s + Math.abs(c.projected - c.actual), 0) / checks.length) * 100
        : null,
    };
  };
  return [build("numbers", byNumbers), build("placed", placed)];
}
