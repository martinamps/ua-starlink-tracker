import { Database } from "bun:sqlite";
import {
  normalizeAircraftType,
  normalizeFleet,
  normalizeWifiProvider,
} from "../observability/metrics";
import type {
  Aircraft,
  AirportDepartures,
  BodyClass,
  FleetAircraft,
  FleetCarrier,
  FleetDiscoveryStats,
  FleetFamily,
  FleetPageData,
  FleetSource,
  FleetStats,
  FleetTail,
  Flight,
  StarlinkStatus,
  WifiProvider,
} from "../types";
import { DB_PATH } from "../utils/constants";
import { info } from "../utils/logger";

type MetaRow = { value: string };

/** Append `AND <alias.>airline = ?` and the param when scope is set. */
export type AirlineFilter = string | readonly string[] | undefined;

function filterKey(f: AirlineFilter): string {
  if (f === undefined) return "ALL";
  return Array.isArray(f) ? f.join(",") : (f as string);
}

function withAirline(
  sql: string,
  airline: AirlineFilter,
  alias = "",
  params: (string | number)[] = []
): { sql: string; params: (string | number)[] } {
  if (airline === undefined) return { sql, params };
  const col = alias ? `${alias}.airline` : "airline";
  if (typeof airline === "string") {
    return { sql: `${sql} AND ${col} = ?`, params: [...params, airline] };
  }
  if (airline.length === 0) return { sql: `${sql} AND 1=0`, params };
  const placeholders = airline.map(() => "?").join(",");
  return { sql: `${sql} AND ${col} IN (${placeholders})`, params: [...params, ...airline] };
}

export function initializeDatabase() {
  const db = new Database(DB_PATH);

  // Enable WAL mode for better concurrent access (prevents SQLITE_BUSY errors)
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000"); // Wait up to 5s if database is locked

  setupTables(db);
  return db;
}

function tableExists(db: Database, tableName: string) {
  return db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
}

export type VerificationSource = "united" | "flightradar24" | "spreadsheet";

export interface VerificationLogEntry {
  id?: number;
  tail_number: string;
  source: VerificationSource;
  checked_at: number;
  has_starlink: boolean | null;
  wifi_provider: string | null;
  aircraft_type: string | null;
  flight_number: string | null;
  error: string | null;
  tail_confirmed?: number | null;
}

function setupTables(db: Database) {
  // Create starlink_verification_log table
  if (!tableExists(db, "starlink_verification_log")) {
    db.query(`
      CREATE TABLE starlink_verification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tail_number TEXT NOT NULL,
        source TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        has_starlink INTEGER,
        wifi_provider TEXT,
        aircraft_type TEXT,
        flight_number TEXT,
        error TEXT
      );
    `).run();

    // Create index for fast lookups by tail_number and source
    db.query(`
      CREATE INDEX idx_verification_tail_source
      ON starlink_verification_log(tail_number, source, checked_at DESC);
    `).run();
  }

  {
    const columns = db.query("PRAGMA table_info(starlink_verification_log)").all();
    const hasTailConfirmed = columns.some((col: any) => col.name === "tail_confirmed");
    if (!hasTailConfirmed) {
      db.query("ALTER TABLE starlink_verification_log ADD COLUMN tail_confirmed INTEGER").run();
      info("Database migration: added starlink_verification_log.tail_confirmed");
    }
  }

  if (!tableExists(db, "starlink_planes")) {
    db.query(
      `
      CREATE TABLE starlink_planes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aircraft TEXT,
        wifi TEXT,
        sheet_gid TEXT,
        sheet_type TEXT,
        DateFound TEXT,
        TailNumber TEXT,
        OperatedBy TEXT,
        fleet TEXT,
        last_flight_check INTEGER DEFAULT 0,
        last_check_successful INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0
      );`
    ).run();
  }

  if (!tableExists(db, "meta")) {
    db.query(
      `
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `
    ).run();
  }

  // Create united_fleet table for fleet-wide discovery
  if (!tableExists(db, "united_fleet")) {
    db.query(`
      CREATE TABLE united_fleet (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tail_number TEXT UNIQUE NOT NULL,
        aircraft_type TEXT,

        -- Source tracking
        first_seen_source TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,

        -- Fleet info
        fleet TEXT DEFAULT 'unknown',
        operated_by TEXT,

        -- Verification state
        starlink_status TEXT DEFAULT 'unknown',
        verified_wifi TEXT,
        verified_at INTEGER,

        -- Discovery scheduling
        discovery_priority REAL DEFAULT 0.5,
        next_check_after INTEGER DEFAULT 0,
        check_attempts INTEGER DEFAULT 0,
        last_check_error TEXT
      );
    `).run();

    // Create index for efficient discovery queries
    db.query(`
      CREATE INDEX idx_fleet_discovery ON united_fleet(
        starlink_status, discovery_priority DESC, next_check_after
      );
    `).run();

    db.query(`
      CREATE INDEX idx_fleet_tail ON united_fleet(tail_number);
    `).run();

    info("Created united_fleet table for fleet-wide discovery");
  }

  {
    const columns = db.query("PRAGMA table_info(united_fleet)").all();
    const hasShipNumber = columns.some((col: any) => col.name === "ship_number");
    if (!hasShipNumber) {
      db.query("ALTER TABLE united_fleet ADD COLUMN ship_number TEXT").run();
      db.query("CREATE INDEX IF NOT EXISTS idx_uf_ship ON united_fleet(ship_number)").run();
      info("Database migration: added united_fleet.ship_number");
    }
  }

  if (!tableExists(db, "upcoming_flights")) {
    db.query(
      `
      CREATE TABLE upcoming_flights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tail_number TEXT,
        flight_number TEXT,
        departure_airport TEXT,
        arrival_airport TEXT,
        departure_time INTEGER,
        arrival_time INTEGER,
        last_updated INTEGER,
        FOREIGN KEY (tail_number) REFERENCES starlink_planes(TailNumber)
      );`
    ).run();
  }

  // Rolling 30d log of departed Starlink flights, one row per departure.
  // Populated by updateFlights() archiving rows whose departure_time has
  // passed before the per-tail DELETE. Enables trailing-window queries
  // that upcoming_flights (forward-only ~47h cache) can't answer.
  if (!tableExists(db, "departure_log")) {
    db.query(`
      CREATE TABLE departure_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tail_number TEXT NOT NULL,
        airport TEXT NOT NULL,
        departed_at INTEGER NOT NULL
      );
      CREATE INDEX idx_dl_departed ON departure_log(departed_at);
      CREATE INDEX idx_dl_airport ON departure_log(airport);
    `).run();
  }

  // Persistent FR24 route lookup cache. Append-only: builds route knowledge over
  // time (which routes a flight number operates, durations) and reduces FR24 calls.
  // Also backfills mainline route data that upcoming_flights can't provide
  // (we only track Starlink planes).
  if (!tableExists(db, "flight_routes")) {
    db.query(`
      CREATE TABLE flight_routes (
        flight_number TEXT NOT NULL,
        origin TEXT NOT NULL,
        destination TEXT NOT NULL,
        duration_sec INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        seen_count INTEGER DEFAULT 1,
        PRIMARY KEY (flight_number, origin, destination)
      );
      CREATE INDEX idx_fr_flight ON flight_routes(flight_number);
      CREATE INDEX idx_fr_route ON flight_routes(origin, destination);
    `).run();
  }

  if (tableExists(db, "starlink_planes")) {
    const columns = db.query("PRAGMA table_info(starlink_planes)").all();
    const migrationsRun = [];

    const hasLastFlightCheck = columns.some((col: any) => col.name === "last_flight_check");
    if (!hasLastFlightCheck) {
      db.query("ALTER TABLE starlink_planes ADD COLUMN last_flight_check INTEGER DEFAULT 0").run();
      migrationsRun.push("last_flight_check");

      // Stagger initial check times for planes with existing flight data
      if (tableExists(db, "upcoming_flights")) {
        const now = Math.floor(Date.now() / 1000);
        const migrationQuery = `
          UPDATE starlink_planes
          SET last_flight_check = ?
          WHERE TailNumber IN (
            SELECT DISTINCT tail_number FROM upcoming_flights
          )
        `;
        const randomHoursAgo = now - Math.floor(Math.random() * 4 + 1) * 60 * 60;
        db.query(migrationQuery).run(randomHoursAgo);
      }
    }

    const hasLastCheckSuccessful = columns.some((col: any) => col.name === "last_check_successful");
    if (!hasLastCheckSuccessful) {
      db.query(
        "ALTER TABLE starlink_planes ADD COLUMN last_check_successful INTEGER DEFAULT 0"
      ).run();
      migrationsRun.push("last_check_successful");

      if (tableExists(db, "upcoming_flights")) {
        db.query(`
          UPDATE starlink_planes
          SET last_check_successful = 1
          WHERE TailNumber IN (
            SELECT DISTINCT tail_number FROM upcoming_flights
          )
        `).run();
      }
    }

    const hasConsecutiveFailures = columns.some((col: any) => col.name === "consecutive_failures");
    if (!hasConsecutiveFailures) {
      db.query(
        "ALTER TABLE starlink_planes ADD COLUMN consecutive_failures INTEGER DEFAULT 0"
      ).run();
      migrationsRun.push("consecutive_failures");
    }

    // Add verified_wifi column - stores what United.com actually reports
    const hasVerifiedWifi = columns.some((col: any) => col.name === "verified_wifi");
    if (!hasVerifiedWifi) {
      db.query("ALTER TABLE starlink_planes ADD COLUMN verified_wifi TEXT DEFAULT NULL").run();
      migrationsRun.push("verified_wifi");
    }

    // Add verified_at timestamp
    const hasVerifiedAt = columns.some((col: any) => col.name === "verified_at");
    if (!hasVerifiedAt) {
      db.query("ALTER TABLE starlink_planes ADD COLUMN verified_at INTEGER DEFAULT NULL").run();
      migrationsRun.push("verified_at");
    }

    if (migrationsRun.length > 0) {
      info(`Database migrations completed: ${migrationsRun.join(", ")}`);
    }
  }

  migrateMultiAirline(db);
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === column
  );
}

