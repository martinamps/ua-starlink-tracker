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
  detectAirline,
  ensureAirlinePrefix,
  normalizeAirlineFlightNumber,
} from "../airlines/flight-number";
import {
  AIRLINES,
  type SiteConfig,
  brandMetadata,
  publicAirlines,
  resolveSite,
} from "../airlines/registry";
import { lookupFlightTailVerdict } from "../api/flight-verdict";
import { handleMcpRequest } from "../api/mcp-server";
import { qatarEquipmentName, qatarEquipmentToWifi } from "../api/qatar-status";
import CheckFlightPage from "../components/check-flight-page";
import FleetPage from "../components/fleet-page";
import McpPage from "../components/mcp-page";
import Page from "../components/page";
import RoutePlannerPage from "../components/route-planner-page";
import { COUNTERS, metrics, withSpan } from "../observability";
import { compareRoute, planItinerary, predictFlight } from "../scripts/starlink-predictor";
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

function analyticsSnippet(site: SiteConfig): string {
  const analytics = site.analytics;
  if (!analytics) return "";
  return `<script defer data-domain="${analytics.dataDomain}" src="${analytics.scriptSrc}"></script>`;
}

function jsonLdBlock(payload: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(payload)}</script>`;
}

function chromeExtensionJsonLd(site: SiteConfig): string {
  if (!site.features.chromeExtension) return "";
  return jsonLdBlock({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "United Starlink Checker for Google Flights",
    operatingSystem: "Chrome",
    applicationCategory: "BrowserApplication",
    description:
      "Check which Google Flights results have Starlink WiFi. See Starlink availability while you search for United flights.",
    url: "https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  });
}

function siteWebJsonLd(site: SiteConfig): string {
  return jsonLdBlock({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: site.brand.title,
    description: site.brand.description,
    url: `https://${site.canonicalHost}/`,
    potentialAction: {
      "@type": "SearchAction",
      target: `https://${site.canonicalHost}/?q={search_term_string}`,
      "query-input": "required name=search_term_string",
    },
  });
}

function sitePageJsonLd(site: SiteConfig, isoDate: string): string {
  return jsonLdBlock({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: site.brand.siteTitle,
    description: site.brand.description,
    url: `https://${site.canonicalHost}/`,
    dateModified: isoDate,
    isPartOf: {
      "@type": "WebSite",
      name: site.brand.title,
      url: `https://${site.canonicalHost}/`,
    },
  });
}

