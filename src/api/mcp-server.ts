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
      "Check whether a specific United Airlines flight has Starlink WiFi on a given date — " +
      "FIRM answer from confirmed aircraft assignments (only reliable within ~2 days of departure). " +
      "If no firm assignment exists yet (flight too far out), automatically falls back to a " +
      "probability estimate. For comparing multiple future flight options, use predict_flight_starlink " +
      "or plan_starlink_itinerary instead.",
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
          description: "Flight date in YYYY-MM-DD format (local departure date).",
        },
      },
      required: ["flight_number", "date"],
    },
  },
  {
    name: "get_fleet_stats",
    description:
      "Get current United Airlines Starlink installation statistics: how many aircraft have " +
      "Starlink across mainline and express fleets, with percentages and last-updated time.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_starlink_aircraft",
    description:
      "List all United Airlines aircraft currently equipped with Starlink WiFi. " +
      "Optionally filter by fleet type or limit results. Returns tail numbers, aircraft types, " +
      "operators, and the date Starlink was first observed.",
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
      "12,000+ historical observations. Works for any date (not limited to ~2-day window). " +
      "Reliability varies: high-confidence (5+ obs) ~85%+ accurate; low-confidence (0-1 obs) " +
      "is just the fleet prior. Quick heuristic: UA3000-6999 (express/regional) have good odds " +
      "if history is positive; UA1-2999 (mainline) are almost always NOT Starlink (~2% fleet " +
      "coverage) regardless of what you might expect.",
    inputSchema: {
      type: "object",
      properties: {
        flight_number: {
          type: "string",
          description:
            "United flight number, e.g. 'UA4680' or '4680'. Express flights (UA3000-6999) " +
            "have good base rates when history is positive; mainline (UA1-2999) almost never " +
            "have Starlink (~2% fleet).",
        },
      },
      required: ["flight_number"],
    },
  },
  {
    name: "plan_starlink_itinerary",
    description:
      "PRIMARY TRAVEL-PLANNING TOOL — use first for any 'routing to X with Starlink' question. " +
      "Multi-stop graph search (up to 2 stops by default, 3 max) through the Starlink route " +
      "network, ranked by joint probability of ALL legs having Starlink. Finds paths like " +
      "SFO→SLC→IAH→JAX automatically. When no all-Starlink path exists, returns PARTIAL " +
      "coverage options (mainline positioning leg + Starlink connection legs).",
    inputSchema: {
      type: "object",
      properties: {
        origin: {
          type: "string",
          description: "Origin airport IATA code (e.g. 'SFO'). Required.",
        },
        destination: {
          type: "string",
          description: "Destination airport IATA code (e.g. 'JAX'). Required.",
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
          description: "Maximum number of itineraries to return (default 8).",
        },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "predict_route_starlink",
    description:
      "PRIMITIVE: Find which United flight numbers on a single direct route are most likely to have " +
      "Starlink. Returns a ranked list with probability for each flight number. For full trip planning " +
      "(including connections), prefer plan_starlink_itinerary. Use this primitive when you need " +
      "granular per-flight data for a specific leg, or when the user asks about a specific route " +
      "without caring about connections. An empty result means the route isn't served by Starlink " +
      "planes yet (near-zero probability).",
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
    },
  },
  {
    name: "search_starlink_flights",
    description:
      "Search CONFIRMED Starlink flights in the NEXT ~2 DAYS ONLY — this is a firm-schedule " +
      "lookup, not a prediction. Data does NOT extend beyond ~2 days (aircraft assignments " +
      "aren't published further out). For dates beyond that, DO NOT use this tool — use " +
      "predict_route_starlink or plan_starlink_itinerary for probability-based planning instead. " +
      "Use this for 'what confirmed Starlink flights leave ORD tomorrow?'",
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
    },
  },
] as const;

// ============================================================================
// Tool implementations
// ============================================================================

