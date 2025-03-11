import { Database } from "bun:sqlite";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Page from "./page";
import { fetchAllSheets, ensureDatabaseFileExists } from "./utils";

// Location of the SQLite database
// Use local path for development, container path for production
const DB_PATH = process.env.NODE_ENV === 'production' 
  ? "/srv/ua-starlink-tracker/plane-data.sqlite"  // Container path (for Coolify deployment)
  : "./plane-data.sqlite";           // Local path for development

// Ensure the database file exists before connecting
ensureDatabaseFileExists(DB_PATH);

// Connect to SQLite
const db = new Database(DB_PATH);

// First check if the table exists
const tableExists = db.query(`
  SELECT name FROM sqlite_master 
  WHERE type='table' AND name='starlink_planes'
`).get();

if (!tableExists) {
  // Create new table with all columns
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
  // Check if we need to add the new columns
  const hasDateFound = db.query(`PRAGMA table_info(starlink_planes)`).all()
    .some((col: any) => col.name === 'DateFound');
  
  if (!hasDateFound) {
    // Add the new columns if they don't exist
    db.query(`ALTER TABLE starlink_planes ADD COLUMN DateFound TEXT;`).run();
    db.query(`ALTER TABLE starlink_planes ADD COLUMN TailNumber TEXT;`).run();
    db.query(`ALTER TABLE starlink_planes ADD COLUMN OperatedBy TEXT;`).run();
  }
  
  // Check if we need to add the fleet column
  const hasFleet = db.query(`PRAGMA table_info(starlink_planes)`).all()
    .some((col: any) => col.name === 'fleet');
  
  if (!hasFleet) {
    // Add the fleet column if it doesn't exist
    db.query(`ALTER TABLE starlink_planes ADD COLUMN fleet TEXT;`).run();
    
    // Update existing records with default values
    db.query(`
      UPDATE starlink_planes 
      SET DateFound = ?, 
          TailNumber = SUBSTR(aircraft, 0, INSTR(aircraft, ' ')), 
          OperatedBy = ?
    `).run(new Date().toISOString().split('T')[0], 'United Airlines');
  }
}

// Create meta table for storing meta data (total count, last updated time, etc)
db.query(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`).run();

/**
 * Re-fetch the data from Google Sheets and upsert it into the database.
 */
async function updateStarlinkData() {
  try {
    const { totalAircraftCount, starlinkAircraft, fleetStats } = await fetchAllSheets();
    
    // Clear table (simple approach)
    db.query(`DELETE FROM starlink_planes`).run();
    
    // Update meta table with total count and last updated time
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('totalAircraftCount', ?)`)
      .run(String(totalAircraftCount));
    
    // Store the last updated timestamp
    const lastUpdated = new Date().toISOString();
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('lastUpdated', ?)`)
      .run(lastUpdated);
      
    // Store fleet statistics
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('expressTotal', ?)`)
      .run(String(fleetStats.express.total));
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('expressStarlink', ?)`)
      .run(String(fleetStats.express.starlink));
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('expressPercentage', ?)`)
      .run(String(fleetStats.express.percentage.toFixed(2)));
      
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('mainlineTotal', ?)`)
      .run(String(fleetStats.mainline.total));
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('mainlineStarlink', ?)`)
      .run(String(fleetStats.mainline.starlink));
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('mainlinePercentage', ?)`)
      .run(String(fleetStats.mainline.percentage.toFixed(2)));

    // Insert new data
    const insertStmt = db.prepare(`
      INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const aircraft of starlinkAircraft) {
      insertStmt.run(
        aircraft["Aircraft"] ?? "",
        aircraft["WiFi"] ?? "",
        aircraft["sheet_gid"] ?? "",
        aircraft["sheet_type"] ?? "",
        aircraft["DateFound"] ?? new Date().toISOString().split('T')[0],
        aircraft["TailNumber"] ?? "",
        aircraft["OperatedBy"] ?? "United Airlines",
        aircraft["fleet"] ?? "express"
      );
    }

    console.log(`Updated data: ${starlinkAircraft.length} Starlink aircraft out of ${totalAircraftCount} total`);
    
    return {
      total: totalAircraftCount,
      starlinkCount: starlinkAircraft.length
    };
  } catch (err) {
    console.error("Error updating starlink data:", err);
    return { total: 0, starlinkCount: 0 };
  }
}

