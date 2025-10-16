import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { checkNewPlanes, startFlightUpdater } from "./src/api/flight-updater";
import Page from "./src/components/page";
import {
  getFleetStats,
  getLastUpdated,
  getStarlinkPlanes,
  getTotalCount,
  getUpcomingFlights,
  initializeDatabase,
  updateDatabase,
} from "./src/database/database";
import type { ApiResponse, Flight } from "./src/types";
import {
  CONTENT_TYPES,
  SECURITY_HEADERS,
  getDomainContent,
  isUnitedDomain,
} from "./src/utils/constants";
import { getNotFoundHtml } from "./src/utils/not-found";
import { fetchAllSheets } from "./src/utils/utils";

// Environment configuration
const STATIC_DIR =
  process.env.NODE_ENV === "production" ? "/app/static" : path.join(import.meta.dir, "static");
const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;

// Bun-native HTML template handling
const htmlTemplateFile = Bun.file(path.join(import.meta.dir, "index.html"));
let htmlTemplateCache: string;

async function getHtmlTemplate(): Promise<string> {
  if (process.env.NODE_ENV === "production") {
    if (!htmlTemplateCache) {
      htmlTemplateCache = await htmlTemplateFile.text();
    }
    return htmlTemplateCache;
  }
  return await htmlTemplateFile.text();
}

// Initialize database
const db = initializeDatabase();

// Log startup info
console.log(
  `Server starting on port ${PORT}. Environment: ${process.env.NODE_ENV || "development"}`
);

// Data update function
async function updateStarlinkData() {
  try {
    const { totalAircraftCount, starlinkAircraft, fleetStats } = await fetchAllSheets();

    updateDatabase(db, totalAircraftCount, starlinkAircraft, fleetStats);

    console.log(
      `Updated data: ${starlinkAircraft.length} Starlink aircraft out of ${totalAircraftCount} total`
    );

    // scan new flights ~immediately
    await checkNewPlanes();

    return {
      total: totalAircraftCount,
      starlinkCount: starlinkAircraft.length,
    };
  } catch (err) {
    console.error("Error updating starlink data:", err);
    return { total: 0, starlinkCount: 0 };
  }
}

// Initialize data and schedule updates
updateStarlinkData();
setInterval(
  () => {
    console.log("Running scheduled update...");
    updateStarlinkData();
  },
  60 * 60 * 1000
); // 1 hour

// HTML template rendering
function renderHtml(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`{{${key}}}`, "g");
    result = result.replace(regex, value);
  }
  return result;
}

// Static files configuration
const staticFiles = [
  {
    path: "/favicon.ico",
    filename: "favicon.ico",
    contentType: "image/x-icon",
  },
  {
    path: "/site.webmanifest",
    filename: "site.webmanifest",
    contentType: "application/manifest+json",
  },
  {
    path: "/apple-touch-icon.png",
    filename: "apple-touch-icon.png",
    contentType: "image/png",
  },
  {
    path: "/android-chrome-192x192.png",
    filename: "android-chrome-192x192.png",
    contentType: "image/png",
  },
  {
    path: "/android-chrome-512x512.png",
    filename: "android-chrome-512x512.png",
    contentType: "image/png",
  },
  {
    path: "/favicon-16x16.png",
    filename: "favicon-16x16.png",
    contentType: "image/png",
  },
  {
    path: "/favicon-32x32.png",
    filename: "favicon-32x32.png",
    contentType: "image/png",
  },
  {
    path: "/static/social-image.webp",
    filename: "social-image.webp",
    contentType: "image/webp",
  },
];

// Generate routes
const routes: Record<string, Response | ((req: Request) => Response)> = {};

