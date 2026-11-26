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
import { canonicalPermalinkFor } from "../airlines/flight-number";
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
 * The day a "departures a day" count is for: the calendar day after today at
 * the airport, as YYYY-MM-DD. Today is partly flown and the schedule holds
 * only what is still to leave, and the day after tomorrow runs past the 48
 * hours the schedule reaches; tomorrow is the one local day that is always
 * whole inside the window. Null for an airport with no mapped timezone, which
 * has no local day to count.
 */
export function nextLocalDay(airport: string, nowSec = unixNow()): string | null {
  const today = airportLocalDate(airport, nowSec);
  if (!today) return null;
  return new Date(Date.parse(`${today}T00:00:00Z`) + DAY_SEC * 1000).toISOString().slice(0, 10);
}

/** How many of an airport's window departures leave on its `date` (local). */
export function countOnLocalDay(
  airport: string,
  date: string,
  departures: readonly { departure_time: number }[]
): number {
  return departures.filter((d) => airportLocalDate(airport, d.departure_time) === date).length;
}

export interface AirportDayCount {
  airport: string;
  /** The airport's next local day, YYYY-MM-DD. */
  date: string;
  /** Equipped departures scheduled to leave on it. */
  departures: number;
}

/**
 * Starlink departures on each airport's next local day, for every airport
 * with at least one, most first. One pass over the same slots the airport
 * pages list, so a page's own count and its row here are the same rows.
 */
export function getAirportDayCounts(
  db: Database,
  airline: string,
  nowSec = unixNow()
): AirportDayCount[] {
  const byAirport = new Map<string, AirportDayCount>();
  for (const d of bookableStarlinkDepartures(db, airline, nowSec)) {
    let entry = byAirport.get(d.origin);
    if (entry === undefined) {
      const date = nextLocalDay(d.origin, nowSec);
      if (!date) continue;
      entry = { airport: d.origin, date, departures: 0 };
      byAirport.set(d.origin, entry);
    }
    if (airportLocalDate(d.origin, d.departure_time) === entry.date) entry.departures++;
  }
  return [...byAirport.values()]
    .filter((e) => e.departures > 0)
    .sort((a, b) => b.departures - a.departures || a.airport.localeCompare(b.airport));
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
 * The assignment log names the pair; departure_log says the tail really left
 * (a leg swapped away before departure is never archived). Driven from the
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