function siteManifest(site: SiteConfig): Response {
  return new Response(
    JSON.stringify({
      name: site.brand.title,
      short_name: site.brand.title.replace(/ Starlink Tracker$/i, ""),
      icons: [
        { src: "/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
        { src: "/android-chrome-512x512.png", sizes: "512x512", type: "image/png" },
      ],
      theme_color: site.brand.accentColor,
      background_color: "#0a0f1a",
      display: "standalone",
    }),
    {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "public, max-age=86400",
      },
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Static-file routes (tenant-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_FILES = [
  { path: "/favicon.ico", filename: "favicon.ico", contentType: "image/x-icon" },
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

/**
 * QR's data shape doesn't fit the upcoming_flights → starlink_planes JOIN that
 * other carriers use (no per-tail signal from QR's flight-status API). Serve
 * straight from qatar_schedule, which the ingester keeps fresh hourly.
 *
 * Contract divergence: the UA endpoint returns `hasStarlink: boolean`. This
 * one returns `boolean | null` — null is the right answer when QR ships a
 * "rolling" subfleet (787) where we have no per-tail signal, or when distinct
 * equipment types are scheduled on the same flight number. Callers on the QR
 * host should expect tri-state. The Chrome extension only hits the UA host,
 * so its boolean contract isn't affected.
 */
function apiCheckFlightQatar(
  reader: ScopedReader,
  cfg: typeof AIRLINES.QR,
  flightNumber: string,
  startOfDay: number,
  endOfDay: number
): Response {
  const normalized = ensureAirlinePrefix(cfg, flightNumber);
  const numeric = normalized.replace(/^[A-Z]+/, "");
  // Match both unpadded and zero-padded forms ("QR1" and "QR001") since the
  // ingester writes "QR1" but users may type either.
  const padded = `QR${numeric.padStart(3, "0")}`;
  const stripped = `QR${String(Number.parseInt(numeric, 10) || 0)}`;
  const variants = Array.from(new Set([normalized, padded, stripped]));
  const rows = reader.getQatarScheduleByFlight(variants, startOfDay, endOfDay);

  if (rows.length === 0) {
    return new Response(
      JSON.stringify({
        hasStarlink: null,
        airline: cfg.name,
        confidence: "no_data",
        reason:
          "No schedule data for this Qatar flight. Coverage is limited to high-traffic routes for the next ~48h; check back closer to departure.",
        flights: [],
      }),
      { headers: SECURITY_HEADERS.api }
    );
  }

  const verdicts = rows.map((r) => r.wifi_verdict);
  const allStarlink = verdicts.every((v) => v === "Starlink");
  const anyRolling = verdicts.some((v) => v === "Rolling");
  const allNone = verdicts.every((v) => v === "None");
  const distinctEquipment = [...new Set(rows.map((r) => qatarEquipmentName(r.equipment_code)))];

  let hasStarlink: boolean | null;
  let confidence: string;
  let reason: string;
  if (allStarlink) {
    hasStarlink = true;
    confidence = "verified";
    reason = `${distinctEquipment.join(", ")} — Qatar Airways completed Starlink installation on this aircraft type.`;
  } else if (allNone) {
    hasStarlink = false;
    confidence = "verified";
    reason = `${distinctEquipment.join(", ")} — not part of Qatar's Starlink rollout.`;
  } else if (anyRolling) {
    hasStarlink = null;
    confidence = "rolling";
    reason = `${distinctEquipment.join(", ")} — Qatar's 787 Starlink rollout is in progress; this aircraft may or may not be equipped yet.`;
  } else {
    hasStarlink = null;
    confidence = "mixed";
    reason = `Mixed equipment scheduled (${distinctEquipment.join(", ")}) — outcome depends on which aircraft operates.`;
  }

  return new Response(
    JSON.stringify({
      hasStarlink,
      airline: cfg.name,
      confidence,
      reason,
      flights: rows.map((r) => ({
        flight_number: r.flight_number,
        aircraft_type: qatarEquipmentName(r.equipment_code),
        equipment_code: r.equipment_code,
        wifi_verdict: r.wifi_verdict,
        departure_airport: r.departure_airport,
        arrival_airport: r.arrival_airport,
        departure_time: r.departure_time,
        arrival_time: r.arrival_time,
        departure_time_formatted: r.departure_time
          ? new Date(r.departure_time * 1000).toISOString()
          : null,
        arrival_time_formatted: r.arrival_time
          ? new Date(r.arrival_time * 1000).toISOString()
          : null,
        flight_status: r.flight_status,
      })),
    }),
    { headers: SECURITY_HEADERS.api }
  );
}

const apiCheckFlight: Handler = async ({ req, url, reader, tenant }) => {
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

  if (cfg.code === "QR") {
    return apiCheckFlightQatar(reader, cfg, flightNumber, startOfDay, endOfDay);
  }

  const normalizedFlightNumber = ensureAirlinePrefix(cfg, flightNumber);
  const variants = buildAirlineFlightNumberVariants(cfg, normalizedFlightNumber);
  const matchingFlights = reader.getFlightsByNumberAndDate(variants, startOfDay, endOfDay);

  if (matchingFlights.length === 0) {
    const segments = await lookupFlightTailVerdict(
      reader,
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

const hubOnly = (tenant: RequestContext["tenant"]): Response | null =>
  tenant === "ALL"
    ? null
    : new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: SECURITY_HEADERS.api,
      });

const apiCheckAnyFlight: Handler = ({ req, url, reader, getReader, tenant }) => {
  if (req.method !== "GET") return methodNotAllowed(true);
  const guard = hubOnly(tenant);
  if (guard) return guard;

  const flightNumber = url.searchParams.get("flight_number");
  const date = url.searchParams.get("date");
  if (!flightNumber || !date) {
    return new Response(
      JSON.stringify({ error: "Missing required parameters: flight_number and date" }),
      { status: 400, headers: SECURITY_HEADERS.api }
    );
  }

  const publicHubAirlines = publicAirlines();
  const cfg = detectAirline(flightNumber, publicHubAirlines);
  if (!cfg) {
    return new Response(
      JSON.stringify({
        error: `Airline not tracked. Tracked: ${publicHubAirlines.map((a) => a.iata).join(", ")}`,
      }),
      { status: 200, headers: SECURITY_HEADERS.api }
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

  // No QR branch here: QR is publicInHub:false, so detectAirline(flightNumber,
  // publicHubAirlines) above never returns QR. QR-specific check-flight is
  // served only by the per-host /api/check-flight on qatarstarlinktracker.com.

  const normalized = ensureAirlinePrefix(cfg, flightNumber);
  const variants = buildAirlineFlightNumberVariants(cfg, normalized);
  const matching = reader.getFlightsByNumberAndDateForAirline(
    variants,
    startOfDay,
    endOfDay,
    cfg.code
  );

  if (matching.length > 0) {
    const f = matching[0];
    return new Response(
      JSON.stringify({
        hasStarlink: true,
        airline: cfg.name,
        confidence: f.verified_wifi === "Starlink" ? "verified" : "likely",
        reason: `${f.tail_number} (${f.aircraft_type}) — ${f.departure_airport} → ${f.arrival_airport}`,
        flights: matching.map((m) => ({
          tail_number: m.tail_number,
          aircraft_type: m.aircraft_type,
          departure_airport: m.departure_airport,
          arrival_airport: m.arrival_airport,
          departure_time: m.departure_time,
        })),
      }),
      { headers: SECURITY_HEADERS.api }
    );
  }

  if (cfg.routeTypeRule) {
    return new Response(
      JSON.stringify({
        hasStarlink: null,
        airline: cfg.name,
        confidence: "type",
        reason: `No schedule data; ${cfg.name} Starlink status is type-determined — check the aircraft type on your booking.`,
      }),
      { headers: SECURITY_HEADERS.api }
    );
  }

  // No schedule row and no type rule — fall back to historical probability
  // rather than a confident "No Starlink" (upcoming_flights only covers ~47h).
  const pred = predictFlight(getReader(cfg.code), normalized);
  return new Response(
    JSON.stringify({
      hasStarlink: null,
      airline: cfg.name,
      probability: pred.probability,
      confidence: pred.confidence,
      reason:
        pred.n_observations > 0
          ? `No schedule data for this date; ~${Math.round(pred.probability * 100)}% based on ${pred.n_observations} historical observation${pred.n_observations === 1 ? "" : "s"}.`
          : `No schedule data for this date; ~${Math.round(pred.probability * 100)}% based on ${cfg.name} fleet rollout rate.`,
    }),
    { headers: SECURITY_HEADERS.api }
  );
};

const apiCompareRoute: Handler = ({ req, url, reader, tenant }) => {
  if (req.method !== "GET") return methodNotAllowed(true);
  const guard = hubOnly(tenant);
  if (guard) return guard;

  const origin = url.searchParams.get("origin");
  const destination = url.searchParams.get("destination");
  if (!origin || !destination || origin.length !== 3 || destination.length !== 3) {
    return new Response(
      JSON.stringify({ error: "origin and destination must be 3-letter IATA codes" }),
      { status: 400, headers: SECURITY_HEADERS.api }
    );
  }

  const results = compareRoute(reader, origin, destination);
  return new Response(
    JSON.stringify({
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      results,
    }),
    { headers: SECURITY_HEADERS.api }
  );
};

const apiPredictFlight: Handler = ({ req, url, reader, tenant }) => {
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
  const pred = predictFlight(reader, ensureAirlinePrefix(cfg, flightNumber));
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

const apiPlanRoute: Handler = ({ req, url, reader }) => {
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
  const itineraries = planItinerary(reader, origin, destination, { maxItineraries: 12, maxStops });
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
  const { req, getReader, site, tenant } = ctx;
  const accept = req.headers.get("accept") || "";
  if (req.method === "GET" && accept.includes("text/html")) {
    if (!site.features.mcpPage) {
      return new Response(getNotFoundHtml(site.brand), {
        status: 404,
        headers: SECURITY_HEADERS.notFound,
      });
    }
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
  return handleMcpRequest(req, tenantScope(tenant), getReader, site.analytics);
};

// ─────────────────────────────────────────────────────────────────────────────
// SEO / text routes
// ─────────────────────────────────────────────────────────────────────────────

const robotsTxt: Handler = ({ site }) => {
  return new Response(
    `User-agent: GPTBot
Allow: /
Disallow: /api/
Disallow: /mcp
Disallow: /debug/

User-agent: ClaudeBot
Allow: /
Disallow: /api/
Disallow: /mcp
Disallow: /debug/

User-agent: PerplexityBot
Allow: /
Disallow: /api/
Disallow: /mcp
Disallow: /debug/

User-agent: *
Allow: /
Disallow: /api/
Disallow: /mcp
Disallow: /debug/

Sitemap: https://${site.canonicalHost}/sitemap.xml`,
    { headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" } }
  );
};

const sitemap: Handler = ({ reader, site }) => {
  const baseUrl = `https://${site.canonicalHost}`;
  const lastUpdated = reader.getLastUpdated();
  const entries = [
    { path: "/", changefreq: "hourly", priority: "1.0", lastmod: lastUpdated },
    ...(site.features.checkFlightPage
      ? [{ path: "/check-flight", changefreq: "weekly", priority: "0.8" }]
      : []),
    ...(site.features.routePlannerPage
      ? [{ path: "/route-planner", changefreq: "weekly", priority: "0.8" }]
      : []),
    ...(site.features.fleetPage ? [{ path: "/fleet", changefreq: "daily", priority: "0.7" }] : []),
    ...(site.features.mcpPage ? [{ path: "/mcp", changefreq: "monthly", priority: "0.6" }] : []),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (entry) => `  <url>
    <loc>${baseUrl}${entry.path}</loc>
    <lastmod>${entry.lastmod ? new Date(entry.lastmod).toISOString() : new Date().toISOString()}</lastmod>
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
  });
};

const llmsTxt: Handler = ({ site, tenant }) => {
  const cfg = tenantConfig(tenant);
  const brand = site.brand;
  const host = site.canonicalHost;
  const name = cfg?.name ?? "major airlines";
  const isHub = tenant === "ALL";

  const homepage = `- [Homepage](https://${host}/): Live tracker with all Starlink-equipped aircraft, fleet statistics, search by tail number/flight number/route`;
  const apiData = `- [API - Fleet Data](https://${host}/api/data): Full JSON dataset of all Starlink-equipped aircraft and flights`;
  const tenantPages = [
    ...(cfg && site.features.checkFlightPage
      ? [
          `- [Check a Flight](https://${host}/check-flight): Check if a specific ${cfg.name} flight has Starlink WiFi by flight number and date. Falls back to probability estimate for future flights.`,
        ]
      : []),
    ...(cfg && site.features.routePlannerPage
      ? [
          `- [Route Planner](https://${host}/route-planner): Find the best routing (direct or 1-stop) to maximize Starlink coverage. Ranks itineraries by probability.`,
        ]
      : []),
    ...(site.features.fleetPage
      ? [
          `- [Fleet Rollout](https://${host}/fleet): See all ${cfg?.name ?? "tracked-airline"} aircraft colored by WiFi provider.`,
        ]
      : []),
    ...(cfg
      ? [
          `- [API - Check Flight](https://${host}/api/check-flight?flight_number=${cfg.iata}123&date=2026-01-22): JSON API to check Starlink status for a specific flight`,
          `- [API - Predict Flight](https://${host}/api/predict-flight?flight_number=${cfg.iata}4680): Probability estimate based on historical observations`,
          `- [API - Plan Route](https://${host}/api/plan-route?origin=SFO&destination=JAX): Full/partial coverage itinerary search`,
        ]
      : [
          `- [API - Check Any Flight](https://${host}/api/check-any-flight?flight_number=UA123&date=2026-01-22): Check Starlink status for a flight on any tracked airline`,
          `- [API - Compare Route](https://${host}/api/compare-route?origin=SFO&destination=HNL): Per-airline Starlink probability for a city pair`,
        ]),
  ];
  const pages = [homepage, ...tenantPages, apiData];
  const mcpSection = site.features.mcpPage
    ? `\n## MCP Server (for AI assistants)\n\n- [MCP Docs & Setup](https://${host}/mcp): Setup instructions for Claude Desktop, Cursor, and other MCP clients\n- [MCP Endpoint](https://${host}/mcp): Model Context Protocol server (POST with application/json). Tools: check_flight, predict_flight_starlink, plan_starlink_itinerary, predict_route_starlink, get_fleet_stats, list_starlink_aircraft, search_starlink_flights. Transport: streamable HTTP (stateless).\n`
    : "";
  const chromeSection =
    site.features.chromeExtension && cfg?.code === "UA"
      ? "\n## Chrome Extension\n\n- [Google Flights Starlink Indicator](https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi): Free Chrome extension that shows Starlink badges on Google Flights search results\n"
      : "";

  return new Response(
    `# ${brand.title}

> ${brand.description}

${isHub ? "Per-aircraft Starlink WiFi status across multiple airlines." : `Tracks the ${name} Starlink WiFi rollout in real time, showing which aircraft have been equipped and their upcoming flight schedules.`} The service is free for all passengers with speeds up to 250 Mbps.

## Pages

${pages.join("\n")}${mcpSection}${chromeSection}`,
    {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// HTML page handlers
// ─────────────────────────────────────────────────────────────────────────────

function buildBaseTemplateVars(ctx: RequestContext, reactHtml: string): Record<string, string> {
  const { reader, site } = ctx;
  const brand = site.brand;

  const fleetStats = reader.getFleetStats();
  const totalCount = reader.getTotalCount();
  const starlinkCount = reader.getStarlinkPlanes().length;
  const percentage = totalCount > 0 ? ((starlinkCount / totalCount) * 100).toFixed(2) : "0.00";
  const isoDate = new Date().toISOString();

  return {
    ...brandMetadata(brand),
    html: reactHtml,
    host: site.canonicalHost,
    totalCount: starlinkCount.toString(),
    totalAircraftCount: totalCount.toString(),
    lastUpdated: reader.getLastUpdated(),
    currentDate: new Date().toLocaleDateString(),
    isoDate,
    mainlineCount: (fleetStats?.mainline.starlink || 0).toString(),
    expressCount: (fleetStats?.express.starlink || 0).toString(),
    percentage,
    mainlinePercentage: (fleetStats?.mainline.percentage || 0).toFixed(2),
    expressPercentage: (fleetStats?.express.percentage || 0).toFixed(2),
    analyticsSnippet: analyticsSnippet(site),
    headSnippet: site.headSnippet ?? "",
    webSiteJsonLd: siteWebJsonLd(site),
    webPageJsonLd: sitePageJsonLd(site, isoDate),
    chromeExtensionJsonLd: chromeExtensionJsonLd(site),
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
  const reactHtml = ReactDOMServer.renderToString(
    React.createElement(component, { brand: ctx.site.brand, site: ctx.site, ...(props ?? {}) } as P)
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

function subPageMeta(
  ctx: RequestContext,
  page: "check-flight" | "route-planner" | "fleet"
): PageMeta {
  const tenant = ctx.tenant;
  const cfg = tenantConfig(tenant);
  const brand = ctx.site.brand;
  const name = cfg?.name ?? "tracked airlines";
  const short = cfg?.name ?? "Tracked Fleets";
  if (page === "check-flight")
    return {
      siteTitle: `Check If Your ${short} Flight Has Starlink WiFi | ${brand.title}`,
      siteDescription: `Enter your ${name} flight number and date to check if your aircraft has free Starlink WiFi. Instant results from our live database — or a probability estimate if your flight is more than 2 days out.`,
      keywords: `check ${cfg?.iata ?? "airline"} flight starlink, does my flight have starlink, starlink checker, ${name} wifi check`,
      ogTitle: `Check If Your ${short} Flight Has Starlink WiFi`,
      ogDescription: `Enter your flight number and date to check if your ${name} aircraft has free Starlink WiFi.`,
    };
  if (page === "route-planner")
    return {
      siteTitle: `Starlink Route Planner — Find ${short} Flights With Starlink WiFi`,
      siteDescription: `Find the best way to fly ${name} with Starlink WiFi. Compare direct flights and smart connections ranked by Starlink probability. Plan productive travel with full-coverage routings.`,
      keywords: `starlink route planner, best route for starlink, plan starlink trip, ${name} starlink connections`,
      ogTitle: `Starlink Route Planner — ${short}`,
      ogDescription:
        "Find direct flights and smart connections with the highest Starlink probability.",
    };
  return {
    siteTitle: `${short} Fleet Starlink Rollout — Every Tail Number, Every WiFi Provider`,
    siteDescription: `See every ${name} aircraft at once, colored by WiFi provider. Track which aircraft types are done and how many Starlink planes are in the air right now.`,
    keywords: `${name} fleet starlink, wifi by aircraft, starlink rollout progress, tail number wifi`,
    ogTitle: `${short} Fleet Starlink Rollout`,
    ogDescription: `Every ${name} tail number, colored by WiFi provider.`,
  };
}

const checkFlightPage: Handler = (ctx) => {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return methodNotAllowed();
  if (!ctx.site.features.checkFlightPage) {
    return new Response(getNotFoundHtml(ctx.site.brand), {
      status: 404,
      headers: SECURITY_HEADERS.notFound,
    });
  }
  return renderSubPage(ctx, CheckFlightPage, "/check-flight", subPageMeta(ctx, "check-flight"));
};

const routePlannerPage: Handler = (ctx) => {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return methodNotAllowed();
  if (!ctx.site.features.routePlannerPage) {
    return new Response(getNotFoundHtml(ctx.site.brand), {
      status: 404,
      headers: SECURITY_HEADERS.notFound,
    });
  }
  return renderSubPage(ctx, RoutePlannerPage, "/route-planner", subPageMeta(ctx, "route-planner"));
};

const fleetPage: Handler = (ctx) => {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") return methodNotAllowed();
  if (!ctx.site.features.fleetPage) {
    return new Response(getNotFoundHtml(ctx.site.brand), {
      status: 404,
      headers: SECURITY_HEADERS.notFound,
    });
  }
  const data = ctx.reader.getFleetPageData();
  return renderSubPage(ctx, FleetPage, "/fleet", subPageMeta(ctx, "fleet"), { data });
};

const homePage: Handler = async (ctx) => {
  const { req, reader, tenant, site } = ctx;
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed();
  const content = getContent(tenant);

  const allFlights = reader.getUpcomingFlights();
  const flightsByTail: Record<string, Flight[]> = {};
  for (const flight of allFlights) {
    if (!flightsByTail[flight.tail_number]) flightsByTail[flight.tail_number] = [];
    flightsByTail[flight.tail_number].push(flight);
  }

  const isHub = tenant === "ALL";
  const reactHtml = ReactDOMServer.renderToString(
    React.createElement(Page, {
      total: reader.getTotalCount(),
      starlink: reader.getStarlinkPlanes(),
      lastUpdated: reader.getLastUpdated(),
      fleetStats: reader.getFleetStats(),
      brand: site.brand,
      site,
      content,
      airlineByTail: reader.getAirlineByTail(),
      perAirlineStats: isHub ? reader.getPerAirlineStats() : undefined,
      recentInstalls: isHub ? reader.getRecentInstalls(25) : undefined,
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

const staticDir: Handler = ({ url, site }) => {
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
  return new Response(getNotFoundHtml(site.brand), {
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

// Per-IP sliding-window rate limit for /api/* paths. Tuned well above real
// usage (Chrome extension on a busy Google Flights page bursts ~20-30; humans
// hit 2-5). Catches bulk scrapers without ever touching a real traveler.
const API_RATE_LIMIT = 60;
const API_RATE_WINDOW_MS = 60_000;
const LOCAL_IPS = new Set(["127.0.0.1", "::1", "localhost"]);

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

export function createApp(db: Database): App {
  const getReader = createReaderFactory(db);
  const ipHits = new Map<string, number[]>();
  let lastSweep = 0;

  function rateLimited(ip: string, now: number): boolean {
    if (LOCAL_IPS.has(ip)) return false;
    if (now - lastSweep > API_RATE_WINDOW_MS) {
      for (const [k, ts] of ipHits) {
        const kept = ts.filter((t) => now - t < API_RATE_WINDOW_MS);
        if (kept.length === 0) ipHits.delete(k);
        else ipHits.set(k, kept);
      }
      lastSweep = now;
    }
    const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < API_RATE_WINDOW_MS);
    if (hits.length >= API_RATE_LIMIT) {
      ipHits.set(ip, hits);
      return true;
    }
    hits.push(now);
    ipHits.set(ip, hits);
    return false;
  }

  const routes: RouteTable = {
    "/": homePage,
    "/check-flight": checkFlightPage,
    "/route-planner": routePlannerPage,
    "/fleet": fleetPage,
    "/api/data": apiData,
    "/api/check-flight": apiCheckFlight,
    "/api/check-any-flight": apiCheckAnyFlight,
    "/api/compare-route": apiCompareRoute,
    "/api/predict-flight": apiPredictFlight,
    "/api/plan-route": apiPlanRoute,
    "/api/mismatches": apiMismatches,
    "/api/fleet-discovery": apiFleetDiscovery,
    "/mcp": mcp,
    "/robots.txt": robotsTxt,
    "/llms.txt": llmsTxt,
    "/sitemap.xml": sitemap,
    "/site.webmanifest": ({ site }) => siteManifest(site),
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

    const site = resolveSite(req.headers.get("host"));
    if (site === null) {
      return new Response("Misdirected Request", {
        status: 421,
        headers: { "Content-Type": "text/plain" },
      });
    }
    const tenant = site.scope === "ALL" ? "ALL" : AIRLINES[site.scope];

    const m = match(url.pathname);
    const route = m?.route ?? "/*";

    if (url.pathname.startsWith("/api/")) {
      const ip = clientIp(req);
      if (rateLimited(ip, Date.now())) {
        metrics.increment(COUNTERS.HTTP_RATE_LIMITED, { route, tenant: tenantScope(tenant) });
        return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
          status: 429,
          headers: { ...SECURITY_HEADERS.api, "Retry-After": "60" },
        });
      }
    }

    const reader: ScopedReader = getReader(tenantScope(tenant));
    const ctx: RequestContext = { req, url, site, tenant, reader, getReader };

    return withSpan(
      "http.request",
      async (span) => {
        span.setTag("http.method", req.method);
        span.setTag("http.route", route);
        span.setTag("tenant", tenantScope(tenant));

        const response = m
          ? await m.handler(ctx)
          : new Response(getNotFoundHtml(site.brand), {
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
