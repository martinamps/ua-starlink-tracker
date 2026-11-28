/**
 * Shared test fixtures. The snapshot schema DDL is read once on first use;
 * makeSyntheticDb() returns a fresh in-memory clone per call so write-path
 * tests never touch the shared readonly snapshot.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AIRPORT_INDEX_MIN_DEPARTURES } from "../src/api/airport-board";
import { handleMcpRequest } from "../src/api/mcp-server";
import { logFlightAssignments } from "../src/database/assignment-log";
import { migrate, setupTables } from "../src/database/database";
import type { Scope, ScopedReader } from "../src/database/reader";
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

/**
 * A writable in-memory copy of the snapshot. The copy's header is set to the
 * rollback journal first: bytes 18 and 19 record WAL when the file was ever
 * left in WAL (openDatabase switches whatever it opens), and an in-memory
 * database with that header fails every statement with "unable to open
 * database file".
 */
export function snapshotInMemory(file = TEST_DB): Database {
  const src = file === TEST_DB ? openSnapshot() : new Database(file, { readonly: true });
  const bytes = src.serialize();
  src.close();
  bytes[18] = 1;
  bytes[19] = 1;
  return Database.deserialize(bytes);
}

let snapshotDdl: string[] | undefined;

function loadSnapshotDdl(): string[] {
  const src = openSnapshot();
  const rows = src
    .query(
      // NOT LIKE 'sqlite_%', not just sqlite_sequence: setupTables now runs
      // ANALYZE, which creates sqlite_stat1 — replaying any internal table's
      // DDL into :memory: throws "reserved for internal use".
      "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
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

/** An empty database built by the real migration alone: no snapshot, no
 * test:setup, so a test that seeds everything itself stays hermetic. */
export function makeFreshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

/**
 * A migrated database in a file, for a test that closes and reopens it.
 * Building the schema on a new file commits each of its ~390 statements by
 * itself, and every commit is an fsync: on a CI runner's disk they averaged
 * ~13 ms in one run, so a first migrate alone could pass a test's 5 s.
 * A reopen in the same process reads the OS page cache, not the platter, so
 * syncing proves nothing here.
 */
export function openFileDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA synchronous = OFF");
  migrate(db);
  return db;
}

/** The HTML from `heading` up to the next <h2>. Throws when the heading is
 * absent, so an assertion on the section can never pass on a missing one. */
export function sectionOf(html: string, heading: string): string {
  const start = html.indexOf(heading);
  if (start < 0) throw new Error(`no section headed "${heading}"`);
  const next = html.indexOf("<h2", start + heading.length);
  return html.slice(start, next < 0 ? undefined : next);
}

/**
 * A rendered page as its reader sees the text: entities decoded and the
 * no-break spaces that tie a code to its city made plain, and the breaks a
 * heading offers inside a slashed name taken out. Compare a heading
 * against this, never against the raw body: React escapes an apostrophe, so
 * "N'Djamena" or "O'Hare" in a heading would fail a raw comparison.
 */
export function readableText(html: string): string {
  return html
    .replace(/<span class="inline-block max-w-full">((?:[^<]|<wbr\/?>)*)<\/span>/g, "$1")
    .replace(/<wbr\/?>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\u00a0/g, " ");
}

/** The attributes of the first element carrying `id`, entity-decoded. */
export function elementAttrs(html: string, id: string): Record<string, string> {
  const tag = html.match(new RegExp(`<[a-z][^>]*\\sid="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no element with id="${id}"`);
  const decode = (v: string) =>
    v
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  return Object.fromEntries(
    [...tag.matchAll(/\s([\w-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])])
  );
}

/** JSON.parse of a <script type="application/json" id="…"> island. */
export function jsonIsland<T = Record<string, unknown>>(html: string, id: string): T {
  const body = html.match(
    new RegExp(`<script type="application/json" id="${id}"[^>]*>([\\s\\S]*?)</script>`)
  )?.[1];
  if (body === undefined) throw new Error(`no JSON island with id="${id}"`);
  return JSON.parse(body) as T;
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

export function mcpReq(
  host: string,
  method: string,
  params: unknown,
  opts: { query?: string; headers?: Record<string, string> } = {}
): Request {
  return req(`/mcp${opts.query ?? ""}`, host, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** mcpReq dispatch + 200 check + parsed body (JSON-RPC errors ride in 200s). */
export async function postMcp(app: Dispatcher, host: string, method: string, params?: unknown) {
  const r = await app.dispatch(mcpReq(host, method, params));
  if (r.status !== 200) throw new Error(`mcp ${method} → ${r.status}`);
  return r.json();
}

/** handleMcpRequest directly (no app, no host routing) + 200 check + parsed body. */
export async function mcpDirect(
  scope: Scope,
  getReader: (scope: Scope) => ScopedReader,
  method: string,
  params: unknown = {}
) {
  const r = await handleMcpRequest(
    mcpReq("unitedstarlinktracker.com", method, params),
    scope,
    getReader
  );
  if (r.status !== 200) throw new Error(`mcp ${method} → ${r.status}`);
  return r.json();
}

/** A tools/call body's first text block and error flag. A JSON-RPC error or
 * a result without text throws: an empty string would let every
 * not.toContain assertion pass vacuously. */
export function toolText(json: {
  error?: unknown;
  result?: { content?: { text?: unknown }[]; isError?: boolean };
}): { text: string; isError: boolean } {
  if (json.error !== undefined) {
    throw new Error(`tools/call returned a JSON-RPC error: ${JSON.stringify(json.error)}`);
  }
  const text = json.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`tools/call result has no text content: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { text, isError: json.result?.isError === true };
}

/** An MCP initialize handshake through the app, parsed. */
export async function mcpInitialize(app: Dispatcher, host: string, query = "") {
  const params = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } };
  return (await app.dispatch(mcpReq(host, "initialize", params, { query }))).json();
}

/** tools/call through the app; resolves to the tool's text and error flag. */
export async function mcpTool(
  app: Dispatcher,
  host: string,
  name: string,
  args: Record<string, unknown> = {}
) {
  return toolText(await postMcp(app, host, "tools/call", { name, arguments: args }));
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
  opts: { arrivalAirport?: string; airline?: string; lastUpdated?: number } = {}
): void {
  const { arrivalAirport = "EWR", airline = "UA", lastUpdated = departureTimeSec } = opts;
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
    lastUpdated,
    airline
  );
}

/**
 * Enough Starlink departures flown from `origin` in the history span for its
 * airport page to index (and so be linked): `tail` must be a Starlink plane.
 * Spread over two to five days back, so no local "today" count moves.
 */
export function addIndexingHistory(
  db: Database,
  tail: string,
  origin: string,
  destination: string,
  now: number,
  airline = "UA"
): void {
  for (let i = 0; i < AIRPORT_INDEX_MIN_DEPARTURES; i++) {
    const departure_time = now - (2 + (i % 4)) * 86400 + i * 600;
    logFlightAssignments(
      db,
      airline,
      tail,
      [
        {
          flight_number: `${airline}${7000 + i}`,
          departure_airport: origin,
          arrival_airport: destination,
          departure_time,
          arrival_time: departure_time + 2 * 3600,
        },
      ],
      now
    );
    db.query(
      "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?, ?, ?, ?)"
    ).run(tail, origin, departure_time, airline);
  }
}

export function addQatarRow(
  db: Database,
  flightNumber: string,
  departureTimeSec: number,
  wifiVerdict: string,
  opts: {
    departureAirport?: string;
    arrivalAirport?: string;
    flightStatus?: string;
    equipmentCode?: string;
  } = {}
): void {
  const {
    departureAirport = "DOH",
    arrivalAirport = "LHR",
    flightStatus = "Scheduled",
    // A fully fitted type: the 777-300ER and 787-8 have held-back aircraft,
    // so their answers are odds, not the plain yes these fixtures stand for.
    equipmentCode = "359",
  } = opts;
  db.query(
    `INSERT INTO qatar_schedule (flight_number, scheduled_date, departure_airport, arrival_airport, departure_time, arrival_time, equipment_code, wifi_verdict, flight_status, last_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    flightNumber,
    new Date(departureTimeSec * 1000).toISOString().slice(0, 10),
    departureAirport,
    arrivalAirport,
    departureTimeSec,
    departureTimeSec + 7 * 3600,
    equipmentCode,
    wifiVerdict,
    flightStatus,
    departureTimeSec
  );
}
