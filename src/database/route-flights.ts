import type { Database } from "bun:sqlite";
import { canonicalPermalinkFor, slotFlightKey } from "../airlines/flight-number";
import { AIRLINES } from "../airlines/registry";
import { departureLocalDate } from "./assignment-log";
import { getDepartureSlots, slotScope } from "./database";
import { listedVerifiedSql, tailEquippedSql } from "./sql/equipped";
import { tailAircraftTypeSql } from "./sql/fragments";
import { DEPARTURE_WINDOW_SEC } from "./sql/windows";

/**
 * One observed departure of a marketed flight, from the assignment log (the
 * only table that keeps a departure time, a tail and a pair together for
 * every leg the updater or a lookup saw: a week back, about two days ahead)
 * and the live schedule. Operating spellings (UAL368, SKW5212) are already
 * collapsed to the marketed number, the key /api/routes counts as slot_flight.
 */
export interface RouteFlightLeg {
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
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

type LegFilter = { origin: string; destination: string } | null;

function loggedLegs(db: Database, airline: string, filter: LegFilter): RouteFlightLeg[] {
  const cfg = AIRLINES[airline];
  if (!cfg) return [];
  // Partners count, as departure slots count them: AS832 on a Hawaiian A330
  // is an Alaska departure on the pair.
  const scope = slotScope(airline, true);
  const where = filter
    ? {
        sql: "uf.departure_airport = ? AND uf.arrival_airport = ?",
        params: [filter.origin, filter.destination],
      }
    : { sql: "1=1", params: [] as string[] };
  const rows = db
    .query(
      `SELECT uf.airline, uf.flight_number, uf.departure_airport, uf.arrival_airport, uf.dep_date,
              uf.departure_time, uf.tail_number, uf.last_seen,
              ${tailAircraftTypeSql("uf.tail_number", "uf.airline")} AS aircraft_type,
              CASE WHEN ${tailEquippedSql("uf.tail_number", "uf.airline")} THEN 1 ELSE 0 END
                AS equipped,
              CASE WHEN ${listedVerifiedSql("uf.tail_number", "uf.airline")} THEN 1 ELSE 0 END
                AS listed_verified
       FROM flight_assignment_log uf
       WHERE ${where.sql} AND uf.departure_time IS NOT NULL AND uf.arrival_airport IS NOT NULL
         AND ${scope.sql}`
    )
    .all(...where.params, ...scope.params) as Array<{
    airline: string;
    flight_number: string;
    departure_airport: string;
    arrival_airport: string;
    dep_date: string;
    departure_time: number;
    tail_number: string;
    last_seen: number;
    aircraft_type: string | null;
    equipped: number;
    listed_verified: number;
  }>;
  return rows.map((r) => ({
    flight_number: slotFlightKey(r.flight_number, r.airline) ?? r.flight_number,
    departure_airport: r.departure_airport,
    arrival_airport: r.arrival_airport,
    dep_date: r.dep_date,
    departure_time: r.departure_time,
    tail_number: r.tail_number,
    aircraft_type: r.aircraft_type,
    equipped: r.equipped === 1,
    verified: r.equipped === 1 && r.listed_verified === 1,
    last_seen: r.last_seen,
  }));
}

/** The live schedule's next two days on a pair, which the log may not hold yet. */
function scheduledLegs(
  db: Database,
  airline: string,
  origin: string,
  destination: string,
  nowSec: number
): RouteFlightLeg[] {
  return getDepartureSlots(db, airline, {
    from: nowSec,
    to: nowSec + DEPARTURE_WINDOW_SEC,
    partners: true,
    origin,
    destination,
  }).flatMap((s) =>
    s.slot_flight
      ? [
          {
            flight_number: s.slot_flight,
            departure_airport: s.departure_airport,
            arrival_airport: s.arrival_airport,
            dep_date: departureLocalDate(s.departure_airport, s.departure_time),
            departure_time: s.departure_time,
            tail_number: s.tail_number,
            aircraft_type: s.aircraft_type,
            equipped: s.equipped === 1,
            verified: s.equipped === 1 && s.verified_wifi === "Starlink",
            last_seen: s.last_updated,
          },
        ]
      : []
  );
}

/** Marketed departures on a pair: logged, plus the live schedule. A key that is
 * no permalink of the airline (an ATC callsign such as SKW312R) is dropped. */
export function getRouteFlightLegs(
  db: Database,
  airline: string,
  origin: string,
  destination: string,
  nowSec: number
): RouteFlightLeg[] {
  const cfg = AIRLINES[airline];
  if (!cfg) return [];
  const marketed = canonicalPermalinkFor(cfg);
  return [
    ...loggedLegs(db, airline, { origin, destination }),
    ...scheduledLegs(db, airline, origin, destination, nowSec),
  ].filter((l) => marketed.test(l.flight_number));
}

/** Every logged leg of the airline, on every pair: the per-leg model's input. */
export function getAllFlightLegs(db: Database, airline: string): RouteFlightLeg[] {
  return loggedLegs(db, airline, null);
}
