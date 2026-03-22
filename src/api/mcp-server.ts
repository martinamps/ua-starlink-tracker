/**
 * MCP (Model Context Protocol) Streamable HTTP Server
 *
 * Stateless, tools-only implementation — no SDK required.
 * Exposes Starlink tracker data to AI assistants via the standard MCP protocol.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 *
 * Connect from any MCP client with:
 *   { "url": "https://unitedstarlinktracker.com/mcp", "transport": "http" }
 */

import type { Database } from "bun:sqlite";
import {
  getFleetStats,
  getLastUpdated,
  getStarlinkPlanes,
  getTotalCount,
  getUpcomingFlights,
} from "../database/database";
import { planItinerary, predictFlight, predictRoute } from "../scripts/starlink-predictor";
import type { Flight } from "../types";
import {
  buildFlightNumberVariants,
  ensureUAPrefix,
  inferFleet,
  normalizeFlightNumber,
} from "../utils/constants";
import { debug, info } from "../utils/logger";
import { FlightRadar24API } from "./flightradar24-api";

// Protocol versions we support (newest first)
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

// Plausible server-side event tracking (client-side JS won't fire for API calls)
const PLAUSIBLE_URL = "https://analytics.martinamps.com/api/event";
const PLAUSIBLE_DOMAIN = "unitedstarlinktracker.com";

/**
 * Fire-and-forget Plausible event. Never awaited — analytics must not
 * block or fail MCP responses.
 *
 * Uses a custom "MCP" goal with props so you can break down by tool in the
 * Plausible dashboard (Behaviors → Goal Conversions → MCP → props).
 */