function migrateMultiAirline(db: Database) {
  const tables = [
    "starlink_planes",
    "united_fleet",
    "upcoming_flights",
    "starlink_verification_log",
    "departure_log",
  ];
  const added: string[] = [];
  for (const t of tables) {
    if (!hasColumn(db, t, "airline")) {
      db.query(`ALTER TABLE ${t} ADD COLUMN airline TEXT NOT NULL DEFAULT 'UA'`).run();
      added.push(t);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sp_airline   ON starlink_planes(airline);
    CREATE INDEX IF NOT EXISTS idx_uf_airline   ON united_fleet(airline, starlink_status);
    CREATE INDEX IF NOT EXISTS idx_upf_airline  ON upcoming_flights(airline, flight_number);
    CREATE INDEX IF NOT EXISTS idx_vlog_airline ON starlink_verification_log(airline, tail_number);
  `);

  const renamed = db
    .query("UPDATE meta SET key = 'UA:' || key WHERE key NOT LIKE '%:%'")
    .run().changes;

  if (added.length > 0 || renamed > 0) {
    info(
      `Database migration: airline column added to [${added.join(", ")}]; ${renamed} meta keys namespaced`
    );
  }
}

export function updateDatabase(
  db: Database,
  totalAircraftCount: number,
  starlinkAircraft: Partial<Aircraft>[],
  fleetStats: FleetStats,
  airline = "UA"
) {
  db.transaction(() => {
    // Get existing data before clearing the table
    const existingDates = new Map<string, string>();
    const existingAircraft = new Map<string, string>();
    const existingFlightChecks = new Map<
      string,
      { last_flight_check: number; last_check_successful: number; consecutive_failures: number }
    >();
    const existingVerification = new Map<
      string,
      { verified_wifi: string | null; verified_at: number | null }
    >();

    const existingPlanes = db
      .query(
        "SELECT TailNumber, DateFound, aircraft, last_flight_check, last_check_successful, consecutive_failures, verified_wifi, verified_at FROM starlink_planes WHERE airline = ?"
      )
      .all(airline) as {
      TailNumber: string;
      DateFound: string;
      aircraft: string | null;
      last_flight_check: number;
      last_check_successful: number;
      consecutive_failures: number;
      verified_wifi: string | null;
      verified_at: number | null;
    }[];

    for (const plane of existingPlanes) {
      if (plane.TailNumber) {
        if (plane.DateFound) {
          existingDates.set(plane.TailNumber, plane.DateFound);
        }
        if (plane.aircraft) {
          existingAircraft.set(plane.TailNumber, plane.aircraft);
        }
        // Preserve flight check data to avoid resetting on every scraper run
        existingFlightChecks.set(plane.TailNumber, {
          last_flight_check: plane.last_flight_check || 0,
          last_check_successful: plane.last_check_successful || 0,
          consecutive_failures: plane.consecutive_failures || 0,
        });
        // Preserve verification data
        existingVerification.set(plane.TailNumber, {
          verified_wifi: plane.verified_wifi,
          verified_at: plane.verified_at,
        });
      }
    }

    // Secondary source for aircraft type when sheet cell is blank: united_fleet
    // is populated by FR24 fleet sync (f.aircraft.model.text).
    const fleetAircraftTypes = new Map<string, string>();
    for (const row of db
      .query(
        "SELECT tail_number, aircraft_type FROM united_fleet WHERE aircraft_type IS NOT NULL AND aircraft_type <> '' AND airline = ?"
      )
      .all(airline) as Array<{ tail_number: string; aircraft_type: string }>) {
      fleetAircraftTypes.set(row.tail_number, row.aircraft_type);
    }

    // Update meta data
    // Only delete spreadsheet planes, preserve discovered ones (sheet_gid = 'discovery')
    db.query("DELETE FROM starlink_planes WHERE sheet_gid != 'discovery' AND airline = ?").run(
      airline
    );
    setMeta(db, "totalAircraftCount", totalAircraftCount, airline);
    setMeta(db, "lastUpdated", new Date().toISOString(), airline);

    // Store fleet statistics
    for (const [fleetType, stats] of Object.entries(fleetStats)) {
      for (const [metric, value] of Object.entries(stats)) {
        const key = `${fleetType}${metric.charAt(0).toUpperCase() + metric.slice(1)}`;
        setMeta(
          db,
          key,
          metric === "percentage" ? (value as number).toFixed(2) : String(value),
          airline
        );
      }
    }

    // Get discovered planes so we don't duplicate them
    const discoveredTails = new Set(
      (
        db
          .query(
            "SELECT TailNumber FROM starlink_planes WHERE sheet_gid = 'discovery' AND airline = ?"
          )
          .all(airline) as {
          TailNumber: string;
        }[]
      ).map((r) => r.TailNumber)
    );

    // Insert aircraft data
    const insertStmt = db.prepare(`
      INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, last_flight_check, last_check_successful, consecutive_failures, verified_wifi, verified_at, airline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Sheet now lists a plane that discovery found first: promote the row with
    // sheet metadata but keep DateFound/verified_wifi/last_flight_check intact.
    const updateDiscoveredStmt = db.prepare(`
      UPDATE starlink_planes
      SET aircraft = ?, OperatedBy = ?, fleet = ?, sheet_gid = ?, sheet_type = ?, wifi = ?
      WHERE TailNumber = ? AND sheet_gid = 'discovery' AND airline = ?
    `);

    for (const aircraft of starlinkAircraft) {
      const tailNumber = aircraft.TailNumber || "";

      // Sheet value wins if present; otherwise preserve what we had; otherwise
      // fall back to united_fleet (FR24-sourced). Prevents blank sheet cells
      // from wiping a known type every hour.
      const aircraftType =
        aircraft.Aircraft ||
        existingAircraft.get(tailNumber) ||
        fleetAircraftTypes.get(tailNumber) ||
        "";

      if (discoveredTails.has(tailNumber)) {
        updateDiscoveredStmt.run(
          aircraftType,
          aircraft.OperatedBy ?? "United Airlines",
          aircraft.fleet ?? "express",
          aircraft.sheet_gid ?? "",
          aircraft.sheet_type ?? "",
          aircraft.WiFi ?? "",
          tailNumber,
          airline
        );
        continue;
      }

      // Preserve existing DateFound or use new one, fallback to today only for truly new aircraft
      const dateFound =
        aircraft.DateFound ||
        existingDates.get(tailNumber) ||
        new Date().toISOString().split("T")[0];

      // Preserve flight check data for existing planes, use 0 for new planes
      const flightCheckData = existingFlightChecks.get(tailNumber) || {
        last_flight_check: 0,
        last_check_successful: 0,
        consecutive_failures: 0,
      };

      // Preserve verification data
      const verificationData = existingVerification.get(tailNumber) || {
        verified_wifi: null,
        verified_at: null,
      };

      insertStmt.run(
        aircraftType,
        aircraft.WiFi ?? "",
        aircraft.sheet_gid ?? "",
        aircraft.sheet_type ?? "",
        dateFound,
        tailNumber,
        aircraft.OperatedBy ?? "United Airlines",
        aircraft.fleet ?? "express",
        flightCheckData.last_flight_check,
        flightCheckData.last_check_successful,
        flightCheckData.consecutive_failures,
        verificationData.verified_wifi,
        verificationData.verified_at,
        airline
      );
    }

    // Purge discovery false-positives that have since verified as not-Starlink
    db.query(
      "DELETE FROM starlink_planes WHERE sheet_gid = 'discovery' AND verified_wifi IS NOT NULL AND verified_wifi != 'Starlink' AND airline = ?"
    ).run(airline);
  })();
}

