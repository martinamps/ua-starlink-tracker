/**
 * Shared test fixtures. The snapshot schema DDL is read once at module load;
 * makeSyntheticDb() returns a fresh in-memory clone per call so write-path
 * tests never touch the shared readonly snapshot.
 */

import { Database } from "bun:sqlite";
import type { predictFlight } from "../src/scripts/starlink-predictor";

export const TEST_DB = "/tmp/ua-test.sqlite";

const SNAPSHOT_DDL: string[] = (() => {
  const src = new Database(TEST_DB, { readonly: true });
  const rows = src
    .query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name <> 'sqlite_sequence'"
    )
    .all() as { sql: string }[];
  src.close();
  return rows.map((r) => r.sql);
})();

export function makeSyntheticDb(): Database {
  const db = new Database(":memory:");
  for (const sql of SNAPSHOT_DDL) db.exec(sql);
  return db;
}

export const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const stubPredict = (n = 0) =>
  ((_reader: unknown, flightNumber: string) => ({
    flight_number: flightNumber,
    probability: 0.5,
    confidence: "low" as const,
    method: "fleet_prior_unknown",
    n_observations: n,
  })) as unknown as typeof predictFlight;

export function addFleet(
  db: Database,
  tail: string,
  status: string | null,
  opts: {
    airline?: string;
    aircraftType?: string;
    verifiedWifi?: string | null;
    verifiedAt?: number | null;
  } = {}
): void {
  const {
    airline = "UA",
    aircraftType = "Boeing 737-900",
    verifiedWifi = null,
    verifiedAt = 1,
  } = opts;
  db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, starlink_status, verified_wifi, verified_at, airline)
     VALUES (?, ?, 'test', 1, 1, ?, ?, ?, ?)`
  ).run(tail, aircraftType, status, verifiedWifi, verifiedAt, airline);
}

export function addFlight(
  db: Database,
  tail: string,
  flightNumber: string,
  departureAirport: string,
  departureTimeSec: number,
  opts: { arrivalAirport?: string; airline?: string } = {}
): void {
  const { arrivalAirport = "EWR", airline = "UA" } = opts;
  db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tail,
    flightNumber,
    departureAirport,
    arrivalAirport,
    departureTimeSec,
    departureTimeSec + 3 * 3600,
    departureTimeSec,
    airline
  );
}

export function addQatarRow(
  db: Database,
  flightNumber: string,
  departureTimeSec: number,
  wifiVerdict: string,
  opts: { departureAirport?: string; arrivalAirport?: string; flightStatus?: string } = {}
): void {
  const { departureAirport = "DOH", arrivalAirport = "LHR", flightStatus = "Scheduled" } = opts;
  db.query(
    `INSERT INTO qatar_schedule (flight_number, scheduled_date, departure_airport, arrival_airport, departure_time, arrival_time, equipment_code, wifi_verdict, flight_status, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, '77W', ?, ?, ?)`
  ).run(
    flightNumber,
    new Date(departureTimeSec * 1000).toISOString().slice(0, 10),
    departureAirport,
    arrivalAirport,
    departureTimeSec,
    departureTimeSec + 7 * 3600,
    wifiVerdict,
    flightStatus,
    departureTimeSec
  );
}
