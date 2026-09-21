/**
 * Per-flight aircraft-assignment history (Starlink Watch) and same-day
 * Starlink alternatives on a route.
 *
 * upcoming_flights is rewritten per tail on every refresh, so it can say which
 * tail flies a flight now but never that the tail changed. This log keeps one
 * row per (flight, local date, leg, tail) the updater has ever seen, which is
 * what a swap is: two tails for one leg. Rows come from tails the updater
 * tracks (starlink_planes) and from the legs a check-flight FR24 lookup
 * resolved, so a swap onto an untracked tail nobody has looked up shows up as
 * the flight vanishing, not as a row — consumers must not read absence as a swap.
 */

import type { Database } from "bun:sqlite";
import {
  detectAirline,
  ensureAirlinePrefix,
  normalizeAirlineFlightNumber,
} from "../airlines/flight-number";
import { AIRLINES, type AirlineConfig } from "../airlines/registry";
import type { Flight } from "../types";
import { airportLocalDate, icaoToIata } from "../utils/airport-tz";
import { airlineIn, placeholders } from "./sql/fragments";

export const ASSIGNMENT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS flight_assignment_log (
    airline TEXT NOT NULL,
    flight_number TEXT NOT NULL,
    dep_date TEXT NOT NULL,
    departure_airport TEXT NOT NULL,
    arrival_airport TEXT,
    tail_number TEXT NOT NULL,
    starlink INTEGER,
    departure_time INTEGER,
    arrival_time INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (airline, flight_number, dep_date, departure_airport, tail_number)
  );
  CREATE INDEX IF NOT EXISTS idx_fal_dep_date ON flight_assignment_log(dep_date);
