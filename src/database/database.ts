import { Database } from "bun:sqlite";
import { DB_PATH } from "../utils/constants";
import type { Aircraft, Flight, FleetStats } from "../types";

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
  return db
    .query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`
    )
    .get();
}

function setupTables(db: Database) {
  // Create tables first
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
        last_flight_check INTEGER DEFAULT 0
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

  // Handle migrations after all tables exist
  if (tableExists(db, "starlink_planes")) {
    // Add last_flight_check column if it doesn't exist
    const columns = db.query("PRAGMA table_info(starlink_planes)").all();
    const hasLastFlightCheck = columns.some((col: any) => col.name === 'last_flight_check');
    if (!hasLastFlightCheck) {
      db.query("ALTER TABLE starlink_planes ADD COLUMN last_flight_check INTEGER DEFAULT 0").run();
      
      // Migrate existing data: if planes already have flight data, set their last_flight_check to avoid immediate re-checking
      if (tableExists(db, "upcoming_flights")) {
        const now = Math.floor(Date.now() / 1000);
        const migrationQuery = `
          UPDATE starlink_planes 
          SET last_flight_check = ? 
          WHERE TailNumber IN (
            SELECT DISTINCT tail_number FROM upcoming_flights
          )
        `;
        const randomHoursAgo = now - (Math.floor(Math.random() * 4 + 1) * 60 * 60); // 1-5 hours ago
        db.query(migrationQuery).run(randomHoursAgo);
        console.log('Migrated existing flight data timestamps');
      }
    }
  }
}

export function updateDatabase(
  db: Database,
  totalAircraftCount: number,
  starlinkAircraft: Partial<Aircraft>[],
  fleetStats: FleetStats
) {
  // Get existing dates before clearing the table
  const existingDates = new Map<string, string>();
  const existingPlanes = db.query("SELECT TailNumber, DateFound FROM starlink_planes").all() as { TailNumber: string; DateFound: string }[];
  for (const plane of existingPlanes) {
    if (plane.TailNumber && plane.DateFound) {
      existingDates.set(plane.TailNumber, plane.DateFound);
    }
  }

  // Update meta data
  db.query("DELETE FROM starlink_planes").run();
  db.query(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('totalAircraftCount', ?)`
  ).run(String(totalAircraftCount));
  db.query(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('lastUpdated', ?)`
  ).run(new Date().toISOString());

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
    INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const aircraft of starlinkAircraft) {
    // Preserve existing DateFound or use new one, fallback to today only for truly new aircraft
    const dateFound = aircraft.DateFound || 
                     existingDates.get(aircraft.TailNumber || "") || 
                     new Date().toISOString().split("T")[0];
    
    insertStmt.run(
      aircraft.Aircraft ?? "",
      aircraft.WiFi ?? "",
      aircraft.sheet_gid ?? "",
      aircraft.sheet_type ?? "",
      dateFound,
      aircraft.TailNumber ?? "",
      aircraft.OperatedBy ?? "United Airlines",
      aircraft.fleet ?? "express"
    );
  }
}

export function getTotalCount(db: Database): number {
  const row = db
    .query(`SELECT value FROM meta WHERE key = 'totalAircraftCount'`)
    .get() as MetaRow | null;
  return row?.value ? Number.parseInt(row.value, 10) : 0;
}

export function getMetaValue(
  db: Database,
  key: string,
  defaultValue: number
): number {
  const row = db
    .query("SELECT value FROM meta WHERE key = ?")
    .get(key) as MetaRow | null;
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

export function updateFlights(db: Database, tailNumber: string, flights: Pick<Flight, 'flight_number' | 'departure_airport' | 'arrival_airport' | 'departure_time' | 'arrival_time'>[]) {
  // Clear old flights for this tail number
  db.query("DELETE FROM upcoming_flights WHERE tail_number = ?").run(tailNumber);
  
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

export function getUpcomingFlights(db: Database, tailNumber?: string): Flight[] {
  const now = Math.floor(Date.now() / 1000);
  const query = tailNumber 
    ? "SELECT * FROM upcoming_flights WHERE tail_number = ? AND departure_time > ? ORDER BY departure_time ASC"
    : "SELECT * FROM upcoming_flights WHERE departure_time > ? ORDER BY departure_time ASC";
  
  const params = tailNumber ? [tailNumber, now] : [now];
  return db.query(query).all(...params) as Flight[];
}

export function updateLastFlightCheck(db: Database, tailNumber: string) {
  const now = Math.floor(Date.now() / 1000);
  db.query("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = ?").run(now, tailNumber);
}

export function needsFlightCheck(db: Database, tailNumber: string, hoursThreshold: number = 4): boolean {
  const row = db.query("SELECT last_flight_check FROM starlink_planes WHERE TailNumber = ?").get(tailNumber) as { last_flight_check: number } | null;
  
  if (!row) return false; // Tail number not found
  
  const lastCheck = row.last_flight_check || 0;
  const now = Math.floor(Date.now() / 1000);
  
  // Get existing flights to make smarter decisions
  const flightInfo = db.query(`
    SELECT COUNT(*) as count,
           MIN(departure_time) as next_departure,
           MAX(departure_time) as latest_departure
    FROM upcoming_flights
    WHERE tail_number = ? AND departure_time > ?
  `).get(tailNumber, now) as { count: number; next_departure: number | null; latest_departure: number | null } | null;

  const hasFlights = flightInfo && flightInfo.count > 0;
  const nextDeparture = flightInfo?.next_departure;
  const latestDeparture = flightInfo?.latest_departure;
  
  // If lastCheck is 0 (never checked), add randomization to prevent all planes checking at once
  if (lastCheck === 0) {
    if (hasFlights) {
      // Set a random last check time within the past 1-3 hours to stagger future checks
      const randomHoursAgo = Math.floor(Math.random() * 2) + 1; // 1-3 hours ago
      const randomLastCheck = now - (randomHoursAgo * 60 * 60);
      db.query("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = ?").run(randomLastCheck, tailNumber);
      return false;
    }
    // New aircraft with no flights should be checked immediately
    return true;
  }
  
  const hoursSinceLastCheck = (now - lastCheck) / 3600;
  
  // Dynamic checking based on flight situation
  if (!hasFlights) {
    // No upcoming flights - check every 8-12 hours with jitter
    const thresholdHours = 8 + Math.random() * 4; // 8-12 hours
    return hoursSinceLastCheck > thresholdHours;
  }
  
  // Have flights - more frequent checks
  const hoursToNextFlight = nextDeparture ? (nextDeparture - now) / 3600 : 999;
  const hoursToLatestFlight = latestDeparture ? (latestDeparture - now) / 3600 : 999;
  
  // If next flight is within 6 hours, check more frequently
  if (hoursToNextFlight <= 6) {
    const thresholdHours = 1 + Math.random() * 0.5; // 1-1.5 hours with jitter
    return hoursSinceLastCheck > thresholdHours;
  }
  
  // If latest flight is within 24 hours, check every 2-4 hours
  if (hoursToLatestFlight <= 24) {
    const thresholdHours = 2 + Math.random() * 2; // 2-4 hours with jitter
    return hoursSinceLastCheck > thresholdHours;
  }
  
  // If we have flights but they're far out, check every 4-8 hours
  const thresholdHours = 4 + Math.random() * 4; // 4-8 hours with jitter
  return hoursSinceLastCheck > thresholdHours;
}
