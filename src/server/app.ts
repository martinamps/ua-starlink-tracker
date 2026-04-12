/**
 * Pure request dispatcher. No Bun.serve, no jobs, no global state beyond
 * memoized readers. server.ts wires this into Bun.serve and starts jobs.
 *
 * Isolation guarantee: dispatch() is the ONLY place that reads the Host
 * header and resolves a tenant. Handlers receive a ScopedReader closed over
 * (db, airline) with no .query() method — forgetting the airline filter is
 * structurally impossible in handler code.
 */

import fs from "node:fs";
import path from "node:path";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { buildFaqJsonLd, getContent } from "../airlines/content";
import {
  buildAirlineFlightNumberVariants,
  ensureAirlinePrefix,
  normalizeAirlineFlightNumber,
} from "../airlines/flight-number";
import {
  AIRLINES,
  HUB_HOSTS,
  brandMetadata,
  resolveTenant,
  tenantBrand,
} from "../airlines/registry";
import { lookupFlightTailVerdict } from "../api/flight-verdict";
import { handleMcpRequest } from "../api/mcp-server";
import CheckFlightPage from "../components/check-flight-page";
import FleetPage from "../components/fleet-page";
import McpPage from "../components/mcp-page";
import Page from "../components/page";
import RoutePlannerPage from "../components/route-planner-page";
import { COUNTERS, metrics, withSpan } from "../observability";
import { planItinerary, predictFlight } from "../scripts/starlink-predictor";
import type { ApiResponse, Flight } from "../types";
import { CONTENT_TYPES, SECURITY_HEADERS } from "../utils/constants";
import { error as logError } from "../utils/logger";
import { getNotFoundHtml } from "../utils/not-found";
import { getSpreadsheetCacheInfo, getSpreadsheetCacheTails } from "../utils/utils";
import {
  type Database,
  type RequestContext,
  type ScopedReader,
  createReaderFactory,
  tenantConfig,
  tenantScope,
} from "./context";

type Handler = (ctx: RequestContext) => Response | Promise<Response>;
type RouteTable = Record<string, Handler>;

interface PageMeta {
  siteTitle: string;
  siteDescription: string;
  keywords: string;
  ogTitle: string;
  ogDescription: string;
}

// ─────────────────────────────────────────────────────────────────────────────

const STATIC_DIR =
  process.env.NODE_ENV === "production"
    ? "/app/static"
    : path.join(import.meta.dir, "..", "..", "static");

const htmlTemplateFile = Bun.file(path.join(import.meta.dir, "..", "..", "index.html"));
let htmlTemplateCache: string;

async function getHtmlTemplate(): Promise<string> {
  if (process.env.NODE_ENV === "production") {
    if (!htmlTemplateCache) htmlTemplateCache = await htmlTemplateFile.text();
    return htmlTemplateCache;
  }
  return await htmlTemplateFile.text();
}

function renderHtml(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, "g"), value);
  }
  return result;
}

function methodNotAllowed(json = false): Response {
  return json
    ? new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: SECURITY_HEADERS.api,
      })
    : new Response("Method not allowed", {
        status: 405,
        headers: { "Content-Type": "text/plain" },
      });
}

// ─────────────────────────────────────────────────────────────────────────────
// Static-file routes (tenant-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_FILES = [
  { path: "/favicon.ico", filename: "favicon.ico", contentType: "image/x-icon" },
  {
    path: "/site.webmanifest",
    filename: "site.webmanifest",
    contentType: "application/manifest+json",
  },
  { path: "/apple-touch-icon.png", filename: "apple-touch-icon.png", contentType: "image/png" },
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
  { path: "/favicon-16x16.png", filename: "favicon-16x16.png", contentType: "image/png" },
  { path: "/favicon-32x32.png", filename: "favicon-32x32.png", contentType: "image/png" },
  { path: "/static/social-image.webp", filename: "social-image.webp", contentType: "image/webp" },
];

