/**
 * Readers behind /routes/{airport}: what leaves one airport on a Starlink
 * plane, and what Starlink planes flew from it lately.
 *
 * The schedule tables hold tracked tails only (the updater follows the
 * Starlink roster), so they can count Starlink departures but never an
 * airport's whole schedule. Nothing here reads the DOT census for one either:
 * it is months old, too far from this week's schedule to divide by.
 */

import type { Database } from "bun:sqlite";
import { canonicalPermalinkFor, slotFlightKey } from "../airlines/flight-number";
import { AIRLINES } from "../airlines/registry";
import { airportLocalDate } from "../utils/airport-tz";
import { getDepartureSlots, getObservationAnchor, slotScope } from "./database";
import { tailEquippedSql } from "./sql/equipped";
import { ROUTE_AIRPORT_RE, isCleanAirportPair, prefixGlob } from "./sql/fragments";
import { DAY_SEC, DEPARTURE_WINDOW_SEC, unixNow } from "./sql/windows";

/**
 * The span the airport history counts over. Six days, not seven: the
 * assignment log is pruned by departure-local date seven days back, so the
 * seventh day is already partly gone for airports west of UTC, and a count
 * labelled "7 days" would run short.
 */
export const AIRPORT_HISTORY_DAYS = 6;

export interface AirportDepartureRow {
  /** The marketed number, a valid /check-flight permalink on the tenant's site. */
  flight_number: string;
  destination: string;
  departure_time: number;
  tail_number: string;
  aircraft_type: string | null;
  verified: boolean;
}

/**
 * Equipped departures in the next 48 hours, from one airport or from all: the
 * slots /routes counts, under the numbers the airline sells. A slot with no
 * bookable number (an ATC callsign on a positioning leg) or no clean
 * destination would be a dead link, so it is left off, as on the route pages.
 */
function bookableStarlinkDepartures(
  db: Database,
  airline: string,
  nowSec: number,
  origin?: string
): Array<AirportDepartureRow & { origin: string }> {
  const cfg = AIRLINES[airline];
  if (!cfg) return [];
  const permalink = canonicalPermalinkFor(cfg);
  return getDepartureSlots(db, airline, {
    from: nowSec,
    to: nowSec + DEPARTURE_WINDOW_SEC,
    partners: true,
    origin,
  }).flatMap((r) =>
    r.equipped === 1 &&
    r.slot_flight &&
    permalink.test(r.slot_flight) &&
    isCleanAirportPair(r.departure_airport, r.arrival_airport)
      ? [
          {
            origin: r.departure_airport,
            flight_number: r.slot_flight,
            destination: r.arrival_airport,
            departure_time: r.departure_time,
            tail_number: r.tail_number,
            aircraft_type: r.aircraft_type ?? null,
            verified: r.verified_wifi === "Starlink",
          },
        ]
      : []
  );
}

/** One airport's slice of the window, soonest first. */
export function getAirportStarlinkDepartures(
  db: Database,
  airline: string,
  airport: string,
  nowSec = unixNow()
): AirportDepartureRow[] {
  return bookableStarlinkDepartures(db, airline, nowSec, airport).map(
    ({ origin: _, ...row }) => row
  );
}

/**
 * Tomorrow at the airport, as YYYY-MM-DD: the calendar day after its local
 * today. Null for an airport with no mapped timezone, which has no local day
 * to count.
 */
export function nextLocalDay(airport: string, nowSec = unixNow()): string | null {
  const today = airportLocalDate(airport, nowSec);
  if (!today) return null;
  return new Date(Date.parse(`${today}T00:00:00Z`) + DAY_SEC * 1000).toISOString().slice(0, 10);
}

/** How many of an airport's departures leave on its `date` (local). */
export function countOnLocalDay(
  airport: string,
  date: string,
  departures: readonly { departure_time: number }[]
): number {
  return departures.filter((d) => airportLocalDate(airport, d.departure_time) === date).length;
}

/**
 * Far enough back to hold all of any airport's local today: 24 hours, one
 * more for the 25-hour day a clock change makes, and one of slack.
 */
const LEFT_LOOKBACK_SEC = 26 * 3600;

/**
 * Departures that left in [from, to) on a tail that is equipped now, one row
 * per spelling the updater logged. Driven from departure_log, which archives
 * every schedule row whose time has passed, and probing the assignment log on
 * its (tail, time) index for the flight and the pair. The CROSS JOIN keeps
 * that order: left to itself the planner walks the airline's whole log.
 *
 * A late swap leaves the old tail's row in the schedule until that tail is
 * refreshed, so both tails can be archived for one flight. `newer` lists the
 * numbers other tails were seen on, for the same leg and time, after this
 * tail last was (the route index finds them): the newest sighting is the
 * plane that flew it.
 */
