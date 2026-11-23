/**
 * Readers behind /routes/{airport}: what leaves one airport on a Starlink
 * plane, and how that compares with everything the airline flies there.
 *
 * The schedule tables hold tracked tails only (the updater follows the
 * Starlink roster), so they can count Starlink departures but never an
 * airport's whole schedule. The one stored record of every departure is the
 * DOT census (bts_monthly_routes: United-marketed, US domestic, months old),
 * which is why the share is a rate against a named month and not a count of
 * this week's flights.
 */

import type { Database } from "bun:sqlite";
import { canonicalPermalinkFor } from "../airlines/flight-number";
import { AIRLINES } from "../airlines/registry";
import { airportCountry } from "../utils/airport-geo";
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

/** The census is published about two months behind; past this it is no longer
 * a fair picture of the schedule and the share is left off. */
const CENSUS_MAX_AGE_DAYS = 240;

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
  /** The same, to US airports only: the census's own scope. */
  domestic: number;
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
    const entry = airports.get(r.origin) ?? { starlink: 0, domestic: 0, destinations: [] };
    entry.starlink += r.n;
    if (airportCountry(r.origin) === "US" && airportCountry(r.destination) === "US") {
      entry.domestic += r.n;
    }
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

export interface AirportCensus {
  /** "2026-08". */
  month: string;
  daysInMonth: number;
  /** Departures performed from each origin that month. */
  performed: Map<string, number>;
}

/**
 * The newest census month's departures per origin. United only: the table has
 * no airline column and bts-sync ingests United-marketed flights. Null when
 * there is no census or its newest month is too old to compare against.
 */
export function getAirportCensus(
  db: Database,
  airline: string,
  nowSec = unixNow()
): AirportCensus | null {
  if (airline !== "UA") return null;
  const newest = db.query("SELECT MAX(month) AS month FROM bts_monthly_routes").get() as {
    month: string | null;
  } | null;
  const month = newest?.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, mon] = month.split("-").map(Number);
  const monthEnd = Date.UTC(year, mon, 1) / 1000;
  if (nowSec - monthEnd > CENSUS_MAX_AGE_DAYS * DAY_SEC) return null;
  const rows = db
    .query(
      "SELECT origin, SUM(performed) AS performed FROM bts_monthly_routes WHERE month = ? GROUP BY origin"
    )
    .all(month) as Array<{ origin: string; performed: number }>;
  return {
    month,
    daysInMonth: new Date(Date.UTC(year, mon, 0)).getUTCDate(),
    performed: new Map(rows.map((r) => [r.origin, r.performed])),
  };
}
