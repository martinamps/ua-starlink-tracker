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
 * Equipped departures from one airport in the next 48 hours: the airport's
 * slice of the slots /routes counts, under the numbers the airline sells.
 * A slot with no bookable number (an ATC callsign on a positioning leg) or no
 * clean destination would be a dead link, so it is left off, as on the route
 * pages.
 */
export function getAirportStarlinkDepartures(
  db: Database,
  airline: string,
  airport: string,
  nowSec = unixNow()
): AirportDepartureRow[] {
  const cfg = AIRLINES[airline];
  if (!cfg) return [];
  const permalink = canonicalPermalinkFor(cfg);
  return getDepartureSlots(db, airline, {
    from: nowSec,
    to: nowSec + DEPARTURE_WINDOW_SEC,
    partners: true,
    origin: airport,
  }).flatMap((r) =>
    r.equipped === 1 &&
    r.slot_flight &&
    permalink.test(r.slot_flight) &&
    isCleanAirportPair(r.departure_airport, r.arrival_airport)
      ? [
          {
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