function toolCheckFlight(
  db: Database,
  args: { flight_number?: unknown; date?: unknown }
): ToolResult {
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

  // Build flight number variants (UA, UAL, express ICAO/IATA codes)
  const normalized = ensureUAPrefix(flightNumber);
  const variants = buildFlightNumberVariants(normalized);
  const placeholders = variants.map(() => "?").join(",");
  const flights = db
    .query(
      `SELECT uf.*, sp.Aircraft as aircraft_type, sp.OperatedBy, sp.fleet
       FROM upcoming_flights uf
       INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
       WHERE uf.flight_number IN (${placeholders})
         AND uf.departure_time >= ? AND uf.departure_time < ?
         AND (sp.verified_wifi IS NULL OR sp.verified_wifi = 'Starlink')
       ORDER BY uf.departure_time ASC`
    )
    .all(...variants, startOfDay, endOfDay) as Array<
    Flight & { aircraft_type: string; OperatedBy: string; fleet: string }
  >;

  if (flights.length === 0) {
    // No schedule data — offer probability estimate instead
    const pred = predictFlight(db, normalized);
    const pct = (pred.probability * 100).toFixed(0);

    return {
      content: [
        {
          type: "text",
          text: `No confirmed aircraft assignment for ${normalized} on ${date} in our database (we only track ~2 days of firm schedules).\n\n**Probability estimate**: ~${pct}% chance of Starlink based on ${pred.n_observations > 0 ? `${pred.n_observations} historical observation(s) of this flight number` : "fleet install rate"} (confidence: ${pred.confidence}). Check again 1-2 days before departure for a firm answer.`,
        },
      ],
    };
  }

  const lines = flights.map((f) => {
    const dep = new Date(f.departure_time * 1000).toISOString();
    const arr = new Date(f.arrival_time * 1000).toISOString();
    return `- ${normalizeFlightNumber(f.flight_number)} (${f.departure_airport}→${f.arrival_airport}) on ${f.aircraft_type} tail ${f.tail_number}, operated by ${f.OperatedBy}. Departs ${dep}, arrives ${arr}.`;
  });

  return {
    content: [
      {
        type: "text",
        text: `✈️ Yes! Flight ${normalized} on ${date} is scheduled on a Starlink-equipped aircraft:\n\n${lines.join("\n")}\n\nStarlink WiFi is free on all equipped United flights.`,
      },
    ],
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

function toolPredictFlightStarlink(db: Database, args: { flight_number?: unknown }): ToolResult {
  const input = typeof args.flight_number === "string" ? args.flight_number.trim() : "";
  if (!input) {
    return {
      content: [{ type: "text", text: "Error: flight_number is required." }],
      isError: true,
    };
  }

  const forPredict = ensureUAPrefix(input);

  // Sanity check: United flight numbers are 1-4 digits (UA1-UA9999).
  // 5+ digit numbers don't exist — don't return a confident "2% fleet prior"
  // for fictional flights.
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

  let text: string;
  if (pred.method !== "flight_history_smoothed") {
    const fleet = inferFleet(forPredict);
    const fleetLabel = fleet === "express" ? "express (regional)" : "mainline";
    text = `${forPredict}: **${pct}%** estimated Starlink probability (fleet prior · no historical data).

This is the ${fleetLabel} fleet install rate, not flight-specific. Treat as an upper bound — absence from our 12k+ observation log is itself a weak negative signal.`;
  } else {
    text = `${forPredict}: **${pct}%** estimated Starlink probability ${confidenceTag(pred.n_observations, pred.confidence)}.

From historical aircraft assignments over the past ~60 days. ${pred.confidence === "high" ? "Strong signal." : "Limited data — estimate may be off by ±20pp."}`;
  }

  return { content: [{ type: "text", text }] };
}

function toolPlanStarlinkItinerary(
  db: Database,
  args: { origin?: unknown; destination?: unknown; max_results?: unknown; max_stops?: unknown }
): ToolResult {
  const origin = typeof args.origin === "string" ? args.origin.trim() : "";
  const destination = typeof args.destination === "string" ? args.destination.trim() : "";
  const maxResults =
    typeof args.max_results === "number" && args.max_results > 0
      ? Math.min(args.max_results, 20)
      : 8;
  const maxStops =
    typeof args.max_stops === "number" && args.max_stops >= 0 ? Math.min(args.max_stops, 3) : 2;

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
  });

  if (itineraries.length === 0) {
    const orig = origin.toUpperCase();
    const dest = destination.toUpperCase();
    return {
      content: [
        {
          type: "text",
          text: `No Starlink routings found from ${orig} to ${dest} within ${maxStops} stops.\n\nNeither the direct route nor any path through our Starlink route network (~738 observed routes) connects ${orig} to ${dest} above 30% leg probability. If both airports are outside the US regional network, United may not fly this route with Starlink-equipped aircraft at all.`,
        },
      ],
    };
  }

  const fullItins = itineraries.filter((it) => it.coverage === "full");
  const partialItins = itineraries.filter((it) => it.coverage === "partial");

  const renderLeg = (leg: (typeof itineraries)[number]["legs"][number]): string => {
    if (leg.flight_number === "(any)") {
      return `position to ${leg.route.split("-")[1]} (mainline, ~2% Starlink)`;
    }
    const pct = (leg.probability * 100).toFixed(0);
    const fleetTag = inferFleet(leg.flight_number) === "mainline" ? " [Mainline]" : "";
    return `${leg.flight_number}${fleetTag} (${leg.route}) — ${pct}% ${confidenceTag(leg.n_observations, leg.confidence)}`;
  };

  const renderItin = (it: (typeof itineraries)[number], i: number): string => {
    // One decimal so displayed ranking matches sort order (avoids "72% below 71%" confusion)
    const jointPct = (it.joint_probability * 100).toFixed(1);
    const atLeastPct = (it.at_least_one_probability * 100).toFixed(0);
    const stops = it.via.length;
    const viaLabel =
      stops === 0 ? "DIRECT" : `via ${it.via.join("→")} (${stops} stop${stops > 1 ? "s" : ""})`;

    let header: string;
    if (it.coverage === "partial") {
      header = `${i + 1}. **${viaLabel}** — Starlink on final leg only (~${(it.legs[it.legs.length - 1].probability * 100).toFixed(0)}%)`;
    } else if (stops === 0) {
      header = `${i + 1}. **${viaLabel}** — **${jointPct}%** Starlink`;
    } else {
      header = `${i + 1}. **${viaLabel}** — **${jointPct}%** all legs (${atLeastPct}% at least one)`;
    }

    const legLines = it.legs.map((l, idx) => `   · Leg ${idx + 1}: ${renderLeg(l)}`).join("\n");
    return `${header}\n${legLines}`;
  };

  const sections: string[] = [];
  if (fullItins.length > 0) {
    sections.push(`**Full Starlink coverage** (ranked by joint probability; within 1pp, fewer stops wins):

${fullItins.map(renderItin).join("\n\n")}`);
  }
  if (partialItins.length > 0) {
    const header =
      fullItins.length === 0
        ? `**No all-Starlink path found within ${maxStops} stops** — all routes out of ${origin.toUpperCase()} in our Starlink data don't connect to ${destination.toUpperCase()}. Best partial options (position on non-Starlink leg, Starlink on connection):\n`
        : "**Partial coverage** (positioning leg needed):\n";
    sections.push(`${header}
${partialItins.map((it, i) => renderItin(it, fullItins.length + i)).join("\n\n")}`);
  }

  const hasMultiLeg = itineraries.some((it) => it.legs.length > 1);
  const timingNote = hasMultiLeg
    ? "\n\n⚠️ Connection timing NOT validated — verify on united.com that the legs connect same-day before booking."
    : "";

  const text = `**Starlink routings: ${origin.toUpperCase()} → ${destination.toUpperCase()}**

${sections.join("\n\n---\n\n")}${timingNote}

_Probabilities from historical aircraft assignments. Not guaranteed — use check_flight 1-2 days before departure for firm answers._`;

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
    return {
      content: [
        {
          type: "text",
          text: `${result.coverage_note}\n\nIf you know a specific flight number for this route, try predict_flight_starlink for a fleet-prior estimate.`,
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

**Combined Fleet**: ${starlinkPlanes.length} of ${totalCount} aircraft (${((starlinkPlanes.length / totalCount) * 100).toFixed(1)}%) have Starlink WiFi

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

  let flights = getUpcomingFlights(db).filter(
    (f) => f.departure_time > now && starlinkTails.has(f.tail_number)
  );

  if (origin) {
    flights = flights.filter((f) => f.departure_airport.toUpperCase().includes(origin));
  }
  if (destination) {
    flights = flights.filter((f) => f.arrival_airport.toUpperCase().includes(destination));
  }

  flights.sort((a, b) => a.departure_time - b.departure_time);
  const total = flights.length;
  const shown = flights.slice(0, limit);

  // Show the agent where our schedule data ends so it doesn't assume absence = no Starlink ever
  const latestDeparture = flights.length > 0 ? flights[flights.length - 1].departure_time : now;
  const dataHorizon = new Date(latestDeparture * 1000).toISOString().slice(0, 10);

  if (total === 0) {
    const routeDesc = origin && destination ? `${origin}→${destination}` : origin || destination;
    return {
      content: [
        {
          type: "text",
          text: `No confirmed Starlink flights found for ${routeDesc} in our ~2-day firm-schedule window.\n\nNote: this tool only sees confirmed assignments through ~${dataHorizon}. If you need dates beyond that, use predict_route_starlink or plan_starlink_itinerary for probability-based planning instead — absence from this tool does NOT mean no Starlink.`,
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
    instructions: `United Starlink tracker. Key facts:
• Express/regional (UA3000-6999): ~${expressPct}% have Starlink
• Mainline (UA1-2999, 737/787/etc): only ~${mainlinePct}% — assume NO Starlink on long-haul
• Probability and confidence are INDEPENDENT: "92% (4 obs · medium)" is less certain than "79% (10 obs · high)", but still higher probability

Tool selection:
• Routing questions ("best way to JAX with Starlink") → plan_starlink_itinerary first. Does multi-stop search (up to 3 stops) automatically.
• Future flight probability → predict_flight_starlink / predict_route_starlink
• Firm confirmation (≤2 days out) → check_flight
• search_starlink_flights = next ~2 days ONLY. Don't use for future dates.`,
  });
}

function handleToolsCall(
  db: Database,
  id: string | number | null,
  params: Record<string, unknown> | undefined
): JsonRpcResponse {
  const toolName = typeof params?.name === "string" ? params.name : undefined;
  const args = (params?.arguments as Record<string, unknown>) || {};

  if (!toolName) {
    return rpcError(id, -32602, "Missing required param: name");
  }

  let result: ToolResult;
  switch (toolName) {
    case "check_flight":
      result = toolCheckFlight(db, args);
      break;
    case "predict_flight_starlink":
      result = toolPredictFlightStarlink(db, args);
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

function dispatch(db: Database, msg: JsonRpcRequest): JsonRpcResponse | null {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize":
      return handleInitialize(db, id, msg.params);

    case "notifications/initialized":
      // Stateless: acknowledge and discard
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call":
      return handleToolsCall(db, id, msg.params);

    default:
      if (isNotification) return null; // Unknown notification — ignore
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
    response = dispatch(db, msg);
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