// Add static file routes
for (const file of staticFiles) {
  routes[file.path] = new Response(await Bun.file(path.join(STATIC_DIR, file.filename)).bytes(), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}

// API endpoint
routes["/api/data"] = (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: SECURITY_HEADERS.api,
    });
  }

  const totalCount = getTotalCount(db);
  const starlinkPlanes = getStarlinkPlanes(db);
  const lastUpdated = getLastUpdated(db);
  const fleetStats = getFleetStats(db);
  const allFlights = getUpcomingFlights(db);

  // Group flights by tail number for easy lookup
  const flightsByTail: Record<string, Flight[]> = {};
  for (const flight of allFlights) {
    if (!flightsByTail[flight.tail_number]) {
      flightsByTail[flight.tail_number] = [];
    }
    flightsByTail[flight.tail_number].push(flight);
  }

  const response: ApiResponse = {
    totalCount,
    starlinkPlanes,
    lastUpdated,
    fleetStats,
    flightsByTail,
  };

  return new Response(JSON.stringify(response), {
    headers: SECURITY_HEADERS.api,
  });
};

routes["/api/check-flight"] = (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: SECURITY_HEADERS.api,
    });
  }

  const url = new URL(req.url);
  const flightNumber = url.searchParams.get("flight_number");
  const date = url.searchParams.get("date");

  if (!flightNumber || !date) {
    return new Response(
      JSON.stringify({ error: "Missing required parameters: flight_number and date" }),
      {
        status: 400,
        headers: SECURITY_HEADERS.api,
      }
    );
  }

  const dateObj = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dateObj.getTime())) {
    return new Response(JSON.stringify({ error: "Invalid date format. Use YYYY-MM-DD" }), {
      status: 400,
      headers: SECURITY_HEADERS.api,
    });
  }

  const startOfDay = Math.floor(dateObj.getTime() / 1000);
  const endOfDay = startOfDay + 86400;

  // Handle UA -> SKW conversion for SkyWest operated flights
  const flightNumbers = [flightNumber];
  if (flightNumber.startsWith("UA")) {
    flightNumbers.push(flightNumber.replace("UA", "SKW"));
  }

  const matchingFlights = db
    .query(
      `
      SELECT
        uf.*,
        sp.Aircraft,
        sp.WiFi,
        sp.DateFound,
        sp.OperatedBy,
        sp.fleet
      FROM upcoming_flights uf
      INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
      WHERE uf.flight_number IN (${flightNumbers.map(() => "?").join(",")})
        AND uf.departure_time >= ?
        AND uf.departure_time < ?
      ORDER BY uf.departure_time ASC
    `
    )
    .all(...flightNumbers, startOfDay, endOfDay) as Array<
    Flight & {
      Aircraft: string;
      WiFi: string;
      DateFound: string;
      OperatedBy: string;
      fleet: string;
    }
  >;

  if (matchingFlights.length === 0) {
    return new Response(
      JSON.stringify({
        hasStarlink: false,
        message: "No Starlink-equipped aircraft found for this flight on the specified date",
        flights: [],
      }),
      {
        headers: SECURITY_HEADERS.api,
      }
    );
  }

  const response = {
    hasStarlink: true,
    flights: matchingFlights.map((flight) => ({
      tail_number: flight.tail_number,
      aircraft_type: flight.Aircraft,
      // Convert SKW back to UA for consistency with user's request
      flight_number:
        flight.flight_number.startsWith("SKW") && flightNumber.startsWith("UA")
          ? flight.flight_number.replace("SKW", "UA")
          : flight.flight_number,
      departure_airport: flight.departure_airport,
      arrival_airport: flight.arrival_airport,
      departure_time: flight.departure_time,
      arrival_time: flight.arrival_time,
      departure_time_formatted: new Date(flight.departure_time * 1000).toISOString(),
      arrival_time_formatted: new Date(flight.arrival_time * 1000).toISOString(),
      starlink_installed_date: flight.DateFound,
      operated_by: flight.OperatedBy,
      fleet_type: flight.fleet,
    })),
  };

  return new Response(JSON.stringify(response), {
    headers: SECURITY_HEADERS.api,
  });
};

// robots.txt route
routes["/robots.txt"] = new Response(
  `User-agent: *
Allow: /
Disallow: /api/
Disallow: /debug/

Sitemap: https://unitedstarlinktracker.com/sitemap.xml`,
  {
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "public, max-age=86400",
    },
  }
);