function trackMcpEvent(req: Request, props: { method: string; tool?: string }): void {
  // Forward the client's UA and IP so Plausible can do bot filtering and
  // unique-visitor counting as if this were a page view.
  const ua = req.headers.get("user-agent") || "mcp-client/unknown";
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "";

  fetch(PLAUSIBLE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": ua,
      ...(ip ? { "X-Forwarded-For": ip } : {}),
    },
    body: JSON.stringify({
      name: "MCP",
      url: `https://${PLAUSIBLE_DOMAIN}/mcp`,
      domain: PLAUSIBLE_DOMAIN,
      props,
    }),
  }).catch((err) => {
    debug(`Plausible event failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  });
}

// ============================================================================
// JSON-RPC types
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// MCP tool result content block
type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

// ============================================================================
// Tool definitions (JSON Schema 2020-12)
// ============================================================================

const TOOLS = [
  {
    name: "check_flight",
    description:
      "Check whether a specific United Airlines flight has Starlink WiFi on a given date. " +
      "Returns FIRM YES if assigned to a verified-Starlink plane, FIRM NO if assigned to a " +
      "verified non-Starlink plane, or a probability estimate if no assignment exists yet " +
      "(aircraft assignments are only published ~2 days in advance). For dates further out, " +
      "call predict_flight_starlink directly — check_flight would just fall through to the same " +
      "probability estimate with extra latency.",
    inputSchema: {
      type: "object",
      properties: {
        flight_number: {
          type: "string",
          description:
            "United flight number, e.g. 'UA544' or just '544'. Also accepts operating-carrier " +
            "codes like SKW5212, OO4680, UAL544.",
        },
        date: {
          type: "string",
          description: "Flight date in YYYY-MM-DD format (matched as UTC calendar day).",
        },
      },
      required: ["flight_number", "date"],
    },
  },
  {
    name: "get_fleet_stats",
    description:
      "Get current United Airlines Starlink installation statistics: how many aircraft have " +
      "Starlink across mainline and express fleets, with percentages. Use for overall rollout " +
      "questions ('how far along is Starlink?'), not for per-flight checks.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_starlink_aircraft",
    description:
      "List United Airlines aircraft currently equipped with Starlink WiFi " +
      "(default: 50 most recent; pass limit up to 500). Returns tail numbers, aircraft types, " +
      "operators, and install date. Use when the question is about the planes themselves " +
      "(tail numbers, aircraft types), not for finding flights.",
    inputSchema: {
      type: "object",
      properties: {
        fleet: {
          type: "string",
          enum: ["express", "mainline"],
          description: "Filter to only express (regional) or mainline aircraft.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum number of aircraft to return (default 50).",
        },
      },
    },
  },
  {
    name: "predict_flight_starlink",
    description:
      "Predict the PROBABILITY that a United flight number gets a Starlink plane — based on " +
      "12,000+ historical observations. Reliability varies: high-confidence (5+ obs) ~85%+ " +
      "accurate; low-confidence (0-1 obs) is just the fleet prior. UA1-2999 (mainline) are " +
      "almost always NOT Starlink (~2% fleet coverage).",
    inputSchema: {
      type: "object",
      properties: {
        flight_number: {
          type: "string",
          description:
            "United flight number, e.g. 'UA4680' or '4680'. Also accepts operating-carrier " +
            "codes (SKW5212, OO4680).",
        },
        date: {
          type: "string",
          description:
            "Optional YYYY-MM-DD. ALWAYS PASS if known — the probability is date-agnostic, " +
            "but when the result is low (<20%) the tool uses this date to look up the actual " +
            "route and returns a ready-to-run plan_starlink_itinerary call with origin/dest " +
            "pre-filled, so alternatives can be presented in one turn.",
        },
      },
      required: ["flight_number"],
    },
  },
  {
    name: "plan_starlink_itinerary",
    description:
      "PRIMARY TRAVEL-PLANNING TOOL — use first for any 'routing to X with Starlink' question. " +
      "Multi-stop search (up to 2 stops default, 3 max) ranked by COVERAGE RATIO (expected " +
      "Starlink hours / total flight hours) — a 92% 1h direct scores the same as a 92% 10h " +
      "multi-stop. Direct flights always shown first. Returns probability-ranked routings, NOT " +
      "bookable itineraries — connection timing isn't validated; verify on united.com.",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: "Origin airport IATA code (e.g. 'SFO').",
        },
        destination: {
          type: "string",
          description: "Destination airport IATA code (e.g. 'JAX').",
        },
        max_stops: {
          type: "integer",
          minimum: 0,
          maximum: 3,
          description:
            "Maximum number of connection stops (default 2, max 3). 0=direct only, 1=one connection, etc.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description:
            "Maximum number of full-coverage itineraries (default 8). Up to 3 partial baselines may be appended.",
        },
        date: {
          type: "string",
          description:
            "Optional YYYY-MM-DD travel date. When within ~2 days (the aircraft-assignment " +
            "window), uses confirmed tail assignments for higher accuracy. Beyond that, uses " +
            "historical prediction only — confirmed assignments don't apply to future dates.",
        },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "predict_route_starlink",
    description:
      "Single-route lookup: find which United flight numbers on a route (or touching an " +
      "airport) are most likely to have Starlink. Pass both origin+destination for a specific " +
      "route, OR just one to list all Starlink flights from/into an airport. Returns ranked " +
      "list with probability per flight number. For trip planning with connections, use " +
      "plan_starlink_itinerary instead — this tool has no connection logic or coverage-ratio " +
      "ranking. Empty result = route not served by Starlink planes.",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: "Origin airport IATA code (e.g. 'SFO', 'ORD'). Case-insensitive.",
        },
        destination: {
          type: "string",
          description: "Destination airport IATA code (e.g. 'EWR', 'DEN'). Case-insensitive.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of flight numbers to return (default 10).",
        },
      },
      anyOf: [{ required: ["origin"] }, { required: ["destination"] }],
    },
  },
  {
    name: "search_starlink_flights",
    description:
      "Search CONFIRMED Starlink flights in the next ~2 days — firm schedule, not prediction. " +
      "Aircraft assignments aren't published further out, so for later dates use " +
      "predict_route_starlink or plan_starlink_itinerary instead. Example: 'what confirmed " +
      "Starlink flights leave ORD tomorrow?'",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: "Origin airport IATA code (e.g. 'SFO', 'ORD'). Case-insensitive.",
        },
        destination: {
          type: "string",
          description: "Destination airport IATA code (e.g. 'LAX', 'DEN'). Case-insensitive.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of flights to return (default 20).",
        },
      },
      anyOf: [{ required: ["origin"] }, { required: ["destination"] }],
    },
  },
] as const;

// ============================================================================
// Tool implementations
// ============================================================================

async function toolCheckFlight(
  db: Database,
  args: { flight_number?: unknown; date?: unknown }
): Promise<ToolResult> {
  const flightNumber = typeof args.flight_number === "string" ? args.flight_number.trim() : "";
  const date = typeof args.date === "string" ? args.date.trim() : "";

  if (!flightNumber || !date) {
    return {
      content: [{ type: "text", text: "Error: flight_number and date are required." }],
      isError: true,
    };
  }

  const dateObj = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dateObj.getTime())) {
    return {
      content: [{ type: "text", text: "Error: invalid date format. Use YYYY-MM-DD." }],
      isError: true,
    };
  }

  const startOfDay = Math.floor(dateObj.getTime() / 1000);
  const endOfDay = startOfDay + 86400;
  const now = Math.floor(Date.now() / 1000);

  const normalized = ensureUAPrefix(flightNumber);
  const numPart = normalized.match(/(\d+)$/)?.[1];
  if (numPart && numPart.length > 4) {
    return {
      content: [
        {
          type: "text",
          text: `${normalized} is outside United's flight number range (UA1-UA9999). This flight likely doesn't exist.`,
        },
      ],
      isError: true,
    };
  }

  const variants = buildFlightNumberVariants(normalized);
  const placeholders = variants.map(() => "?").join(",");

  // All assignments we have for this flight on this date, with verified_wifi status.
  // We track flights only for planes in starlink_planes, so every row here is at
  // least "spreadsheet says Starlink" — but verified_wifi may say otherwise.
  const assignments = db
    .query(
      `SELECT uf.*, sp.Aircraft as aircraft_type, sp.OperatedBy, sp.fleet, sp.verified_wifi
       FROM upcoming_flights uf
       INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
       WHERE uf.flight_number IN (${placeholders})
         AND uf.departure_time >= ? AND uf.departure_time < ?
       ORDER BY uf.last_updated DESC`
    )
    .all(...variants, startOfDay, endOfDay) as Array<
    Flight & {
      aircraft_type: string;
      OperatedBy: string;
      fleet: string;
      verified_wifi: string | null;
    }
  >;

  // Dedupe by (departure_time) — stale cache can have two tails for same departure
  // after an aircraft swap. Keep the most-recently-updated row (query is DESC).
  const seen = new Set<number>();
  const deduped = assignments.filter((a) => {
    if (seen.has(a.departure_time)) return false;
    seen.add(a.departure_time);
    return true;
  });

  // Verified-Starlink: united.com confirmed. Unverified: in spreadsheet but
  // verified_wifi is NULL (never checked). Different confidence levels.
  const verified = deduped.filter((f) => f.verified_wifi === "Starlink");
  const unverified = deduped.filter((f) => f.verified_wifi === null);
  const nonStarlink = deduped.filter(
    (f) => f.verified_wifi !== null && f.verified_wifi !== "Starlink"
  );

  const renderAssignment = (f: (typeof deduped)[number]): string => {
    const dep = new Date(f.departure_time * 1000).toISOString();
    const arr = new Date(f.arrival_time * 1000).toISOString();
    const ac = f.aircraft_type || "aircraft";
    return `- ${normalizeFlightNumber(f.flight_number)} (${f.departure_airport}→${f.arrival_airport}) on ${ac} tail ${f.tail_number}, operated by ${f.OperatedBy}. Departs ${dep}, arrives ${arr}.`;
  };

  // Firm YES: assigned to a united.com-verified Starlink tail
  if (verified.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `✈️ Yes! Flight ${normalized} on ${date} is scheduled on a verified Starlink aircraft:\n\n${verified.map(renderAssignment).join("\n")}\n\nStarlink WiFi is free on all equipped United flights.`,
        },
      ],
    };
  }

  // Likely YES: spreadsheet says Starlink but not yet confirmed on united.com.
  // Spreadsheet is usually right (~80-90%) but not a firm answer.
  if (unverified.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `Likely yes — ${normalized} on ${date} is assigned to a tail tracked as Starlink in the fleet spreadsheet (not yet verified against united.com):\n\n${unverified.map(renderAssignment).join("\n")}\n\nSpreadsheet data is usually accurate but unverified. Check united.com or the flight status 24h out to confirm.`,
        },
      ],
    };
  }

  // Firm NO: we have an assignment but it's a non-Starlink plane. We also
  // already know the route from the assignment — no lookup needed.
  if (nonStarlink.length > 0) {
    const f = nonStarlink[0];
    const ac = f.aircraft_type || "aircraft";
    const altBlock = buildAlternativesBlock(
      db,
      [{ origin: f.departure_airport, destination: f.arrival_airport }],
      startOfDay + 43200
    );
    return {
      content: [
        {
          type: "text",
          text: `${altBlock}\n\n❌ No Starlink: ${normalized} on ${date} is assigned to tail ${f.tail_number} (${ac}), verified as ${f.verified_wifi} WiFi — NOT Starlink. Aircraft swaps can happen, but the assignment is currently firm.`,
        },
      ],
    };
  }

  // No assignment data at all — probability fallback. If low, look up the route
  // from FR24 (cached) so we can give the agent a concrete next step.
  const pred = predictFlight(db, normalized);
  const pct = (pred.probability * 100).toFixed(0);

  const isPast = endOfDay < now - 86400;
  const isNearTerm = startOfDay < now + 3 * 86400;
  const timing = isPast
    ? "This date is in the past; we don't retain historical assignments."
    : isNearTerm
      ? "No assignment published — this is unusual for a near-term flight. The tail may not be in our Starlink-tracked set yet."
      : "Check again 1-2 days before departure for a firm answer.";

  // Probability context FIRST, alternatives table LAST. Recency bias: the
  // agent's final impression is "here's the table to present", not "no data".
  const probLine = `**${normalized} on ${date}**: ~${pct}% Starlink probability ${pred.n_observations > 0 ? `(${pred.n_observations} historical obs)` : "(fleet install rate)"}. Aircraft assignment not yet published — that happens ~2 days out. ${timing}`;

  let altBlock = "";
  if (pred.probability < 0.2 && !isPast) {
    const routes = await lookupFlightRoutes(db, normalized, startOfDay + 43200);
    altBlock = `\n\n${buildAlternativesBlock(db, routes, startOfDay + 43200)}`;
  }

  return {
    content: [{ type: "text", text: `${probLine}${altBlock}` }],
  };
}

/**
 * Format confidence as a parenthetical qualifier — keeps it visually subordinate
 * to the probability number so they don't get mentally merged.
 * e.g. "92% (4 obs · medium confidence)" not "92% Likely — 4 obs, medium"
 */
function confidenceTag(nObs: number, confidence: string): string {
  return `(${nObs} obs · ${confidence} confidence)`;
}

// Single shared FR24 client for route lookups. Module-level state is fine for
// a long-lived server. Cache is best-effort — failures degrade to "ask the user".
const fr24 = new FlightRadar24API();
type RouteEntry = { origin: string; destination: string; duration_hours?: number };

// Promise-based cache: concurrent requests for the same key await the in-flight
// fetch instead of hammering FR24. Dedupes parallel calls (e.g. 15 agents at once).
const routeCache = new Map<string, { promise: Promise<RouteEntry[]>; at: number }>();
const ROUTE_CACHE_TTL = 3600;

async function lookupFlightRoutes(
  db: Database,
  uaFlightNumber: string,
  targetDateUnix?: number
): Promise<RouteEntry[]> {
  const cacheKey = `${uaFlightNumber}:${targetDateUnix ? Math.floor(targetDateUnix / 86400) : "any"}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = routeCache.get(cacheKey);
  if (cached && now - cached.at < ROUTE_CACHE_TTL) return cached.promise;

  const promise = (async (): Promise<RouteEntry[]> => {
    // L1: persistent SQLite cache (builds up over time, survives restarts).
    // Use if we have data fresher than 7 days.
    const sqliteCached = db
      .query(
        `SELECT origin, destination, duration_sec
         FROM flight_routes
         WHERE flight_number = ? AND last_seen_at > ?
         ORDER BY seen_count DESC`
      )
      .all(uaFlightNumber, now - 7 * 86400) as Array<{
      origin: string;
      destination: string;
      duration_sec: number | null;
    }>;
    if (sqliteCached.length > 0) {
      return sqliteCached.map((r) => ({
        origin: r.origin,
        destination: r.destination,
        duration_hours: r.duration_sec && r.duration_sec > 0 ? r.duration_sec / 3600 : undefined,
      }));
    }

    // L2: live FR24 lookup (best data, ~1wk forward). Persist result.
    try {
      const found = await fr24.getFlightRoutes(uaFlightNumber, targetDateUnix);
      if (found.length > 0) {
        const upsert = db.query(`
          INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
          VALUES (?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT (flight_number, origin, destination) DO UPDATE SET
            duration_sec = COALESCE(excluded.duration_sec, duration_sec),
            last_seen_at = excluded.last_seen_at,
            seen_count = seen_count + 1
        `);
        for (const r of found) {
          try {
            upsert.run(uaFlightNumber, r.origin, r.destination, r.duration_sec || null, now, now);
          } catch {
            // Readonly DB (e.g. tests) — skip persist, use result directly
          }
        }
        return found.map((r) => ({
          origin: r.origin,
          destination: r.destination,
          duration_hours: r.duration_sec > 0 ? r.duration_sec / 3600 : undefined,
        }));
      }
    } catch {
      // fall through to L3
    }

    // L3: our own upcoming_flights (sparse, ~2-day Starlink-plane snapshot)
    const variants = buildFlightNumberVariants(uaFlightNumber);
    const placeholders = variants.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT DISTINCT departure_airport, arrival_airport,
                AVG(arrival_time - departure_time) as dur_sec
         FROM upcoming_flights
         WHERE flight_number IN (${placeholders})
         GROUP BY departure_airport, arrival_airport
         LIMIT 3`
      )
      .all(...variants) as Array<{
      departure_airport: string;
      arrival_airport: string;
      dur_sec: number;
    }>;

    return rows.map((r) => ({
      origin: r.departure_airport,
      destination: r.arrival_airport,
      duration_hours: r.dur_sec > 0 ? r.dur_sec / 3600 : undefined,
    }));
  })();

  // Set immediately for in-flight dedup, but evict if the result is empty/error
  // so the next request retries instead of serving a cached [] for 1hr.
  routeCache.set(cacheKey, { promise, at: now });
  promise.then(
    (result) => {
      if (result.length === 0) routeCache.delete(cacheKey);
    },
    () => routeCache.delete(cacheKey)
  );
  return promise;
}

/**
 * Compact inline alternatives renderer. When check_flight/predict_flight_starlink
 * returns low probability, EMBED the actual alternative flights directly instead
 * of telling the agent to call another tool (which they don't reliably follow).
 * Calls planItinerary() for each route segment and returns top-2 per segment.
 * One tool call → complete answer.
 */
function buildAlternativesBlock(
  db: Database,
  routes: RouteEntry[],
  targetDateUnix?: number
): string {
  if (routes.length === 0) {
    return "**Starlink alternatives**: route lookup failed. Ask the person for origin/destination, then call plan_starlink_itinerary.";
  }

  const fmtH = (h: number) => (h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(h * 60)}m`);

  type Row = {
    segment: string;
    flights: string;
    via: string;
    stops: number;
    starlinkPct: string;
    starlinkH: string;
    totalH: string;
  };
  const rows: Row[] = [];

  for (const r of routes.slice(0, 3)) {
    const segment = `${r.origin}→${r.destination}`;
    const its = planItinerary(db, r.origin, r.destination, {
      maxStops: 2,
      maxItineraries: 2,
      targetDateUnix,
    });

    // Always show the direct as a baseline row for tradeoff context, even if
    // it's below the graph threshold. The person's ORIGINAL flight is almost
    // always the direct — they need to see "direct is 2% → connection gets you 76%"
    // to understand what they're trading. Only skip if the direct is already
    // in the planner results (i.e. it passed the threshold on its own).
    const directInResults = its.some((it) => it.via.length === 0);
    if (!directInResults) {
      // Direct not in graph (below threshold). Show it as a baseline so the
      // tradeoff is visible: "direct is 2%, connection gets you 76%".
      // Duration: try upcoming_flights first (has it if any Starlink plane has
      // flown the route), else use the FR24-supplied duration from the route
      // lookup itself.
      const directEdge = db
        .query(
          `SELECT flight_number, AVG(arrival_time - departure_time) as dur_sec
           FROM upcoming_flights
           WHERE departure_airport = ? AND arrival_airport = ?
           GROUP BY flight_number LIMIT 1`
        )
        .get(r.origin, r.destination) as { flight_number: string; dur_sec: number } | null;

      const directProb = directEdge
        ? predictFlight(db, ensureUAPrefix(directEdge.flight_number)).probability
        : 0.02;

      const durH = directEdge ? directEdge.dur_sec / 3600 : (r.duration_hours ?? null);
      rows.push({
        segment,
        flights: directEdge ? ensureUAPrefix(directEdge.flight_number) : "nonstop",
        via: "direct — baseline",
        stops: 0,
        starlinkPct: `~${(directProb * 100).toFixed(0)}%`,
        starlinkH: durH !== null ? fmtH(directProb * durH) : "~0",
        totalH: durH !== null ? fmtH(durH) : "—",
      });
    }

    if (its.length === 0) {
      // Direct baseline was added above; no connection options found either.
      continue;
    }

    for (const it of its.slice(0, 2)) {
      const legs = it.legs
        .filter((l) => l.flight_number !== "(any)")
        .map((l) => l.flight_number)
        .join(" + ");
      const via = it.via.length === 0 ? "direct" : it.via.join("→");

      if (it.expected_starlink_hours !== null && it.total_flight_hours !== null) {
        rows.push({
          segment,
          flights: legs,
          via,
          stops: it.via.length,
          starlinkPct: `${((it.coverage_ratio ?? 0) * 100).toFixed(0)}%`,
          starlinkH: fmtH(it.expected_starlink_hours),
          totalH: fmtH(it.total_flight_hours),
        });
      } else if (it.coverage === "partial") {
        const known = it.legs.reduce(
          (s, l) => (l.duration_hours !== null ? s + l.probability * l.duration_hours : s),
          0
        );
        rows.push({
          segment,
          flights: legs || "(positioning)",
          via,
          stops: it.via.length,
          starlinkPct: "partial",
          starlinkH: `~${fmtH(known)}`,
          totalH: "?",
        });
      }
    }
  }

  const tableRows = rows
    .map(
      (r) =>
        `| ${r.segment} | ${r.flights} | ${r.via} | ${r.stops} | ${r.starlinkPct} | ${r.starlinkH} | ${r.totalH} |`
    )
    .join("\n");

  const segmentNote =
    routes.length > 1
      ? " Both route segments are in the table — don't ask which one; the person knows."
      : "";

  // Structure: XML-style presentation block so the directive is unmissable,
  // then the table, then a minimal footer. No prose around the table that the
  // agent could grab-and-summarize instead of the table itself.
  return `<present_verbatim>
| Segment | Flights | Via | Stops | Starlink % | Starlink hrs | Total hrs |
|---|---|---|---|---|---|---|
${tableRows}
</present_verbatim>

Render the table above in your response EXACTLY — do not summarize it into prose, do not drop columns.${segmentNote} This is the complete answer: no more tool calls, no "download offline" / "use legacy WiFi" / "mobile hotspot" tips (non-responsive — they asked for better FLIGHTS). Verify timing on united.com before rebooking. Starlink % = coverage ratio (Starlink hrs / total hrs).`;
}

async function toolPredictFlightStarlink(
  db: Database,
  args: { flight_number?: unknown; date?: unknown }
): Promise<ToolResult> {
  const input = typeof args.flight_number === "string" ? args.flight_number.trim() : "";
  if (!input) {
    return {
      content: [{ type: "text", text: "Error: flight_number is required." }],
      isError: true,
    };
  }

  const forPredict = ensureUAPrefix(input);
  const numPart = forPredict.match(/\d+$/)?.[0];
  if (numPart && numPart.length > 4) {
    return {
      content: [
        {
          type: "text",
          text: `${forPredict} is outside United's flight number range (UA1-UA9999). This flight likely doesn't exist.`,
        },
      ],
      isError: true,
    };
  }

  const pred = predictFlight(db, forPredict);
  const pct = (pred.probability * 100).toFixed(0);

  let details: string;
  if (pred.method !== "flight_history_smoothed") {
    const fleet = inferFleet(forPredict);
    const fleetLabel = fleet === "express" ? "express (regional)" : "mainline";
    details = `${fleetLabel} fleet install rate — not flight-specific.`;
  } else {
    details =
      pred.n_observations >= 5 ? "Sample size is solid." : "Limited data — estimate may drift.";
  }

  const probLine = `**${forPredict}**: ~${pct}% Starlink probability ${pred.method === "flight_history_smoothed" ? confidenceTag(pred.n_observations, pred.confidence) : "(fleet prior)"}. ${details}`;

  // Alternatives LAST so it's the agent's final impression (recency bias).
  let altBlock = "";
  if (pred.probability < 0.2) {
    const date = typeof args.date === "string" ? args.date.trim() : "";
    const dateObj = date ? new Date(`${date}T12:00:00Z`) : null;
    const dateUnix =
      dateObj && !Number.isNaN(dateObj.getTime())
        ? Math.floor(dateObj.getTime() / 1000)
        : undefined;
    const routes = await lookupFlightRoutes(db, forPredict, dateUnix);
    altBlock = `\n\n${buildAlternativesBlock(db, routes, dateUnix)}`;
  }

  return { content: [{ type: "text", text: `${probLine}${altBlock}` }] };
}

function toolPlanStarlinkItinerary(
  db: Database,
  args: {
    origin?: unknown;
    destination?: unknown;
    max_results?: unknown;
    max_stops?: unknown;
    date?: unknown;
  }
): ToolResult {
  const origin = typeof args.origin === "string" ? args.origin.trim() : "";
  const destination = typeof args.destination === "string" ? args.destination.trim() : "";
  const maxResults =
    typeof args.max_results === "number" && args.max_results > 0
      ? Math.min(args.max_results, 20)
      : 8;
  const maxStops =
    typeof args.max_stops === "number" && args.max_stops >= 0 ? Math.min(args.max_stops, 3) : 2;

  // Optional date for confirmed-edge seeding. Without a date (or outside the
  // ~2-day snapshot window), the planner uses historical prediction only.
  const dateStr = typeof args.date === "string" ? args.date.trim() : "";
  const dateObj = dateStr ? new Date(`${dateStr}T12:00:00Z`) : null;
  const targetDateUnix =
    dateObj && !Number.isNaN(dateObj.getTime()) ? Math.floor(dateObj.getTime() / 1000) : undefined;

  if (!origin || !destination) {
    return {
      content: [{ type: "text", text: "Error: both origin and destination are required." }],
      isError: true,
    };
  }

  if (origin.toUpperCase() === destination.toUpperCase()) {
    return {
      content: [
        {
          type: "text",
          text: `Origin and destination are the same (${origin.toUpperCase()}). Please specify a different destination.`,
        },
      ],
      isError: true,
    };
  }

  const itineraries = planItinerary(db, origin, destination, {
    maxItineraries: maxResults,
    maxStops,
    targetDateUnix,
  });

  if (itineraries.length === 0) {
    const orig = origin.toUpperCase();
    const dest = destination.toUpperCase();
    return {
      content: [
        {
          type: "text",
          text: `No Starlink routings found from ${orig} to ${dest} within ${maxStops} stops.\n\nNo path through the Starlink route graph connects these airports. This may be a mainline-only route (~2% Starlink fleet-wide).\n\n**Fallbacks**: (1) \`search_starlink_flights\` with just \`destination="${dest}"\` or \`origin="${orig}"\` — confirmed near-term assignments may exist even when historical probability is low; (2) if the user has a specific flight, \`predict_flight_starlink\` for a per-flight estimate; (3) otherwise advise booking the nonstop — no Starlink routing meaningfully improves odds on mainline-only routes.`,
        },
      ],
    };
  }

  const fullItins = itineraries.filter((it) => it.coverage === "full");
  const partialItins = itineraries.filter((it) => it.coverage === "partial");

  const fmtHours = (h: number): string => {
    if (h >= 1) return `${h.toFixed(1)}h`;
    return `${Math.round(h * 60)}m`;
  };

  const renderLeg = (leg: (typeof itineraries)[number]["legs"][number]): string => {
    if (leg.flight_number === "(any)") {
      const [from, to] = leg.route.split("-");
      return `position ${from}→${to} (mainline, ~2% Starlink, duration unknown)`;
    }
    const pct = (leg.probability * 100).toFixed(0);
    const fleetTag = inferFleet(leg.flight_number) === "mainline" ? " [Mainline]" : "";
    const dur = leg.duration_hours !== null ? ` ~${fmtHours(leg.duration_hours)}` : "";
    const tag = leg.confirmed
      ? "(confirmed near-term assignment)"
      : confidenceTag(leg.n_observations, leg.confidence);
    return `${leg.flight_number}${fleetTag} (${leg.route}${dur}) — ${pct}% ${tag}`;
  };

  const renderItin = (it: (typeof itineraries)[number], i: number): string => {
    // One decimal so displayed ranking matches sort order
    const jointPct = (it.joint_probability * 100).toFixed(1);
    const stops = it.via.length;
    const viaLabel =
      stops === 0 ? "DIRECT" : `via ${it.via.join("→")} (${stops} stop${stops > 1 ? "s" : ""})`;

    // Time-aware summary — this is what users actually care about for tradeoffs
    let timeSummary: string;
    if (it.total_flight_hours !== null && it.expected_starlink_hours !== null) {
      const ratio = it.coverage_ratio !== null ? ` (${(it.coverage_ratio * 100).toFixed(0)}%)` : "";
      timeSummary = ` · **~${fmtHours(it.expected_starlink_hours)} Starlink** / ~${fmtHours(it.total_flight_hours)} flying${ratio}`;
    } else if (it.coverage === "partial") {
      const knownStarlink = it.legs.reduce(
        (s, l) => (l.duration_hours !== null ? s + l.probability * l.duration_hours : s),
        0
      );
      timeSummary = ` · ~${fmtHours(knownStarlink)} Starlink (positioning leg duration unknown)`;
    } else {
      timeSummary = "";
    }

    let header: string;
    if (it.coverage === "partial") {
      header = `${i + 1}. **${viaLabel}**${timeSummary}`;
    } else if (stops === 0) {
      header = `${i + 1}. **${viaLabel}** — ${jointPct}% Starlink${timeSummary}`;
    } else {
      header = `${i + 1}. **${viaLabel}** — ${jointPct}% joint${timeSummary}`;
    }

    const legLines = it.legs.map((l, idx) => `   · Leg ${idx + 1}: ${renderLeg(l)}`).join("\n");
    return `${header}\n${legLines}`;
  };

  const sections: string[] = [];
  if (fullItins.length > 0) {
    sections.push(`**Full Starlink coverage**:

${fullItins.map(renderItin).join("\n\n")}`);
  }
  if (partialItins.length > 0) {
    const header =
      fullItins.length === 0
        ? `**No all-Starlink path found within ${maxStops} stops.** Partial coverage options (one positioning leg ~2% Starlink, one Starlink leg):\n`
        : "**Baseline: 1-stop positioning + Starlink connection** (for comparison — what a 'normal' routing gets you):\n";
    sections.push(`${header}
${partialItins.map((it, i) => renderItin(it, fullItins.length + i)).join("\n\n")}`);
  }

  const hasMultiLeg = itineraries.some((it) => it.legs.length > 1);
  const timingNote = hasMultiLeg
    ? "\n\n⚠️ Connection timing NOT validated — verify legs actually connect same-day on united.com."
    : "";

  const text = `**Starlink routings: ${origin.toUpperCase()} → ${destination.toUpperCase()}**

${sections.join("\n\n---\n\n")}${timingNote}

**Ranking**: by coverage ratio (expected Starlink hours / total hours) — a 92% direct and a 92% multi-stop score the same. "~1.8h Starlink / ~7h flying (26%)" = 26% of flight time expected on Starlink. Compare the ratio, not raw hours.`;

  return { content: [{ type: "text", text }] };
}

function toolPredictRouteStarlink(
  db: Database,
  args: { origin?: unknown; destination?: unknown; limit?: unknown }
): ToolResult {
  const origin = typeof args.origin === "string" ? args.origin.trim() : undefined;
  const destination = typeof args.destination === "string" ? args.destination.trim() : undefined;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 50) : 10;

  if (!origin && !destination) {
    return {
      content: [
        { type: "text", text: "Error: at least one of origin or destination is required." },
      ],
      isError: true,
    };
  }

  const result = predictRoute(db, origin || null, destination || null);

  if (result.flights.length === 0) {
    // No DIRECT Starlink flights on this route. If both endpoints given,
    // inline the connection-based alternatives so the agent never sees a
    // dead-end that contradicts check_flight's embedded alternatives.
    if (origin && destination) {
      const alt = buildAlternativesBlock(db, [
        { origin: origin.toUpperCase(), destination: destination.toUpperCase() },
      ]);
      return {
        content: [
          {
            type: "text",
            text: `No DIRECT Starlink flight on ${origin.toUpperCase()}→${destination.toUpperCase()} — this tool only finds single-route flights. Connection-based alternatives below:\n\n${alt}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `${result.coverage_note}\n\nIf you have a specific flight number, try predict_flight_starlink for a fleet-prior estimate.`,
        },
      ],
    };
  }

  const shown = result.flights.slice(0, limit);
  const lines = shown.map((f) => {
    const pct = (f.probability * 100).toFixed(0);
    const fleet = inferFleet(f.flight_number);
    const fleetTag = fleet === "mainline" ? "[Mainline]" : "          "; // align columns
    // Distinguish "observed and confirmed 0%" from "unobserved (fleet prior)"
    const obsNote =
      f.n_observations === 0
        ? "(unobserved — fleet prior)"
        : confidenceTag(f.n_observations, f.confidence);
    return `  ${f.flight_number.padEnd(8)} ${fleetTag} (${f.route})  ${pct.padStart(3)}%  ${obsNote}`;
  });

  const routeDesc =
    result.origin && result.destination
      ? `${result.origin}→${result.destination}`
      : result.origin
        ? `from ${result.origin}`
        : `to ${result.destination}`;

  const text = `**Starlink probability ${routeDesc}** (ranked highest-first):

${lines.join("\n")}

${result.coverage_note}

Probability and confidence are independent: 92% with 4 obs (medium) is a *less certain* estimate than 79% with 10 obs (high), but still indicates higher Starlink likelihood.`;

  return { content: [{ type: "text", text }] };
}

function toolGetFleetStats(db: Database): ToolResult {
  const totalCount = getTotalCount(db);
  const starlinkPlanes = getStarlinkPlanes(db);
  const fleetStats = getFleetStats(db);
  const lastUpdated = getLastUpdated(db);

  const text = `United Airlines Starlink Installation Progress (as of ${lastUpdated}):

**Combined Fleet**: ${starlinkPlanes.length} of ${totalCount} aircraft (${totalCount > 0 ? ((starlinkPlanes.length / totalCount) * 100).toFixed(1) : "0.0"}%) have Starlink WiFi

**Express (Regional) Fleet**: ${fleetStats.express.starlink} of ${fleetStats.express.total} aircraft (${fleetStats.express.percentage.toFixed(1)}%)
**Mainline Fleet**: ${fleetStats.mainline.starlink} of ${fleetStats.mainline.total} aircraft (${fleetStats.mainline.percentage.toFixed(1)}%)

United began installing Starlink on March 7, 2025. The service offers free WiFi at speeds up to 250 Mbps. Installation continues at roughly 40+ aircraft per month.`;

  return { content: [{ type: "text", text }] };
}

function toolListStarlinkAircraft(
  db: Database,
  args: { fleet?: unknown; limit?: unknown }
): ToolResult {
  const fleet = args.fleet === "express" || args.fleet === "mainline" ? args.fleet : undefined;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 50;

  let planes = getStarlinkPlanes(db);
  if (fleet) {
    planes = planes.filter((p) => p.fleet === fleet);
  }

  const total = planes.length;
  const shown = planes.slice(0, limit);

  const lines = shown.map(
    (p) =>
      `${p.TailNumber} — ${p.Aircraft || "Unknown type"} (${p.fleet}, ${p.OperatedBy}, first seen ${p.DateFound})`
  );

  const header = fleet
    ? `${total} Starlink-equipped aircraft in United's ${fleet} fleet`
    : `${total} Starlink-equipped aircraft in United's fleet`;

  return {
    content: [
      {
        type: "text",
        text: `${header} (showing ${shown.length}):\n\n${lines.join("\n")}`,
      },
    ],
  };
}

function toolSearchStarlinkFlights(
  db: Database,
  args: { origin?: unknown; destination?: unknown; limit?: unknown }
): ToolResult {
  const origin = typeof args.origin === "string" ? args.origin.toUpperCase().trim() : undefined;
  const destination =
    typeof args.destination === "string" ? args.destination.toUpperCase().trim() : undefined;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 100) : 20;

  if (!origin && !destination) {
    return {
      content: [
        {
          type: "text",
          text: "Error: at least one of origin or destination must be provided.",
        },
      ],
      isError: true,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const starlinkTails = new Set(getStarlinkPlanes(db).map((p) => p.TailNumber));
  const allFuture = getUpcomingFlights(db).filter(
    (f) => f.departure_time > now && starlinkTails.has(f.tail_number)
  );

  // Data horizon from the UNFILTERED set — showing now() when the filtered result
  // is empty would wrongly imply we have zero forward data
  const latestDeparture =
    allFuture.length > 0 ? allFuture[allFuture.length - 1].departure_time : now;
  const dataHorizon = new Date(latestDeparture * 1000).toISOString().slice(0, 10);

  let flights = allFuture;
  if (origin) flights = flights.filter((f) => f.departure_airport.toUpperCase() === origin);
  if (destination) flights = flights.filter((f) => f.arrival_airport.toUpperCase() === destination);

  flights.sort((a, b) => a.departure_time - b.departure_time);
  const total = flights.length;
  const shown = flights.slice(0, limit);

  if (total === 0) {
    const routeDesc = origin && destination ? `${origin}→${destination}` : origin || destination;
    return {
      content: [
        {
          type: "text",
          text: `No confirmed Starlink flights found for ${routeDesc} in the next ~2 days.\n\nNote: this tool only sees confirmed assignments through ~${dataHorizon}. If you need dates beyond that, use predict_route_starlink or plan_starlink_itinerary for probability-based planning instead — absence from this tool does NOT mean no Starlink.`,
        },
      ],
    };
  }

  const lines = shown.map((f) => {
    const dep = new Date(f.departure_time * 1000).toISOString().slice(0, 16).replace("T", " ");
    return `${normalizeFlightNumber(f.flight_number)} ${f.departure_airport}→${f.arrival_airport} dep ${dep}Z (tail ${f.tail_number})`;
  });

  const routeDesc = origin && destination ? `${origin}→${destination}` : origin || destination;
  return {
    content: [
      {
        type: "text",
        text: `Found ${total} confirmed Starlink flight(s) for ${routeDesc} (showing ${shown.length}):\n\n${lines.join("\n")}\n\nSchedule data extends through ~${dataHorizon}. For dates beyond that, use predict_route_starlink or plan_starlink_itinerary.`,
      },
    ],
  };
}

// ============================================================================
// JSON-RPC dispatch
// ============================================================================

function rpcError(id: string | number | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function handleInitialize(
  db: Database,
  id: string | number | null,
  params: Record<string, unknown> | undefined
): JsonRpcResponse {
  const clientVersion =
    typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;

  // Echo the client's version if we support it, else our preferred
  const protocolVersion =
    clientVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)
      ? clientVersion
      : SUPPORTED_PROTOCOL_VERSIONS[0];

  // Include LIVE fleet stats in instructions so the agent has accurate priors
  // and doesn't hallucinate about mainline coverage (which is ~2%, not "decent").
  const fleetStats = getFleetStats(db);
  const expressPct = fleetStats.express.percentage.toFixed(0);
  const mainlinePct = fleetStats.mainline.percentage.toFixed(1);

  return rpcResult(id, {
    protocolVersion,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "united-starlink-tracker",
      version: "1.0.0",
    },
    instructions: `United Airlines Starlink tracker — UNITED ONLY. For other carriers (Delta, American, JetBlue, international), decline: this tracker has no data on them.

Fleet reality:
• Express/regional (UA3000-6999): ~${expressPct}% Starlink
• Mainline (UA1-2999, 737/787/etc): only ~${mainlinePct}% — assume NO Starlink on long-haul

Default assumption: people who install this connector want to MAXIMIZE Starlink hours and accept extra stops for it. When plan_starlink_itinerary returns a 2-stop with higher coverage, present it confidently — don't hedge toward the nonstop unless asked. Compare coverage ratio (expected Starlink hours / total hours), not leg percentages.

Tool selection:
• Routing/tradeoff → plan_starlink_itinerary (multi-stop, coverage ratio)
• Specific flight number → check_flight (≤2 days out) or predict_flight_starlink (further out, pass date)
• Route without flight number → predict_route_starlink
• search_starlink_flights = next ~2 days confirmed only

⚠️ Low/no Starlink flight: check_flight and predict_flight_starlink EMBED a markdown table of alternatives (route looked up + planItinerary run for you). RENDER THE TABLE — don't summarize it into prose, don't ask which segment (both are shown), don't re-call predict_route_starlink (only finds directs, misses the connections in the table), don't add "download offline" / "use legacy WiFi" / "mobile hotspot" tips (non-responsive — they asked for better FLIGHTS).

When a tool wraps content in <present_verbatim>...</present_verbatim>, copy that content into your response unchanged. This is a hard constraint, not a suggestion.`,
  });
}

async function handleToolsCall(
  db: Database,
  id: string | number | null,
  params: Record<string, unknown> | undefined
): Promise<JsonRpcResponse> {
  const toolName = typeof params?.name === "string" ? params.name : undefined;
  const args = (params?.arguments as Record<string, unknown>) || {};

  if (!toolName) {
    return rpcError(id, -32602, "Missing required param: name");
  }

  let result: ToolResult;
  switch (toolName) {
    case "check_flight":
      result = await toolCheckFlight(db, args);
      break;
    case "predict_flight_starlink":
      result = await toolPredictFlightStarlink(db, args);
      break;
    case "predict_route_starlink":
      result = toolPredictRouteStarlink(db, args);
      break;
    case "plan_starlink_itinerary":
      result = toolPlanStarlinkItinerary(db, args);
      break;
    case "get_fleet_stats":
      result = toolGetFleetStats(db);
      break;
    case "list_starlink_aircraft":
      result = toolListStarlinkAircraft(db, args);
      break;
    case "search_starlink_flights":
      result = toolSearchStarlinkFlights(db, args);
      break;
    default:
      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
  }

  return rpcResult(id, result);
}

async function dispatch(db: Database, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize":
      return handleInitialize(db, id, msg.params);
    case "notifications/initialized":
      return null;
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return handleToolsCall(db, id, msg.params);
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

// ============================================================================
// HTTP handler
// ============================================================================

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Handle an incoming MCP HTTP request.
 * Mount this at a single path (e.g. /mcp) in your Bun.serve router.
 */
export async function handleMcpRequest(req: Request, db: Database): Promise<Response> {
  // GET = open SSE stream for server→client push. We're stateless, no push.
  // DELETE = terminate session. We're stateless, no sessions.
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  // Validate Content-Type
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return new Response(
      JSON.stringify(rpcError(null, -32700, "Content-Type must be application/json")),
      { status: 415, headers: JSON_HEADERS }
    );
  }

  // Parse JSON body
  let msg: JsonRpcRequest;
  try {
    msg = await req.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error: invalid JSON")), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  // Validate JSON-RPC envelope
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return new Response(
      JSON.stringify(rpcError(msg.id ?? null, -32600, "Invalid Request: not JSON-RPC 2.0")),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  // Dispatch
  let response: JsonRpcResponse | null;
  try {
    response = await dispatch(db, msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    info(`MCP handler error: ${message}`);
    response = rpcError(msg.id ?? null, -32603, `Internal error: ${message}`);
  }

  // Track meaningful MCP usage in Plausible (skip ping & notifications — noise)
  if (msg.method === "initialize" || msg.method === "tools/list") {
    trackMcpEvent(req, { method: msg.method });
  } else if (msg.method === "tools/call") {
    const toolName = typeof msg.params?.name === "string" ? msg.params.name : "unknown";
    trackMcpEvent(req, { method: "tools/call", tool: toolName });
  }

  // Notification (no id) → 202 Accepted, empty body
  if (response === null) {
    return new Response(null, { status: 202 });
  }

  // Request → 200 OK with JSON-RPC response
  return new Response(JSON.stringify(response), { status: 200, headers: JSON_HEADERS });
}
