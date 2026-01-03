// IMPORTANT: Tracer must be imported FIRST before any other imports
import "./src/observability/tracer";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { COUNTERS, metrics, withSpan } from "./src/observability";
import { info, error as logError } from "./src/utils/logger";

// ============ Route Tracing Helpers ============

/**
 * Allowlist of known routes for metrics (max ~25 to avoid cardinality explosion).
 * Unknown routes (404s, bot probes) are mapped to "unknown" and NOT emitted as metrics.
 */
const KNOWN_ROUTES = new Set([
  "/",
  "/api/data",
  "/api/check-flight",
  "/api/mismatches",
  "/api/fleet-discovery",
  "/sitemap.xml",
  "/robots.txt",
  "/debug/files",
  // Static assets are grouped
  "/static/*",
]);

/**
 * Normalize a route for metrics. Returns null for unknown routes (skip metrics).
 */
function normalizeRouteForMetrics(pathname: string): string | null {
  if (KNOWN_ROUTES.has(pathname)) {
    return pathname;
  }
  if (pathname.startsWith("/static/")) {
    return "/static/*";
  }
  // Unknown route - don't emit metrics to avoid cardinality explosion
  return null;
}

/**
 * Wrap a route handler with tracing and metrics.
 * Use this for API routes that need observability.
 */
function tracedRoute(
  routePath: string,
  handler: (req: Request) => Response | Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    return withSpan(
      "http.request",
      async (span) => {
        span.setTag("http.method", req.method);
        span.setTag("http.route", routePath);

        const response = await handler(req);

        span.setTag("http.status_code", response.status);

        // Only emit metrics for known routes
        const normalizedRoute = normalizeRouteForMetrics(routePath);
        if (normalizedRoute) {
          metrics.increment(COUNTERS.HTTP_REQUEST, {
            method: req.method,
            route: normalizedRoute,
            status_code: response.status,
          });
        }

        return response;
      },
      { "http.route": routePath }
    );
  };
}

// Global error handlers to prevent silent crashes
process.on("unhandledRejection", (reason) => {
  logError("Unhandled Rejection", reason);
});

process.on("uncaughtException", (err) => {
  logError("Uncaught Exception", err);
  // Don't exit - try to keep the server running
});

import { checkNewPlanes, startFlightUpdater } from "./src/api/flight-updater";
import Page from "./src/components/page";
import {
  getFleetDiscoveryStats,
  getFleetStats,
  getLastUpdated,
  getStarlinkPlanes,
  getTotalCount,
  getUpcomingFlights,
  getVerificationSummary,
  getWifiMismatches,
  initializeDatabase,
  syncSpreadsheetToFleet,
  updateDatabase,
} from "./src/database/database";
import { startFleetDiscovery } from "./src/scripts/fleet-discovery";
import { startFleetSync } from "./src/scripts/fleet-sync";
import { startStarlinkVerifier } from "./src/scripts/starlink-verifier";
import type { ApiResponse, Flight } from "./src/types";
import {
  CONTENT_TYPES,
  SECURITY_HEADERS,
  getDomainContent,
  isUnitedDomain,
  normalizeFlightNumber,
} from "./src/utils/constants";
import { getNotFoundHtml } from "./src/utils/not-found";
import {
  fetchAllSheets,
  getSpreadsheetCacheInfo,
  getSpreadsheetCacheTails,
} from "./src/utils/utils";

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
info(`Server starting on port ${PORT}. Environment: ${process.env.NODE_ENV || "development"}`);

// Data update function
async function updateStarlinkData() {
  try {
    const { totalAircraftCount, starlinkAircraft, fleetStats } = await fetchAllSheets();

    updateDatabase(db, totalAircraftCount, starlinkAircraft, fleetStats);

    // Sync spreadsheet planes to united_fleet for discovery
    const synced = syncSpreadsheetToFleet(db);
    if (synced > 0) {
      info(`Synced ${synced} new planes to united_fleet`);
    }

    info(
      `Updated data: ${starlinkAircraft.length} Starlink aircraft out of ${totalAircraftCount} total`
    );

    // scan new flights ~immediately
    await checkNewPlanes();

    return {
      total: totalAircraftCount,
      starlinkCount: starlinkAircraft.length,
    };
  } catch (err) {
    logError("Error updating starlink data", err);
    return { total: 0, starlinkCount: 0 };
  }
}

// fill gaps we may have missed
info("Checking for new planes...");
checkNewPlanes().catch((err) => logError("Error checking new planes on startup", err));