// sitemap.xml route
routes["/sitemap.xml"] = (req) => {
  const baseUrl = "https://unitedstarlinktracker.com";
  const lastUpdated = getLastUpdated(db);

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${lastUpdated ? new Date(lastUpdated).toISOString() : new Date().toISOString()}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;

  return new Response(sitemap, {
    headers: {
      "Content-Type": "application/xml",
      "Cache-Control": "public, max-age=3600",
    },
  });
};

// Debug endpoint
routes["/debug/files"] = (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const isAuthorized =
    process.env.NODE_ENV !== "production" || token === "starlink-tracker-debug-1a2b3c";

  if (!isAuthorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  const debugInfo = {
    environment: {
      nodeEnv: process.env.NODE_ENV,
      staticDir: STATIC_DIR,
    },
    database: {
      planes: getStarlinkPlanes(db).length,
      lastUpdated: getLastUpdated(db),
    },
  };

  return new Response(JSON.stringify(debugInfo, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
};

// Start server
Bun.serve({
  port: PORT,
  routes,

  async fetch(req) {
    const url = new URL(req.url);
    const host = req.headers.get("host") || "unitedstarlinktracker.com";

    // Home page
    if (url.pathname === "/") {
      if (req.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { "Content-Type": "text/plain" },
        });
      }

      const totalCount = getTotalCount(db);
      const starlinkPlanes = getStarlinkPlanes(db);
      const lastUpdated = getLastUpdated(db);
      const fleetStats = getFleetStats(db);
      const allFlights = getUpcomingFlights(db);

      // Group flights by tail number for rendering
      const flightsByTail: Record<string, Flight[]> = {};
      for (const flight of allFlights) {
        if (!flightsByTail[flight.tail_number]) {
          flightsByTail[flight.tail_number] = [];
        }
        flightsByTail[flight.tail_number].push(flight);
      }

      const reactHtml = ReactDOMServer.renderToString(
        React.createElement(Page, {
          total: totalCount,
          starlink: starlinkPlanes,
          lastUpdated,
          fleetStats,
          isUnited: isUnitedDomain(host),
          flightsByTail,
        })
      );

      const metadata = getDomainContent(host);
      const starlinkCount = starlinkPlanes.length;
      const percentage = totalCount > 0 ? ((starlinkCount / totalCount) * 100).toFixed(2) : "0.00";

      const htmlVariables = {
        ...metadata,
        html: reactHtml,
        host,
        totalCount: starlinkCount.toString(),
        totalAircraftCount: totalCount.toString(),
        lastUpdated: lastUpdated,
        isUnited: isUnitedDomain(host).toString(),
        currentDate: new Date().toLocaleDateString(),
        mainlineCount: (fleetStats?.mainline.starlink || 0).toString(),
        expressCount: (fleetStats?.express.starlink || 0).toString(),
        percentage: percentage,
        mainlinePercentage: (fleetStats?.mainline.percentage || 0).toFixed(2),
        expressPercentage: (fleetStats?.express.percentage || 0).toFixed(2),
      };

      const template = await getHtmlTemplate();
      const html = renderHtml(template, htmlVariables);
      return new Response(html, { headers: SECURITY_HEADERS.html });
    }

    // Static files
    if (url.pathname.startsWith("/static/")) {
      const subPath = url.pathname.replace(/^\/static\//, "");
      const filePath = path.join(STATIC_DIR, subPath);

      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase().substring(1);
          const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

          return new Response(Bun.file(filePath), {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=86400",
            },
          });
        }
      } catch (error) {
        console.error(`Error serving static file ${filePath}:`, error);
      }
    }

    // 404 page
    return new Response(getNotFoundHtml(host), {
      status: 404,
      headers: SECURITY_HEADERS.notFound,
    });
  },
});

// Start the flight updater
startFlightUpdater();

console.log(`Server running at http://localhost:${PORT}`);
