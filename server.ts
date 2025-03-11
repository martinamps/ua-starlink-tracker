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

// Simple in-memory rate limiting
const RATE_LIMIT = 30; // requests per minute
const RATE_WINDOW = 60 * 1000; // 1 minute in milliseconds
const ipRequests = new Map<string, { count: number, resetTime: number }>();

function applyRateLimit(req: Request): { allowed: boolean, remaining: number } {
  // Get client IP (in production, you'd rely on X-Forwarded-For or similar)
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  const now = Date.now();
  
  if (!ipRequests.has(ip)) {
    // First request from this IP
    ipRequests.set(ip, { 
      count: 1, 
      resetTime: now + RATE_WINDOW 
    });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  
  const record = ipRequests.get(ip)!;
  
  // Reset if window has expired
  if (now > record.resetTime) {
    record.count = 1;
    record.resetTime = now + RATE_WINDOW;
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  
  // Increment and check
  record.count += 1;
  const remaining = Math.max(0, RATE_LIMIT - record.count);
  
  return { 
    allowed: record.count <= RATE_LIMIT,
    remaining
  };
}

// Clean up rate limit records periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of ipRequests.entries()) {
    if (now > record.resetTime) {
      ipRequests.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Bun server
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    
    // Apply security headers to all responses
    const securityHeaders = {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'self'",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store, max-age=0"
    };

    if (url.pathname === "/api/data") {
      // Apply rate limiting for API endpoints
      const rateLimit = applyRateLimit(req);
      
      // Return 429 if rate limit exceeded
      if (!rateLimit.allowed) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Try again later." }),
          { 
            status: 429, 
            headers: {
              ...securityHeaders,
              "Retry-After": "60",
              "X-RateLimit-Limit": String(RATE_LIMIT),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60)
            }
          }
        );
      }
      
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
      
      // For security, ensure the API is read-only
      // No POST/PUT/DELETE methods allowed
      if (req.method !== "GET") {
        return new Response(
          JSON.stringify({ error: "Method not allowed" }),
          { status: 405, headers: securityHeaders }
        );
      }
      
      // Return the data with appropriate security headers
      return new Response(
        JSON.stringify({ 
          totalCount, 
          starlinkPlanes, 
          lastUpdated,
          fleetStats
        }),
        { 
          headers: {
            ...securityHeaders,
            "X-RateLimit-Limit": String(RATE_LIMIT),
            "X-RateLimit-Remaining": String(rateLimit.remaining),
            "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 60)
          } 
        }
      );
    }

    if (url.pathname === "/") {
      // Apply more lenient rate limiting for the main page
      const rateLimit = applyRateLimit(req);
      if (!rateLimit.allowed) {
        return new Response(
          "Too many requests. Please try again later.",
          { 
            status: 429, 
            headers: {
              "Content-Type": "text/plain",
              "Retry-After": "60"
            }
          }
        );
      }
      
      // Only allow GET requests
      if (req.method !== "GET") {
        return new Response(
          "Method not allowed",
          { status: 405, headers: { "Content-Type": "text/plain" } }
        );
      }
      
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
        <html lang="en">
          <head>
            <title>United Airlines Starlink Tracker | Live WiFi Rollout Statistics</title>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <meta name="description" content="Track United Airlines and United Express Starlink WiFi installation progress. Live statistics showing percentage of the fleet equipped with SpaceX's Starlink internet." />
            <meta name="keywords" content="United Airlines, Starlink, WiFi, Internet, SpaceX, Aircraft, Fleet, United Express, In-flight WiFi" />
            <meta name="robots" content="index, follow" />
            <meta property="og:title" content="United Airlines Starlink Tracker" />
            <meta property="og:description" content="Live statistics showing United Airlines Starlink WiFi installation progress across mainline and express fleets." />
            <meta property="og:type" content="website" />
            <meta name="twitter:card" content="summary" />
            <meta name="twitter:title" content="United Airlines Starlink Tracker" />
            <meta name="twitter:description" content="Live statistics on United Airlines Starlink WiFi installation across the fleet." />
            <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>✈️</text></svg>" />
            
            <!-- Security headers -->
            <meta http-equiv="Content-Security-Policy" content="default-src 'self' https://unpkg.com; script-src 'self' 'unsafe-inline' https://unpkg.com https://analytics.martinamps.com; style-src 'self' 'unsafe-inline';">
            <meta http-equiv="X-Content-Type-Options" content="nosniff">
            <meta http-equiv="X-Frame-Options" content="DENY">
            <meta name="referrer" content="no-referrer">
            
            <!-- Production versions of React -->
            <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
            <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
            
            <style>
              body {
                margin: 0;
                padding: 0;
                background-color: #f9f9f9;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
              }
              * {
                box-sizing: border-box;
              }
              @media (prefers-color-scheme: dark) {
                body {
                  background-color: #1a1a1a;
                  color: #f0f0f0;
                }
              }
            </style>
            
            <!-- Analytics -->
            <script defer data-domain="unitedstarlinktracker.com" src="https://analytics.martinamps.com/js/script.js"></script>
            
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
            
            <!-- Security: Prevent clickjacking -->
            <script>
              if (window.self !== window.top) {
                window.top.location = window.self.location;
              }
            </script>
            
            <!-- Structured data for SEO -->
            <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "WebSite",
              "name": "United Airlines Starlink Tracker",
              "description": "Track United Airlines Starlink WiFi installation progress across the fleet",
              "url": "https://ua-starlink-tracker.example.com/"
            }
            </script>
          </body>
        </html>
        `,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Show a proper 404 page
    return new Response(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <title>404 - Page Not Found | United Airlines Starlink Tracker</title>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta name="robots" content="noindex, nofollow" />
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
              text-align: center;
              padding: 50px;
              background-color: #f9f9f9;
              color: #333;
            }
            h1 { color: #0066cc; }
            a { color: #0066cc; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <h1>404 - Page Not Found</h1>
          <p>The page you're looking for doesn't exist.</p>
          <p><a href="/">Return to United Airlines Starlink Tracker</a></p>
        </body>
      </html>
    `, { status: 404, headers: { "Content-Type": "text/html" } });
  },
});

console.log(`Server running at http://localhost:${PORT}`);