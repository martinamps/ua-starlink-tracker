import { Database } from "bun:sqlite";
import { DB_PATH } from "./constants";

type MetaRow = { value: string };
type PlaneRow = {
  Aircraft: string;
  WiFi: string;
  sheet_gid: string;
  sheet_type: string;
  DateFound: string;
  TailNumber: string;
  OperatedBy: string;
  fleet: string;
};

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
        fleet TEXT
      );`
    ).run();
    db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tailnumber ON starlink_planes(TailNumber);`
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
}

export function updateDatabase(
  db: Database,
  totalAircraftCount: number,
  starlinkAircraft: Array<{
    Aircraft?: string;
    WiFi?: string;
    sheet_gid?: string;
    sheet_type?: string;
    DateFound?: string;
    TailNumber?: string;
    OperatedBy?: string;
    fleet?: string;
  }>,
  fleetStats: {
    express: { total: number; starlink: number; percentage: number };
    mainline: { total: number; starlink: number; percentage: number };
  }
) {
  // Update meta data
  // Retrieve existing installation dates before clearing the table
  const existingRows = db
    .query("SELECT TailNumber, DateFound FROM starlink_planes")
    .all() as { TailNumber: string; DateFound: string }[];
  const existingDates = new Map(
    existingRows.map((r) => [r.TailNumber, r.DateFound])
  );

  // Clear table to insert fresh data but preserve known dates
  db.query("DELETE FROM starlink_planes").run();
  db.query(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('totalAircraftCount', ?)`
  ).run(String(totalAircraftCount));
  db.query(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('lastUpdated', ?)`
  ).run(new Date().toISOString());

  // Store fleet statistics
  const stats = ["express", "mainline"];
  const metrics = ["total", "starlink", "percentage"];

  for (const fleet of stats) {
    for (const metric of metrics) {
      const value =
        fleet === "express"
          ? fleetStats.express[metric]
          : fleetStats.mainline[metric];
      const formattedValue =
        metric === "percentage" ? value.toFixed(2) : String(value);

      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        `${fleet}${metric.charAt(0).toUpperCase() + metric.slice(1)}`,
        formattedValue
      );
    }
  }

  // Insert aircraft data
  const insertStmt = db.prepare(`
    INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const aircraft of starlinkAircraft) {
    const preservedDate =
      existingDates.get(aircraft.TailNumber ?? "") ?? aircraft.DateFound;
    insertStmt.run(
      aircraft.Aircraft ?? "",
      aircraft.WiFi ?? "",
      aircraft.sheet_gid ?? "",
      aircraft.sheet_type ?? "",
      preservedDate ?? new Date().toISOString().split("T")[0],
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

export function getStarlinkPlanes(db: Database): PlaneRow[] {
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
    .all() as PlaneRow[];
}

export function getFleetStats(db: Database) {
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