`;

/** Kept past departure so a feed refreshed the day after still shows the swap. */
const ASSIGNMENT_LOG_RETENTION_DAYS = 7;

export interface AssignmentLogRow {
  airline: string;
  flight_number: string;
  dep_date: string;
  departure_airport: string;
  arrival_airport: string | null;
  tail_number: string;
  starlink: number | null;
  departure_time: number | null;
  arrival_time: number | null;
  first_seen: number;
  last_seen: number;
}

function utcDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/** The traveler's printed date: departure-airport local, UTC when unmapped. */
export function departureLocalDate(departureAirport: string, departureTime: number): string {
  return airportLocalDate(icaoToIata(departureAirport), departureTime) ?? utcDate(departureTime);
}

/**
 * 1/0 from the same evidence the verdict engine ranks (a settled united_fleet
 * negative outranks the sheet; an observed non-Starlink provider is a no),
 * null when the tail is in neither table.
 */
function tailStarlinkFlag(db: Database, tailNumber: string): number | null {
  const sp = db
    .query("SELECT verified_wifi FROM starlink_planes WHERE TailNumber = ?")
    .get(tailNumber) as { verified_wifi: string | null } | null;
  const uf = db
    .query("SELECT starlink_status FROM united_fleet WHERE tail_number = ?")
    .get(tailNumber) as { starlink_status: string | null } | null;
  if (uf?.starlink_status === "negative") return 0;
  if (sp) return sp.verified_wifi !== null && sp.verified_wifi !== "Starlink" ? 0 : 1;
  if (uf?.starlink_status === "confirmed") return 1;
  return null;
}

/** Upsert one row per scheduled leg; first_seen survives, last_seen moves. */
export function logFlightAssignments(
  db: Database,
  airline: string,
  tailNumber: string,
  flights: Pick<
    Flight,
    "flight_number" | "departure_airport" | "arrival_airport" | "departure_time" | "arrival_time"
  >[],
  now: number
): void {
  if (flights.length === 0) return;
  const cfg = AIRLINES[airline];
  const starlink = tailStarlinkFlag(db, tailNumber);
  const upsert = db.prepare(`
    INSERT INTO flight_assignment_log
      (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number,
       starlink, departure_time, arrival_time, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (airline, flight_number, dep_date, departure_airport, tail_number) DO UPDATE SET
      arrival_airport = excluded.arrival_airport,
      starlink = excluded.starlink,
      departure_time = excluded.departure_time,
      arrival_time = excluded.arrival_time,
      last_seen = excluded.last_seen
  `);
  for (const f of flights) {
    if (!f.flight_number || !f.departure_airport) continue;
    const flightNumber = cfg
      ? ensureAirlinePrefix(cfg, f.flight_number)
      : f.flight_number.trim().toUpperCase();
    upsert.run(
      airline,
      flightNumber,
      departureLocalDate(f.departure_airport, f.departure_time),
      f.departure_airport,
      f.arrival_airport || null,
      tailNumber,
      starlink,
      f.departure_time,
      f.arrival_time,
      now,
      now
    );
  }
}

export interface ResolvedLeg {
  tail_number: string;
  origin: string;
  destination: string;
  departure_time: number;
  arrival_time: number;
}

/**
 * The legs a request-path FR24 lookup answered with, so DB-only readers (the
 * Watch feed) can serve the same tail without their own FR24 call.
 * Best-effort: readonly DBs (tests, MCP snapshot) just skip.
 */
export function logResolvedAssignments(
  db: Database,
  airlines: readonly string[],
  flightNumber: string,
  legs: readonly ResolvedLeg[],
  now: number
): void {
  const cfg = detectAirline(
    flightNumber,
    airlines.map((a) => AIRLINES[a]).filter((c): c is AirlineConfig => !!c)
  );
  if (!cfg) return;
  const byTail = new Map<string, ResolvedLeg[]>();
  for (const l of legs) byTail.set(l.tail_number, [...(byTail.get(l.tail_number) ?? []), l]);
  try {
    for (const [tail, tailLegs] of byTail) {
      logFlightAssignments(
        db,
        cfg.code,
        tail,
        tailLegs.map((l) => ({
          flight_number: flightNumber,
          departure_airport: l.origin,
          arrival_airport: l.destination,
          departure_time: l.departure_time,
          arrival_time: l.arrival_time,
        })),
        now
      );
    }
  } catch {}
}

export function pruneAssignmentLog(db: Database, now: number): void {
  db.query("DELETE FROM flight_assignment_log WHERE dep_date < ?").run(
    utcDate(now - ASSIGNMENT_LOG_RETENTION_DAYS * 86400)
  );
}

/** Every tail seen assigned to the flight on its local date, oldest first. */
export function getAssignmentHistory(
  db: Database,
  airlines: readonly string[],
  variants: readonly string[],
  depDate: string
): AssignmentLogRow[] {
  if (variants.length === 0) return [];
  const a = airlineIn(airlines);
  return db
    .query(
      `SELECT * FROM flight_assignment_log
       WHERE ${a.sql} AND flight_number IN (${placeholders(variants)}) AND dep_date = ?
       ORDER BY first_seen ASC, tail_number ASC`
    )
    .all(...a.params, ...variants, depDate) as AssignmentLogRow[];
}

export interface SameDayAlternative {
  flight_number: string;
  departure_time: number;
  tail_number: string;
  aircraft_type: string | null;
}

export interface SameDayAlternativesQuery {
  origin: string;
  destination: string;
  /** Departure-airport local date the traveler is flying. */
  dateLocal: string;
  /** Center of the window — the original flight's departure. */
  aroundUnix: number;
  windowH?: number;
  /** Marketing numbers to leave out (the flight being asked about). */
  exclude?: readonly string[];
  now?: number;
  limit?: number;
}

// ATC callsigns (SKW485Y) aren't bookable flight numbers and alias a real
// marketed departure in the same slot.
const CALLSIGN_SHAPED = /^[A-Z]{2,3}\d{1,4}[A-Z]$/;

/**
 * Other departures on the exact origin→destination pair that day on tails not
 * known to be non-Starlink. Scoped by upcoming_flights.airline, so SkyWest rows
 * flown for another tenant (OO/SKW numbers under AS) never leak across.
 * Same-slot duplicates (a stale row left on the pre-swap tail) collapse to the
 * most recently refreshed row.
 */
export function getSameDayStarlinkAlternatives(
  db: Database,
  airlines: readonly string[],
  q: SameDayAlternativesQuery
): SameDayAlternative[] {
  const now = q.now ?? Math.floor(Date.now() / 1000);
  const windowSec = (q.windowH ?? 10) * 3600;
  const a = airlineIn(airlines, "uf.airline");
  const rows = db
    .query(
      `SELECT uf.flight_number, uf.departure_time, uf.tail_number, uf.airline,
              sp.Aircraft AS aircraft_type,
              CASE WHEN neg.tail_number IS NOT NULL
                     OR (sp.verified_wifi IS NOT NULL AND sp.verified_wifi <> 'Starlink')
                   THEN 1 ELSE 0 END AS non_starlink
       FROM upcoming_flights uf
       INNER JOIN starlink_planes sp ON sp.TailNumber = uf.tail_number
       LEFT JOIN united_fleet neg
         ON neg.tail_number = uf.tail_number AND neg.starlink_status = 'negative'
       WHERE ${a.sql}
         AND uf.departure_airport = ? AND uf.arrival_airport = ?
         AND uf.departure_time > ? AND uf.departure_time BETWEEN ? AND ?
       ORDER BY uf.departure_time ASC, uf.last_updated DESC`
    )
    .all(
      ...a.params,
      q.origin,
      q.destination,
      now,
      q.aroundUnix - windowSec,
      q.aroundUnix + windowSec
    ) as (SameDayAlternative & { airline: string; non_starlink: number })[];

  const exclude = new Set(q.exclude ?? []);
  const seenSlots = new Set<number>();
  const out: SameDayAlternative[] = [];
  for (const r of rows) {
    if (!r.flight_number || CALLSIGN_SHAPED.test(r.flight_number)) continue;
    if (seenSlots.has(r.departure_time)) continue;
    seenSlots.add(r.departure_time);
    // After the slot claim: a stale Starlink row must not outlive the swap
    // that moved its departure onto a non-Starlink tail.
    if (r.non_starlink) continue;
    if (departureLocalDate(q.origin, r.departure_time) !== q.dateLocal) continue;
    const cfg = AIRLINES[r.airline];
    const flightNumber = cfg ? normalizeAirlineFlightNumber(cfg, r.flight_number) : r.flight_number;
    if (exclude.has(flightNumber) || exclude.has(r.flight_number)) continue;
    out.push({
      flight_number: flightNumber,
      departure_time: r.departure_time,
      tail_number: r.tail_number,
      aircraft_type: r.aircraft_type ?? null,
    });
    if (out.length >= (q.limit ?? 3)) break;
  }
  return out;
}
