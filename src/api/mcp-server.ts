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
import type { Flight } from "../types";
import { normalizeFlightNumber } from "../utils/constants";
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
      "Check whether a specific United Airlines flight has Starlink WiFi on a given date. " +
      "Returns tail number, aircraft type, route, and departure time if the scheduled aircraft " +
      "is known to have Starlink.",
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
    name: "search_starlink_flights",
    description:
      "Search upcoming flights operated by Starlink-equipped aircraft. Filter by route " +
      "(origin and/or destination airport), or find all Starlink flights from a specific airport. " +
      "Useful for answering 'which United flights from SFO have Starlink this week?'",
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
  const normalized = normalizeFlightNumber(flightNumber);
  const variants: string[] = [normalized];
  if (/^UA\d+$/.test(normalized)) {
    const num = normalized.slice(2);
    const prefixes = [
      "UAL",
      "SKW",
      "ASH",
      "RPA",
      "GJS",
      "PDT",
      "ACA",
      "ENY",
      "OO",
      "YX",
      "YV",
      "G7",
    ];
    for (const p of prefixes) variants.push(`${p}${num}`);
  }

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
    return {
      content: [
        {
          type: "text",
          text: `No Starlink-equipped aircraft found for flight ${normalized} on ${date}. This flight either doesn't exist in our database, is operated by a non-Starlink aircraft, or is too far in the future (we track ~7 days out).`,
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

  if (total === 0) {
    const routeDesc = origin && destination ? `${origin}→${destination}` : origin || destination;
    return {
      content: [
        {
          type: "text",
          text: `No upcoming Starlink-equipped flights found for ${routeDesc}. Try a major United hub like ORD, DEN, IAH, EWR, or SFO.`,
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
        text: `Found ${total} upcoming Starlink flight(s) for ${routeDesc} (showing ${shown.length}):\n\n${lines.join("\n")}`,
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

  return rpcResult(id, {
    protocolVersion,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "united-starlink-tracker",
      version: "1.0.0",
    },
    instructions:
      "This server provides live data about which United Airlines aircraft have SpaceX Starlink WiFi installed. " +
      "Use check_flight to look up a specific flight, get_fleet_stats for installation progress, " +
      "list_starlink_aircraft to enumerate equipped planes, or search_starlink_flights to find Starlink flights by route.",
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
      return handleInitialize(id, msg.params);

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