const LEFT_SQL = `SELECT dl.airport AS origin, dl.tail_number AS tail, dl.departed_at AS departure_time,
       fal.flight_number AS flight_number, fal.arrival_airport AS destination,
       (SELECT group_concat(fal2.flight_number, ' ') FROM flight_assignment_log fal2
         WHERE fal2.departure_airport = fal.departure_airport
           AND fal2.arrival_airport = fal.arrival_airport
           AND fal2.departure_time = fal.departure_time AND fal2.airline = fal.airline
           AND fal2.tail_number <> fal.tail_number AND fal2.last_seen > fal.last_seen) AS newer
  FROM departure_log dl
  CROSS JOIN flight_assignment_log fal
    ON fal.tail_number = dl.tail_number AND fal.departure_time = dl.departed_at
   AND fal.departure_airport = dl.airport AND fal.airline = dl.airline
  WHERE dl.airline = ? AND dl.departed_at >= ? AND dl.departed_at < ?
    AND ${tailEquippedSql("dl.tail_number", "dl.airline")}`;

/**
 * Starlink departures that have already left, over the last day, from one
 * airport or from all, under the rule the scheduled count keeps: one flight
 * leaves one airport at one time once, whichever tail flew it and however it
 * is spelled, and counts only under a number the airline sells with a clean
 * destination (a positioning leg is left out here as it is there). A flight
 * seen later on another tail belongs to that tail: counted there if it has
 * Starlink, not at all if not.
 */
export function getStarlinkDeparturesLeft(
  db: Database,
  airline: string,
  nowSec = unixNow(),
  origin?: string
): Array<{ origin: string; departure_time: number }> {
  const cfg = AIRLINES[airline];
  if (!cfg) return [];
  const permalink = canonicalPermalinkFor(cfg);
  const rows = db
    .query(origin ? `${LEFT_SQL} AND dl.airport = ?` : LEFT_SQL)
    .all(
      ...(origin
        ? [airline, nowSec - LEFT_LOOKBACK_SEC, nowSec, origin]
        : [airline, nowSec - LEFT_LOOKBACK_SEC, nowSec])
    ) as Array<{
    origin: string;
    tail: string;
    departure_time: number;
    flight_number: string;
    destination: string | null;
    newer: string | null;
  }>;
  const tails = new Set<string>();
  const left = new Map<string, { origin: string; departure_time: number }>();
  for (const r of rows) {
    const flight = slotFlightKey(r.flight_number, airline);
    if (!flight || !permalink.test(flight)) continue;
    if (!r.destination || !isCleanAirportPair(r.origin, r.destination)) continue;
    if (r.newer?.split(" ").some((n) => slotFlightKey(n, airline) === flight)) continue;
    const tailKey = `${r.origin}|${r.tail}|${r.departure_time}`;
    const flightKey = `${r.origin}|${flight}|${r.departure_time}`;
    if (tails.has(tailKey) || left.has(flightKey)) continue;
    tails.add(tailKey);
    left.set(flightKey, { origin: r.origin, departure_time: r.departure_time });
  }
  return [...left.values()];
}

export interface AirportDayCount {
  airport: string;
  /** The airport's local today, YYYY-MM-DD, and its Starlink departures:
   * those already gone and those still scheduled. */
  today: { date: string; left: number; toGo: number; departures: number };
  /** The airport's local tomorrow: scheduled departures only. */
  tomorrow: { date: string; departures: number };
}

/**
 * Starlink departures on each airport's local today and tomorrow, for every
 * airport with any, most today first. Today is whole: what left is read from
 * the departure archive, what is still to come from the schedule, and the
 * rest of a local day is always inside the 48 hours the schedule holds.
 * One pass over the same slots the airport pages list, so a page's own count
 * and its row here are the same rows.
 */