// Initialize data and schedule updates
updateStarlinkData();
setInterval(
  () => {
    info("Running scheduled update...");
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
routes["/api/data"] = tracedRoute("/api/data", (req) => {
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
});

routes["/api/check-flight"] = tracedRoute("/api/check-flight", (req) => {
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

  // Normalize flight number to UA prefix for consistent matching
  const normalizedFlightNumber = normalizeFlightNumber(flightNumber);

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
      WHERE uf.flight_number = ?
        AND uf.departure_time >= ?
        AND uf.departure_time < ?
        AND (sp.verified_wifi IS NULL OR sp.verified_wifi = 'Starlink')
      ORDER BY uf.departure_time ASC
    `
    )
    .all(normalizedFlightNumber, startOfDay, endOfDay) as Array<
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
      flight_number: flight.flight_number,
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
});

// API endpoint to get verification mismatches
routes["/api/mismatches"] = tracedRoute("/api/mismatches", (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: SECURITY_HEADERS.api,
    });
  }

  const summary = getVerificationSummary(db);
  const mismatches = getWifiMismatches(db);

  const response = {
    summary,
    mismatches: mismatches.map((m) => ({
      tail_number: m.TailNumber,
      aircraft: m.Aircraft,
      operated_by: m.OperatedBy,
      spreadsheet_says: m.spreadsheet_wifi === "StrLnk" ? "Starlink" : m.spreadsheet_wifi,
      verified_as: m.verified_wifi,
      verified_at: new Date(m.verified_at * 1000).toISOString(),
      date_found: m.DateFound,
    })),
  };

  return new Response(JSON.stringify(response, null, 2), {
    headers: SECURITY_HEADERS.api,
  });
});

// API endpoint to get fleet discovery stats
routes["/api/fleet-discovery"] = tracedRoute("/api/fleet-discovery", (req) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: SECURITY_HEADERS.api,
    });
  }

  const stats = getFleetDiscoveryStats(db);
  const spreadsheetCache = getSpreadsheetCacheTails();
  const cacheInfo = getSpreadsheetCacheInfo();

  // Find planes confirmed as Starlink in united_fleet but NOT in spreadsheet cache
  const confirmedStarlinkPlanes = db
    .query(
      `
      SELECT tail_number, aircraft_type, verified_wifi, verified_at, first_seen_source, fleet, operated_by
      FROM united_fleet
      WHERE starlink_status = 'confirmed'
      ORDER BY verified_at DESC
    `
    )
    .all() as Array<{
    tail_number: string;
    aircraft_type: string | null;
    verified_wifi: string | null;
    verified_at: number | null;
    first_seen_source: string;
    fleet: string;
    operated_by: string | null;
  }>;

  // Filter to only planes NOT in the spreadsheet cache
  const newDiscoveries = confirmedStarlinkPlanes
    .filter((p) => !spreadsheetCache.has(p.tail_number))
    .map((p) => ({
      tail_number: p.tail_number,
      aircraft_type: p.aircraft_type,
      verified_wifi: p.verified_wifi,
      verified_at: p.verified_at,
      verified_at_formatted: p.verified_at ? new Date(p.verified_at * 1000).toISOString() : null,
      first_seen_source: p.first_seen_source,
      fleet: p.fleet,
      operated_by: p.operated_by,
    }));

  // Get pending planes breakdown
  const pendingPlanes = db
    .query(
      `
      SELECT tail_number, aircraft_type, verified_at, last_check_error
      FROM united_fleet
      WHERE starlink_status = 'unknown'
      ORDER BY verified_at ASC NULLS FIRST
    `
    )
    .all() as Array<{
    tail_number: string;
    aircraft_type: string | null;
    verified_at: number | null;
    last_check_error: string | null;
  }>;

  const pendingNoFlights = pendingPlanes.filter((p) =>
    p.last_check_error?.includes("No upcoming flights")
  );
  const pendingCheckable = pendingPlanes.filter(
    (p) => !p.last_check_error?.includes("No upcoming flights")
  );

  const response = {
    // Planes we discovered with Starlink that aren't in the spreadsheet
    discovered_not_in_spreadsheet: newDiscoveries,
    // Spreadsheet cache info
    spreadsheet_cache: {
      size: cacheInfo.size,
      updated_at: cacheInfo.updatedAt,
      updated_at_formatted: cacheInfo.updatedAt
        ? new Date(cacheInfo.updatedAt).toISOString()
        : null,
    },
    // Fleet verification progress summary
    verification: {
      total_fleet: stats.total_fleet,
      verified_starlink: stats.verified_starlink,
      verified_non_starlink: stats.verified_non_starlink,
      pending_total: stats.pending_verification,
      pending_no_flights: pendingNoFlights.length,
      pending_checkable: pendingCheckable.length,
    },
    // Samples of pending planes for debugging
    pending_checkable_sample: pendingCheckable.slice(0, 10).map((p) => p.tail_number),
    pending_no_flights_sample: pendingNoFlights.slice(0, 10).map((p) => p.tail_number),
  };

  return new Response(JSON.stringify(response, null, 2), {
    headers: SECURITY_HEADERS.api,
  });
});

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
routes["/sitemap.xml"] = tracedRoute("/sitemap.xml", (req) => {
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
});

// Debug endpoint
routes["/debug/files"] = tracedRoute("/debug/files", (req) => {
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
});

// Request handler for home page and static files
async function handleRequest(req: Request): Promise<Response> {
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
    } catch (err) {
      logError(`Error serving static file ${filePath}`, err);
    }
  }

  // 404 page
  return new Response(getNotFoundHtml(host), {
    status: 404,
    headers: SECURITY_HEADERS.notFound,
  });
}

// Start server
Bun.serve({
  port: PORT,
  routes,

  async fetch(req) {
    const url = new URL(req.url);

    // Determine route for tracing (home page, static files, or 404)
    let route = "/";
    if (url.pathname.startsWith("/static/")) {
      route = "/static/*";
    } else if (url.pathname !== "/") {
      route = "/*"; // 404 catch-all
    }

    return withSpan(
      "http.request",
      async (span) => {
        span.setTag("http.method", req.method);
        span.setTag("http.route", route);

        const response = await handleRequest(req);

        span.setTag("http.status_code", response.status);

        // Only emit metrics for known routes (skip 404s from bots/scrapers)
        const normalizedRoute = normalizeRouteForMetrics(route);
        if (normalizedRoute) {
          metrics.increment(COUNTERS.HTTP_REQUEST, {
            method: req.method,
            route: normalizedRoute,
            status_code: response.status,
          });
        }

        return response;
      },
      { "http.route": route }
    );
  },
});

// Start background jobs
startFlightUpdater();
startStarlinkVerifier();
startFleetSync();
startFleetDiscovery("maintenance");

info(`Server running at http://localhost:${PORT}`);
