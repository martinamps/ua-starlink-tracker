import { Database } from "bun:sqlite";
import { fetchAllSheets, ensureDatabaseFileExists } from "./utils";

// Location of the SQLite database
const DB_PATH = process.env.NODE_ENV === "production" 
  ? "/srv/ua-starlink-tracker/plane-data.sqlite"  // Container path
  : "./plane-data.sqlite";                       // Local path

// Initialize database
export function initializeDatabase() {
  ensureDatabaseFileExists(DB_PATH);
  const db = new Database(DB_PATH);
  setupTables(db);
  return db;
}

// Create tables and migrations
function setupTables(db: Database) {
  // Check if the starlink_planes table exists
  const tableExists = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='starlink_planes'`)
    .get();

  if (!tableExists) {
    // Create new table
    db.query(`
      CREATE TABLE starlink_planes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aircraft TEXT,
        wifi TEXT,
        sheet_gid TEXT,
        sheet_type TEXT,
        DateFound TEXT,
        TailNumber TEXT,
        OperatedBy TEXT,
        fleet TEXT
      );
    `).run();
  } else {
    // Handle migrations for existing tables
    const hasDateFound = db.query("PRAGMA table_info(starlink_planes)").all()
      .some((col: any) => col.name === "DateFound");
    
    if (!hasDateFound) {
      db.query("ALTER TABLE starlink_planes ADD COLUMN DateFound TEXT;").run();
      db.query("ALTER TABLE starlink_planes ADD COLUMN TailNumber TEXT;").run();
      db.query("ALTER TABLE starlink_planes ADD COLUMN OperatedBy TEXT;").run();
    }
    
    const hasFleet = db.query("PRAGMA table_info(starlink_planes)").all()
      .some((col: any) => col.name === "fleet");
    
    if (!hasFleet) {
      db.query("ALTER TABLE starlink_planes ADD COLUMN fleet TEXT;").run();
      db.query(`
        UPDATE starlink_planes 
        SET DateFound = ?, 
            TailNumber = SUBSTR(aircraft, 0, INSTR(aircraft, ' ')), 
            OperatedBy = ?
      `).run(new Date().toISOString().split("T")[0], "United Airlines");
    }
  }
  
  // Create meta table for storing metadata
  db.query(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `).run();
}

// Update data from Google Sheets
export async function updateStarlinkData(db: Database) {
  try {
    const { totalAircraftCount, starlinkAircraft, fleetStats } = await fetchAllSheets();
    
    // Clear table and update with new data
    db.query("DELETE FROM starlink_planes").run();
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('totalAircraftCount', ?)`)
      .run(String(totalAircraftCount));
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastUpdated', ?)`)
      .run(new Date().toISOString());
    
    // Store fleet statistics
    const stats = ["express", "mainline"];
    const metrics = ["total", "starlink", "percentage"];
    
    for (const fleet of stats) {
      for (const metric of metrics) {
        const value = fleet === "express" 
          ? fleetStats.express[metric]
          : fleetStats.mainline[metric];
          
        const formattedValue = metric === "percentage" 
          ? value.toFixed(2) 
          : String(value);
          
        db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
          .run(`${fleet}${metric.charAt(0).toUpperCase() + metric.slice(1)}`, formattedValue);
      }
    }
    
    // Insert aircraft data
    const insertStmt = db.prepare(`
      INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const aircraft of starlinkAircraft) {
      insertStmt.run(
        aircraft.Aircraft ?? "",
        aircraft.WiFi ?? "",
        aircraft.sheet_gid ?? "",
        aircraft.sheet_type ?? "",
        aircraft.DateFound ?? new Date().toISOString().split("T")[0],
        aircraft.TailNumber ?? "",
        aircraft.OperatedBy ?? "United Airlines",
        aircraft.fleet ?? "express"
      );
    }
    
    console.log(`Updated data: ${starlinkAircraft.length} Starlink aircraft out of ${totalAircraftCount} total`);
    return { total: totalAircraftCount, starlinkCount: starlinkAircraft.length };
  } catch (err) {
    console.error("Error updating starlink data:", err);
    return { total: 0, starlinkCount: 0 };
  }
}

// Get database values with helper functions
export function getTotalCount(db: Database): number {
  const row = db.query(`SELECT value FROM meta WHERE key = 'totalAircraftCount'`).get();
  return row?.value ? Number.parseInt(row.value, 10) : 0;
}

export function getMetaValue(db: Database, key: string, defaultValue: number): number {
  const row = db.query(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row?.value ? Number.parseFloat(row.value) : defaultValue;
}

export function getLastUpdated(db: Database): string {
  const lastUpdated = db.query(`SELECT value FROM meta WHERE key = 'lastUpdated'`).get();
  return lastUpdated?.value ? lastUpdated.value : new Date().toISOString();
}

export function getStarlinkPlanes(db: Database): any[] {
  return db.query(`
    SELECT aircraft as Aircraft,
           wifi as WiFi,
           sheet_gid,
           sheet_type,
           DateFound,
           TailNumber,
           OperatedBy,
           fleet
    FROM starlink_planes
  `).all();
}

export function getFleetStats(db: Database) {
  return {
    express: {
      total: getMetaValue(db, 'expressTotal', 0),
      starlink: getMetaValue(db, 'expressStarlink', 0),
      percentage: getMetaValue(db, 'expressPercentage', 0)
    },
    mainline: {
      total: getMetaValue(db, 'mainlineTotal', 0),
      starlink: getMetaValue(db, 'mainlineStarlink', 0),
      percentage: getMetaValue(db, 'mainlinePercentage', 0)
    }
  };
}