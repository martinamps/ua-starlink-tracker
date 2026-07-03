import { Database } from "bun:sqlite";
import { ensureAirlinePrefix } from "../airlines/flight-number";
import {
  AIRLINES,
  type LastUpdatedOwner,
  OBSERVED_WIFI_SOURCES,
  VERIFICATION_SOURCES,
  enabledAirlines,
  lastUpdatedOwner,
  looksLikeValidTailNumber,
  verifierSourceTag,
} from "../airlines/registry";
import {
  COUNTERS,
  metrics,
  normalizeAircraftType,
  normalizeAirlineTag,
  normalizeFleet,
  normalizeStarlinkStatus,
  normalizeWifiProvider,
} from "../observability/metrics";
import type {
  AdsbObservationRecord,
  AdsbSweepRecord,
  Aircraft,
  AirportDepartures,
  BodyClass,
  BtsMonthAggregates,
  FaaRegistryRow,
  FleetAircraft,
  FleetAnchorRow,
  FleetCarrier,
  FleetDiscoveryStats,
  FleetFamily,
  FleetPageData,
  FleetProgressRow,
  FleetSource,
  FleetStats,
  FleetTail,
  Flight,
  InstallPace,
  InstallPaceWeek,
  RecentInstall,
  RouteSchedule,
  RouteScheduleRow,
  SecFilingRow,
  StarlinkStatus,
  WifiProvider,
} from "../types";
import { DB_PATH } from "../utils/constants";
import { info, error as logError, warn } from "../utils/logger";

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

/** Resolve an AirlineFilter to concrete airline codes (undefined = all enabled). */
function airlineCodes(airline: AirlineFilter): readonly string[] {
  if (airline === undefined) return enabledAirlines().map((a) => a.code);
  return typeof airline === "string" ? [airline] : airline;
}