export function getMeta(db: Database, key: string, airline = "UA"): string | null {
  const namespaced = db
    .query("SELECT value FROM meta WHERE key = ?")
    .get(`${airline}:${key}`) as MetaRow | null;
  if (namespaced?.value != null) return namespaced.value;
  const bare = db.query("SELECT value FROM meta WHERE key = ?").get(key) as MetaRow | null;
  return bare?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string | number, airline = "UA"): void {
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    `${airline}:${key}`,
    String(value)
  );
}

export function getTotalCount(db: Database, airline = "UA"): number {
  const v = getMeta(db, "totalAircraftCount", airline);
  return v ? Number.parseInt(v, 10) : 0;
}

export function getMetaValue(
  db: Database,
  key: string,
  defaultValue: number,
  airline?: string
): number {
  const v = getMeta(db, key, airline);
  return v ? Number.parseFloat(v) : defaultValue;
}

export function getLastUpdated(db: Database, airline = "UA"): string {
  return getMeta(db, "lastUpdated", airline) ?? new Date().toISOString();
}

export function getStarlinkPlanes(db: Database, airline?: AirlineFilter): Aircraft[] {
  const q = withAirline(
    `SELECT aircraft as Aircraft,
            wifi as WiFi,
            sheet_gid,
            sheet_type,
            DateFound,
            TailNumber,
            OperatedBy,
            fleet
     FROM starlink_planes
     WHERE (verified_wifi IS NULL OR verified_wifi = 'Starlink')`,
    airline
  );
  return db.query(`${q.sql} ORDER BY DateFound DESC`).all(...q.params) as Aircraft[];
}

/**
 * Get ALL starlink_planes including mismatches (verified_wifi = 'None'/'Panasonic'/etc).
 * Used by the verifier and flight-updater so mismatched planes can still be
 * re-verified and self-heal if United's data changes.
 */
export function getAllStarlinkPlanes(db: Database, airline?: AirlineFilter): Aircraft[] {
  const q = withAirline(
    `SELECT aircraft as Aircraft,
            wifi as WiFi,
            sheet_gid,
            sheet_type,
            DateFound,
            TailNumber,
            OperatedBy,
            fleet,
            verified_wifi
     FROM starlink_planes
     WHERE 1=1`,
    airline
  );
  return db.query(`${q.sql} ORDER BY DateFound DESC`).all(...q.params) as Aircraft[];
}

export function getFleetStats(db: Database, airline = "UA"): FleetStats {
  // Get totals from spreadsheet data (accurate for fleet size)
  const expressTotal = getMetaValue(db, "expressTotal", 0, airline);
  const mainlineTotal = getMetaValue(db, "mainlineTotal", 0, airline);

  // united_fleet.starlink_status is the consensus-driven truth — same source
  // as the Datadog metric. Unverified = sheet claims Starlink but crawler
  // hasn't confirmed: either consensus hasn't settled (insufficient obs,
  // mid-retrofit, grounded) or consensus disagrees (sheet stale).
  const q = withAirline(
    `SELECT
       sp.fleet,
       SUM(CASE WHEN uf.starlink_status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
       SUM(CASE WHEN uf.starlink_status IS NOT 'confirmed' THEN 1 ELSE 0 END) as unverified
     FROM starlink_planes sp
     LEFT JOIN united_fleet uf ON sp.TailNumber = uf.tail_number
     WHERE (sp.verified_wifi IS NULL OR sp.verified_wifi = 'Starlink')`,
    airline,
    "sp"
  );
  const rows = db.query(`${q.sql} GROUP BY sp.fleet`).all(...q.params) as Array<{
    fleet: string;
    confirmed: number;
    unverified: number;
  }>;

  const express = rows.find((r) => r.fleet === "express") ?? { confirmed: 0, unverified: 0 };
  const mainline = rows.find((r) => r.fleet === "mainline") ?? { confirmed: 0, unverified: 0 };

  return {
    express: {
      total: expressTotal,
      starlink: express.confirmed,
      unverified: express.unverified,
      percentage: expressTotal > 0 ? (express.confirmed / expressTotal) * 100 : 0,
    },
    mainline: {
      total: mainlineTotal,
      starlink: mainline.confirmed,
      unverified: mainline.unverified,
      percentage: mainlineTotal > 0 ? (mainline.confirmed / mainlineTotal) * 100 : 0,
    },
  };
}