// Call updateStarlinkData immediately at startup
updateStarlinkData();

// Set an hourly interval to re-fetch and store the data
setInterval(() => {
  console.log("Running scheduled update...");
  updateStarlinkData();
}, 60 * 60 * 1000); // 1 hour

/** 
 * Helper functions to read from DB 
 */
function getTotalCount(): number {
  const row = db.query(`
    SELECT value 
    FROM meta 
    WHERE key = 'totalAircraftCount'
  `).get();

  if (row && row.value) {
    return parseInt(row.value, 10);
  }
  
  return 0; // Default
}

function getMetaValue(key: string, defaultValue: number): number {
  const row = db.query(`
    SELECT value 
    FROM meta 
    WHERE key = ?
  `).get(key);

  if (row && row.value) {
    return parseFloat(row.value);
  }
  
  return defaultValue;
}

function getLastUpdated(): string {
  const lastUpdated = db.query(`
    SELECT value 
    FROM meta 
    WHERE key = 'lastUpdated'
  `).get();

  if (lastUpdated && lastUpdated.value) {
    return lastUpdated.value;
  }
  
  return new Date().toISOString(); // Default to now if no value exists
}

function getStarlinkPlanes(): any[] {
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

// Get port from environment variable or use 3000 as default
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Bun server
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/data") {
      // Gather data from DB
      const totalCount = getTotalCount();
      const starlinkPlanes = getStarlinkPlanes();
      const lastUpdated = getLastUpdated();
      
      // Get fleet statistics from DB
      const fleetStats = {
        express: {
          total: getMetaValue('expressTotal', 0),
          starlink: getMetaValue('expressStarlink', 0),
          percentage: getMetaValue('expressPercentage', 0)
        },
        mainline: {
          total: getMetaValue('mainlineTotal', 0),
          starlink: getMetaValue('mainlineStarlink', 0),
          percentage: getMetaValue('mainlinePercentage', 0)
        }
      };
      
      return new Response(
        JSON.stringify({ 
          totalCount, 
          starlinkPlanes, 
          lastUpdated,
          fleetStats
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/") {
      // Initial data for SSR
      const totalCount = getTotalCount();
      const starlinkPlanes = getStarlinkPlanes();
      const lastUpdated = getLastUpdated();
      
      // Get fleet statistics from DB
      const fleetStats = {
        express: {
          total: getMetaValue('expressTotal', 0),
          starlink: getMetaValue('expressStarlink', 0),
          percentage: getMetaValue('expressPercentage', 0)
        },
        mainline: {
          total: getMetaValue('mainlineTotal', 0),
          starlink: getMetaValue('mainlineStarlink', 0),
          percentage: getMetaValue('mainlinePercentage', 0)
        }
      };

      const html = ReactDOMServer.renderToString(
        React.createElement(Page, { 
          total: totalCount, 
          starlink: starlinkPlanes,
          lastUpdated: lastUpdated,
          fleetStats: fleetStats
        })
      );
      return new Response(
        `
        <!DOCTYPE html>
        <html>
          <head>
            <title>UA Tracker</title>
            <meta charset="UTF-8" />
            <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
            <script>
              // Define React and Page globally for client-side hydration
              var Page = ${Bun.file("./page.tsx").toString()};
            </script>
          </head>
          <body>
            <div id="root">${html}</div>
            <script>
              // Hydrate the React component with the initial data
              ReactDOM.hydrateRoot(
                document.getElementById('root'),
                React.createElement(Page, ${JSON.stringify({
                  total: totalCount,
                  starlink: starlinkPlanes,
                  lastUpdated: lastUpdated,
                  fleetStats: fleetStats
                })})
              );
            </script>
          </body>
        </html>
        `,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${PORT}`);