/** `flight_number GLOB` clause matching any of the given carrier prefixes. */
function flightNumberGlob(prefixes: readonly string[]): { clause: string; params: string[] } {
  return {
    clause: prefixes.map(() => "flight_number GLOB ?").join(" OR "),
    params: prefixes.map((p) => `${p}[0-9]*`),
  };
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

function addColumn(db: Database, table: string, column: string, ddl: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export type VerificationSource = "united" | "flightradar24" | "spreadsheet" | "alaska" | "qatar";

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
  /** Required: a verification row without an explicit airline would silently
   * be attributed to the wrong carrier (same bug class as the og:image leak). */
  airline: string;
}

// Exported so tests' synthetic in-memory DBs pick up tables added after the
// last `test:setup` snapshot, instead of failing on a stale schema.
export function setupTables(db: Database) {
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
  addColumn(db, "united_fleet", "rts_until", "INTEGER");

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

  // Qatar's flight-status API exposes per-flight equipment but no tail, so the
  // upcoming_flights → starlink_planes JOIN that other carriers use doesn't
  // fit. qatar_schedule caches QR's equipment-code-per-flight directly so the
  // API serves from the DB (per CLAUDE.md "upstream citizenship") instead of
  // proxying live calls.
  if (!tableExists(db, "qatar_schedule")) {
    db.query(`
      CREATE TABLE qatar_schedule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flight_number TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        departure_airport TEXT,
        arrival_airport TEXT,
        departure_time INTEGER,
        arrival_time INTEGER,
        equipment_code TEXT,
        wifi_verdict TEXT,
        flight_status TEXT,
        last_updated INTEGER NOT NULL,
        UNIQUE(flight_number, scheduled_date)
      );
      CREATE INDEX idx_qs_dep_time ON qatar_schedule(departure_time);
      CREATE INDEX idx_qs_route ON qatar_schedule(departure_airport, arrival_airport, departure_time);
      CREATE INDEX idx_qs_flight ON qatar_schedule(flight_number, scheduled_date);
    `).run();
  }

  // Per-type Starlink install pipeline from the United Fleet Site progress
  // workbooks (Complete / In Mod / Verification needed), refreshed daily.
  if (!tableExists(db, "fleet_progress")) {
    db.query(`
      CREATE TABLE fleet_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        airline TEXT NOT NULL,
        segment TEXT NOT NULL,
        type_code TEXT NOT NULL,
        total INTEGER,
        starlink_complete INTEGER,
        in_mod INTEGER,
        verification_needed INTEGER,
        sheet_updated TEXT,
        fetched_at INTEGER NOT NULL,
        UNIQUE(airline, segment, type_code)
      );
    `).run();
  }

  // Officially-reported fleet/Starlink figures from SEC filings, plus the
  // watcher's record of which filings have already been seen.
  if (!tableExists(db, "fleet_anchors")) {
    db.query(`
      CREATE TABLE fleet_anchors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        airline TEXT NOT NULL,
        as_of_date TEXT NOT NULL,
        scope TEXT NOT NULL,
        metric TEXT NOT NULL,
        value TEXT NOT NULL,
        source_form TEXT NOT NULL,
        source_url TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        UNIQUE(airline, metric, as_of_date)
      );
    `).run();
  }
  if (!tableExists(db, "sec_filings_seen")) {
    db.query(`
      CREATE TABLE sec_filings_seen (
        accession TEXT PRIMARY KEY,
        cik TEXT NOT NULL,
        company TEXT NOT NULL,
        form TEXT NOT NULL,
        filed_date TEXT NOT NULL,
        primary_doc_url TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );
    `).run();
  }

  // FAA Releasable Aircraft Registry slice for tracked tails (no airline column —
  // the registry is national; tails are globally unique).
  if (!tableExists(db, "faa_registry")) {
    db.query(`
      CREATE TABLE faa_registry (
        tail_number TEXT PRIMARY KEY,
        mode_s_hex TEXT,
        serial TEXT,
        year_mfr TEXT,
        faa_status TEXT NOT NULL,
        registrant TEXT,
        faa_model TEXT,
        expiration_date TEXT,
        dereg_date TEXT,
        last_refreshed INTEGER NOT NULL
      );
    `).run();
  }

  // BTS FGK monthly shadow aggregates (per-operator, per-tail, per-route).
  if (!tableExists(db, "bts_monthly_operators")) {
    db.exec(`
      CREATE TABLE bts_monthly_operators (
        month TEXT NOT NULL,
        op_carrier TEXT NOT NULL,
        flights INTEGER NOT NULL,
        performed INTEGER NOT NULL,
        distinct_tails INTEGER NOT NULL,
        ingested_at INTEGER NOT NULL,
        UNIQUE(month, op_carrier)
      );
      CREATE TABLE bts_monthly_tails (
        month TEXT NOT NULL,
        tail_number TEXT NOT NULL,
        op_carrier TEXT NOT NULL,
        departures INTEGER NOT NULL,
        UNIQUE(month, tail_number)
      );
      CREATE TABLE bts_monthly_routes (
        month TEXT NOT NULL,
        origin TEXT NOT NULL,
        dest TEXT NOT NULL,
        performed INTEGER NOT NULL,
        UNIQUE(month, origin, dest)
      );
      CREATE INDEX idx_bts_tails_month ON bts_monthly_tails(month);
      CREATE INDEX idx_bts_routes_month ON bts_monthly_routes(month);
    `);
  }

  // ADS-B shadow sweep audit trail: one aggregate row per sweep plus the
  // per-aircraft observations it classified against upcoming_flights.
  if (!tableExists(db, "adsb_sweeps")) {
    db.exec(`
      CREATE TABLE adsb_sweeps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        swept_at INTEGER NOT NULL,
        provider TEXT NOT NULL,
        requests INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        tails_queried INTEGER NOT NULL,
        observed INTEGER NOT NULL,
        airborne INTEGER NOT NULL,
        matched INTEGER NOT NULL,
        mismatched INTEGER NOT NULL,
        no_assignment INTEGER NOT NULL,
        no_callsign INTEGER NOT NULL
      );
      CREATE INDEX idx_adsb_sweeps_at ON adsb_sweeps(swept_at);
    `);
  }
  if (!tableExists(db, "adsb_observations")) {
    db.exec(`
      CREATE TABLE adsb_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observed_at INTEGER NOT NULL,
        tail_number TEXT NOT NULL,
        callsign TEXT,
        hex TEXT,
        airborne INTEGER NOT NULL,
        ground_speed REAL,
        lat REAL,
        lon REAL,
        aircraft_type TEXT,
        provider TEXT NOT NULL,
        shadow_result TEXT,
        assigned_flight TEXT
      );
      CREATE INDEX idx_adsb_obs_tail ON adsb_observations(tail_number, observed_at);
      CREATE INDEX idx_adsb_obs_at ON adsb_observations(observed_at);
    `);
  }
  addColumn(db, "adsb_sweeps", "non_revenue", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "adsb_sweeps", "low_speed", "INTEGER NOT NULL DEFAULT 0");

  // Starlink RFC 8805 geofeed prefixes — backs isStarlinkIp().
  if (!tableExists(db, "starlink_prefixes")) {
    db.exec(`
      CREATE TABLE starlink_prefixes (
        cidr TEXT PRIMARY KEY,
        lo TEXT NOT NULL,
        hi TEXT NOT NULL,
        v6 INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `);
  }

  // Passenger-verify dark-launch probe results. Everything except ip / in_geofeed
  // is client-asserted; trust filtering happens at read time.
  if (!tableExists(db, "passenger_reports")) {
    db.exec(`
      CREATE TABLE passenger_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reported_at INTEGER NOT NULL,
        ip TEXT NOT NULL,
        ip_prefix TEXT NOT NULL,
        in_geofeed INTEGER NOT NULL,
        source TEXT NOT NULL,
        outcome TEXT NOT NULL,
        claimed_flight TEXT,
        claimed_tail TEXT,
        claimed_date TEXT,
        router_id TEXT,
        ua_hash TEXT,
        airborne_match INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_passenger_reports_prefix ON passenger_reports(ip_prefix, reported_at);
      CREATE INDEX idx_passenger_reports_tail ON passenger_reports(claimed_tail, reported_at);
      CREATE INDEX idx_passenger_reports_at ON passenger_reports(reported_at);
    `);
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

/**
 * Refusal reason for a destructive roster replace, or null when sane.
 * A 200-with-HTML body parses to 0 rows; replacing the roster with it would
 * irreversibly reset DateFound/verified state on the next good run. The sheet
 * roster has no fixed healthy size, so the rule is relative shrink plus a
 * non-empty floor (fleet-sync's minFleetSanity covers the FR24 path).
 */
function rosterReplaceRefusal(newCount: number, existingCount: number): string | null {
  if (newCount === 0) {
    return "parsed 0 rows";
  }
  if (existingCount > 20 && newCount < existingCount / 2) {
    return `parsed ${newCount} rows < 50% of existing ${existingCount}`;
  }
  return null;
}

/** Sheet-roster rows for one airline (discovery rows excluded). Shared by the
 * floor COUNT and the destructive DELETE so they can never drift apart. */
export const SHEET_ROSTER_WHERE = "sheet_gid != 'discovery' AND airline = ?";

/** Returns the refusal reason when the parsed roster fails the sanity floor
 * (nothing written), or null when the replace proceeded. */
export function updateDatabase(
  db: Database,
  totalAircraftCount: number,
  starlinkAircraft: Partial<Aircraft>[],
  fleetStats: FleetStats,
  airline = "UA"
): string | null {
  const existingSheetRows = (
    db
      .query(`SELECT COUNT(*) AS n FROM starlink_planes WHERE ${SHEET_ROSTER_WHERE}`)
      .get(airline) as { n: number }
  ).n;
  const refusal = rosterReplaceRefusal(starlinkAircraft.length, existingSheetRows);
  if (refusal) {
    logError(
      `updateDatabase(${airline}): refusing roster replace — ${refusal}; keeping existing data`
    );
    return refusal;
  }

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
    db.query(`DELETE FROM starlink_planes WHERE ${SHEET_ROSTER_WHERE}`).run(airline);
    setMeta(db, "totalAircraftCount", totalAircraftCount, airline);
    stampLastUpdated(db, airline, "sheet-scrape");

    // Raw sheet tallies (pre-dedup, pre-verification). Display/API counts come
    // from getStarlinkPlanes()/getFleetStats() — these meta keys are diagnostic.
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
      if (!looksLikeValidTailNumber(tailNumber)) {
        warn(`skipping invalid tail '${tailNumber}' from sheet ${aircraft.sheet_gid}`);
        continue;
      }

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
          aircraft.OperatedBy ?? AIRLINES[airline]?.name ?? airline,
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
        aircraft.OperatedBy ?? AIRLINES[airline]?.name ?? airline,
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
  return null;
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

/**
 * Single enforcement point for lastUpdated ownership: stamps only when the
 * calling pipeline IS the registry-declared owner for the airline, so a
 * secondary writer (daily fleet sync, residential sync) can never mask a
 * dead primary pipeline's staleness.
 */
export function stampLastUpdated(db: Database, airline: string, writer: LastUpdatedOwner): void {
  if (lastUpdatedOwner(airline) === writer) {
    setMeta(db, "lastUpdated", new Date().toISOString(), airline);
  }
}

/**
 * Recompute meta totals for an airline from united_fleet rows. UA's meta is
 * owned by the hourly spreadsheet scrape (updateDatabase); for HA/AS this is
 * the only periodic writer — without it their meta freezes at seed time.
 * lastUpdated goes through stampLastUpdated as the "fleet-meta" writer.
 */
export function refreshFleetMeta(db: Database, airline: string): void {
  const rows = db
    .query(`
      SELECT fleet,
             COUNT(*) AS total,
             SUM(CASE WHEN starlink_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
      FROM united_fleet
      WHERE airline = ?
      GROUP BY fleet
    `)
    .all(airline) as Array<{ fleet: string; total: number; confirmed: number }>;

  let mainlineTotal = 0;
  let mainlineStarlink = 0;
  let expressTotal = 0;
  let expressStarlink = 0;
  for (const r of rows) {
    if (r.fleet === "mainline") {
      mainlineTotal += r.total;
      mainlineStarlink += r.confirmed;
    } else {
      expressTotal += r.total;
      expressStarlink += r.confirmed;
    }
  }
  const total = mainlineTotal + expressTotal;
  if (total === 0) return;
  const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(2) : "0.00");

  setMeta(db, "totalAircraftCount", total, airline);
  setMeta(db, "mainlineTotal", mainlineTotal, airline);
  setMeta(db, "mainlineStarlink", mainlineStarlink, airline);
  setMeta(db, "mainlinePercentage", pct(mainlineStarlink, mainlineTotal), airline);
  setMeta(db, "expressTotal", expressTotal, airline);
  setMeta(db, "expressStarlink", expressStarlink, airline);
  setMeta(db, "expressPercentage", pct(expressStarlink, expressTotal), airline);
  stampLastUpdated(db, airline, "fleet-meta");
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

export function getAirlineByTail(db: Database, airline?: AirlineFilter): Record<string, string> {
  const q = withAirline("SELECT TailNumber, airline FROM starlink_planes WHERE 1=1", airline);
  const rows = db.query(q.sql).all(...q.params) as { TailNumber: string; airline: string }[];
  return Object.fromEntries(rows.map((r) => [r.TailNumber, r.airline]));
}

// Shared "this row counts as Starlink-equipped" predicate for starlink_planes
// reads. Excludes tails united_fleet has settled as 'negative' so the headline
// list, hero rings, hub cards, and check-flight all agree. `_neg` alias avoids
// collisions with callers that already join united_fleet/upcoming_flights as uf.
function equippedFilter(sp: string): string {
  return `(${sp}.verified_wifi IS NULL OR ${sp}.verified_wifi = 'Starlink')
    AND NOT EXISTS (
      SELECT 1 FROM united_fleet _neg
      WHERE _neg.tail_number = ${sp}.TailNumber AND _neg.starlink_status = 'negative'
    )`;
}

// DateFound records when WE found the tail, not when the antenna went on.
// Bulk writers — seed batches (sheet_gid '*_seed'), type-rule settles, and
// FlyerTalk backfills — stamp a single run date across many tails, so any
// "recent installs" surface must exclude them or a one-day import reads as an
// install spike. (Set E made type_rule writes DateFound NULL; the predicate
// still excludes legacy 'type_deterministic' rows with a stamped date.)
const INSTALL_FILTER = `DateFound IS NOT NULL
    AND (sheet_gid IS NULL OR (
      sheet_gid NOT LIKE '%\\_seed' ESCAPE '\\'
      AND sheet_gid <> 'type_deterministic'
      AND sheet_gid NOT LIKE 'flyertalk\\_%' ESCAPE '\\'
    ))`;

/** JS mirror of INSTALL_FILTER's sheet_gid exclusions for non-SQL surfaces
 * (OG sparkline). Agreement with the SQL is pinned in tests/vocabulary.test.ts. */
export function isBulkGid(gid: string | null | undefined): boolean {
  return !!gid && /_seed$|^type_deterministic$|^flyertalk_/.test(gid);
}

export function getRecentInstalls(
  db: Database,
  airline: AirlineFilter,
  limit = 25,
  perAirlineCap?: number
): RecentInstall[] {
  const cols = "airline, TailNumber, aircraft as Aircraft, OperatedBy, DateFound";
  const filter = `${equippedFilter("starlink_planes")} AND ${INSTALL_FILTER}`;
  if (perAirlineCap && perAirlineCap > 0) {
    const q = withAirline(
      `SELECT ${cols}, ROW_NUMBER() OVER (PARTITION BY airline ORDER BY DateFound DESC) AS rn
       FROM starlink_planes WHERE ${filter}`,
      airline
    );
    return db
      .query(
        `SELECT airline, TailNumber, Aircraft, OperatedBy, DateFound FROM (${q.sql})
         WHERE rn <= ? ORDER BY DateFound DESC LIMIT ?`
      )
      .all(...q.params, perAirlineCap, limit) as RecentInstall[];
  }
  const q = withAirline(`SELECT ${cols} FROM starlink_planes WHERE ${filter}`, airline);
  return db
    .query(`${q.sql} ORDER BY DateFound DESC LIMIT ?`)
    .all(...q.params, limit) as RecentInstall[];
}

export interface HubAirlineStat {
  code: string;
  starlink: number;
  total: number;
  fleetTotal: number;
  installs30d: number;
}

export function getHubStats(db: Database, codes: readonly string[]): HubAirlineStat[] {
  const placeholders = codes.map(() => "?").join(",");
  const fleet = db
    .query(
      `SELECT airline, COUNT(*) total FROM united_fleet
       WHERE airline IN (${placeholders}) GROUP BY airline`
    )
    .all(...codes) as { airline: string; total: number }[];
  // Equipped count from starlink_planes — the authoritative table — not from
  // united_fleet.starlink_status, which lags during reconcile cycles. Same
  // source /api/fleet-summary uses, so the cards never contradict it.
  const equipped = db
    .query(
      `SELECT airline, COUNT(*) n FROM starlink_planes
       WHERE ${equippedFilter("starlink_planes")}
         AND airline IN (${placeholders})
       GROUP BY airline`
    )
    .all(...codes) as { airline: string; n: number }[];
  const equippedBy = Object.fromEntries(equipped.map((r) => [r.airline, r.n]));
  const v = db
    .query(
      `SELECT airline, COUNT(*) n FROM starlink_planes
       WHERE DateFound >= date('now','-30 day')
         AND ${equippedFilter("starlink_planes")}
         AND ${INSTALL_FILTER}
         AND airline IN (${placeholders})
       GROUP BY airline`
    )
    .all(...codes) as { airline: string; n: number }[];
  const v30 = Object.fromEntries(v.map((r) => [r.airline, r.n]));
  return fleet.map((f) => {
    const starlink = equippedBy[f.airline] ?? 0;
    return {
      code: f.airline,
      starlink,
      total: getTotalCount(db, f.airline) || f.total,
      fleetTotal: f.total,
      installs30d: v30[f.airline] ?? 0,
    };
  });
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
     FROM starlink_planes sp
     WHERE ${equippedFilter("sp")}`,
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

  // `starlink` is the per-fleet slice of getStarlinkPlanes() so the hero rings
  // satisfy express + mainline = headline. The united_fleet JOIN only annotates
  // how many of those rows still lack a 'confirmed' consensus (unverified).
  const q = withAirline(
    `SELECT
       sp.fleet,
       SUM(CASE WHEN uf.starlink_status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
       SUM(CASE WHEN uf.starlink_status IS NOT 'confirmed' THEN 1 ELSE 0 END) as unverified
     FROM starlink_planes sp
     LEFT JOIN united_fleet uf ON sp.TailNumber = uf.tail_number
     WHERE ${equippedFilter("sp")}`,
    airline,
    "sp"
  );
  const rows = db.query(`${q.sql} GROUP BY sp.fleet`).all(...q.params) as Array<{
    fleet: string;
    confirmed: number;
    unverified: number;
  }>;

  // FleetStats has a fixed two-bucket shape (express/mainline). Per-airline
  // subfleet labels vary ("express", "horizon", ...) so anything non-mainline
  // rolls into express. The original label survives on starlink_planes.fleet
  // for UI badges (e.g. as.tsx reads p.fleet === "horizon").
  const express = rows
    .filter((r) => r.fleet !== "mainline")
    .reduce(
      (a, r) => ({ confirmed: a.confirmed + r.confirmed, unverified: a.unverified + r.unverified }),
      {
        confirmed: 0,
        unverified: 0,
      }
    );
  const mainline = rows.find((r) => r.fleet === "mainline") ?? { confirmed: 0, unverified: 0 };
  const expressStarlink = express.confirmed + express.unverified;
  const mainlineStarlink = mainline.confirmed + mainline.unverified;

  return {
    express: {
      total: expressTotal,
      starlink: expressStarlink,
      unverified: express.unverified,
      percentage: expressTotal > 0 ? (expressStarlink / expressTotal) * 100 : 0,
    },
    mainline: {
      total: mainlineTotal,
      starlink: mainlineStarlink,
      unverified: mainline.unverified,
      percentage: mainlineTotal > 0 ? (mainlineStarlink / mainlineTotal) * 100 : 0,
    },
  };
}

export interface FleetRosterEntry {
  tail_number: string;
  aircraft_type: string;
  verified_wifi: string | null;
}

/**
 * The scoped carrier's typed airframe roster from united_fleet. The predictor
 * derives each tail's current Starlink status from the verification log
 * (point-in-time in backtests); verified_wifi is only the fallback for tails
 * the log has never observed.
 */
export function getFleetRoster(db: Database, airline?: AirlineFilter): FleetRosterEntry[] {
  const q = withAirline(
    `SELECT tail_number, aircraft_type, verified_wifi FROM united_fleet
     WHERE aircraft_type IS NOT NULL AND aircraft_type <> ''`,
    airline
  );
  return db.query(q.sql).all(...q.params) as FleetRosterEntry[];
}

// FR24 has shipped epoch-0 / half-parsed departure rows before. Enforce the
// floor at the insert so the invariant lives in the table, not on every read.
const MIN_VALID_DEPARTURE_TS = 946684800; // 2000-01-01

export function updateFlights(
  db: Database,
  tailNumber: string,
  flights: Pick<
    Flight,
    "flight_number" | "departure_airport" | "arrival_airport" | "departure_time" | "arrival_time"
  >[]
) {
  const now = Math.floor(Date.now() / 1000);
  const valid = flights.filter((f) => f.departure_time >= MIN_VALID_DEPARTURE_TS);
  if (valid.length < flights.length) {
    info(`updateFlights ${tailNumber}: dropped ${flights.length - valid.length} pre-2000 rows`);
  }
  const airline =
    (
      db.query("SELECT airline FROM starlink_planes WHERE TailNumber = ?").get(tailNumber) as
        | { airline: string }
        | undefined
    )?.airline ??
    (
      db.query("SELECT airline FROM united_fleet WHERE tail_number = ?").get(tailNumber) as
        | { airline: string }
        | undefined
    )?.airline ??
    "UA";

  const updateFlightsTransaction = db.transaction(() => {
    archivePastDepartures(db, now, tailNumber);
    db.query("DELETE FROM upcoming_flights WHERE tail_number = ?").run(tailNumber);

    if (valid.length > 0) {
      const insertStmt = db.prepare(`
        INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const flight of valid) {
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

  // Mirror routes into the long-lived flight_routes cache so it accumulates
  // independently of the FR24 cache-miss path in mcp-server.lookupFlightRoutes.
  // Stored under the marketing-carrier code (UA123) — that's what
  // getCachedFlightRoutes is queried with.
  const cfg = AIRLINES[airline];
  // All rows with valid airports feed the route cache — a half-parsed
  // departure_time invalidates the schedule row, not the route knowledge.
  for (const flight of flights) {
    if (!flight.flight_number || !flight.departure_airport || !flight.arrival_airport) continue;
    const normalized = cfg
      ? ensureAirlinePrefix(cfg, flight.flight_number)
      : flight.flight_number.trim().toUpperCase();
    const dur =
      flight.arrival_time > flight.departure_time && flight.departure_time >= MIN_VALID_DEPARTURE_TS
        ? flight.arrival_time - flight.departure_time
        : null;
    cacheFlightRoute(db, normalized, flight.departure_airport, flight.arrival_airport, dur, now);
  }
}

// Archive departed flights into departure_log before they're deleted from
// upcoming_flights. NOT-EXISTS dedupe guards against double-logging on the
// per-tail path; the global call (no tailNumber) lets airlines whose tails
// rarely have near-term flights (AS regional, QR long-haul) archive promptly.
export function archivePastDepartures(
  db: Database,
  now = Math.floor(Date.now() / 1000),
  tailNumber?: string
): number {
  const params: (string | number)[] = [now];
  if (tailNumber) params.push(tailNumber);
  return db
    .query(
      `INSERT INTO departure_log (tail_number, airport, departed_at, airline)
       SELECT tail_number, departure_airport, departure_time, airline
       FROM upcoming_flights uf
       WHERE departure_time < ?${tailNumber ? " AND tail_number = ?" : ""}
         AND NOT EXISTS (
           SELECT 1 FROM departure_log dl
           WHERE dl.tail_number = uf.tail_number AND dl.departed_at = uf.departure_time
         )`
    )
    .run(...params).changes;
}

export function getUpcomingFlights(
  db: Database,
  tailNumber?: string,
  airline?: AirlineFilter
): Flight[] {
  const now = Math.floor(Date.now() / 1000);

  let sql = "SELECT * FROM upcoming_flights WHERE departure_time > ?";
  const params: (string | number)[] = [now];
  if (tailNumber) {
    sql += " AND tail_number = ?";
    params.push(tailNumber);
  }
  const q = withAirline(sql, airline, "", params);
  return db.query(`${q.sql} ORDER BY departure_time ASC`).all(...q.params) as Flight[];
}

export type FlightAssignmentRow = Flight & {
  aircraft_type: string;
  OperatedBy: string;
  fleet: string;
  verified_wifi: string | null;
  /** 1 when united_fleet has settled the tail 'negative' — see equippedFilter. */
  settled_negative: number;
  /** united_fleet.verified_wifi for settled-negative tails (names the actual provider). */
  settled_wifi: string | null;
};

/**
 * Check-flight assignments lookup (REST + MCP via check-flight-core). No
 * verified_wifi filter — the core classifies rows into confidence tiers —
 * and ordered by last_updated DESC (for swap dedup). `settled_negative`
 * mirrors equippedFilter's NOT EXISTS clause (the canonical negative-settle
 * rule) so callers don't re-derive it per row; the LEFT JOIN can't fan out
 * because united_fleet.tail_number is UNIQUE.
 */
export function getFlightAssignments(
  db: Database,
  flightNumberVariants: string[],
  startOfDay: number,
  endOfDay: number,
  airline?: AirlineFilter
): FlightAssignmentRow[] {
  const placeholders = flightNumberVariants.map(() => "?").join(", ");
  const q = withAirline(
    `SELECT uf.*, sp.Aircraft as aircraft_type, sp.OperatedBy, sp.fleet, sp.verified_wifi,
       CASE WHEN _neg.tail_number IS NOT NULL THEN 1 ELSE 0 END as settled_negative,
       _neg.verified_wifi as settled_wifi
     FROM upcoming_flights uf
     INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
     LEFT JOIN united_fleet _neg
       ON _neg.tail_number = sp.TailNumber AND _neg.starlink_status = 'negative'
     WHERE uf.flight_number IN (${placeholders})
       AND uf.departure_time >= ? AND uf.departure_time < ?`,
    airline,
    "uf",
    [...flightNumberVariants, startOfDay, endOfDay]
  );
  return db
    .query(`${q.sql} ORDER BY uf.last_updated DESC`)
    .all(...q.params) as FlightAssignmentRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Predictor / route-graph readers (scoped by airline; consumed via ScopedReader)
// ─────────────────────────────────────────────────────────────────────────────

export interface VerificationObservation {
  flight_number: string;
  tail_number: string;
  has_starlink: number;
  checked_at: number;
}

// A clean observation: the check reached the vendor (error IS NULL), parsed a
// verdict, and saw a real provider string. has_starlink=0 with an empty
// wifi_provider is a scrape that missed the wifi section, not a negative.
// Shared by the predictor (here), computeWifiConsensus, and the precision
// harness so training, settling, and scoring all see the same population.
// Columns are unqualified — embed only where the enclosing FROM scope is the
// verification log itself (single table, correlated subqueries included).
export const CLEAN_OBSERVATION_WHERE = `error IS NULL AND has_starlink IS NOT NULL
    AND wifi_provider IS NOT NULL AND wifi_provider <> ''`;

export function getVerificationObservations(
  db: Database,
  airline?: AirlineFilter
): VerificationObservation[] {
  // Sources derive from each scoped airline's verifier backend, so a non-UA
  // predictor reads its own verifier's rows instead of silently getting none.
  const codes = airlineCodes(airline);
  const sources = [
    ...new Set(
      codes.filter((c) => AIRLINES[c]?.verifierBackend).map((c) => verifierSourceTag(AIRLINES[c]))
    ),
  ];
  if (sources.length === 0) return [];
  const q = withAirline(
    `SELECT flight_number, tail_number, has_starlink, checked_at
     FROM starlink_verification_log
     WHERE flight_number IS NOT NULL AND source IN (${sources.map(() => "?").join(",")})
       AND ${CLEAN_OBSERVATION_WHERE}`,
    airline,
    "",
    sources
  );
  return db.query(q.sql).all(...q.params) as VerificationObservation[];
}

export interface RouteFlightRow {
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  route_obs: number;
}

export function getRouteFlights(
  db: Database,
  origin: string | null,
  destination: string | null,
  airline?: AirlineFilter
): RouteFlightRow[] {
  let sql = `SELECT flight_number, departure_airport, arrival_airport, COUNT(*) as route_obs
             FROM upcoming_flights WHERE 1=1`;
  const params: (string | number)[] = [];
  if (origin) {
    sql += " AND departure_airport = ?";
    params.push(origin);
  }
  if (destination) {
    sql += " AND arrival_airport = ?";
    params.push(destination);
  }
  const q = withAirline(sql, airline, "", params);
  return db
    .query(
      `${q.sql} GROUP BY flight_number, departure_airport, arrival_airport ORDER BY route_obs DESC`
    )
    .all(...q.params) as RouteFlightRow[];
}

export interface RouteGraphEdge {
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  obs: number;
  avg_duration_sec: number;
}

export function getRouteGraphEdges(db: Database, airline?: AirlineFilter): RouteGraphEdge[] {
  const q = withAirline(
    `SELECT flight_number, departure_airport, arrival_airport,
            COUNT(*) as obs, AVG(arrival_time - departure_time) as avg_duration_sec
     FROM upcoming_flights WHERE 1=1`,
    airline
  );
  return db
    .query(`${q.sql} GROUP BY flight_number, departure_airport, arrival_airport`)
    .all(...q.params) as RouteGraphEdge[];
}

/**
 * Every ORIG-DEST pair the carrier flies. Only proves absence when a route
 * census exists — that's United's BTS T-100 only (bts_monthly_routes has no
 * airline column) — so any other scope, or an empty census, returns null.
 * upcoming_flights + the flight_routes lookup cache only ADD pairs on top.
 */
export function getServedRoutePairs(db: Database, airline?: AirlineFilter): Set<string> | null {
  const codes = airlineCodes(airline);
  if (codes.length !== 1 || codes[0] !== "UA") return null;

  // Last 12 ingested months: recent enough to keep seasonal routes, bounded
  // so the scan doesn't grow with every month bts-sync appends.
  const pairs = new Set<string>(
    (
      db
        .query(
          `SELECT DISTINCT origin || '-' || dest AS r FROM bts_monthly_routes
           WHERE month IN (SELECT DISTINCT month FROM bts_monthly_routes ORDER BY month DESC LIMIT 12)`
        )
        .all() as { r: string }[]
    ).map((row) => row.r)
  );
  if (pairs.size === 0) return null;

  const uf = withAirline(
    "SELECT DISTINCT departure_airport || '-' || arrival_airport AS r FROM upcoming_flights WHERE 1=1",
    airline
  );
  for (const row of db.query(uf.sql).all(...uf.params) as { r: string }[]) pairs.add(row.r);

  // codes[0] is "UA" (guarded above) — resolved, never a default.
  const cfg = AIRLINES[codes[0]];
  if (cfg) {
    const glob = flightNumberGlob([cfg.iata, cfg.icao]);
    const rows = db
      .query(
        `SELECT DISTINCT origin || '-' || destination AS r FROM flight_routes WHERE ${glob.clause}`
      )
      .all(...glob.params) as { r: string }[];
    for (const row of rows) pairs.add(row.r);
  }
  return pairs;
}

export interface ConfirmedEdge {
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  departure_time: number;
  fleet: string;
}

/** Bounds are the WIDENED window (flightDateWindow queryStart/queryEnd) —
 * callers must filter rows by the departure airport's local date. */
export function getConfirmedStarlinkEdges(
  db: Database,
  queryStart: number,
  queryEnd: number,
  airline?: AirlineFilter
): ConfirmedEdge[] {
  const q = withAirline(
    `SELECT DISTINCT uf.flight_number, uf.departure_airport, uf.arrival_airport, uf.departure_time, sp.fleet
     FROM upcoming_flights uf
     JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
     WHERE sp.verified_wifi = 'Starlink'
       AND uf.departure_time >= ? AND uf.departure_time < ?`,
    airline,
    "uf",
    [queryStart, queryEnd]
  );
  return db.query(q.sql).all(...q.params) as ConfirmedEdge[];
}

export interface SubfleetPenetration {
  equipped: number;
  total: number;
  pct: number;
}

/**
 * Unbiased per-subfleet Starlink install rate from the FULL fleet roster
 * (united_fleet), not from any Starlink-biased observation table. Numerator
 * is the same starlink_planes count getHubStats() uses (united_fleet's
 * starlink_status lags during reconcile cycles), so the route-compare
 * percentages and the hub cards directly above them can never disagree.
 */
export function getSubfleetPenetration(
  db: Database,
  airline: string
): Map<string, SubfleetPenetration> {
  const rows = db
    .query(
      `SELECT uf.fleet, COUNT(*) AS total,
              SUM(CASE WHEN sp.TailNumber IS NOT NULL THEN 1 ELSE 0 END) AS equipped
       FROM united_fleet uf
       LEFT JOIN starlink_planes sp
              ON sp.TailNumber = uf.tail_number
             AND sp.airline = uf.airline
             AND ${equippedFilter("sp")}
       WHERE uf.airline = ?
       GROUP BY uf.fleet`
    )
    .all(airline) as { fleet: string; total: number; equipped: number }[];
  const out = new Map<string, SubfleetPenetration>();
  for (const r of rows) {
    out.set(r.fleet, {
      equipped: r.equipped,
      total: r.total,
      pct: r.total > 0 ? r.equipped / r.total : 0,
    });
  }
  return out;
}

/**
 * All flight numbers observed flying NONSTOP between two airports (either
 * direction) for a given marketing carrier. Union of upcoming_flights
 * (operator-correct, ~48h window) and flight_routes (longer history,
 * filtered by carrier-prefix GLOB since it has no airline column).
 * Returns bare numeric strings so OO5579/SKW5579/UA5579 dedupe.
 */
export function getObservedDirectFlightNumbers(
  db: Database,
  airline: string,
  prefixes: readonly string[],
  origin: string,
  destination: string
): string[] {
  const upcoming = db
    .query(
      `SELECT DISTINCT flight_number FROM upcoming_flights
       WHERE airline = ?
         AND ((departure_airport = ? AND arrival_airport = ?)
           OR (departure_airport = ? AND arrival_airport = ?))`
    )
    .all(airline, origin, destination, destination, origin) as { flight_number: string }[];

  const glob = flightNumberGlob(prefixes);
  const cached = glob.clause
    ? (db
        .query(
          `SELECT DISTINCT flight_number FROM flight_routes
           WHERE ((origin = ? AND destination = ?) OR (origin = ? AND destination = ?))
             AND (${glob.clause})`
        )
        .all(origin, destination, destination, origin, ...glob.params) as {
        flight_number: string;
      }[])
    : [];

  const seen = new Set<string>();
  for (const r of [...upcoming, ...cached]) {
    const m = r.flight_number.match(/(\d+)$/);
    if (m) seen.add(m[1]);
  }
  return [...seen];
}

/** True if the airline serves both airports — gates inferred_absent so it
 * never fires for routes the airline doesn't fly. Checks flight_routes (the
 * historical cache, populated by any lookup) in addition to upcoming_flights
 * (Starlink-only, ~48h) so coverage is symmetric across carriers. */
export function airlineServesAirports(
  db: Database,
  airline: string,
  prefixes: readonly string[],
  ...airports: string[]
): boolean {
  const glob = flightNumberGlob(prefixes);
  for (const ap of airports) {
    const row =
      db
        .query(
          `SELECT 1 FROM upcoming_flights
           WHERE airline = ? AND (departure_airport = ? OR arrival_airport = ?) LIMIT 1`
        )
        .get(airline, ap, ap) ??
      (glob.clause
        ? db
            .query(
              `SELECT 1 FROM flight_routes
               WHERE (origin = ? OR destination = ?) AND (${glob.clause}) LIMIT 1`
            )
            .get(ap, ap, ...glob.params)
        : undefined);
    if (!row) return false;
  }
  return true;
}

export interface DirectRouteEdge {
  flight_number: string;
  dur_sec: number;
}

export function getDirectRouteEdge(
  db: Database,
  origin: string,
  destination: string,
  airline?: AirlineFilter
): DirectRouteEdge | null {
  const q = withAirline(
    `SELECT flight_number, AVG(arrival_time - departure_time) as dur_sec
     FROM upcoming_flights
     WHERE departure_airport = ? AND arrival_airport = ?`,
    airline,
    "",
    [origin, destination]
  );
  return db
    .query(`${q.sql} GROUP BY flight_number LIMIT 1`)
    .get(...q.params) as DirectRouteEdge | null;
}

export interface RouteEntryRow {
  origin: string;
  destination: string;
  duration_sec: number | null;
}

/** flight_routes cache lookup (last_seen_at > freshAfter). flight_routes is airline-agnostic (PK includes IATA prefix). */
export function getCachedFlightRoutes(
  db: Database,
  flightNumber: string,
  freshAfter: number
): RouteEntryRow[] {
  return db
    .query(
      `SELECT origin, destination, duration_sec FROM flight_routes
       WHERE flight_number = ? AND last_seen_at > ? ORDER BY seen_count DESC`
    )
    .all(flightNumber, freshAfter) as RouteEntryRow[];
}

/** Best-effort upsert into flight_routes cache. Readonly-safe (swallows write errors). */
export function cacheFlightRoute(
  db: Database,
  flightNumber: string,
  origin: string,
  destination: string,
  durationSec: number | null,
  now = Math.floor(Date.now() / 1000)
): void {
  try {
    db.query(`
      INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (flight_number, origin, destination) DO UPDATE SET
        duration_sec = COALESCE(excluded.duration_sec, duration_sec),
        last_seen_at = excluded.last_seen_at,
        seen_count = seen_count + 1
    `).run(flightNumber, origin, destination, durationSec, now, now);
  } catch {
    // readonly DB (tests/snapshots) — skip persist
  }
}

/** L3 fallback for route lookup: distinct routes for these flight-number variants in our own snapshot. */
export function getRoutesForFlightVariants(
  db: Database,
  variants: string[],
  airline?: AirlineFilter
): { departure_airport: string; arrival_airport: string; dur_sec: number }[] {
  const placeholders = variants.map(() => "?").join(",");
  const q = withAirline(
    `SELECT DISTINCT departure_airport, arrival_airport,
            AVG(arrival_time - departure_time) as dur_sec
     FROM upcoming_flights WHERE flight_number IN (${placeholders})`,
    airline,
    "",
    [...variants]
  );
  return db
    .query(`${q.sql} GROUP BY departure_airport, arrival_airport LIMIT 3`)
    .all(...q.params) as { departure_airport: string; arrival_airport: string; dur_sec: number }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-tail lookups. tail_number is UNIQUE, but the airline filter is still
// load-bearing: without it, a tenant's FR24 fallback can resolve ANOTHER
// airline's tail to "verified yes" under its own branding (cross-tenant leak).
// ─────────────────────────────────────────────────────────────────────────────

export function getStarlinkPlaneByTail(
  db: Database,
  tail: string,
  airline?: AirlineFilter
): { Aircraft: string; OperatedBy: string; fleet: string } | null {
  const q = withAirline(
    "SELECT Aircraft, OperatedBy, fleet FROM starlink_planes WHERE TailNumber = ?",
    airline,
    "",
    [tail]
  );
  return db.query(q.sql).get(...q.params) as {
    Aircraft: string;
    OperatedBy: string;
    fleet: string;
  } | null;
}

export function getFleetEntryByTail(
  db: Database,
  tail: string,
  airline?: AirlineFilter
): { starlink_status: string; verified_wifi: string | null; verified_at: number | null } | null {
  const q = withAirline(
    "SELECT starlink_status, verified_wifi, verified_at FROM united_fleet WHERE tail_number = ?",
    airline,
    "",
    [tail]
  );
  return db.query(q.sql).get(...q.params) as {
    starlink_status: string;
    verified_wifi: string | null;
    verified_at: number | null;
  } | null;
}

export function getStarlinkTailsByCheckAge(db: Database): string[] {
  return (
    db
      .query(
        "SELECT TailNumber FROM starlink_planes WHERE TailNumber IS NOT NULL ORDER BY last_flight_check ASC"
      )
      .all() as { TailNumber: string }[]
  ).map((r) => r.TailNumber);
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
    (tail_number, source, checked_at, has_starlink, wifi_provider, aircraft_type, flight_number, error, tail_confirmed, airline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.tail_number,
    entry.source,
    now,
    entry.has_starlink === null ? null : entry.has_starlink ? 1 : 0,
    entry.wifi_provider,
    entry.aircraft_type,
    entry.flight_number,
    entry.error,
    entry.tail_confirmed ?? null,
    entry.airline
  );
}

/**
 * Drop subprocess-crash rows that carry no observation. Aircraft-mismatch
 * rows are kept — they document tail-on-flight assignments. The 7-day window
 * stays above needsVerification's max ~96h jitter so retry-storm protection
 * holds.
 */
export function pruneCrashRows(db: Database): number {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  const result = db
    .query(`
      DELETE FROM starlink_verification_log
      WHERE has_starlink IS NULL
        AND error LIKE 'Process exited with code%'
        AND checked_at < ?
    `)
    .run(cutoff);
  return result.changes;
}

/**
 * Next united_fleet tail (alaska-json airlines) that has no future upcoming_flights row.
 * Breaks the circular dep where getNextAlaskaVerifyTarget requires upcoming_flights but
 * the flight-updater only populates upcoming_flights for starlink_planes tails.
 */
export function getNextFleetTailNeedingFlights(
  db: Database,
  exclude: string[] = []
): string | null {
  const codes = enabledAirlines()
    .filter((a) => a.verifierBackend === "alaska-json")
    .map((a) => a.code);
  if (codes.length === 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const codePh = codes.map(() => "?").join(",");
  const exPh = exclude.length
    ? `AND uf.tail_number NOT IN (${exclude.map(() => "?").join(",")})`
    : "";
  const row = db
    .query(`
      SELECT uf.tail_number
      FROM united_fleet uf
      WHERE uf.airline IN (${codePh})
        ${exPh}
        AND NOT EXISTS (
          SELECT 1 FROM upcoming_flights f
          WHERE f.tail_number = uf.tail_number AND f.departure_time > ?
        )
      ORDER BY uf.verified_at IS NOT NULL, uf.verified_at ASC, uf.tail_number
      LIMIT 1
    `)
    .get(...codes, ...exclude, now) as { tail_number: string } | null;
  return row?.tail_number ?? null;
}

export function getNextAlaskaVerifyTarget(
  db: Database,
  airline: "AS" | "HA"
): { tail_number: string; aircraft_type: string | null; fleet: string | null } | null {
  const now = Math.floor(Date.now() / 1000);
  return db
    .query(`
      SELECT uf.tail_number, uf.aircraft_type, uf.fleet
      FROM united_fleet uf
      WHERE uf.airline = ?
        AND (uf.verified_at IS NULL OR uf.verified_at < ?)
        AND EXISTS (SELECT 1 FROM upcoming_flights f WHERE f.tail_number = uf.tail_number AND f.departure_time > ?)
      ORDER BY uf.verified_at IS NOT NULL, uf.verified_at ASC
      LIMIT 1
    `)
    .get(airline, now - ALASKA_VERIFY_THRESHOLD_HOURS * 3600, now) as {
    tail_number: string;
    aircraft_type: string | null;
    fleet: string | null;
  } | null;
}

export const ALASKA_VERIFY_THRESHOLD_HOURS = 168;

export function getNextFlightForTail(
  db: Database,
  tail: string
): { flight_number: string; departure_time: number; departure_airport: string } | null {
  return db
    .query(`
      SELECT flight_number, departure_time, departure_airport FROM upcoming_flights
      WHERE tail_number = ? AND departure_time > ?
      ORDER BY departure_time ASC LIMIT 1
    `)
    .get(tail, Math.floor(Date.now() / 1000)) as {
    flight_number: string;
    departure_time: number;
    departure_airport: string;
  } | null;
}

// Emit fleet.status_change at the write site so every mutator path is
// covered, not just the discovery scan (which can be starved during outages).
function emitFleetStatusChange(
  prev: { starlink_status: string | null; fleet: string | null; airline: string | null } | null,
  next: StarlinkStatus
): void {
  if (!prev || prev.starlink_status === next) return;
  metrics.increment(COUNTERS.FLEET_STATUS_CHANGE, {
    fleet: normalizeFleet(prev.fleet),
    from: normalizeStarlinkStatus(prev.starlink_status),
    to: normalizeStarlinkStatus(next),
    airline: normalizeAirlineTag(prev.airline),
  });
}

function getFleetStatusRow(
  db: Database,
  tail: string
): { starlink_status: string | null; fleet: string | null; airline: string | null } | null {
  return db
    .query("SELECT starlink_status, fleet, airline FROM united_fleet WHERE tail_number = ?")
    .get(tail) as {
    starlink_status: string | null;
    fleet: string | null;
    airline: string | null;
  } | null;
}

export function setFleetVerified(
  db: Database,
  tail: string,
  wifi: string | null,
  status: StarlinkStatus
): void {
  const now = Math.floor(Date.now() / 1000);
  const prev = getFleetStatusRow(db, tail);
  db.query(
    "UPDATE united_fleet SET verified_wifi = ?, verified_at = ?, starlink_status = ? WHERE tail_number = ?"
  ).run(wifi, now, status, tail);
  emitFleetStatusChange(prev, status);
}

export function touchFleetVerifiedAt(db: Database, tail: string): void {
  db.query("UPDATE united_fleet SET verified_at = ? WHERE tail_number = ?").run(
    Math.floor(Date.now() / 1000),
    tail
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
    airline: string;
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
    airline: row.airline,
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
    alaska: ALASKA_VERIFY_THRESHOLD_HOURS,
    qatar: 24, // qatar-fltstatus is schedule-grade; daily is plenty
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
    airline: string;
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
    airline: row.airline,
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
    alaska: 0,
    qatar: 0,
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
 * Compute wifi consensus from recent CLEAN_OBSERVATION_WHERE log entries.
 * Returns verdict=null when n < minObs OR the split is in the ambiguous zone.
 */
export function computeWifiConsensus(
  db: Database,
  tailNumber: string,
  opts: {
    windowDays?: number;
    minObs?: number;
    threshold?: number;
    /** Default (display surfaces): all registry verifier sources. WRITE paths
     * must pass OBSERVED_WIFI_SOURCES so type-derived rows never gain
     * verified_wifi write authority. */
    sources?: readonly VerificationSource[];
    /** Scope the evidence rows to the reading tenant's airline(s). */
    airline?: AirlineFilter;
  } = {}
): WifiConsensus {
  const { windowDays = 30, minObs = 2, threshold = 0.7, sources = VERIFICATION_SOURCES } = opts;
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400;
  // Accepted sources derive from the registry (each enabled airline's
  // verifier backend), so AS/HA evidence weighs in — not just united rows.
  const base = withAirline(
    `tail_number = ? AND source IN (${sources.map(() => "?").join(",")})
    AND checked_at >= ?
    AND ${CLEAN_OBSERVATION_WHERE}`,
    opts.airline,
    "",
    [tailNumber, ...sources, cutoff]
  );

  // Primary: only tail_confirmed=1 (post-fix clean data)
  let obs = db
    .query(`SELECT has_starlink, wifi_provider FROM starlink_verification_log
      WHERE ${base.sql} AND tail_confirmed = 1 ORDER BY checked_at DESC`)
    .all(...base.params) as Array<{
    has_starlink: number;
    wifi_provider: string;
  }>;

  // Grace fallback: if zero confirmed rows, read legacy NULL rows so display
  // counts (n, starlinkPct) aren't zero during the 30d transition. Legacy is
  // the contaminated set, so it MUST NOT produce a verdict — otherwise tails
  // reset to unknown get re-dragged to negative before clean data accumulates.
  let usedLegacyFallback = false;
  if (obs.length === 0) {
    obs = db
      .query(`SELECT has_starlink, wifi_provider FROM starlink_verification_log
        WHERE ${base.sql} AND tail_confirmed IS NULL ORDER BY checked_at DESC`)
      .all(...base.params) as Array<{
      has_starlink: number;
      wifi_provider: string;
    }>;
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

  if (n < minObs) {
    return {
      verdict: null,
      n,
      starlinkPct,
      reason: `insufficient recent obs (${n} in last ${windowDays}d, need ${minObs})`,
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

  if (starlinkPct >= threshold) {
    return {
      verdict: "Starlink",
      n,
      starlinkPct,
      reason: `${starlinkObs}/${n} recent obs Starlink (${(starlinkPct * 100).toFixed(0)}%)`,
    };
  }

  if (1 - starlinkPct >= threshold) {
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

export function consensusToFleetStatus(verdict: string | null): StarlinkStatus | null {
  return verdict === null ? null : verdict === "Starlink" ? "confirmed" : "negative";
}

/**
 * On the first confirmed tail of an aircraft family, pull every negative
 * sibling forward in the discovery queue. Returns the number of tails bumped
 * (0 when not first-of-family). Priority 0.9 keeps user-triggered bumps (1.0)
 * ahead of a large cascade.
 */
export function cascadeSubfleetDiscovery(
  db: Database,
  confirmedTail: string,
  aircraftType: string | null,
  airline: string
): number {
  const family = normalizeAircraftType(aircraftType);
  if (family === "unknown" || family === "other") return 0;

  const peers = db
    .query(
      "SELECT tail_number, aircraft_type, starlink_status FROM united_fleet WHERE airline = ? AND tail_number != ?"
    )
    .all(airline, confirmedTail) as Array<{
    tail_number: string;
    aircraft_type: string | null;
    starlink_status: string;
  }>;
  const sameFamily = peers.filter((p) => normalizeAircraftType(p.aircraft_type) === family);
  if (sameFamily.some((p) => p.starlink_status === "confirmed")) return 0;

  const toBump = sameFamily
    .filter((p) => p.starlink_status === "negative")
    .map((p) => p.tail_number);
  if (toBump.length === 0) return 0;

  const now = Math.floor(Date.now() / 1000);
  db.query(
    `UPDATE united_fleet
     SET next_check_after = MIN(next_check_after, ?),
         discovery_priority = MAX(discovery_priority, 0.9)
     WHERE tail_number IN (${toBump.map(() => "?").join(",")})`
  ).run(now, ...toBump);
  return toBump.length;
}

/**
 * Bump discovery priority so a tail is re-checked on the next fleet-discovery
 * cycle. Idempotent: only bumps if not already due.
 */
export function bumpDiscoveryPriority(
  db: Database,
  tailNumber: string,
  airline?: AirlineFilter
): void {
  const now = Math.floor(Date.now() / 1000);
  try {
    const q = withAirline(
      `UPDATE united_fleet
      SET next_check_after = ?, discovery_priority = 1.0
      WHERE tail_number = ? AND next_check_after > ?`,
      airline,
      "",
      [now, tailNumber, now]
    );
    db.query(q.sql).run(...q.params);
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

export function reconcileTypeDeterministicFleets(db: Database): number {
  let total = 0;
  for (const a of enabledAirlines()) {
    if (!a.typeDeterministicWifi) continue;
    const rows = db
      .query(
        "SELECT tail_number, aircraft_type, starlink_status, fleet, airline FROM united_fleet WHERE airline = ? AND aircraft_type IS NOT NULL"
      )
      .all(a.code) as Array<{
      tail_number: string;
      aircraft_type: string;
      starlink_status: string | null;
      fleet: string | null;
      airline: string | null;
    }>;
    // Deliberately does NOT stamp united_fleet.verified_at: a type-rule
    // settle is not a per-tail verification, and the verifier queue serves
    // NULL verified_at first so these tails get real checks promptly.
    const update = db.query(
      "UPDATE united_fleet SET starlink_status = ? WHERE tail_number = ? AND airline = ?"
    );
    let changed = 0;
    const apply = db.transaction(
      (pending: Array<(typeof rows)[number] & { next: StarlinkStatus }>) => {
        for (const r of pending) {
          update.run(r.next, r.tail_number, a.code);
          emitFleetStatusChange(r, r.next);
          if (r.next === "confirmed") {
            addDiscoveredStarlinkPlane(
              db,
              r.tail_number,
              r.aircraft_type,
              "Starlink",
              a.name,
              r.fleet ?? "mainline",
              { airline: a.code, evidence: "type_rule" }
            );
          }
          changed++;
        }
      }
    );
    apply(
      rows.flatMap((r) => {
        const next = a.typeDeterministicWifi?.(r.aircraft_type) ?? null;
        return next === null || next === r.starlink_status ? [] : [{ ...r, next }];
      })
    );
    if (changed > 0) info(`Type-deterministic reconcile: ${a.code} ${changed} tails updated`);
    total += changed;
  }
  return total;
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
    // Write authority: only observed-wifi sources. Type-derived rows (alaska
    // wifi = type inference) must not flip verified_wifi from here.
    const consensus = computeWifiConsensus(db, tail, { sources: OBSERVED_WIFI_SOURCES });
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

// Excludes 'None': united.com flaps Starlink↔None on regionals, so 'None' isn't
// an actionable sheet contradiction. Shared by getWifiMismatches +
// getVerificationSummary so /api/mismatches list and summary.count can't drift.
const WIFI_MISMATCH_PREDICATE = `verified_wifi IS NOT NULL
       AND verified_wifi != 'None'
       AND (
         (wifi IN ('StrLnk', 'Starlink') AND verified_wifi != 'Starlink')
         OR
         (wifi NOT IN ('StrLnk', 'Starlink') AND verified_wifi = 'Starlink')
       )`;

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
     WHERE ${WIFI_MISMATCH_PREDICATE}`,
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
      AND verified_wifi != 'None'
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
       SUM(CASE WHEN ${WIFI_MISMATCH_PREDICATE} THEN 1 ELSE 0 END) as mismatches_count,
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
  // Seed verdicts settle starlink_status without the verifier loop. Applied on
  // insert only — re-runs do NOT clobber an existing status (avoids the
  // documented starlink_status tug-of-war between writers). Evidence tiers:
  //  - "observed" (community-spotted tails, e.g. FlyerTalk): the wifi was seen
  //    on this tail, so verified_wifi/verified_at are stamped and the tail is
  //    parked out of the verifier queue for a year.
  //  - "type_rule": the status is a fleet-program inference, not a per-tail
  //    observation. Mirrors reconcileTypeDeterministicFleets: verified stamps
  //    stay NULL and the tail stays verifier-eligible (no parking), so the
  //    per-tail verifier confirms it organically.
  seedVerdict?: {
    starlinkStatus: StarlinkStatus;
    verifiedWifi: string | null;
    evidence: "observed" | "type_rule";
  }
): void {
  const now = Math.floor(Date.now() / 1000);
  // Empty/placeholder type strings must not clobber a real value via COALESCE.
  const type = aircraftType?.trim();
  const safeType = type && !/^unknown$/i.test(type) ? type : null;

  const existing = db
    .query("SELECT id, starlink_status, fleet, airline FROM united_fleet WHERE tail_number = ?")
    .get(tailNumber) as {
    id: number;
    starlink_status: StarlinkStatus;
    fleet: string | null;
    airline: string | null;
  } | null;

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
      const observed = seedVerdict.evidence === "observed";
      db.query(`
        UPDATE united_fleet
        SET starlink_status = ?, verified_wifi = ?, verified_at = ?, next_check_after = ?
        WHERE tail_number = ?
      `).run(
        seedVerdict.starlinkStatus,
        observed ? seedVerdict.verifiedWifi : null,
        observed && seedVerdict.verifiedWifi ? now : null,
        observed ? now + 365 * 24 * 3600 : 0,
        tailNumber
      );
      emitFleetStatusChange(existing, seedVerdict.starlinkStatus);
    }
  } else {
    const status = seedVerdict?.starlinkStatus ?? "unknown";
    const observed = seedVerdict?.evidence === "observed";
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
      observed ? (seedVerdict?.verifiedWifi ?? null) : null,
      observed && seedVerdict?.verifiedWifi ? now : null,
      observed ? now + 365 * 24 * 3600 : 0,
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

// 10 consecutive errors with the 1h→24h backoff is ~6 days off the schedule —
// long enough to mean grounded/maintenance, short of the 20-attempt parked tier.
const RTS_STREAK_THRESHOLD = 10;
const RTS_GRACE_SECS = 7 * 24 * 3600;

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

  const prev = db
    .query(
      "SELECT aircraft_type, check_attempts, rts_until, starlink_status, fleet, airline FROM united_fleet WHERE tail_number = ?"
    )
    .get(tailNumber) as {
    aircraft_type: string | null;
    check_attempts: number;
    rts_until: number | null;
    starlink_status: string | null;
    fleet: string | null;
    airline: string | null;
  } | null;

  // A long error streak clearing is a return-to-service: hold a tight re-check
  // window for a week so a retrofit isn't missed by the 14d negative cadence.
  const returnedToService = !result.error && (prev?.check_attempts ?? 0) >= RTS_STREAK_THRESHOLD;
  const rtsUntil = returnedToService ? now + RTS_GRACE_SECS : (prev?.rts_until ?? null);

  let nextCheckDelay: number;
  if (result.error) {
    const attempts = (prev?.check_attempts ?? 0) + 1;
    // 1h, 2h, 4h, 8h, max 24h — but 20+ consecutive failures means parked/stored,
    // and weekly is enough to catch a return to service.
    nextCheckDelay =
      attempts >= 20 ? 7 * 24 * 3600 : Math.min(24 * 3600, 3600 * 2 ** (attempts - 1));
  } else if (result.needsMoreObs) {
    // Consensus is ambiguous/insufficient — re-check in ~36h so it converges
    // within a few days instead of waiting 7-14 days between observations.
    nextCheckDelay = 36 * 3600;
  } else if (result.starlinkStatus === "confirmed") {
    nextCheckDelay = 7 * 24 * 3600;
  } else {
    nextCheckDelay = 14 * 24 * 3600;
  }
  if (!result.error && result.starlinkStatus !== "confirmed" && rtsUntil && rtsUntil > now)
    nextCheckDelay = Math.min(nextCheckDelay, 24 * 3600);

  const jitter = (Math.random() - 0.5) * 0.2 * nextCheckDelay;
  const nextCheckAfter = now + nextCheckDelay + jitter;

  const priority = calculateDiscoveryPriority(
    prev?.aircraft_type ?? null,
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
          discovery_priority = ?,
          rts_until = ?
      WHERE tail_number = ?
    `).run(
      result.starlinkStatus,
      result.verifiedWifi,
      now,
      nextCheckAfter,
      priority,
      rtsUntil,
      tailNumber
    );
    emitFleetStatusChange(prev, result.starlinkStatus);
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

  const existsStmt = db.prepare(
    "SELECT id, starlink_status, fleet, airline FROM united_fleet WHERE tail_number = ?"
  );
  // starlink_status follows verified_wifi (the consensus-driven column) so
  // retrofit transitions converge hourly instead of waiting 7-14d for discovery.
  // When verified_wifi is NULL (unverified) we leave status alone — avoids the
  // NULL→negative drag (3a41095). aircraft_type COALESCE so an empty sheet value
  // can't clobber a real FR24-sourced type.
  const updateStmt = db.prepare(`
    UPDATE united_fleet
    SET aircraft_type = COALESCE(?, aircraft_type),
        fleet = ?,
        operated_by = ?,
        verified_wifi = COALESCE(?, verified_wifi),
        starlink_status = CASE WHEN ? != 'unknown' THEN ? ELSE starlink_status END
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

  // Defer metric emit until the transaction commits so DogStatsD never reports
  // a transition that gets rolled back.
  const transitions: Array<{
    prev: { starlink_status: string | null; fleet: string | null; airline: string | null };
    next: StarlinkStatus;
  }> = [];

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

      const existing = existsStmt.get(plane.TailNumber) as {
        id: number;
        starlink_status: string | null;
        fleet: string | null;
        airline: string | null;
      } | null;
      if (existing) {
        if (starlinkStatus !== "unknown" && existing.starlink_status !== starlinkStatus) {
          transitions.push({ prev: existing, next: starlinkStatus });
        }
        updateStmt.run(
          type,
          plane.fleet,
          plane.OperatedBy,
          plane.verified_wifi,
          starlinkStatus,
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

  for (const t of transitions) emitFleetStatusChange(t.prev, t.next);

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
  operatedBy: string | null,
  fleet: string,
  opts: {
    airline: string;
    sheetGid?: string;
    dateFound?: string;
    /** Required — defaulting to 'observed' is exactly the rollout-cliff
     * fabrication path this field exists to prevent.
     * 'type_rule' = settled by a program rule, not observed on this tail:
     * no DateFound (a deploy-day batch would fabricate a rollout cliff in
     * rolloutSeries/installs30d) and no verified_* stamp (per-tail
     * verification hasn't happened; the verifier queue serves NULL
     * verified_at first, so these get real checks promptly). */
    evidence: "observed" | "type_rule";
  }
): void {
  // Runtime guard too: ad-hoc callers (bun -e, untyped scripts) bypass tsc,
  // and a silently-defaulted 'observed' is the fabrication path.
  if (opts.evidence !== "observed" && opts.evidence !== "type_rule") {
    throw new Error(
      `addDiscoveredStarlinkPlane(${tailNumber}): opts.evidence must be "observed" or "type_rule"`
    );
  }

  // Check if already in starlink_planes
  const existing = db.query("SELECT id FROM starlink_planes WHERE TailNumber = ?").get(tailNumber);
  if (existing) return;

  const typeRule = opts.evidence === "type_rule";
  const gid = opts.sheetGid ?? (typeRule ? "type_deterministic" : "discovery");
  const today = new Date().toISOString().split("T")[0];

  db.query(`
    INSERT INTO starlink_planes (
      aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet,
      verified_wifi, verified_at, airline
    ) VALUES (?, 'StrLnk', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    aircraftType || null,
    gid,
    gid,
    typeRule ? null : (opts.dateFound ?? today),
    tailNumber,
    operatedBy || (AIRLINES[opts.airline]?.name ?? opts.airline),
    fleet,
    typeRule ? null : wifiProvider,
    typeRule ? null : Math.floor(Date.now() / 1000),
    opts.airline
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

export function bodyClassOf(family: string): BodyClass {
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

/** Replace an airline's install-pipeline rows, per segment, so types dropped
 * from the sheet don't linger as stale rows. */
export function replaceFleetProgress(
  db: Database,
  airline: string,
  rows: Array<Omit<FleetProgressRow, "airline" | "fetched_at">>
): void {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (const segment of new Set(rows.map((r) => r.segment))) {
      db.query("DELETE FROM fleet_progress WHERE airline = ? AND segment = ?").run(
        airline,
        segment
      );
    }
    for (const r of rows) {
      db.query(`
        INSERT INTO fleet_progress
          (airline, segment, type_code, total, starlink_complete, in_mod, verification_needed,
           sheet_updated, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        airline,
        r.segment,
        r.type_code,
        r.total,
        r.starlink_complete,
        r.in_mod,
        r.verification_needed,
        r.sheet_updated,
        now
      );
    }
  })();
}

export function getFleetProgress(db: Database, airline?: AirlineFilter): FleetProgressRow[] {
  const q = withAirline(
    `SELECT airline, segment, type_code, total, starlink_complete, in_mod, verification_needed,
            sheet_updated, fetched_at
     FROM fleet_progress WHERE 1=1`,
    airline
  );
  return db.query(`${q.sql} ORDER BY segment, type_code`).all(...q.params) as FleetProgressRow[];
}

/** Replace the FAA registry slice with the latest pull (full refresh, one transaction). */
export function replaceFaaRegistry(
  db: Database,
  rows: Array<Omit<FaaRegistryRow, "last_refreshed">>
): void {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.query("DELETE FROM faa_registry").run();
    for (const r of rows) {
      db.query(`
        INSERT INTO faa_registry
          (tail_number, mode_s_hex, serial, year_mfr, faa_status, registrant, faa_model,
           expiration_date, dereg_date, last_refreshed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        r.tail_number,
        r.mode_s_hex,
        r.serial,
        r.year_mfr,
        r.faa_status,
        r.registrant,
        r.faa_model,
        r.expiration_date,
        r.dereg_date,
        now
      );
    }
  })();
}

export function replaceStarlinkPrefixes(
  db: Database,
  rows: ReadonlyArray<{ cidr: string; lo: bigint; hi: bigint; v6: boolean }>
): void {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.query("DELETE FROM starlink_prefixes").run();
    for (const r of rows) {
      db.query(
        "INSERT OR REPLACE INTO starlink_prefixes (cidr, lo, hi, v6, fetched_at) VALUES (?, ?, ?, ?, ?)"
      ).run(r.cidr, r.lo.toString(), r.hi.toString(), r.v6 ? 1 : 0, now);
    }
  })();
}

export function getStarlinkPrefixes(
  db: Database
): Array<{ cidr: string; lo: bigint; hi: bigint; v6: boolean }> {
  const rows = db.query("SELECT cidr, lo, hi, v6 FROM starlink_prefixes").all() as Array<{
    cidr: string;
    lo: string;
    hi: string;
    v6: number;
  }>;
  return rows.map((r) => ({ cidr: r.cidr, lo: BigInt(r.lo), hi: BigInt(r.hi), v6: r.v6 === 1 }));
}

export interface PassengerReportInsert {
  ip: string;
  ip_prefix: string;
  in_geofeed: boolean;
  source: string;
  outcome: string;
  claimed_flight: string | null;
  claimed_tail: string | null;
  claimed_date: string | null;
  router_id: string | null;
  ua_hash: string | null;
  airborne_match: boolean;
}

export function recordPassengerReport(db: Database, r: PassengerReportInsert): void {
  db.query(`
    INSERT INTO passenger_reports
      (reported_at, ip, ip_prefix, in_geofeed, source, outcome,
       claimed_flight, claimed_tail, claimed_date, router_id, ua_hash, airborne_match)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Math.floor(Date.now() / 1000),
    r.ip,
    r.ip_prefix,
    r.in_geofeed ? 1 : 0,
    r.source,
    r.outcome,
    r.claimed_flight,
    r.claimed_tail,
    r.claimed_date,
    r.router_id,
    r.ua_hash,
    r.airborne_match ? 1 : 0
  );
}

export function isFlightAirborne(
  db: Database,
  variants: readonly string[],
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (variants.length === 0) return false;
  const placeholders = variants.map(() => "?").join(",");
  return (
    db
      .query(
        `SELECT 1 FROM upcoming_flights
         WHERE flight_number IN (${placeholders}) AND departure_time <= ? AND arrival_time >= ?
         LIMIT 1`
      )
      .get(...variants, nowSec, nowSec) !== null
  );
}

/** Per-(prefix, source, tail) dedupe window — limits ballot-stuffing within
 * one flight without letting the page-load probe row swallow a later manual
 * submission from the same client. */
export function passengerReportSeenRecently(
  db: Database,
  ipPrefix: string,
  source: string,
  tail: string | null,
  windowSec: number
): boolean {
  const since = Math.floor(Date.now() / 1000) - windowSec;
  const row = db
    .query(
      `SELECT 1 FROM passenger_reports
       WHERE ip_prefix = ? AND reported_at > ? AND source = ? AND claimed_tail IS ?
       LIMIT 1`
    )
    .get(ipPrefix, since, source, tail);
  return row !== null;
}

/** Upsert anchors keyed by (airline, metric, as-of date) — editing SEED_ANCHORS
 * and redeploying is the whole correction story, no manual SQL. */
export function seedFleetAnchors(
  db: Database,
  rows: Array<Omit<FleetAnchorRow, "added_at">>
): void {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (const r of rows) {
      db.query(`
        INSERT INTO fleet_anchors
          (airline, as_of_date, scope, metric, value, source_form, source_url, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(airline, metric, as_of_date) DO UPDATE SET
          scope = excluded.scope,
          value = excluded.value,
          source_form = excluded.source_form,
          source_url = excluded.source_url
      `).run(r.airline, r.as_of_date, r.scope, r.metric, r.value, r.source_form, r.source_url, now);
    }
  })();
}

export function getFleetAnchors(db: Database, airline?: AirlineFilter): FleetAnchorRow[] {
  const q = withAirline(
    `SELECT airline, as_of_date, scope, metric, value, source_form, source_url, added_at
     FROM fleet_anchors WHERE 1=1`,
    airline
  );
  return db.query(`${q.sql} ORDER BY as_of_date DESC, metric`).all(...q.params) as FleetAnchorRow[];
}

/** Record filings not seen before; returns only the newly inserted ones. */
export function recordSecFilings(
  db: Database,
  filings: Array<Omit<SecFilingRow, "seen_at">>
): Array<Omit<SecFilingRow, "seen_at">> {
  const now = Math.floor(Date.now() / 1000);
  const fresh: Array<Omit<SecFilingRow, "seen_at">> = [];
  db.transaction(() => {
    for (const f of filings) {
      const result = db
        .query(`
          INSERT OR IGNORE INTO sec_filings_seen
            (accession, cik, company, form, filed_date, primary_doc_url, seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(f.accession, f.cik, f.company, f.form, f.filed_date, f.primary_doc_url, now);
      if (result.changes > 0) fresh.push(f);
    }
  })();
  return fresh;
}

export function getFaaRegistryByTail(db: Database, tail: string): FaaRegistryRow | null {
  return (
    (db
      .query("SELECT * FROM faa_registry WHERE tail_number = ?")
      .get(tail) as FaaRegistryRow | null) ?? null
  );
}

/** Replace one month's BTS aggregates in a single transaction. */
export function replaceBtsMonth(db: Database, month: string, agg: BtsMonthAggregates): void {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    db.query("DELETE FROM bts_monthly_operators WHERE month = ?").run(month);
    db.query("DELETE FROM bts_monthly_tails WHERE month = ?").run(month);
    db.query("DELETE FROM bts_monthly_routes WHERE month = ?").run(month);
    for (const o of agg.operators) {
      db.query(`
        INSERT INTO bts_monthly_operators (month, op_carrier, flights, performed, distinct_tails, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(month, o.op_carrier, o.flights, o.performed, o.distinct_tails, now);
    }
    for (const t of agg.tails) {
      db.query(`
        INSERT INTO bts_monthly_tails (month, tail_number, op_carrier, departures)
        VALUES (?, ?, ?, ?)
      `).run(month, t.tail_number, t.op_carrier, t.departures);
    }
    for (const r of agg.routes) {
      db.query(`
        INSERT INTO bts_monthly_routes (month, origin, dest, performed)
        VALUES (?, ?, ?, ?)
      `).run(month, r.origin, r.dest, r.performed);
    }
  })();
}

export function getBtsIngestedMonths(db: Database): string[] {
  return (
    db
      .query("SELECT DISTINCT month FROM bts_monthly_operators ORDER BY month DESC")
      .all() as Array<{ month: string }>
  ).map((r) => r.month);
}

export function getFleetTailsWithStatus(
  db: Database,
  airline: string
): Array<{ tail_number: string; starlink_status: string }> {
  return db
    .query("SELECT tail_number, starlink_status FROM united_fleet WHERE airline = ?")
    .all(airline) as Array<{ tail_number: string; starlink_status: string }>;
}

const ADSB_OBSERVATION_RETENTION_DAYS = 7;
const ADSB_SWEEP_RETENTION_DAYS = 90;

/** Persist one shadow sweep + its observations and prune old audit rows. */
export function recordAdsbSweep(
  db: Database,
  sweep: AdsbSweepRecord,
  observations: Array<Omit<AdsbObservationRecord, "id">>
): void {
  const obsCutoff = sweep.swept_at - ADSB_OBSERVATION_RETENTION_DAYS * 86400;
  const sweepCutoff = sweep.swept_at - ADSB_SWEEP_RETENTION_DAYS * 86400;
  db.transaction(() => {
    db.query(`
      INSERT INTO adsb_sweeps
        (swept_at, provider, requests, latency_ms, tails_queried, observed, airborne,
         matched, mismatched, no_assignment, no_callsign, non_revenue, low_speed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sweep.swept_at,
      sweep.provider,
      sweep.requests,
      sweep.latency_ms,
      sweep.tails_queried,
      sweep.observed,
      sweep.airborne,
      sweep.matched,
      sweep.mismatched,
      sweep.no_assignment,
      sweep.no_callsign,
      sweep.non_revenue,
      sweep.low_speed
    );
    for (const o of observations) {
      db.query(`
        INSERT INTO adsb_observations
          (observed_at, tail_number, callsign, hex, airborne, ground_speed, lat, lon,
           aircraft_type, provider, shadow_result, assigned_flight)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        o.observed_at,
        o.tail_number,
        o.callsign,
        o.hex,
        o.airborne,
        o.ground_speed,
        o.lat,
        o.lon,
        o.aircraft_type,
        o.provider,
        o.shadow_result,
        o.assigned_flight
      );
    }
    db.query("DELETE FROM adsb_observations WHERE observed_at < ?").run(obsCutoff);
    db.query("DELETE FROM adsb_sweeps WHERE swept_at < ?").run(sweepCutoff);
  })();
}

// One definition of "departure on a Starlink-equipped aircraft, next 48h":
// the same equipped predicate /api/check-flight uses, with a real upper bound.
// The homepage airports panel and /routes both render from this base, so the
// two surfaces can never disagree under the same window label.
const DEPARTURE_WINDOW_HOURS = 48;
const EQUIPPED_DEPARTURES_SQL = `
     FROM upcoming_flights uf
     INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
     WHERE ${equippedFilter("sp")}
       AND uf.departure_time >= ? AND uf.departure_time < ?`;

export function getAirportDepartures(
  db: Database,
  airline?: AirlineFilter,
  nowSec = Math.floor(Date.now() / 1000)
): AirportDepartures {
  try {
    db.query("DELETE FROM departure_log WHERE departed_at < ?").run(nowSec - 30 * 86400);
  } catch {
    // readonly DB (tests/snapshots) — trim is best-effort housekeeping
  }

  const q = withAirline(
    `SELECT uf.departure_airport AS airport,
            COUNT(DISTINCT uf.flight_number || ':' || uf.departure_time) AS count${EQUIPPED_DEPARTURES_SQL}`,
    airline,
    "uf",
    [nowSec, nowSec + DEPARTURE_WINDOW_HOURS * 3600]
  );
  const rows = db
    .query(`${q.sql} GROUP BY uf.departure_airport ORDER BY count DESC LIMIT 30`)
    .all(...q.params) as Array<{ airport: string; count: number }>;

  return { rows, windowLabel: `next ${DEPARTURE_WINDOW_HOURS} hours` };
}

export function getRouteStarlinkSchedule(
  db: Database,
  airline?: AirlineFilter,
  nowSec = Math.floor(Date.now() / 1000)
): RouteSchedule {
  const windowEnd = nowSec + DEPARTURE_WINDOW_HOURS * 3600;
  // The DISTINCT pair count dedupes tail-swap leftovers (multiple rows for one
  // physical departure).
  const baseSql = EQUIPPED_DEPARTURES_SQL;
  const q = withAirline(
    `SELECT uf.departure_airport AS origin, uf.arrival_airport AS destination,
            COUNT(DISTINCT uf.flight_number || ':' || uf.departure_time) AS departures,
            COUNT(DISTINCT uf.flight_number) AS flight_numbers,
            MIN(uf.departure_time) AS next_departure${baseSql}`,
    airline,
    "uf",
    [nowSec, windowEnd]
  );
  const rows = db
    .query(
      `${q.sql} GROUP BY uf.departure_airport, uf.arrival_airport
       ORDER BY departures DESC, flight_numbers DESC, origin ASC LIMIT 60`
    )
    .all(...q.params) as RouteScheduleRow[];

  // Headline total uses the same predicate without the LIMIT, so the header
  // never disagrees with what a user could count by paging the rows.
  const totalQ = withAirline(
    `SELECT COUNT(DISTINCT uf.flight_number || ':' || uf.departure_time) AS n${baseSql}`,
    airline,
    "uf",
    [nowSec, windowEnd]
  );
  const totalDepartures = (db.query(totalQ.sql).get(...totalQ.params) as { n: number }).n;

  return { rows, totalDepartures, windowLabel: `next ${DEPARTURE_WINDOW_HOURS} hours` };
}

function computeInstallPace(
  db: Database,
  airline: AirlineFilter | undefined,
  fleetStats: FleetStats
): InstallPace {
  // Same filters as getRecentInstalls — INSTALL_FILTER excludes every bulk
  // writer (seed, type_deterministic, flyertalk) whose shared DateFound would
  // render as a one-week "install spike".
  const q = withAirline(
    `SELECT DateFound AS d, fleet FROM starlink_planes
     WHERE DateFound >= date('now', '-77 days')
       AND ${equippedFilter("starlink_planes")}
       AND ${INSTALL_FILTER}`,
    airline
  );
  const found = db.query(q.sql).all(...q.params) as Array<{ d: string; fleet: string | null }>;

  // Bucket by week starting Monday, then fill the trailing 10 weeks so
  // zero-install weeks are visible instead of silently skipped.
  const weekStartOf = (date: Date): string => {
    const day = (date.getUTCDay() + 6) % 7;
    const monday = new Date(date.getTime() - day * 86400_000);
    return monday.toISOString().slice(0, 10);
  };
  const byWeek = new Map<string, number>();
  const mainlineByWeek = new Map<string, number>();
  for (const r of found) {
    const dt = new Date(`${r.d}T00:00:00Z`);
    if (Number.isNaN(dt.getTime())) continue;
    const wk = weekStartOf(dt);
    byWeek.set(wk, (byWeek.get(wk) || 0) + 1);
    if (normalizeFleet(r.fleet) === "mainline")
      mainlineByWeek.set(wk, (mainlineByWeek.get(wk) || 0) + 1);
  }

  const currentWeek = weekStartOf(new Date());
  const weeks: InstallPaceWeek[] = [];
  for (let i = 9; i >= 0; i--) {
    const wk = weekStartOf(new Date(Date.now() - i * 7 * 86400_000));
    weeks.push({ weekStart: wk, installs: byWeek.get(wk) || 0 });
  }

  // Pace: average of the 6 most recent *complete* weeks of mainline installs.
  const fullWeeks = weeks.filter((w) => w.weekStart !== currentWeek).slice(-6);
  const rawPace =
    fullWeeks.length > 0
      ? fullWeeks.reduce((s, w) => s + (mainlineByWeek.get(w.weekStart) || 0), 0) / fullWeeks.length
      : 0;
  // Round before projecting so a reader recomputing from the displayed pace
  // lands on the same answer.
  const mainlinePaceWk = Math.round(rawPace * 10) / 10;

  // express/mainline mirror getFleetStats — the same numbers the homepage rings
  // show, so the two pages can never disagree.
  const express = { starlink: fleetStats.express.starlink, total: fleetStats.express.total };
  const mainline = { starlink: fleetStats.mainline.starlink, total: fleetStats.mainline.total };

  const remainingMainline = Math.max(0, mainline.total - mainline.starlink);
  let projectedFinishMonth: string | null = null;
  if (mainlinePaceWk >= 0.5 && remainingMainline > 0) {
    const weeksLeft = remainingMainline / mainlinePaceWk;
    // Beyond ~3 years a straight-line extrapolation is noise, not a projection.
    if (weeksLeft <= 156) {
      const finish = new Date(Date.now() + weeksLeft * 7 * 86400_000);
      const m = finish.getUTCMonth();
      const season = m <= 3 ? "early" : m <= 7 ? "mid" : "late";
      projectedFinishMonth = `${season} ${finish.getUTCFullYear()}`;
    }
  }

  return {
    weeks,
    express,
    mainline,
    mainlinePaceWk,
    remainingMainline,
    projectedFinishMonth,
  };
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
  // Install pace is a single-airline narrative (its projection extrapolates one
  // airline's retrofit program); the hub's mixed fleet gets no pace section.
  // Tenant readers pass a one-element array, direct callers pass a string code.
  const soleAirline =
    typeof airline === "string" ? airline : airline?.length === 1 ? airline[0] : null;
  const installPace = soleAirline
    ? computeInstallPace(db, airline, getFleetStats(db, soleAirline))
    : null;

  return {
    pulse,
    families,
    carriers,
    bodyClass,
    allTails,
    totalFleet: rows.length,
    totalStarlink,
    installPace,
    // Single-airline narrative like installPace — the hub page must not show
    // one airline's pipeline as if it covered every tracked fleet.
    progress: soleAirline ? getFleetProgress(db, airline) : [],
    anchors: soleAirline ? getFleetAnchors(db, airline) : [],
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

// ─────────────────────────────────────────────────────────────────────────────
// Qatar schedule cache — equipment-per-flight from QR's flight-status API.
// ─────────────────────────────────────────────────────────────────────────────

export interface QatarScheduleRow {
  flight_number: string;
  scheduled_date: string;
  departure_airport: string | null;
  arrival_airport: string | null;
  departure_time: number | null;
  arrival_time: number | null;
  equipment_code: string | null;
  wifi_verdict: string | null;
  flight_status: string | null;
  last_updated: number;
}

export function upsertQatarSchedule(db: Database, row: QatarScheduleRow): void {
  db.query(
    `INSERT INTO qatar_schedule
       (flight_number, scheduled_date, departure_airport, arrival_airport,
        departure_time, arrival_time, equipment_code, wifi_verdict,
        flight_status, last_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(flight_number, scheduled_date) DO UPDATE SET
       departure_airport = excluded.departure_airport,
       arrival_airport   = excluded.arrival_airport,
       departure_time    = excluded.departure_time,
       arrival_time      = excluded.arrival_time,
       equipment_code    = excluded.equipment_code,
       wifi_verdict      = excluded.wifi_verdict,
       flight_status     = excluded.flight_status,
       last_updated      = excluded.last_updated`
  ).run(
    row.flight_number,
    row.scheduled_date,
    row.departure_airport,
    row.arrival_airport,
    row.departure_time,
    row.arrival_time,
    row.equipment_code,
    row.wifi_verdict,
    row.flight_status,
    row.last_updated
  );
}

/**
 * Look up QR flights for a date range. Matches by flight_number (variants
 * passed in pre-normalized, e.g. ["QR1", "QR001"]) AND by departure_time
 * window — same shape /api/check-flight uses for other carriers.
 */
export function getQatarScheduleByFlight(
  db: Database,
  flightNumberVariants: string[],
  startOfDay: number,
  endOfDay: number
): QatarScheduleRow[] {
  if (flightNumberVariants.length === 0) return [];
  const placeholders = flightNumberVariants.map(() => "?").join(",");
  return db
    .query(
      `SELECT * FROM qatar_schedule
       WHERE flight_number IN (${placeholders})
         AND departure_time >= ?
         AND departure_time < ?
       ORDER BY departure_time ASC`
    )
    .all(...flightNumberVariants, startOfDay, endOfDay) as QatarScheduleRow[];
}

export function getQatarScheduleByRoute(
  db: Database,
  origin: string,
  destination: string,
  startOfDay: number,
  endOfDay: number
): QatarScheduleRow[] {
  return db
    .query(
      `SELECT * FROM qatar_schedule
       WHERE departure_airport = ?
         AND arrival_airport = ?
         AND departure_time >= ?
         AND departure_time < ?
       ORDER BY departure_time ASC`
    )
    .all(
      origin.toUpperCase(),
      destination.toUpperCase(),
      startOfDay,
      endOfDay
    ) as QatarScheduleRow[];
}

/**
 * Drop departed rows, but only for the given routes — a route whose fetch
 * failed this run keeps its stale rows (bounded growth, heals on recovery,
 * and the freshness gauge stays honest because old timestamps survive).
 */
export function pruneQatarScheduleBefore(
  db: Database,
  beforeEpoch: number,
  routes: ReadonlyArray<readonly [string, string]>
): number {
  const stmt = db.query(
    "DELETE FROM qatar_schedule WHERE departure_time < ? AND departure_airport = ? AND arrival_airport = ?"
  );
  let pruned = 0;
  for (const [origin, destination] of routes) {
    pruned += stmt.run(beforeEpoch, origin, destination).changes;
  }
  return pruned;
}

export function getQatarScheduleStats(db: Database): {
  total: number;
  starlink: number;
  rolling: number;
  none: number;
  lastUpdated: number | null;
} {
  const counts = db
    .query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN wifi_verdict = 'Starlink' THEN 1 ELSE 0 END) AS starlink,
         SUM(CASE WHEN wifi_verdict = 'Rolling'  THEN 1 ELSE 0 END) AS rolling,
         SUM(CASE WHEN wifi_verdict = 'None'     THEN 1 ELSE 0 END) AS none,
         MAX(last_updated) AS lastUpdated
       FROM qatar_schedule`
    )
    .get() as {
    total: number;
    starlink: number;
    rolling: number;
    none: number;
    lastUpdated: number | null;
  };
  return {
    total: counts.total ?? 0,
    starlink: counts.starlink ?? 0,
    rolling: counts.rolling ?? 0,
    none: counts.none ?? 0,
    lastUpdated: counts.lastUpdated ?? null,
  };
}
