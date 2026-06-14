/**
 * Shared test fixtures. The snapshot schema DDL is read once on first use;
 * makeSyntheticDb() returns a fresh in-memory clone per call so write-path
 * tests never touch the shared readonly snapshot.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setupTables } from "../src/database/database";
import type { predictFlight } from "../src/scripts/starlink-predictor";

// Snapshot lives inside the checkout (gitignored) so parallel worktrees never
// truncate each other's open readonly connection via test:setup's `cp`.
// scripts/test-setup.sh derives the same path from its own location.
export const TEST_DB = join(import.meta.dir, "..", ".test-snapshot.sqlite");

/** Readonly handle on the shared snapshot; fails loud when test:setup hasn't run. */
export function openSnapshot(): Database {
  if (!existsSync(TEST_DB)) {
    throw new Error(`missing test snapshot at ${TEST_DB} — run \`bun run test:setup\``);
  }
  return new Database(TEST_DB, { readonly: true });
}

let snapshotDdl: string[] | undefined;

function loadSnapshotDdl(): string[] {
  const src = openSnapshot();
  const rows = src
    .query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name <> 'sqlite_sequence'"
    )
    .all() as { sql: string }[];
  src.close();
  return rows.map((r) => r.sql);
}

export function makeSyntheticDb(): Database {
  snapshotDdl ??= loadSnapshotDdl();
  const db = new Database(":memory:");
  for (const sql of snapshotDdl) db.exec(sql);
  // Tables added since the snapshot was generated (setupTables is idempotent),
  // so a stale .test-snapshot.sqlite doesn't fail write-path tests.
  setupTables(db);
  return db;
}

export const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ── dispatch helpers (shared by isolation + tenant-matrix) ──────────────────

interface Dispatcher {
  dispatch(req: Request): Promise<Response>;
}

export function req(path: string, host: string, init: RequestInit = {}): Request {
  return new Request(`http://x${path}`, {
    ...init,
    headers: { Host: host, ...(init.headers as Record<string, string>) },
  });
}

export async function bodyOf(app: Dispatcher, path: string, host: string, init?: RequestInit) {
  const r = await app.dispatch(req(path, host, init));
  return { status: r.status, text: await r.text() };
}

/** bodyOf + 200 check + JSON.parse; throws (failing the test) on non-200. */
export async function jsonOf(app: Dispatcher, path: string, host: string, init?: RequestInit) {
  const { status, text } = await bodyOf(app, path, host, init);
  if (status !== 200) throw new Error(`${path} → ${status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export function mcpReq(host: string, method: string, params: unknown): Request {
  return req("/mcp", host, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** mcpReq dispatch + 200 check + parsed body (JSON-RPC errors ride in 200s). */
export async function postMcp(app: Dispatcher, host: string, method: string, params?: unknown) {
  const r = await app.dispatch(mcpReq(host, method, params));
  if (r.status !== 200) throw new Error(`mcp ${method} → ${r.status}`);
  return r.json();
}

export const stubPredict = (n = 0) =>
  ((_reader: unknown, flightNumber: string) => ({
    flight_number: flightNumber,
    probability: 0.5,
    confidence: "low" as const,
    method: "fleet_prior_unknown",
    n_observations: n,
  })) as unknown as typeof predictFlight;

/**
 * Seed a starlink_planes row. The wifi literal is 'StrLnk' — the raw sheet
 * value, which is what updateDatabase and addDiscoveredStarlinkPlane write
 * (the snapshot also carries 'Starlink' from non-sheet seed rows).
 */
export function addPlane(
  db: Database,
  tail: string,
  verifiedWifi: string | null = null,
  opts: { airline?: string; aircraft?: string } = {}
): void {
  const { airline = "UA", aircraft = "Boeing 737-900" } = opts;
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
     VALUES (?, 'StrLnk', '2026-01-01', ?, 'United Airlines', 'mainline', ?, ?)`
  ).run(aircraft, tail, verifiedWifi, airline);
}

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