export function getAirportDayCounts(
  db: Database,
  airline: string,
  nowSec = unixNow()
): AirportDayCount[] {
  const byAirport = new Map<string, AirportDayCount | null>();
  const entryFor = (airport: string) => {
    let entry = byAirport.get(airport);
    if (entry === undefined) {
      const today = airportLocalDate(airport, nowSec);
      const tomorrow = nextLocalDay(airport, nowSec);
      entry =
        today && tomorrow
          ? {
              airport,
              today: { date: today, left: 0, toGo: 0, departures: 0 },
              tomorrow: { date: tomorrow, departures: 0 },
            }
          : null;
      byAirport.set(airport, entry);
    }
    return entry;
  };
  for (const d of getStarlinkDeparturesLeft(db, airline, nowSec)) {
    const entry = entryFor(d.origin);
    if (entry && airportLocalDate(d.origin, d.departure_time) === entry.today.date) {
      entry.today.left++;
    }
  }
  for (const d of bookableStarlinkDepartures(db, airline, nowSec)) {
    const entry = entryFor(d.origin);
    if (!entry) continue;
    const date = airportLocalDate(d.origin, d.departure_time);
    if (date === entry.today.date) entry.today.toGo++;
    else if (date === entry.tomorrow.date) entry.tomorrow.departures++;
  }
  const counts: AirportDayCount[] = [];
  for (const entry of byAirport.values()) {
    if (!entry) continue;
    entry.today.departures = entry.today.left + entry.today.toGo;
    if (entry.today.departures > 0 || entry.tomorrow.departures > 0) counts.push(entry);
  }
  return counts.sort(
    (a, b) =>
      b.today.departures - a.today.departures ||
      b.tomorrow.departures - a.tomorrow.departures ||
      a.airport.localeCompare(b.airport)
  );
}

/**
 * Existence gate for /routes/{airport}: the airline has a departure from it in
 * the schedule or the route cache. Mirrors routeHasData, so every route page's
 * origin has an airport page.
 */
export function airportHasData(db: Database, airport: string, airline: string): boolean {
  if (!ROUTE_AIRPORT_RE.test(airport)) return false;
  const scope = slotScope(airline, true);
  const live = db
    .query(
      `SELECT 1 FROM upcoming_flights uf WHERE ${scope.sql} AND uf.departure_airport = ? LIMIT 1`
    )
    .get(...scope.params, airport);
  if (live) return true;
  const cfg = AIRLINES[airline];
  if (!cfg) return false;
  return Boolean(
    db
      .query("SELECT 1 FROM flight_routes WHERE origin = ? AND flight_number GLOB ? LIMIT 1")
      .get(airport, prefixGlob(cfg.iata))
  );
}

export interface AirportHistoryEntry {
  /** Departures flown by planes that have Starlink, all destinations. */
  starlink: number;
  /** Per destination, most departures first. */
  destinations: Array<{ destination: string; starlink: number }>;
}

export interface AirportHistory {
  days: number;
  /** (from, to] in unix seconds. */
  from: number;
  to: number;
  airports: Map<string, AirportHistoryEntry>;
}

/**
 * The assignment log names the pair; departure_log says the time passed with
 * the tail's row still in the schedule (a late swap can leave the old tail's
 * row there too, so a swap between two Starlink planes counts twice here). Driven from the
 * log, probing departure_log on its (tail, time) index. One tail leaves one
 * airport at one time once, however many spellings logged it.
 */
export const AIRPORT_HISTORY_SQL = `SELECT fal.departure_airport AS origin, fal.arrival_airport AS destination,
       COUNT(DISTINCT fal.tail_number || '|' || fal.departure_time) AS n
  FROM flight_assignment_log fal
  WHERE fal.airline = ? AND fal.departure_time > ? AND fal.departure_time <= ?
    AND fal.arrival_airport IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM departure_log dl
      WHERE dl.tail_number = fal.tail_number AND dl.departed_at = fal.departure_time
        AND dl.airport = fal.departure_airport
    )
    AND ${tailEquippedSql("fal.tail_number", "fal.airline")}
  GROUP BY 1, 2`;

/**
 * Starlink departures per airport and destination over the last
 * AIRPORT_HISTORY_DAYS, for every airport at once: the page, its index rule
 * and the sitemap all read this one pass. Measured back from the airline's
 * newest observation, so a stalled ingest ages nothing out.
 */
export function getAirportHistory(
  db: Database,
  airline: string,
  nowSec = unixNow()
): AirportHistory {
  const anchor = Math.min(nowSec, getObservationAnchor(db, airline, nowSec) || nowSec);
  const from = anchor - AIRPORT_HISTORY_DAYS * DAY_SEC;
  const rows = db.query(AIRPORT_HISTORY_SQL).all(airline, from, anchor) as Array<{
    origin: string;
    destination: string;
    n: number;
  }>;
  const airports = new Map<string, AirportHistoryEntry>();
  for (const r of rows) {
    if (!isCleanAirportPair(r.origin, r.destination)) continue;
    const entry = airports.get(r.origin) ?? { starlink: 0, destinations: [] };
    entry.starlink += r.n;
    entry.destinations.push({ destination: r.destination, starlink: r.n });
    airports.set(r.origin, entry);
  }
  for (const entry of airports.values()) {
    entry.destinations.sort(
      (a, b) => b.starlink - a.starlink || a.destination.localeCompare(b.destination)
    );
  }
  return { days: AIRPORT_HISTORY_DAYS, from, to: anchor, airports };
}