const staticResponses = new Map<string, Response>();
for (const f of STATIC_FILES) {
  const fp = path.join(STATIC_DIR, f.filename);
  if (fs.existsSync(fp)) {
    staticResponses.set(
      f.path,
      new Response(Bun.file(fp), {
        headers: { "Content-Type": f.contentType, "Cache-Control": "public, max-age=86400" },
      })
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API handlers
// ─────────────────────────────────────────────────────────────────────────────

const apiData: Handler = ({ req, reader }) => {
  if (req.method !== "GET") return methodNotAllowed(true);

  const totalCount = reader.getTotalCount();
  const starlinkPlanes = reader.getStarlinkPlanes();
  const lastUpdated = reader.getLastUpdated();
  const fleetStats = reader.getFleetStats();
  const allFlights = reader.getUpcomingFlights();

  const flightsByTail: Record<string, Flight[]> = {};
  for (const flight of allFlights) {
    if (!flightsByTail[flight.tail_number]) flightsByTail[flight.tail_number] = [];
    flightsByTail[flight.tail_number].push(flight);
  }

  const response: ApiResponse = {
    totalCount,
    starlinkPlanes,
    lastUpdated,
    fleetStats,
    flightsByTail,
  };
  return new Response(JSON.stringify(response), { headers: SECURITY_HEADERS.api });
};

const apiCheckFlight: Handler = async ({ req, url, reader, db, tenant }) => {
  if (req.method !== "GET") return methodNotAllowed(true);
  // TODO Phase-2: hub ('ALL') should infer airline from flight-number prefix.
  const cfg = tenantConfig(tenant) ?? AIRLINES.UA;

  const flightNumber = url.searchParams.get("flight_number");
  const date = url.searchParams.get("date");
  if (!flightNumber || !date) {
    return new Response(
      JSON.stringify({ error: "Missing required parameters: flight_number and date" }),
      { status: 400, headers: SECURITY_HEADERS.api }
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

  const normalizedFlightNumber = ensureAirlinePrefix(cfg, flightNumber);
  const variants = buildAirlineFlightNumberVariants(cfg, normalizedFlightNumber);
  const matchingFlights = reader.getFlightsByNumberAndDate(variants, startOfDay, endOfDay);

  if (matchingFlights.length === 0) {
    const segments = await lookupFlightTailVerdict(
      db,
      normalizedFlightNumber,
      startOfDay,
      endOfDay
    );
    if (segments !== null) {
      const starlinkSegs = segments.filter((s) => s.hasStarlink);
      if (starlinkSegs.length > 0) {
        return new Response(
          JSON.stringify({
            hasStarlink: true,
            confidence: starlinkSegs.every((s) => s.confidence === "verified")
              ? "verified"
              : "likely",
            method: "fr24_tail_lookup",
            flights: starlinkSegs.map((s) => ({
              tail_number: s.tail_number,
              aircraft_type: s.aircraft_model,
              flight_number: normalizedFlightNumber,
              ua_flight_number: normalizedFlightNumber,
              departure_airport: s.origin,
              arrival_airport: s.destination,
              departure_time: s.departure_time,
              arrival_time: s.arrival_time,
              departure_time_formatted: new Date(s.departure_time * 1000).toISOString(),
              arrival_time_formatted: new Date(s.arrival_time * 1000).toISOString(),
              operated_by: s.operated_by ?? null,
              fleet_type: s.fleet_type ?? null,
            })),
          }),
          { headers: SECURITY_HEADERS.api }
        );
      }
      if (segments.length > 0) {
        return new Response(
          JSON.stringify({
            hasStarlink: false,
            method: "fr24_tail_lookup",
            flights: [],
            fallback: { segments },
          }),
          { headers: SECURITY_HEADERS.api }
        );
      }
    }
    return new Response(
      JSON.stringify({
        hasStarlink: false,
        message: "No Starlink-equipped aircraft found for this flight on the specified date",
        flights: [],
      }),
      { headers: SECURITY_HEADERS.api }
    );
  }

  const response = {
    hasStarlink: true,
    confidence: matchingFlights.every((f) => f.verified_wifi === "Starlink")
      ? "verified"
      : "likely",
    flights: matchingFlights.map((flight) => ({
      tail_number: flight.tail_number,
      aircraft_type: flight.aircraft_type,
      flight_number: flight.flight_number,
      ua_flight_number: normalizeAirlineFlightNumber(cfg, flight.flight_number),
      departure_airport: flight.departure_airport,
      arrival_airport: flight.arrival_airport,
      departure_time: flight.departure_time,
      arrival_time: flight.arrival_time,
      departure_time_formatted: new Date(flight.departure_time * 1000).toISOString(),
      arrival_time_formatted: new Date(flight.arrival_time * 1000).toISOString(),
      operated_by: flight.OperatedBy,
      fleet_type: flight.fleet,
    })),
  };
  return new Response(JSON.stringify(response), { headers: SECURITY_HEADERS.api });
};

const apiPredictFlight: Handler = ({ req, url, db, tenant }) => {
  if (req.method !== "GET") return methodNotAllowed(true);
  const flightNumber = url.searchParams.get("flight_number");
  if (!flightNumber) {
    return new Response(JSON.stringify({ error: "Missing flight_number" }), {
      status: 400,
      headers: SECURITY_HEADERS.api,
    });
  }
  // TODO Phase-2: hub should infer airline from prefix; predictor itself is still UA-only.
  const cfg = tenantConfig(tenant) ?? AIRLINES.UA;
  const pred = predictFlight(db, ensureAirlinePrefix(cfg, flightNumber));
  return new Response(
    JSON.stringify({
      flight_number: pred.flight_number,
      probability: pred.probability,
      confidence: pred.confidence,
      method: pred.method,
      n_observations: pred.n_observations,
    }),
    { headers: SECURITY_HEADERS.api }
  );
};

const apiPlanRoute: Handler = ({ req, url, db }) => {
  if (req.method !== "GET") return methodNotAllowed(true);
  const origin = url.searchParams.get("origin");
  const destination = url.searchParams.get("destination");
  const maxStopsParam = url.searchParams.get("max_stops");
  const maxStops = maxStopsParam ? Math.min(Number.parseInt(maxStopsParam, 10), 3) : 2;
  if (!origin || !destination) {
    return new Response(JSON.stringify({ error: "Missing origin or destination" }), {
      status: 400,
      headers: SECURITY_HEADERS.api,
    });
  }
  const itineraries = planItinerary(db, origin, destination, { maxItineraries: 12, maxStops });
  return new Response(JSON.stringify({ origin, destination, itineraries }), {
    headers: SECURITY_HEADERS.api,
  });
};

const apiMismatches: Handler = ({ req, reader }) => {
  if (req.method !== "GET") return methodNotAllowed(true);
  const summary = reader.getVerificationSummary();
  const mismatches = reader.getWifiMismatches();
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
  return new Response(JSON.stringify(response, null, 2), { headers: SECURITY_HEADERS.api });
};

const apiFleetDiscovery: Handler = ({ req, reader }) => {
  if (req.method !== "GET") return methodNotAllowed(true);
  const stats = reader.getFleetDiscoveryStats();
  const spreadsheetCache = getSpreadsheetCacheTails();
  const cacheInfo = getSpreadsheetCacheInfo();
  const confirmed = reader.getConfirmedFleetTails();
  const newDiscoveries = confirmed
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
  const pending = reader.getPendingFleetTails();
  const pendingNoFlights = pending.filter((p) =>
    p.last_check_error?.includes("No upcoming flights")
  );
  const pendingCheckable = pending.filter(
    (p) => !p.last_check_error?.includes("No upcoming flights")
  );

  const response = {
    discovered_not_in_spreadsheet: newDiscoveries,
    spreadsheet_cache: {
      size: cacheInfo.size,
      updated_at: cacheInfo.updatedAt,
      updated_at_formatted: cacheInfo.updatedAt
        ? new Date(cacheInfo.updatedAt).toISOString()
        : null,
    },
    verification: {
      total_fleet: stats.total_fleet,
      verified_starlink: stats.verified_starlink,
      verified_non_starlink: stats.verified_non_starlink,
      pending_total: stats.pending_verification,
      pending_no_flights: pendingNoFlights.length,
      pending_checkable: pendingCheckable.length,
    },
    pending_checkable_sample: pendingCheckable.slice(0, 10).map((p) => p.tail_number),
    pending_no_flights_sample: pendingNoFlights.slice(0, 10).map((p) => p.tail_number),
  };
  return new Response(JSON.stringify(response, null, 2), { headers: SECURITY_HEADERS.api });
};

const mcp: Handler = async (ctx) => {
  const { req, db, reader } = ctx;
  const accept = req.headers.get("accept") || "";
  if (req.method === "GET" && accept.includes("text/html")) {
    return renderSubPage(ctx, McpPage, "/mcp", {
      siteTitle: "Add Starlink Tracker to Claude — United Starlink MCP Connector",
      siteDescription:
        "Add the United Starlink Tracker to Claude Desktop in 30 seconds — just paste one URL. Ask Claude to check flights, predict Starlink probability, or plan routes with live data.",
      keywords:
        "claude starlink connector, united starlink mcp, claude united flights, starlink tracker claude, claude custom connector, ai assistant united wifi",
      ogTitle: "Add Starlink Tracker to Claude",
      ogDescription:
        "Paste one URL into Claude Desktop. Ask Claude about United Starlink flights, probabilities, and routing.",
    });
  }
  return handleMcpRequest(req, db, reader.scope === "ALL" ? undefined : reader.scope);
};

// ─────────────────────────────────────────────────────────────────────────────
// SEO / text routes
// ─────────────────────────────────────────────────────────────────────────────

const robotsTxt: Handler = ({ tenant }) => {
  const cfg = tenantConfig(tenant);
  const host = cfg?.canonicalHost ?? HUB_HOSTS[0];
  return new Response(
    `User-agent: GPTBot
Allow: /
Disallow: /api/
Disallow: /debug/

User-agent: ClaudeBot
Allow: /
Disallow: /api/
Disallow: /debug/

User-agent: PerplexityBot
Allow: /
Disallow: /api/
Disallow: /debug/

User-agent: *
Allow: /
Disallow: /api/
Disallow: /debug/

Sitemap: https://${host}/sitemap.xml`,
    { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } }
  );
};

const sitemap: Handler = ({ reader, tenant }) => {
  const cfg = tenantConfig(tenant);
  const baseUrl = `https://${cfg?.canonicalHost ?? HUB_HOSTS[0]}`;
  const lastUpdated = reader.getLastUpdated();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${lastUpdated ? new Date(lastUpdated).toISOString() : new Date().toISOString()}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/check-flight</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/route-planner</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/fleet</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/mcp</loc>
    <lastmod>${new Date().toISOString()}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
</urlset>`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
  });
};

const llmsTxt: Handler = () =>
  new Response(
    `# United Starlink Tracker

> Track which United Airlines flights have free Starlink WiFi. Live status for every Starlink-equipped aircraft, installation progress, and upcoming flight schedules.

United Airlines began installing SpaceX Starlink WiFi on March 7, 2025. The service is completely free for all passengers with speeds up to 250 Mbps. This tracker monitors the rollout in real time, showing which aircraft have been equipped and their upcoming flight schedules.

## Pages

- [Homepage](https://unitedstarlinktracker.com/): Live tracker with all Starlink-equipped aircraft, fleet statistics, search by tail number/flight number/route
- [Check a Flight](https://unitedstarlinktracker.com/check-flight): Check if a specific United flight has Starlink WiFi by flight number and date. Falls back to probability estimate for future flights.
- [Route Planner](https://unitedstarlinktracker.com/route-planner): Find the best routing (direct or 1-stop) to maximize Starlink coverage. Ranks itineraries by probability.
- [Fleet Rollout](https://unitedstarlinktracker.com/fleet): See all United aircraft colored by WiFi provider, live airborne Starlink count, express carrier leaderboard.
- [API - Check Flight](https://unitedstarlinktracker.com/api/check-flight?flight_number=UA123&date=2026-01-22): JSON API to check Starlink status for a specific flight
- [API - Predict Flight](https://unitedstarlinktracker.com/api/predict-flight?flight_number=UA4680): Probability estimate based on 12k+ historical observations
- [API - Plan Route](https://unitedstarlinktracker.com/api/plan-route?origin=SFO&destination=JAX): Full/partial coverage itinerary search
- [API - Fleet Data](https://unitedstarlinktracker.com/api/data): Full JSON dataset of all Starlink-equipped aircraft and flights

## MCP Server (for AI assistants)

- [MCP Docs & Setup](https://unitedstarlinktracker.com/mcp): Setup instructions for Claude Desktop, Cursor, and other MCP clients
- [MCP Endpoint](https://unitedstarlinktracker.com/mcp): Model Context Protocol server (POST with application/json). Tools: check_flight, predict_flight_starlink, plan_starlink_itinerary, predict_route_starlink, get_fleet_stats, list_starlink_aircraft, search_starlink_flights. Transport: streamable HTTP (stateless).

## Chrome Extension

- [Google Flights Starlink Indicator](https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi): Free Chrome extension that shows Starlink badges on Google Flights search results
`,
    {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    }
  );

// ─────────────────────────────────────────────────────────────────────────────
// HTML page handlers
// ─────────────────────────────────────────────────────────────────────────────

function buildBaseTemplateVars(ctx: RequestContext, reactHtml: string): Record<string, string> {
  const { reader, req, tenant } = ctx;
  const brand = tenantBrand(tenant);
  const cfg = tenantConfig(tenant);
  const host = req.headers.get("host") || cfg?.canonicalHost || HUB_HOSTS[0];

  const fleetStats = reader.getFleetStats();
  const totalCount = reader.getTotalCount();
  const starlinkCount = reader.getStarlinkPlanes().length;
  const percentage = totalCount > 0 ? ((starlinkCount / totalCount) * 100).toFixed(2) : "0.00";

  return {
    ...brandMetadata(brand),
    html: reactHtml,
    host,
    totalCount: starlinkCount.toString(),
    totalAircraftCount: totalCount.toString(),
    lastUpdated: reader.getLastUpdated(),
    currentDate: new Date().toLocaleDateString(),
    isoDate: new Date().toISOString(),
    mainlineCount: (fleetStats?.mainline.starlink || 0).toString(),
    expressCount: (fleetStats?.express.starlink || 0).toString(),
    percentage,
    mainlinePercentage: (fleetStats?.mainline.percentage || 0).toFixed(2),
    expressPercentage: (fleetStats?.express.percentage || 0).toFixed(2),
    faqJsonLd: "",
  };
}

async function renderSubPage<P extends object = object>(
  ctx: RequestContext,
  component: React.ComponentType<P>,
  canonicalPath: string,
  meta: PageMeta,
  props?: P
): Promise<Response> {
  const brand = tenantBrand(ctx.tenant);
  const reactHtml = ReactDOMServer.renderToString(
    React.createElement(component, { brand, ...(props ?? {}) } as P)
  );
  const htmlVariables: Record<string, string> = {
    ...buildBaseTemplateVars(ctx, reactHtml),
    ...meta,
  };

  let template = await getHtmlTemplate();
  template = template
    .replace(
      `<link rel="canonical" href="https://{{host}}/" />`,
      `<link rel="canonical" href="https://{{host}}${canonicalPath}" />`
    )
    .replace(
      `<meta property="og:url" content="https://{{host}}/" />`,
      `<meta property="og:url" content="https://{{host}}${canonicalPath}" />`
    );
  return new Response(renderHtml(template, htmlVariables), { headers: SECURITY_HEADERS.html });
}

const checkFlightPage: Handler = (ctx) => {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return methodNotAllowed();
  return renderSubPage(ctx, CheckFlightPage, "/check-flight", {
    siteTitle: "Check If Your United Flight Has Starlink WiFi | United Starlink Tracker",
    siteDescription:
      "Enter your United Airlines flight number and date to check if your aircraft has free Starlink WiFi. Instant results from our live database — or a probability estimate if your flight is more than 2 days out.",
    keywords:
      "check united flight starlink, does my united flight have starlink, united starlink checker, united wifi check, united starlink probability",
    ogTitle: "Check If Your United Flight Has Starlink WiFi",
    ogDescription:
      "Enter your flight number and date to check if your United Airlines aircraft has free Starlink WiFi.",
  });
};

const routePlannerPage: Handler = (ctx) => {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return methodNotAllowed();
  return renderSubPage(ctx, RoutePlannerPage, "/route-planner", {
    siteTitle: "Starlink Route Planner — Find United Flights With Starlink WiFi",
    siteDescription:
      "Find the best way to fly United with Starlink WiFi. Compare direct flights and smart connections ranked by Starlink probability. Plan productive travel with full-coverage routings.",
    keywords:
      "united starlink route planner, best united route for starlink, plan united starlink trip, starlink flight connections, united wifi routing",
    ogTitle: "Starlink Route Planner — United Airlines",
    ogDescription:
      "Find direct flights and smart connections with the highest Starlink probability. Sometimes DEN→ASE→ORD beats flying direct.",
  });
};

const fleetPage: Handler = (ctx) => {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return methodNotAllowed();
  const data = ctx.reader.getFleetPageData();
  return renderSubPage(
    ctx,
    FleetPage,
    "/fleet",
    {
      siteTitle: "United Fleet Starlink Rollout — Every Tail Number, Every WiFi Provider",
      siteDescription:
        "See all 1,500+ United Airlines aircraft at once, colored by WiFi provider. Track which aircraft types are done, which express carrier is winning, and how many Starlink planes are in the air right now.",
      keywords:
        "united fleet starlink, united airlines wifi by aircraft, starlink rollout progress, united express carrier starlink, united tail number wifi",
      ogTitle: "United Fleet Starlink Rollout — The Hangar Floor View",
      ogDescription:
        "Every United tail number, colored by WiFi provider. Your 16-hour flight to Singapore still has Panasonic. Your 53-minute Duluth hop has Starlink.",
    },
    { data }
  );
};

const homePage: Handler = async (ctx) => {
  const { req, reader, tenant } = ctx;
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  const brand = tenantBrand(tenant);
  const content = getContent(tenant);

  const allFlights = reader.getUpcomingFlights();
  const flightsByTail: Record<string, Flight[]> = {};
  for (const flight of allFlights) {
    if (!flightsByTail[flight.tail_number]) flightsByTail[flight.tail_number] = [];
    flightsByTail[flight.tail_number].push(flight);
  }

  const reactHtml = ReactDOMServer.renderToString(
    React.createElement(Page, {
      total: reader.getTotalCount(),
      starlink: reader.getStarlinkPlanes(),
      lastUpdated: reader.getLastUpdated(),
      fleetStats: reader.getFleetStats(),
      brand,
      content,
      perAirlineStats: tenant === "ALL" ? reader.getPerAirlineStats() : undefined,
      flightsByTail,
      airportDepartures: reader.getAirportDepartures(),
    })
  );

  const template = await getHtmlTemplate();
  const baseVars = buildBaseTemplateVars(ctx, reactHtml);
  return new Response(
    renderHtml(template, {
      ...baseVars,
      faqJsonLd: renderHtml(buildFaqJsonLd(content, baseVars.currentDate), baseVars),
    }),
    { headers: SECURITY_HEADERS.html }
  );
};

const staticDir: Handler = ({ url, tenant }) => {
  const subPath = url.pathname.replace(/^\/static\//, "");
  const filePath = path.join(STATIC_DIR, subPath);
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase().substring(1);
      const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
      return new Response(Bun.file(filePath), {
        headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=86400" },
      });
    }
  } catch (err) {
    logError(`Error serving static file ${filePath}`, err);
  }
  return new Response(getNotFoundHtml(tenantBrand(tenant)), {
    status: 404,
    headers: SECURITY_HEADERS.notFound,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Route table + dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface App {
  routes: RouteTable;
  dispatch(req: Request): Promise<Response>;
}

export function createApp(db: Database): App {
  const getReader = createReaderFactory(db);
  const routes: RouteTable = {
    "/": homePage,
    "/check-flight": checkFlightPage,
    "/route-planner": routePlannerPage,
    "/fleet": fleetPage,
    "/api/data": apiData,
    "/api/check-flight": apiCheckFlight,
    "/api/predict-flight": apiPredictFlight,
    "/api/plan-route": apiPlanRoute,
    "/api/mismatches": apiMismatches,
    "/api/fleet-discovery": apiFleetDiscovery,
    "/mcp": mcp,
    "/robots.txt": robotsTxt,
    "/llms.txt": llmsTxt,
    "/sitemap.xml": sitemap,
  };

  const prefixRoutes: Array<[string, Handler]> = [
    ["/check-flight/", checkFlightPage],
    ["/route-planner/", routePlannerPage],
    ["/static/", staticDir],
  ];

  function match(pathname: string): { handler: Handler; route: string } | null {
    const exact = routes[pathname];
    if (exact) return { handler: exact, route: pathname };
    for (const [prefix, h] of prefixRoutes) {
      if (pathname.startsWith(prefix)) return { handler: h, route: prefix.slice(0, -1) };
    }
    return null;
  }

  async function dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Tenant-agnostic static assets bypass tenancy resolution.
    const staticRes = staticResponses.get(url.pathname);
    if (staticRes) return staticRes.clone();

    const tenant = resolveTenant(req.headers.get("host"));
    if (tenant === null) {
      return new Response("Misdirected Request", {
        status: 421,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const reader: ScopedReader = getReader(tenantScope(tenant));
    const ctx: RequestContext = { req, url, tenant, reader, db };

    const m = match(url.pathname);
    const route = m?.route ?? "/*";

    return withSpan(
      "http.request",
      async (span) => {
        span.setTag("http.method", req.method);
        span.setTag("http.route", route);
        span.setTag("tenant", tenantScope(tenant));

        const response = m
          ? await m.handler(ctx)
          : new Response(getNotFoundHtml(tenantBrand(tenant)), {
              status: 404,
              headers: SECURITY_HEADERS.notFound,
            });

        span.setTag("http.status_code", response.status);
        if (m) {
          metrics.increment(COUNTERS.HTTP_REQUEST, {
            method: req.method,
            route: m.route === "/static" ? "/static/*" : m.route,
            status_code: response.status,
            tenant: tenantScope(tenant),
          });
        }
        return response;
      },
      { "http.route": route }
    );
  }

  return { routes, dispatch };
}