export function updateFlights(
  db: Database,
  tailNumber: string,
  flights: Pick<
    Flight,
    "flight_number" | "departure_airport" | "arrival_airport" | "departure_time" | "arrival_time"
  >[]
) {
  const now = Math.floor(Date.now() / 1000);
  const airline =
    (
      db.query("SELECT airline FROM starlink_planes WHERE TailNumber = ?").get(tailNumber) as
        | { airline: string }
        | undefined
    )?.airline ?? "UA";

  const updateFlightsTransaction = db.transaction(() => {
    // Archive departed flights into departure_log before the DELETE so we
    // build a trailing 30d window. INSERT OR IGNORE-equivalent via NOT EXISTS
    // guard against double-logging when updateFlights runs twice before a
    // flight departs.
    db.query(`
      INSERT INTO departure_log (tail_number, airport, departed_at, airline)
      SELECT tail_number, departure_airport, departure_time, airline
      FROM upcoming_flights
      WHERE tail_number = ? AND departure_time < ?
        AND NOT EXISTS (
          SELECT 1 FROM departure_log dl
          WHERE dl.tail_number = upcoming_flights.tail_number
            AND dl.departed_at = upcoming_flights.departure_time
        )
    `).run(tailNumber, now);

    db.query("DELETE FROM upcoming_flights WHERE tail_number = ?").run(tailNumber);

    if (flights.length > 0) {
      const insertStmt = db.prepare(`
        INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const flight of flights) {
        insertStmt.run(
          tailNumber,
          flight.flight_number,
          flight.departure_airport,
          flight.arrival_airport,
          flight.departure_time,
          flight.arrival_time,
          now,
          airline
        );
      }
    }
  });

  updateFlightsTransaction();
}

export function getUpcomingFlights(
  db: Database,
  tailNumber?: string,
  airline?: AirlineFilter
): Flight[] {
  const now = Math.floor(Date.now() / 1000);
  const minValidTimestamp = 946684800;

  let sql = "SELECT * FROM upcoming_flights WHERE departure_time > ? AND departure_time > ?";
  const params: (string | number)[] = [now, minValidTimestamp];
  if (tailNumber) {
    sql += " AND tail_number = ?";
    params.push(tailNumber);
  }
  const q = withAirline(sql, airline, "", params);
  return db.query(`${q.sql} ORDER BY departure_time ASC`).all(...q.params) as Flight[];
}

export type CheckFlightRow = Flight & {
  aircraft_type: string;
  WiFi: string;
  DateFound: string;
  OperatedBy: string;
  fleet: string;
  verified_wifi: string | null;
};

/** Primary lookup for /api/check-flight and MCP check_flight. */
export function getFlightsByNumberAndDate(
  db: Database,
  flightNumberVariants: string[],
  startOfDay: number,
  endOfDay: number,
  airline?: AirlineFilter
): CheckFlightRow[] {
  const placeholders = flightNumberVariants.map(() => "?").join(", ");
  const q = withAirline(
    `SELECT
       uf.*,
       sp.Aircraft as aircraft_type,
       sp.WiFi,
       sp.DateFound,
       sp.OperatedBy,
       sp.fleet,
       sp.verified_wifi
     FROM upcoming_flights uf
     INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
     WHERE uf.flight_number IN (${placeholders})
       AND uf.departure_time >= ?
       AND uf.departure_time < ?
       AND (sp.verified_wifi IS NULL OR sp.verified_wifi = 'Starlink')`,
    airline,
    "uf",
    [...flightNumberVariants, startOfDay, endOfDay]
  );
  return db.query(`${q.sql} ORDER BY uf.departure_time ASC`).all(...q.params) as CheckFlightRow[];
}

export function updateLastFlightCheck(db: Database, tailNumber: string, success = true) {
  const now = Math.floor(Date.now() / 1000);
  if (success) {
    db.query(
      "UPDATE starlink_planes SET last_flight_check = ?, last_check_successful = 1, consecutive_failures = 0 WHERE TailNumber = ?"
    ).run(now, tailNumber);
  } else {
    db.query(
      "UPDATE starlink_planes SET last_flight_check = ?, last_check_successful = 0, consecutive_failures = consecutive_failures + 1 WHERE TailNumber = ?"
    ).run(now, tailNumber);
  }
}

export function needsFlightCheck(db: Database, tailNumber: string): boolean {
  const now = Math.floor(Date.now() / 1000);

  // Single optimized query combining plane data with flight info
  const data = db
    .query(`
    SELECT
      sp.last_flight_check,
      sp.last_check_successful,
      sp.consecutive_failures,
      COUNT(uf.id) as flight_count,
      MIN(CASE WHEN uf.departure_time > ? THEN uf.departure_time ELSE NULL END) as next_departure,
      MAX(CASE WHEN uf.departure_time > ? THEN uf.departure_time ELSE NULL END) as latest_departure
    FROM starlink_planes sp
    LEFT JOIN upcoming_flights uf ON sp.TailNumber = uf.tail_number
    WHERE sp.TailNumber = ?
    GROUP BY sp.TailNumber
  `)
    .get(now, now, tailNumber) as {
    last_flight_check: number;
    last_check_successful: number;
    consecutive_failures: number;
    flight_count: number;
    next_departure: number | null;
    latest_departure: number | null;
  } | null;

  if (!data) return false;

  const lastCheck = data.last_flight_check || 0;
  const lastCheckSuccessful = data.last_check_successful || 0;
  const consecutiveFailures = data.consecutive_failures || 0;
  const hasFlights = data.next_departure !== null;
  const nextDeparture = data.next_departure;
  const latestDeparture = data.latest_departure;

  if (lastCheck === 0) {
    return true;
  }

  const hoursSinceLastCheck = (now - lastCheck) / 3600;

  if (!lastCheckSuccessful && consecutiveFailures > 0) {
    // Exponential backoff: 0.5hr, 1hr, 2hr, 4hr, then cap at 4hr
    const backoffHours = Math.min(4, 2 ** (consecutiveFailures - 1) * 0.5);
    return hoursSinceLastCheck > backoffHours;
  }

  if (!hasFlights) {
    const thresholdHours = 2 + Math.random() * 2;
    return hoursSinceLastCheck > thresholdHours;
  }

  const hoursToNextFlight = nextDeparture ? (nextDeparture - now) / 3600 : 999;
  const hoursToLatestFlight = latestDeparture ? (latestDeparture - now) / 3600 : 999;

  if (hoursToNextFlight <= 6) {
    const thresholdHours = 1 + Math.random() * 0.5;
    return hoursSinceLastCheck > thresholdHours;
  }

  if (hoursToLatestFlight <= 24) {
    const thresholdHours = 2 + Math.random() * 2;
    return hoursSinceLastCheck > thresholdHours;
  }

  const thresholdHours = 4 + Math.random() * 4;
  return hoursSinceLastCheck > thresholdHours;
}

// ============================================
// Starlink Verification Log Functions
// ============================================

/**
 * Log a verification check result
 */
export function logVerification(
  db: Database,
  entry: Omit<VerificationLogEntry, "id" | "checked_at">
): void {
  const now = Math.floor(Date.now() / 1000);
  db.query(`
    INSERT INTO starlink_verification_log
    (tail_number, source, checked_at, has_starlink, wifi_provider, aircraft_type, flight_number, error, tail_confirmed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.tail_number,
    entry.source,
    now,
    entry.has_starlink === null ? null : entry.has_starlink ? 1 : 0,
    entry.wifi_provider,
    entry.aircraft_type,
    entry.flight_number,
    entry.error,
    entry.tail_confirmed ?? null
  );
}

/**
 * Get the last verification for a tail number from a specific source
 */
export function getLastVerification(
  db: Database,
  tailNumber: string,
  source: VerificationSource
): VerificationLogEntry | null {
  const row = db
    .query(`
    SELECT * FROM starlink_verification_log
    WHERE tail_number = ? AND source = ?
    ORDER BY checked_at DESC
    LIMIT 1
  `)
    .get(tailNumber, source) as {
    id: number;
    tail_number: string;
    source: string;
    checked_at: number;
    has_starlink: number | null;
    wifi_provider: string | null;
    aircraft_type: string | null;
    flight_number: string | null;
    error: string | null;
  } | null;

  if (!row) return null;

  return {
    id: row.id,
    tail_number: row.tail_number,
    source: row.source as VerificationSource,
    checked_at: row.checked_at,
    has_starlink: row.has_starlink === null ? null : row.has_starlink === 1,
    wifi_provider: row.wifi_provider,
    aircraft_type: row.aircraft_type,
    flight_number: row.flight_number,
    error: row.error,
  };
}

/**
 * Generate a deterministic jitter based on tail number
 * Returns a value between 0 and 1 that's consistent for each tail number
 */
function getTailNumberJitter(tailNumber: string): number {
  let hash = 0;
  for (let i = 0; i < tailNumber.length; i++) {
    hash = (hash * 31 + tailNumber.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000;
}

/**
 * Check if a plane needs verification from a specific source
 * Uses jittered thresholds to distribute checks over time:
 * - United: 48-96 hours (centered on 72)
 * - FR24: 18-30 hours (centered on 24)
 * - Spreadsheet: 0.5-1.5 hours (centered on 1)
 */
export function needsVerification(
  db: Database,
  tailNumber: string,
  source: VerificationSource,
  hoursThreshold?: number
): boolean {
  // Base thresholds by source (will be jittered ±33%)
  const baseThresholds: Record<VerificationSource, number> = {
    united: 72, // 3 days for United (to avoid spam)
    flightradar24: 24, // 1 day for FR24
    spreadsheet: 1, // 1 hour for spreadsheet (primary source)
  };

  const baseThreshold = hoursThreshold ?? baseThresholds[source];

  // Add deterministic jitter: ±33% based on tail number
  // This distributes checks evenly across planes
  const jitter = getTailNumberJitter(tailNumber); // 0 to 1
  const jitterRange = baseThreshold * 0.33; // ±33%
  const threshold = baseThreshold - jitterRange + jitter * 2 * jitterRange;

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - threshold * 3600;

  // A tail is "recently checked" if we've logged ANY attempt for it, not
  // just clean ones. Persistent errors (aircraft mismatch, subprocess crash,
  // tail-not-extracted) won't resolve on retry — re-attempting every 60s
  // just burns rate limit. N521GJ retry-stormed 108 times in 6h because
  // "Process exited with code 1" wasn't in the old whitelist. The verifier's
  // 48-96h jitter schedule is the right cadence for a second attempt.
  const lastCheck = db
    .query(`
    SELECT checked_at FROM starlink_verification_log
    WHERE tail_number = ? AND source = ? AND checked_at > ?
    ORDER BY checked_at DESC
    LIMIT 1
  `)
    .get(tailNumber, source, cutoff) as { checked_at: number } | null;

  return !lastCheck;
}

/**
 * Get verification history for a tail number
 */
export function getVerificationHistory(
  db: Database,
  tailNumber: string,
  limit = 10
): VerificationLogEntry[] {
  const rows = db
    .query(`
    SELECT * FROM starlink_verification_log
    WHERE tail_number = ?
    ORDER BY checked_at DESC
    LIMIT ?
  `)
    .all(tailNumber, limit) as Array<{
    id: number;
    tail_number: string;
    source: string;
    checked_at: number;
    has_starlink: number | null;
    wifi_provider: string | null;
    aircraft_type: string | null;
    flight_number: string | null;
    error: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    tail_number: row.tail_number,
    source: row.source as VerificationSource,
    checked_at: row.checked_at,
    has_starlink: row.has_starlink === null ? null : row.has_starlink === 1,
    wifi_provider: row.wifi_provider,
    aircraft_type: row.aircraft_type,
    flight_number: row.flight_number,
    error: row.error,
  }));
}

/**
 * Get planes that need United verification (haven't been checked in 72 hours)
 */
export function getPlanesNeedingUnitedVerification(db: Database, limit = 10): string[] {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 72 * 3600; // 72 hours ago

  // Get planes that either:
  // 1. Have never been verified by United
  // 2. Were last verified more than 72 hours ago
  const rows = db
    .query(`
    SELECT sp.TailNumber
    FROM starlink_planes sp
    LEFT JOIN (
      SELECT tail_number, MAX(checked_at) as last_check
      FROM starlink_verification_log
      WHERE source = 'united'
      GROUP BY tail_number
    ) vl ON sp.TailNumber = vl.tail_number
    WHERE vl.last_check IS NULL OR vl.last_check < ?
    ORDER BY COALESCE(vl.last_check, 0) ASC
    LIMIT ?
  `)
    .all(cutoff, limit) as { TailNumber: string }[];

  return rows.map((r) => r.TailNumber);
}

/**
 * Get verification stats summary
 */
export function getVerificationStats(db: Database): {
  total_checks: number;
  checks_by_source: Record<VerificationSource, number>;
  verified_starlink: number;
  verified_not_starlink: number;
  errors: number;
  last_24h_checks: number;
} {
  const total = db.query("SELECT COUNT(*) as count FROM starlink_verification_log").get() as {
    count: number;
  };

  const bySource = db
    .query(`
    SELECT source, COUNT(*) as count FROM starlink_verification_log GROUP BY source
  `)
    .all() as { source: string; count: number }[];

  const verified = db
    .query(`
    SELECT
      SUM(CASE WHEN has_starlink = 1 THEN 1 ELSE 0 END) as starlink,
      SUM(CASE WHEN has_starlink = 0 THEN 1 ELSE 0 END) as not_starlink,
      SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as errors
    FROM starlink_verification_log
  `)
    .get() as { starlink: number; not_starlink: number; errors: number };

  const now = Math.floor(Date.now() / 1000);
  const last24h = db
    .query(`
    SELECT COUNT(*) as count FROM starlink_verification_log WHERE checked_at > ?
  `)
    .get(now - 24 * 3600) as { count: number };

  const sourceMap: Record<VerificationSource, number> = {
    united: 0,
    flightradar24: 0,
    spreadsheet: 0,
  };
  for (const row of bySource) {
    if (row.source in sourceMap) {
      sourceMap[row.source as VerificationSource] = row.count;
    }
  }

  return {
    total_checks: total.count,
    checks_by_source: sourceMap,
    verified_starlink: verified.starlink || 0,
    verified_not_starlink: verified.not_starlink || 0,
    errors: verified.errors || 0,
    last_24h_checks: last24h.count,
  };
}

export interface WifiConsensus {
  verdict: string | null;
  n: number;
  starlinkPct: number;
  reason: string;
}

/**
 * Compute wifi consensus from recent verification log entries.
 * Filters wifi_provider <> '' because a clean scrape that found the page but
 * missed the wifi section reports has_starlink=0, wifi_provider='' — that's
 * noise, not signal.
 * Returns verdict=null when n < minObs OR the split is in the ambiguous zone.
 */
export function computeWifiConsensus(
  db: Database,
  tailNumber: string,
  opts = { windowDays: 30, minObs: 2, threshold: 0.7 }
): WifiConsensus {
  const cutoff = Math.floor(Date.now() / 1000) - opts.windowDays * 86400;
  const baseWhere = `tail_number = ? AND source = 'united' AND checked_at >= ?
    AND error IS NULL AND has_starlink IS NOT NULL
    AND wifi_provider IS NOT NULL AND wifi_provider <> ''`;

  // Primary: only tail_confirmed=1 (post-fix clean data)
  let obs = db
    .query(`SELECT has_starlink, wifi_provider FROM starlink_verification_log
      WHERE ${baseWhere} AND tail_confirmed = 1 ORDER BY checked_at DESC`)
    .all(tailNumber, cutoff) as Array<{ has_starlink: number; wifi_provider: string }>;

  // Grace fallback: if zero confirmed rows, read legacy NULL rows so display
  // counts (n, starlinkPct) aren't zero during the 30d transition. Legacy is
  // the contaminated set, so it MUST NOT produce a verdict — otherwise tails
  // reset to unknown get re-dragged to negative before clean data accumulates.
  let usedLegacyFallback = false;
  if (obs.length === 0) {
    obs = db
      .query(`SELECT has_starlink, wifi_provider FROM starlink_verification_log
        WHERE ${baseWhere} AND tail_confirmed IS NULL ORDER BY checked_at DESC`)
      .all(tailNumber, cutoff) as Array<{ has_starlink: number; wifi_provider: string }>;
    usedLegacyFallback = obs.length > 0;
  }

  const n = obs.length;
  const starlinkObs = obs.filter((o) => o.has_starlink === 1).length;
  const starlinkPct = n > 0 ? starlinkObs / n : 0;

  if (usedLegacyFallback) {
    return {
      verdict: null,
      n,
      starlinkPct,
      reason: `legacy obs only (${n} pre-tail_confirmed rows) — display-only, not settling`,
    };
  }

  if (n < opts.minObs) {
    return {
      verdict: null,
      n,
      starlinkPct,
      reason: `insufficient recent obs (${n} in last ${opts.windowDays}d, need ${opts.minObs})`,
    };
  }

  // Recency override: a fresh retrofit shows as old-provider→new-provider in
  // the 30d window, dragging the average below threshold for weeks until the
  // pre-retrofit obs age out. If the last 3 clean obs all agree, trust that —
  // a monotonic transition is a stronger signal than the rolling percentage.
  const streak = 3;
  if (n >= streak) {
    const recent = obs.slice(0, streak);
    const allStarlink = recent.every((o) => o.has_starlink === 1);
    const allSame = new Set(recent.map((o) => o.wifi_provider)).size === 1;
    if (allStarlink) {
      return {
        verdict: "Starlink",
        n,
        starlinkPct,
        reason: `last ${streak} consecutive obs all Starlink (retrofit transition)`,
      };
    }
    if (allSame && recent[0].has_starlink === 0) {
      return {
        verdict: recent[0].wifi_provider,
        n,
        starlinkPct,
        reason: `last ${streak} consecutive obs all ${recent[0].wifi_provider}`,
      };
    }
  }

  if (starlinkPct >= opts.threshold) {
    return {
      verdict: "Starlink",
      n,
      starlinkPct,
      reason: `${starlinkObs}/${n} recent obs Starlink (${(starlinkPct * 100).toFixed(0)}%)`,
    };
  }

  if (1 - starlinkPct >= opts.threshold) {
    const providerCounts = new Map<string, number>();
    for (const o of obs) {
      if (o.has_starlink === 0) {
        providerCounts.set(o.wifi_provider, (providerCounts.get(o.wifi_provider) ?? 0) + 1);
      }
    }
    const mostCommon = [...providerCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "None";
    return {
      verdict: mostCommon,
      n,
      starlinkPct,
      reason: `${n - starlinkObs}/${n} recent obs NOT Starlink (${((1 - starlinkPct) * 100).toFixed(0)}%), provider: ${mostCommon}`,
    };
  }

  return {
    verdict: null,
    n,
    starlinkPct,
    reason: `ambiguous: ${starlinkObs}/${n} Starlink recently — likely mid-retrofit or data noise`,
  };
}

/**
 * Bump discovery priority so a tail is re-checked on the next fleet-discovery
 * cycle. Idempotent: only bumps if not already due.
 */
export function bumpDiscoveryPriority(db: Database, tailNumber: string): void {
  const now = Math.floor(Date.now() / 1000);
  try {
    db.query(`
      UPDATE united_fleet
      SET next_check_after = ?, discovery_priority = 1.0
      WHERE tail_number = ? AND next_check_after > ?
    `).run(now, tailNumber, now);
  } catch {
    // best-effort signal; readonly DBs (tests, MCP snapshot) just skip
  }
}

/**
 * Update the verified WiFi status for a plane
 */
export function updateVerifiedWifi(
  db: Database,
  tailNumber: string,
  verifiedWifi: string | null
): void {
  const now = Math.floor(Date.now() / 1000);
  db.query(`
    UPDATE starlink_planes
    SET verified_wifi = ?, verified_at = ?
    WHERE TailNumber = ?
  `).run(verifiedWifi, now, tailNumber);
}

/**
 * Reconciliation sweep — recompute consensus for every sheet-listed tail with
 * ≥2 tail_confirmed obs and heal any drift between the log and verified_wifi.
 *
 * Write-triggered consensus (verifier check, swap-capture) is the primary path
 * but it only fires on new writes. This catches rows that crossed the threshold
 * before a fix deployed, or any other path that adds obs without triggering
 * consensus. Runs with the hourly sync — cheap enough to be the safety net.
 */
export function reconcileConsensus(db: Database): number {
  const candidates = db
    .query(`
      SELECT sp.TailNumber as tail, sp.verified_wifi as current
      FROM starlink_planes sp
      WHERE (SELECT COUNT(*) FROM starlink_verification_log
             WHERE tail_number = sp.TailNumber AND tail_confirmed = 1) >= 2
    `)
    .all() as Array<{ tail: string; current: string | null }>;

  let healed = 0;
  for (const { tail, current } of candidates) {
    const consensus = computeWifiConsensus(db, tail);
    if (consensus.verdict !== null && consensus.verdict !== current) {
      updateVerifiedWifi(db, tail, consensus.verdict);
      healed++;
    }
  }
  return healed;
}

/**
 * Get mismatches between spreadsheet data and verified data
 * Returns planes where:
 * - Spreadsheet says Starlink but verification says otherwise
 * - Or spreadsheet says no Starlink but verification found Starlink
 */
export interface WifiMismatch {
  TailNumber: string;
  Aircraft: string;
  OperatedBy: string;
  spreadsheet_wifi: string;
  verified_wifi: string;
  verified_at: number;
  DateFound: string;
}

export function getWifiMismatches(db: Database, airline?: AirlineFilter): WifiMismatch[] {
  const q = withAirline(
    `SELECT
       TailNumber,
       aircraft as Aircraft,
       OperatedBy,
       wifi as spreadsheet_wifi,
       verified_wifi,
       verified_at,
       DateFound
     FROM starlink_planes
     WHERE verified_wifi IS NOT NULL
       AND (
         (wifi IN ('StrLnk', 'Starlink') AND verified_wifi != 'Starlink')
         OR
         (wifi NOT IN ('StrLnk', 'Starlink') AND verified_wifi = 'Starlink')
       )`,
    airline
  );
  return db.query(`${q.sql} ORDER BY verified_at DESC`).all(...q.params) as WifiMismatch[];
}

/**
 * Clear verified_wifi for mismatched planes so they can be re-verified.
 * Use this after fixing verification logic to allow re-verification.
 */
export function clearMismatchVerifications(db: Database): number {
  const result = db
    .query(`
    UPDATE starlink_planes
    SET verified_wifi = NULL, verified_at = NULL
    WHERE verified_wifi IS NOT NULL
      AND wifi IN ('StrLnk', 'Starlink')
      AND verified_wifi != 'Starlink'
  `)
    .run();
  return result.changes;
}

/**
 * Get planes that haven't been verified yet
 */
export function getUnverifiedPlanes(db: Database, limit = 50): Aircraft[] {
  return db
    .query(`
      SELECT
        aircraft as Aircraft,
        wifi as WiFi,
        TailNumber,
        OperatedBy,
        DateFound,
        fleet
      FROM starlink_planes
      WHERE verified_wifi IS NULL
      ORDER BY DateFound DESC
      LIMIT ?
    `)
    .all(limit) as Aircraft[];
}

/**
 * Get verification summary stats
 */
export function getVerificationSummary(
  db: Database,
  airline?: AirlineFilter
): {
  total_planes: number;
  verified_count: number;
  unverified_count: number;
  mismatches_count: number;
  verified_starlink: number;
  verified_none: number;
  verified_other: number;
} {
  const q = withAirline(
    `SELECT
       COUNT(*) as total_planes,
       SUM(CASE WHEN verified_wifi IS NOT NULL THEN 1 ELSE 0 END) as verified_count,
       SUM(CASE WHEN verified_wifi IS NULL THEN 1 ELSE 0 END) as unverified_count,
       SUM(CASE WHEN verified_wifi IS NOT NULL AND (
         (wifi IN ('StrLnk', 'Starlink') AND verified_wifi != 'Starlink')
         OR (wifi NOT IN ('StrLnk', 'Starlink') AND verified_wifi = 'Starlink')
       ) THEN 1 ELSE 0 END) as mismatches_count,
       SUM(CASE WHEN verified_wifi = 'Starlink' THEN 1 ELSE 0 END) as verified_starlink,
       SUM(CASE WHEN verified_wifi = 'None' THEN 1 ELSE 0 END) as verified_none,
       SUM(CASE WHEN verified_wifi IS NOT NULL AND verified_wifi NOT IN ('Starlink', 'None') THEN 1 ELSE 0 END) as verified_other
     FROM starlink_planes
     WHERE 1=1`,
    airline
  );
  const stats = db.query(q.sql).get(...q.params) as any;

  return {
    total_planes: stats.total_planes || 0,
    verified_count: stats.verified_count || 0,
    unverified_count: stats.unverified_count || 0,
    mismatches_count: stats.mismatches_count || 0,
    verified_starlink: stats.verified_starlink || 0,
    verified_none: stats.verified_none || 0,
    verified_other: stats.verified_other || 0,
  };
}

// ============================================
// Fleet Discovery Functions
// ============================================

/**
 * Generate a deterministic hash from tail number for jitter
 */
function hashTailNumber(tailNumber: string): number {
  let hash = 0;
  for (let i = 0; i < tailNumber.length; i++) {
    hash = (hash * 31 + tailNumber.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Calculate discovery priority for an aircraft
 * Higher priority = check sooner
 */
export function calculateDiscoveryPriority(
  aircraftType: string | null,
  starlinkStatus: StarlinkStatus,
  tailNumber: string
): number {
  let priority = 0.5;

  // Never verified = highest priority
  if (starlinkStatus === "unknown") priority += 0.3;

  // E175/CRJ-550 more likely to have Starlink
  if (aircraftType) {
    if (/E175|ERJ.?175/i.test(aircraftType)) priority += 0.15;
    if (/CRJ.?550/i.test(aircraftType)) priority += 0.1;
  }

  // Deterministic jitter based on tail number (0.0 to 0.1)
  priority += (hashTailNumber(tailNumber) % 100) / 1000;

  return Math.min(1.0, priority);
}

/**
 * Upsert an aircraft into the united_fleet table
 */
export function upsertFleetAircraft(
  db: Database,
  tailNumber: string,
  aircraftType: string | null,
  source: FleetSource,
  fleet = "unknown",
  operatedBy: string | null = null,
  airline = "UA",
  // Type-map seeds (e.g. Hawaiian) where wifi status is press-release-grade per
  // aircraft type and the verifier loop does not apply. Applied on insert only —
  // re-runs do NOT clobber an existing status (avoids the documented
  // starlink_status tug-of-war between writers).
  seedVerdict?: { starlinkStatus: StarlinkStatus; verifiedWifi: string | null }
): void {
  const now = Math.floor(Date.now() / 1000);
  // Empty/placeholder type strings must not clobber a real value via COALESCE.
  const type = aircraftType?.trim();
  const safeType = type && !/^unknown$/i.test(type) ? type : null;

  const existing = db
    .query("SELECT id, starlink_status FROM united_fleet WHERE tail_number = ?")
    .get(tailNumber) as { id: number; starlink_status: StarlinkStatus } | null;

  if (existing) {
    db.query(`
      UPDATE united_fleet
      SET aircraft_type = COALESCE(?, aircraft_type),
          last_seen_at = ?,
          fleet = CASE WHEN fleet = 'unknown' THEN ? ELSE fleet END,
          operated_by = COALESCE(?, operated_by),
          discovery_priority = ?
      WHERE tail_number = ?
    `).run(
      safeType,
      now,
      fleet,
      operatedBy,
      calculateDiscoveryPriority(safeType, existing.starlink_status, tailNumber),
      tailNumber
    );
    if (seedVerdict && existing.starlink_status === "unknown") {
      db.query(`
        UPDATE united_fleet
        SET starlink_status = ?, verified_wifi = ?, verified_at = ?, next_check_after = ?
        WHERE tail_number = ?
      `).run(
        seedVerdict.starlinkStatus,
        seedVerdict.verifiedWifi,
        seedVerdict.verifiedWifi ? now : null,
        now + 365 * 24 * 3600,
        tailNumber
      );
    }
  } else {
    const status = seedVerdict?.starlinkStatus ?? "unknown";
    const priority = calculateDiscoveryPriority(safeType, status, tailNumber);
    db.query(`
      INSERT INTO united_fleet (
        tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at,
        fleet, operated_by, starlink_status, verified_wifi, verified_at,
        next_check_after, discovery_priority, airline
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tailNumber,
      safeType,
      source,
      now,
      now,
      fleet,
      operatedBy,
      status,
      seedVerdict?.verifiedWifi ?? null,
      seedVerdict?.verifiedWifi ? now : null,
      seedVerdict ? now + 365 * 24 * 3600 : 0,
      priority,
      airline
    );
  }
}

/**
 * Get next planes to verify based on priority and scheduling
 */
export function getNextPlanesToVerify(db: Database, limit = 10, airline = "UA"): FleetAircraft[] {
  const now = Math.floor(Date.now() / 1000);

  return db
    .query(`
    SELECT * FROM united_fleet
    WHERE next_check_after <= ? AND airline = ?
    ORDER BY
      CASE starlink_status
        WHEN 'unknown' THEN 0
        WHEN 'negative' THEN 1
        WHEN 'confirmed' THEN 2
      END,
      discovery_priority DESC,
      last_seen_at DESC
    LIMIT ?
  `)
    .all(now, airline, limit) as FleetAircraft[];
}

/**
 * Update fleet verification result
 */
export function updateFleetVerificationResult(
  db: Database,
  tailNumber: string,
  result: {
    starlinkStatus: StarlinkStatus;
    verifiedWifi: string | null;
    error?: string | null;
    needsMoreObs?: boolean;
  }
): void {
  const now = Math.floor(Date.now() / 1000);

  // Calculate next check time based on status
  let nextCheckDelay: number;
  if (result.error) {
    // Exponential backoff for errors: get current attempts
    const current = db
      .query("SELECT check_attempts FROM united_fleet WHERE tail_number = ?")
      .get(tailNumber) as { check_attempts: number } | null;
    const attempts = (current?.check_attempts || 0) + 1;
    // 1h, 2h, 4h, 8h, max 24h
    nextCheckDelay = Math.min(24 * 3600, 3600 * 2 ** (attempts - 1));
  } else if (result.needsMoreObs) {
    // Consensus is ambiguous/insufficient — re-check in ~36h so it converges
    // within a few days instead of waiting 7-14 days between observations.
    nextCheckDelay = 36 * 3600;
  } else if (result.starlinkStatus === "confirmed") {
    // Re-verify confirmed Starlink in 7 days
    nextCheckDelay = 7 * 24 * 3600;
  } else {
    // Re-verify non-Starlink in 14 days
    nextCheckDelay = 14 * 24 * 3600;
  }

  // Add jitter (±10%)
  const jitter = (Math.random() - 0.5) * 0.2 * nextCheckDelay;
  const nextCheckAfter = now + nextCheckDelay + jitter;

  // Recalculate priority
  const current = db
    .query("SELECT aircraft_type FROM united_fleet WHERE tail_number = ?")
    .get(tailNumber) as { aircraft_type: string | null } | null;
  const priority = calculateDiscoveryPriority(
    current?.aircraft_type || null,
    result.starlinkStatus,
    tailNumber
  );

  if (result.error) {
    db.query(`
      UPDATE united_fleet
      SET check_attempts = check_attempts + 1,
          last_check_error = ?,
          next_check_after = ?,
          discovery_priority = ?
      WHERE tail_number = ?
    `).run(result.error, nextCheckAfter, priority, tailNumber);
  } else {
    db.query(`
      UPDATE united_fleet
      SET starlink_status = ?,
          verified_wifi = ?,
          verified_at = ?,
          check_attempts = 0,
          last_check_error = NULL,
          next_check_after = ?,
          discovery_priority = ?
      WHERE tail_number = ?
    `).run(result.starlinkStatus, result.verifiedWifi, now, nextCheckAfter, priority, tailNumber);
  }
}

/**
 * Sync planes from starlink_planes table to united_fleet
 * Marks spreadsheet planes as confirmed Starlink
 */
export function syncSpreadsheetToFleet(db: Database): number {
  const now = Math.floor(Date.now() / 1000);
  let synced = 0;

  const spreadsheetPlanes = db
    .query(`
    SELECT TailNumber, aircraft, OperatedBy, fleet, verified_wifi
    FROM starlink_planes
    WHERE airline = 'UA'
  `)
    .all() as Array<{
    TailNumber: string;
    aircraft: string;
    OperatedBy: string;
    fleet: string;
    verified_wifi: string | null;
  }>;

  const existsStmt = db.prepare("SELECT id FROM united_fleet WHERE tail_number = ?");
  // starlink_status is discovery-owned; only bootstrap it from the sheet when
  // discovery hasn't touched the plane yet. aircraft_type uses COALESCE so
  // an empty/placeholder sheet value can't clobber a real FR24-sourced type.
  const updateStmt = db.prepare(`
    UPDATE united_fleet
    SET aircraft_type = COALESCE(?, aircraft_type),
        fleet = ?,
        operated_by = ?,
        verified_wifi = COALESCE(?, verified_wifi),
        starlink_status = CASE WHEN starlink_status = 'unknown' THEN ? ELSE starlink_status END
    WHERE tail_number = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO united_fleet (
      tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at,
      fleet, operated_by, starlink_status, verified_wifi, discovery_priority,
      next_check_after
    ) VALUES (?, ?, 'spreadsheet', ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const safeType = (t: string | null): string | null => {
    const s = t?.trim();
    return s && !/^unknown$/i.test(s) && normalizeAircraftType(s) !== "other" ? s : null;
  };

  const sync = db.transaction(() => {
    for (const plane of spreadsheetPlanes) {
      // NULL verified_wifi means unverified — must map to 'unknown', not
      // 'negative'. The UPDATE CASE guard bootstraps unknown→this value, so
      // computing 'negative' here was dragging freshly-reset tails back every
      // hour before consensus could accumulate clean observations.
      const starlinkStatus: StarlinkStatus =
        plane.verified_wifi === "Starlink"
          ? "confirmed"
          : plane.verified_wifi === null
            ? "unknown"
            : "negative";
      const type = safeType(plane.aircraft);

      if (existsStmt.get(plane.TailNumber)) {
        updateStmt.run(
          type,
          plane.fleet,
          plane.OperatedBy,
          plane.verified_wifi,
          starlinkStatus,
          plane.TailNumber
        );
      } else {
        const insertStatus = starlinkStatus;
        const priority = calculateDiscoveryPriority(type, insertStatus, plane.TailNumber);
        insertStmt.run(
          plane.TailNumber,
          type,
          now,
          now,
          plane.fleet,
          plane.OperatedBy,
          insertStatus,
          plane.verified_wifi,
          priority,
          now + 7 * 24 * 3600
        );
        synced++;
      }
    }
  });
  sync();

  return synced;
}

/**
 * Add a newly discovered Starlink plane to starlink_planes table
 * Called when discovery finds Starlink on a plane not in the spreadsheet
 */
export function addDiscoveredStarlinkPlane(
  db: Database,
  tailNumber: string,
  aircraftType: string | null,
  wifiProvider: string,
  operatedBy: string | null = null,
  fleet = "express",
  opts?: { sheetGid?: string; dateFound?: string; airline?: string }
): void {
  // Check if already in starlink_planes
  const existing = db.query("SELECT id FROM starlink_planes WHERE TailNumber = ?").get(tailNumber);
  if (existing) return;

  const today = new Date().toISOString().split("T")[0];

  db.query(`
    INSERT INTO starlink_planes (
      aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet,
      verified_wifi, verified_at, airline
    ) VALUES (?, 'StrLnk', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    aircraftType || null,
    opts?.sheetGid ?? "discovery",
    opts?.sheetGid ?? "discovery",
    opts?.dateFound ?? today,
    tailNumber,
    operatedBy || "United Airlines",
    fleet,
    wifiProvider,
    Math.floor(Date.now() / 1000),
    opts?.airline ?? "UA"
  );
}

/**
 * Get fleet discovery statistics
 */
export function getFleetDiscoveryStats(db: Database, airline?: AirlineFilter): FleetDiscoveryStats {
  const q1 = withAirline(
    `SELECT
       COUNT(*) as total_fleet,
       SUM(CASE WHEN starlink_status = 'confirmed' THEN 1 ELSE 0 END) as verified_starlink,
       SUM(CASE WHEN starlink_status = 'negative' THEN 1 ELSE 0 END) as verified_non_starlink,
       SUM(CASE WHEN starlink_status = 'unknown' THEN 1 ELSE 0 END) as pending_verification
     FROM united_fleet WHERE 1=1`,
    airline
  );
  const stats = db.query(q1.sql).get(...q1.params) as {
    total_fleet: number;
    verified_starlink: number;
    verified_non_starlink: number;
    pending_verification: number;
  };

  const q2 = withAirline(
    `SELECT COUNT(*) as count FROM united_fleet uf
     WHERE uf.starlink_status = 'confirmed'
       AND NOT EXISTS (SELECT 1 FROM starlink_planes sp WHERE sp.TailNumber = uf.tail_number)`,
    airline,
    "uf"
  );
  const discovered = db.query(q2.sql).get(...q2.params) as { count: number };

  const q3 = withAirline(
    `SELECT tail_number, aircraft_type, verified_wifi, verified_at, first_seen_source
     FROM united_fleet
     WHERE starlink_status = 'confirmed' AND verified_at > ?`,
    airline,
    "",
    [Math.floor(Date.now() / 1000) - 7 * 24 * 3600]
  );
  const recentDiscoveries = db
    .query(`${q3.sql} ORDER BY verified_at DESC LIMIT 10`)
    .all(...q3.params) as Array<{
    tail_number: string;
    aircraft_type: string | null;
    verified_wifi: string | null;
    verified_at: number | null;
    first_seen_source: FleetSource;
  }>;

  return {
    total_fleet: stats.total_fleet || 0,
    verified_starlink: stats.verified_starlink || 0,
    verified_non_starlink: stats.verified_non_starlink || 0,
    pending_verification: stats.pending_verification || 0,
    discovered_not_in_spreadsheet: discovered.count || 0,
    recent_discoveries: recentDiscoveries,
  };
}

export function getConfirmedFleetTails(
  db: Database,
  airline?: AirlineFilter
): Array<{
  tail_number: string;
  aircraft_type: string | null;
  verified_wifi: string | null;
  verified_at: number | null;
  first_seen_source: string;
  fleet: string;
  operated_by: string | null;
}> {
  const q = withAirline(
    `SELECT tail_number, aircraft_type, verified_wifi, verified_at, first_seen_source, fleet, operated_by
     FROM united_fleet
     WHERE starlink_status = 'confirmed'`,
    airline
  );
  return db.query(`${q.sql} ORDER BY verified_at DESC`).all(...q.params) as ReturnType<
    typeof getConfirmedFleetTails
  >;
}

export function getPendingFleetTails(
  db: Database,
  airline?: AirlineFilter
): Array<{
  tail_number: string;
  aircraft_type: string | null;
  verified_at: number | null;
  last_check_error: string | null;
}> {
  const q = withAirline(
    `SELECT tail_number, aircraft_type, verified_at, last_check_error
     FROM united_fleet
     WHERE starlink_status = 'unknown'`,
    airline
  );
  return db.query(`${q.sql} ORDER BY verified_at ASC NULLS FIRST`).all(...q.params) as ReturnType<
    typeof getPendingFleetTails
  >;
}

/**
 * Get a fleet aircraft by tail number
 */
export function getFleetAircraft(db: Database, tailNumber: string): FleetAircraft | null {
  return db
    .query("SELECT * FROM united_fleet WHERE tail_number = ?")
    .get(tailNumber) as FleetAircraft | null;
}

/**
 * Get all fleet aircraft
 */
export function getAllFleetAircraft(db: Database): FleetAircraft[] {
  return db.query("SELECT * FROM united_fleet ORDER BY tail_number").all() as FleetAircraft[];
}

/**
 * Map ship numbers → tail numbers. United.com shows ship numbers (#3237) for
 * mainline flights instead of registrations; this lets the verifier resolve them.
 */
export function getShipToTailMap(db: Database): Map<string, string> {
  const rows = db
    .query("SELECT ship_number, tail_number FROM united_fleet WHERE ship_number IS NOT NULL")
    .all() as Array<{ ship_number: string; tail_number: string }>;
  return new Map(rows.map((r) => [r.ship_number, r.tail_number]));
}

export function updateShipNumber(db: Database, tailNumber: string, shipNumber: string): void {
  db.query("UPDATE united_fleet SET ship_number = ? WHERE tail_number = ?").run(
    shipNumber,
    tailNumber
  );
}

// ============ /fleet page aggregation ============

const CARRIER_NAMES = ["SkyWest", "Republic", "Mesa", "GoJet"] as const;

function normalizeCarrier(op: string | null): string | null {
  const lower = (op || "").toLowerCase();
  for (const name of CARRIER_NAMES) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return null;
}

function bodyClassOf(family: string): BodyClass {
  if (/^(B767|B777|B787|A350)/.test(family)) return "widebody";
  if (/^(B737|B757|A319|A320|A321)/.test(family)) return "narrowbody";
  if (/^(E175|ERJ|CRJ)/.test(family)) return "regional";
  return "narrowbody"; // safer default for unknowns than inflating regional
}

const fleetPageCache = new Map<string, { data: FleetPageData; at: number }>();
const FLEET_PAGE_TTL_MS = 60_000;

/**
 * Aggregate all data needed for the /fleet page in a single pass.
 * Returns families (sorted by Starlink penetration desc), express carrier
 * leaderboard, body-class provider split, live-airborne pulse with a
 * 30-min-bucketed sparkline, and the full tail list. Memoized for 60s.
 */
export function getFleetPageData(db: Database, airline?: AirlineFilter): FleetPageData {
  const now = Date.now();
  const key = filterKey(airline);
  const cached = fleetPageCache.get(key);
  if (cached && now - cached.at < FLEET_PAGE_TTL_MS) {
    return cached.data;
  }
  const data = computeFleetPageData(db, airline);
  fleetPageCache.set(key, { data, at: now });
  return data;
}

export function getAirportDepartures(db: Database, airline?: AirlineFilter): AirportDepartures {
  const now = Math.floor(Date.now() / 1000);
  try {
    db.query("DELETE FROM departure_log WHERE departed_at < ?").run(now - 30 * 86400);
  } catch {
    // readonly DB (tests/snapshots) — trim is best-effort housekeeping
  }

  const q = withAirline(
    `SELECT uf.departure_airport AS airport, COUNT(*) AS count
     FROM upcoming_flights uf
     JOIN united_fleet f ON f.tail_number = uf.tail_number
     WHERE f.starlink_status = 'confirmed' AND uf.departure_time >= ?`,
    airline,
    "uf",
    [now]
  );
  const rows = db
    .query(`${q.sql} GROUP BY uf.departure_airport ORDER BY count DESC LIMIT 30`)
    .all(...q.params) as Array<{ airport: string; count: number }>;

  return { rows, windowLabel: "next 48 hours" };
}

function computeFleetPageData(db: Database, airline?: AirlineFilter): FleetPageData {
  const q = withAirline(
    `SELECT tail_number, aircraft_type, fleet, operated_by,
            starlink_status, verified_wifi, verified_at
     FROM united_fleet WHERE 1=1`,
    airline
  );
  const rows = db.query(`${q.sql} ORDER BY tail_number`).all(...q.params) as Array<{
    tail_number: string;
    aircraft_type: string | null;
    fleet: string;
    operated_by: string | null;
    starlink_status: string;
    verified_wifi: string | null;
    verified_at: number | null;
  }>;

  const allTails: FleetTail[] = [];
  const familyMap = new Map<string, FleetFamily>();
  const carrierMap = new Map<string, { confirmed: number; total: number }>();
  const bodyClass = {
    regional: { starlink: 0, viasat: 0, panasonic: 0, thales: 0, none: 0, unknown: 0 },
    narrowbody: { starlink: 0, viasat: 0, panasonic: 0, thales: 0, none: 0, unknown: 0 },
    widebody: { starlink: 0, viasat: 0, panasonic: 0, thales: 0, none: 0, unknown: 0 },
  } as Record<BodyClass, Record<WifiProvider, number>>;

  let totalStarlink = 0;

  for (const r of rows) {
    const rawFamily = normalizeAircraftType(r.aircraft_type);
    const family = rawFamily === "other" ? "unknown" : rawFamily;
    const rawProvider = normalizeWifiProvider(r.verified_wifi);
    const provider: WifiProvider =
      rawProvider === "other" ? "unknown" : (rawProvider as WifiProvider);
    const body = bodyClassOf(family);

    const tail: FleetTail = {
      tail: r.tail_number,
      type: r.aircraft_type || "",
      family,
      provider,
      fleet: normalizeFleet(r.fleet) as FleetTail["fleet"],
      verified_at: r.verified_at,
    };
    allTails.push(tail);

    if (provider === "starlink") totalStarlink++;
    bodyClass[body][provider]++;

    let fam = familyMap.get(family);
    if (!fam) {
      fam = { family, body, total: 0, starlink: 0, tails: [] };
      familyMap.set(family, fam);
    }
    fam.total++;
    fam.tails.push(tail);
    if (provider === "starlink") fam.starlink++;

    const carrier = normalizeCarrier(r.operated_by);
    if (carrier && r.fleet === "express") {
      const c = carrierMap.get(carrier) || { confirmed: 0, total: 0 };
      c.total++;
      if (r.starlink_status === "confirmed") c.confirmed++;
      carrierMap.set(carrier, c);
    }
  }

  const families = [...familyMap.values()].sort((a, b) => {
    if (a.family === "unknown") return 1;
    if (b.family === "unknown") return -1;
    return b.starlink / b.total - a.starlink / a.total || b.total - a.total;
  });

  const carriers: FleetCarrier[] = [...carrierMap.entries()]
    .map(([name, c]) => ({
      name,
      confirmed: c.confirmed,
      total: c.total,
      pct: c.total > 0 ? (c.confirmed / c.total) * 100 : 0,
    }))
    .sort((a, b) => b.pct - a.pct);

  const pulse = computePulse(db, airline);

  return {
    pulse,
    families,
    carriers,
    bodyClass,
    allTails,
    totalFleet: rows.length,
    totalStarlink,
  };
}

function computePulse(db: Database, airline?: AirlineFilter): FleetPageData["pulse"] {
  const nowSec = Math.floor(Date.now() / 1000);
  const winStart = nowSec - 6 * 3600;
  const winCap = nowSec + 66 * 3600;

  const q = withAirline(
    `SELECT uf.departure_time AS d, uf.arrival_time AS a
     FROM upcoming_flights uf
     JOIN united_fleet f ON f.tail_number = uf.tail_number
     WHERE f.starlink_status = 'confirmed'
       AND uf.arrival_time >= ? AND uf.departure_time <= ?`,
    airline,
    "uf",
    [winStart, winCap]
  );
  const flights = db.query(q.sql).all(...q.params) as Array<{ d: number; a: number }>;

  if (flights.length === 0) {
    return { now: 0, sparkline: [], peak: 0, trough: 0, totalHours: 0 };
  }

  const events: Array<[number, number]> = [];
  let totalSec = 0;
  let lastArrival = 0;
  for (const f of flights) {
    events.push([f.d, 1], [f.a + 1, -1]);
    totalSec += f.a - f.d;
    if (f.a > lastArrival) lastArrival = f.a;
  }
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const winEnd = Math.min(lastArrival, winCap);
  const step = 1800;
  const sparkline: number[] = [];
  let airborne = 0;
  let ei = 0;
  let peak = 0;
  let trough = Number.POSITIVE_INFINITY;
  let airborneNow = 0;

  for (let t = winStart; t <= winEnd; t += step) {
    while (ei < events.length && events[ei][0] <= t) {
      airborne += events[ei][1];
      ei++;
    }
    sparkline.push(airborne);
    if (airborne > peak) peak = airborne;
    if (airborne < trough) trough = airborne;
    if (t <= nowSec && nowSec < t + step) airborneNow = airborne;
  }

  return { now: airborneNow, sparkline, peak, trough, totalHours: totalSec / 3600 };
}
