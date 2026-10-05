import type { Database } from "bun:sqlite";
import { canonicalPermalinkFor, slotFlightKey } from "../airlines/flight-number";
import { AIRLINES } from "../airlines/registry";
import { slotScope } from "./database";
import { listedVerifiedSql, tailEquippedSql } from "./sql/equipped";

/**
 * One observed departure of a marketed flight on a pair, from the assignment
 * log: the only table that keeps a departure time, a tail and a pair together
 * for every leg the updater or a lookup saw, past (a week) and upcoming (about
 * two days out). Operating spellings (UAL368, SKW5212) are already collapsed to
 * the marketed number, the same key /api/routes counts as slot_flight.
 */
export interface RouteFlightLeg {
  flight_number: string;
  /** Departure-airport local date the leg flies on. */
  dep_date: string;
  departure_time: number;
  tail_number: string;
  aircraft_type: string | null;
  /** equippedSql over the tail's listing. */
  equipped: boolean;
  /** Equipped and observed on Starlink (the "verified" tier). */
  verified: boolean;
  /** When this tail was last seen on the leg; the newest tail per day wins a swap. */
  last_seen: number;
}

export function getRouteFlightLegs(
  db: Database,
  airline: string,
  origin: string,
  destination: string
): RouteFlightLeg[] {
  const cfg = AIRLINES[airline];
  if (!cfg) return [];
  // Partners count, as departure slots count them: AS832 on a Hawaiian A330
  // is an Alaska departure on the pair.
  const scope = slotScope(airline, true);
  const rows = db
    .query(
      `SELECT uf.airline, uf.flight_number, uf.dep_date, uf.departure_time, uf.tail_number,
              uf.last_seen,
              COALESCE(
                (SELECT f.aircraft_type FROM united_fleet f
                 WHERE f.tail_number = uf.tail_number AND f.airline = uf.airline),
                (SELECT sp.Aircraft FROM starlink_planes sp
                 WHERE sp.TailNumber = uf.tail_number AND sp.airline = uf.airline
                 ORDER BY sp.id LIMIT 1)
              ) AS aircraft_type,
              CASE WHEN ${tailEquippedSql("uf.tail_number", "uf.airline")} THEN 1 ELSE 0 END
                AS equipped,
              CASE WHEN ${listedVerifiedSql("uf.tail_number", "uf.airline")} THEN 1 ELSE 0 END
                AS listed_verified
       FROM flight_assignment_log uf
       WHERE uf.departure_airport = ? AND uf.arrival_airport = ?
         AND uf.departure_time IS NOT NULL AND ${scope.sql}`
    )
    .all(origin, destination, ...scope.params) as Array<{
    airline: string;
    flight_number: string;
    dep_date: string;
    departure_time: number;
    tail_number: string;
    last_seen: number;
    aircraft_type: string | null;
    equipped: number;
    listed_verified: number;
  }>;

  // A key that is no permalink of the airline is an ATC callsign (SKW312R) or
  // a positioning leg nobody books.
  const marketed = canonicalPermalinkFor(cfg);
  const out: RouteFlightLeg[] = [];
  for (const r of rows) {
    const fn = slotFlightKey(r.flight_number, r.airline);
    if (!fn || !marketed.test(fn)) continue;
    out.push({
      flight_number: fn,
      dep_date: r.dep_date,
      departure_time: r.departure_time,
      tail_number: r.tail_number,
      aircraft_type: r.aircraft_type,
      equipped: r.equipped === 1,
      verified: r.equipped === 1 && r.listed_verified === 1,
      last_seen: r.last_seen,
    });
  }
  return out;
}
