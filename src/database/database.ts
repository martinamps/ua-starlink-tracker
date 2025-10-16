import { Database } from "bun:sqlite";
import type { Aircraft, FleetStats, Flight } from "../types";
import { DB_PATH } from "../utils/constants";

type MetaRow = { value: string };

export function initializeDatabase() {
  if (!Bun.file(DB_PATH).exists()) {
    Bun.write(DB_PATH, "");
  }

  const db = new Database(DB_PATH);
  setupTables(db);
  return db;
}

function tableExists(db: Database, tableName: string) {
  return db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
}

function setupTables(db: Database) {
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

    if (migrationsRun.length > 0) {
      console.log(`Database migrations completed: ${migrationsRun.join(", ")}`);
    }
  }
}

export function updateDatabase(
  db: Database,
  totalAircraftCount: number,
  starlinkAircraft: Partial<Aircraft>[],
  fleetStats: FleetStats
) {
  // Get existing data before clearing the table
  const existingDates = new Map<string, string>();
  const existingFlightChecks = new Map<
    string,
    { last_flight_check: number; last_check_successful: number; consecutive_failures: number }
  >();

  const existingPlanes = db
    .query(
      "SELECT TailNumber, DateFound, last_flight_check, last_check_successful, consecutive_failures FROM starlink_planes"
    )
    .all() as {
    TailNumber: string;
    DateFound: string;
    last_flight_check: number;
    last_check_successful: number;
    consecutive_failures: number;
  }[];

  for (const plane of existingPlanes) {
    if (plane.TailNumber) {
      if (plane.DateFound) {
        existingDates.set(plane.TailNumber, plane.DateFound);
      }
      // Preserve flight check data to avoid resetting on every scraper run
      existingFlightChecks.set(plane.TailNumber, {
        last_flight_check: plane.last_flight_check || 0,
        last_check_successful: plane.last_check_successful || 0,
        consecutive_failures: plane.consecutive_failures || 0,
      });
    }
  }

  // Update meta data
  db.query("DELETE FROM starlink_planes").run();
  db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('totalAircraftCount', ?)`).run(
    String(totalAircraftCount)
  );
  db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastUpdated', ?)`).run(
    new Date().toISOString()
  );

  // Store fleet statistics
  for (const [fleetType, stats] of Object.entries(fleetStats)) {
    for (const [metric, value] of Object.entries(stats)) {
      const key = `${fleetType}${metric.charAt(0).toUpperCase() + metric.slice(1)}`;
      const formattedValue = metric === "percentage" ? (value as number).toFixed(2) : String(value);
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, formattedValue);
    }
  }

  // Insert aircraft data
  const insertStmt = db.prepare(`
    INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, last_flight_check, last_check_successful, consecutive_failures)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const aircraft of starlinkAircraft) {
    const tailNumber = aircraft.TailNumber || "";

    // Preserve existing DateFound or use new one, fallback to today only for truly new aircraft
    const dateFound =
      aircraft.DateFound || existingDates.get(tailNumber) || new Date().toISOString().split("T")[0];

    // Preserve flight check data for existing planes, use 0 for new planes
    const flightCheckData = existingFlightChecks.get(tailNumber) || {
      last_flight_check: 0,
      last_check_successful: 0,
      consecutive_failures: 0,
    };

    insertStmt.run(
      aircraft.Aircraft ?? "",
      aircraft.WiFi ?? "",
      aircraft.sheet_gid ?? "",
      aircraft.sheet_type ?? "",
      dateFound,
      tailNumber,
      aircraft.OperatedBy ?? "United Airlines",
      aircraft.fleet ?? "express",
      flightCheckData.last_flight_check,
      flightCheckData.last_check_successful,
      flightCheckData.consecutive_failures
    );
  }
}

export function getTotalCount(db: Database): number {
  const row = db
    .query(`SELECT value FROM meta WHERE key = 'totalAircraftCount'`)
    .get() as MetaRow | null;
  return row?.value ? Number.parseInt(row.value, 10) : 0;
}

export function getMetaValue(db: Database, key: string, defaultValue: number): number {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as MetaRow | null;
  return row?.value ? Number.parseFloat(row.value) : defaultValue;
}

export function getLastUpdated(db: Database): string {
  const lastUpdated = db
    .query(`SELECT value FROM meta WHERE key = 'lastUpdated'`)
    .get() as MetaRow | null;
  return lastUpdated?.value ? lastUpdated.value : new Date().toISOString();
}

export function getStarlinkPlanes(db: Database): Aircraft[] {
  return db
    .query(
      `
      SELECT aircraft as Aircraft,
             wifi as WiFi,
             sheet_gid,
             sheet_type,
             DateFound,
             TailNumber,
             OperatedBy,
             fleet
      FROM starlink_planes
    `
    )
    .all() as Aircraft[];
}

export function getFleetStats(db: Database): FleetStats {
  return {
    express: {
      total: getMetaValue(db, "expressTotal", 0),
      starlink: getMetaValue(db, "expressStarlink", 0),
      percentage: getMetaValue(db, "expressPercentage", 0),
    },
    mainline: {
      total: getMetaValue(db, "mainlineTotal", 0),
      starlink: getMetaValue(db, "mainlineStarlink", 0),
      percentage: getMetaValue(db, "mainlinePercentage", 0),
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
  const updateFlightsTransaction = db.transaction(() => {
    db.query("DELETE FROM upcoming_flights WHERE tail_number = ?").run(tailNumber);

    if (flights.length > 0) {
      const insertStmt = db.prepare(`
        INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Math.floor(Date.now() / 1000);
      for (const flight of flights) {
        insertStmt.run(
          tailNumber,
          flight.flight_number,
          flight.departure_airport,
          flight.arrival_airport,
          flight.departure_time,
          flight.arrival_time,
          now
        );
      }
    }
  });

  updateFlightsTransaction();
}

export function getUpcomingFlights(db: Database, tailNumber?: string): Flight[] {
  const now = Math.floor(Date.now() / 1000);
  // Also filter out corrupted timestamps (less than year 2000 in seconds)
  const minValidTimestamp = 946684800; // Jan 1, 2000 in seconds

  const query = tailNumber
    ? "SELECT * FROM upcoming_flights WHERE tail_number = ? AND departure_time > ? AND departure_time > ? ORDER BY departure_time ASC"
    : "SELECT * FROM upcoming_flights WHERE departure_time > ? AND departure_time > ? ORDER BY departure_time ASC";

  const params = tailNumber ? [tailNumber, now, minValidTimestamp] : [now, minValidTimestamp];
  return db.query(query).all(...params) as Flight[];
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

export function needsFlightCheck(db: Database, tailNumber: string, hoursThreshold = 4): boolean {
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
