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
 *
 * Tenancy:
 *   - Each `/mcp` host serves that host's airline scope by default (UA host →
 *     UA reader, QR host → QR reader, hub host → ALL).
 *   - Clients can override with `?scope=ALL|UA|HA|AS|QR` to widen or pin scope.
 *   - serverInfo / instructions / tool descriptions reflect the resolved scope.
 *   - Tool implementations resolve the scope's AirlineConfig: flight numbers
 *     normalize per-carrier and prose is templated from the config. The
 *     prediction model is UA-trained, so prediction tools answer non-UA scopes
 *     from registry type rules / subfleet penetration — never UA priors.
 */

import {
  buildAirlineFlightNumberVariants,
  canonicalFlightInput,
  detectAirline,
  ensureAirlinePrefix,
  inferSubfleet,
  marketingFlightNumber,
  normalizeAirlineFlightNumber,
} from "../airlines/flight-number";
import {
  AIRLINES,
  type AirlineCode,
  type AirlineConfig,
  type AnalyticsConfig,
  SITES,
  hubLookupAirlines,
  siteForAirline,
} from "../airlines/registry";
import type { FlightAssignmentRow } from "../database/database";
import { type Scope, type ScopedReader, aggregatePenetration } from "../database/reader";
import {
  COUNTERS,
  DISTRIBUTIONS,
  mcpClientTags,
  metrics,
  normalizeScopeTag,
} from "../observability";
import {
  ENFORCE_ITINERARY_TIME_BUDGET,
  carrierPrediction,
  carrierPredictionTelemetry,
  carrierRouteAnswer,
  compareRoute,
  describeCarrierPrediction,
  itineraryHourBudget,
  joinSentences,
  noModelConfidence,
  planItinerary,
  predictFlight,
  predictRoute,
  routeBaseline,
} from "../scripts/starlink-predictor";
import { AIRPORT_COORDS } from "../utils/airport-geo";
import { isRealIsoDate, matchesLocalDate } from "../utils/airport-tz";
import { debug, error as logError } from "../utils/logger";
import {
  type FlightVerdict,
  type LegResolution,
  SWAP_DEGRADED_NOTE,
  answersOtherLeg,
  carrierReader,
  decideCarrier,
  flightDateWindow,
  fr24DegradedNote,
  isPlausibleFlightNumber,
  legOffRoute,
  legSubject,
  normalizeAirportCode,
  parseLegQuery,
  recordFlightLookup,
  recordLegScope,
  recordPrediction,
  recordUntrackedLookup,
  resolveFlightVerdict,
  verdictAssignment,
  verdictTelemetry,
  wifiLabel,
  withLeg,
  withLegNote,
} from "./check-flight-core";
import { type FallbackSegment, cachedFlightAssignments } from "./flight-verdict";
import { FlightRadar24API } from "./flightradar24-api";
import {
  QATAR_PUBLISHED_DAYS_FORWARD,
  dohDateISO,
  qatarEquipmentClass,
  qatarEquipmentName,
} from "./qatar-status";
import {
  type QatarLeg,
  type QatarVerdict,
  addDaysISO,
  qatarHistoryReason,
  qatarNoDataReason,
} from "./qatar-verdict";

// Protocol versions we support (newest first)
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

// registry/server.*.json must carry the same value (tests/mcp-registry.test.ts).
export const MCP_SERVER_VERSION = "1.0.0";

/** The host's own site: a ?scope= override still lives on the host it was asked on. */
function mcpWebsiteUrl(hostScope: Scope): string {
  const site = hostScope === "ALL" ? SITES.airline : siteForAirline(hostScope as AirlineCode);
  return `https://${(site ?? SITES.united).canonicalHost}`;
}

const DEFAULT_ANALYTICS: AnalyticsConfig = {
  scriptSrc: "https://analytics.martinamps.com/js/script.js",
  dataDomain: "unitedstarlinktracker.com",
  eventApiUrl: "https://analytics.martinamps.com/api/event",
};

/**
 * Fire-and-forget Plausible event. Never awaited — analytics must not
 * block or fail MCP responses.
 *
 * Uses a custom "MCP" goal with props so you can break down by tool in the
 * Plausible dashboard (Behaviors → Goal Conversions → MCP → props).
 */
function trackMcpEvent(
  req: Request,
  analytics: AnalyticsConfig | null | undefined,
  props: { method: string; tool?: string }
): void {
  if (!analytics?.eventApiUrl) return;
  // Tests dispatch /mcp through createApp() with real per-tenant analytics
  // configs; without this guard every `bun test` run (local + CI) posts live
  // events to Plausible — including for unregistered domains.
  if (process.env.NODE_ENV !== "production") return;
  // Forward the client's UA and IP so Plausible can do bot filtering and
  // unique-visitor counting as if this were a page view.
  const ua = req.headers.get("user-agent") || "mcp-client/unknown";
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "";

  fetch(analytics.eventApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": ua,
      ...(ip ? { "X-Forwarded-For": ip } : {}),
    },
    body: JSON.stringify({
      name: "MCP",
      url: `https://${analytics.dataDomain}/mcp`,
      domain: analytics.dataDomain,
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

const textResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const toolError = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

// ============================================================================
// Tool definitions (JSON Schema 2020-12)
// ============================================================================

// Registry-derived (pinned in tests/vocabulary.test.ts). Only carriers the hub
// already answers for: an enabled-but-unpublished airline (collecting data
// before launch) must not be reachable through ?scope=.
export const VALID_SCOPES: readonly Scope[] = ["ALL", ...hubLookupAirlines().map((a) => a.code)];

function isValidScope(s: string): s is Scope {
  return (VALID_SCOPES as readonly string[]).includes(s);
}

/**
 * Resolve `?scope=` from an MCP request URL. Falls back to the host's scope.
 * Returns the resolved scope plus a boolean for whether the override was applied
 * (used in serverInfo / instructions to surface the active scope to the AI).
 */
function resolveScope(req: Request, hostScope: Scope): { scope: Scope; overridden: boolean } {
  try {
    const raw = new URL(req.url).searchParams.get("scope");
    if (!raw) return { scope: hostScope, overridden: false };
    const upper = raw.toUpperCase();
    if (isValidScope(upper) && upper !== hostScope) return { scope: upper, overridden: true };
    return { scope: hostScope, overridden: false };
  } catch {
    return { scope: hostScope, overridden: false };
  }
}

/** Human label for a scope. Used in tool descriptions and result text. */
function scopeLabel(scope: Scope): string {
  if (scope === "ALL") return "tracked airlines";
  return AIRLINES[scope as AirlineCode]?.name ?? scope;
}

/** Title-case label for the start of a sentence ("Airline" vs. "tracked airlines"). */
function scopeTitle(scope: Scope): string {
  if (scope === "ALL") return "Multi-airline";
  return AIRLINES[scope as AirlineCode]?.name ?? scope;
}

/** Sample flight number for a scope (used in inputSchema descriptions). */
function exampleFlightNumber(scope: Scope): string {
  if (scope === "ALL") return "UA544";
  return `${scope}${scope === "UA" ? "544" : "1"}`;
}

/** "a United Airlines", "an Alaska Airlines", "a tracked-airline" — "Uni…" is a consonant sound. */
function withArticle(label: string): string {
  return `${/^(?!uni)[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
}

/** Can this scope's route tools run the itinerary planner (multi-stop, tables)? */
function scopeHasPlanner(scope: Scope): boolean {
  return scope !== "ALL" && Boolean(AIRLINES[scope as AirlineCode]?.flightHistoryModel);
}

function buildTools(scope: Scope) {
  const carrier = scopeLabel(scope);
  // Adjective form: "tracked airlines flight number" reads as a typo.
  const carrierAdj = scope === "ALL" ? "tracked-airline" : carrier;
  const example = exampleFlightNumber(scope);
  // Operating-carrier codes only resolve on the UA host: the hub matches
  // marketing codes alone, because SkyWest (OO/SKW) flies for several airlines.
  const prefixHint =
    scope === "UA"
      ? " Also accepts operating-carrier codes like SKW5212, OO4680, UAL544."
      : scope === "ALL"
        ? " Also accepts ICAO airline codes like UAL544; use the marketing flight number (UA5212, not SKW5212)."
        : "";

  const tools = [
    {
      name: "check_flight",
      description: `Use when the user asks "does my flight have Starlink/WiFi?" with a specific ${carrierAdj} flight number and date. Returns FIRM YES if assigned to a verified-Starlink plane, FIRM NO if assigned to a verified non-Starlink plane, or a probability estimate if no assignment exists yet (assignments publish ~2 days out). For dates further out, call predict_flight_starlink directly — check_flight just falls through to the same estimate with extra latency.`,
      inputSchema: {
        type: "object",
        properties: {
          flight_number: {
            type: "string",
            description: `Flight number, e.g. '${example}' or just the digits.${prefixHint}`,
            examples: [example, example.replace(/\D/g, "")],
          },
          date: {
            type: "string",
            description:
              "Flight date in YYYY-MM-DD format, matched to the departure airport's local calendar date (UTC fallback for unmapped airports).",
            examples: ["2026-05-15"],
          },
          origin: {
            type: "string",
            description:
              "Optional 3-letter IATA departure airport of the traveller's leg (e.g. 'DEN'); scopes the answer to that leg of a multi-leg flight number.",
          },
          destination: {
            type: "string",
            description:
              "Optional 3-letter IATA arrival airport of the traveller's leg (e.g. 'SAN'); with origin, picks one leg of a multi-leg flight number.",
          },
        },
        required: ["flight_number", "date"],
        examples: [{ flight_number: example, date: "2026-05-15" }],
      },
    },
    {
      name: "get_fleet_stats",
      description: `Use when the user asks "how far along is the Starlink rollout?" or wants overall fleet numbers. Returns ${carrier} Starlink installation counts and percentages across mainline and express fleets, plus a per-aircraft-type breakdown (installed/total per family). Not for per-flight checks — use check_flight for that.`,
      inputSchema: {
        type: "object",
        properties: {},
        examples: [{}],
      },
    },
    {
      name: "list_starlink_aircraft",
      description: `Use when the user asks about the planes themselves — "which tail numbers have Starlink?", "which aircraft types are equipped?". Returns ${carrier} tail numbers, aircraft types, operators, and install dates (default 50 most recent; pass limit up to 500). Not for finding flights — use search_starlink_flights for that.`,
      inputSchema: {
        type: "object",
        properties: {
          fleet: {
            type: "string",
            enum: ["express", "mainline"],
            description: "Filter to only express (regional) or mainline aircraft.",
            examples: ["express"],
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum number of aircraft to return (default 50).",
            examples: [100],
          },
        },
        examples: [{ fleet: "express", limit: 100 }, {}],
      },
    },
    {
      name: "predict_flight_starlink",
      description: `Use when the user asks "will my flight have Starlink?" for a date too far out for a confirmed assignment, or with no date at all. Returns the probability that ${withArticle(carrierAdj)} flight number gets a Starlink plane, from historical observations. Reliability varies: high-confidence (5+ obs) is the most reliable tier but is not a guarantee; low-confidence (0-1 obs) is just the fleet prior.${
        scope === "UA" || scope === "ALL"
          ? " UA1-2999 (mainline) has materially lower coverage than UA3000-6999 (express) — call get_fleet_stats for the current split rather than assuming a rate."
          : ""
      }`,
      inputSchema: {
        type: "object",
        properties: {
          flight_number: {
            type: "string",
            description: `Flight number, e.g. '${example}' or just the digits.${prefixHint}`,
            examples: [example],
          },
          date: {
            type: "string",
            description:
              "Optional YYYY-MM-DD. ALWAYS PASS if known — the probability is date-agnostic, " +
              "but when the result is low (<20%) the tool uses this date to look up the actual " +
              "route and returns a ready-to-run plan_starlink_itinerary call with origin/dest " +
              "pre-filled, so alternatives can be presented in one turn.",
            examples: ["2026-06-01"],
          },
        },
        required: ["flight_number"],
        examples: [{ flight_number: example, date: "2026-06-01" }, { flight_number: example }],
      },
    },
    {
      name: "plan_starlink_itinerary",
      description:
        scope === "ALL"
          ? 'Use when the user asks "what\'s the best way to fly X to Y with Starlink?". ' +
            "Compares Starlink odds on the route across every tracked airline (nonstop, per-carrier). " +
            "For multi-stop UA routings, connect to unitedstarlinktracker.com/mcp."
          : !scopeHasPlanner(scope)
            ? `Use when the user asks "what's the best way to fly X to Y with Starlink?". Returns ${carrier} Starlink odds for the NONSTOP route, from which aircraft types fly it — no multi-stop search or connection ranking for this airline yet. For a specific flight, use check_flight with the flight number and date.`
            : 'Use when the user asks "what\'s the best way to fly X to Y with Starlink?" or wants ranked alternatives. ' +
              "PRIMARY TRAVEL-PLANNING TOOL — multi-stop search (up to 2 stops default, 3 max) ranked by " +
              "COVERAGE RATIO (expected Starlink hours / total flight hours) so a 92% 1h direct scores the " +
              "same as a 92% 10h multi-stop. Direct flights always shown first. Returns probability-ranked " +
              "routings, NOT bookable itineraries — connection timing isn't validated; verify on the airline's site.",
      inputSchema: {
        type: "object",
        properties: {
          origin: {
            type: "string",
            description: "Origin airport IATA code (e.g. 'SFO').",
            examples: ["SFO"],
          },
          destination: {
            type: "string",
            description: "Destination airport IATA code (e.g. 'JAX').",
            examples: ["JAX"],
          },
          max_stops: {
            type: "integer",
            minimum: 0,
            maximum: 3,
            description:
              "Maximum number of connection stops (default 2, max 3). 0=direct only, 1=one connection, etc.",
            examples: [1],
          },
          max_results: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description:
              "Maximum number of full-coverage itineraries (default 8). Up to 3 partial baselines may be appended.",
            examples: [8],
          },
          date: {
            type: "string",
            description:
              "Optional YYYY-MM-DD travel date. When within ~2 days (the aircraft-assignment " +
              "window), uses confirmed tail assignments for higher accuracy. Beyond that, uses " +
              "historical prediction only — confirmed assignments don't apply to future dates.",
            examples: ["2026-05-20"],
          },
        },
        required: ["origin", "destination"],
        examples: [
          { origin: "SFO", destination: "EWR" },
          { origin: "ORD", destination: "JAX", date: "2026-05-20", max_stops: 1 },
        ],
      },
    },
    {
      name: "predict_route_starlink",
      description:
        scopeHasPlanner(scope) || scope === "ALL"
          ? `Use when the user asks "which flights between X and Y have Starlink?" or "what Starlink flights serve airport X?". Single-route lookup: returns ${carrier} flight numbers on a route (or touching an airport) ranked by Starlink probability. ${scope === "ALL" ? "Both origin and destination are required (per-airline route comparison)." : "Pass both origin+destination for a specific route, OR just one to list all Starlink flights from/into an airport."} For trip planning with connections, use plan_starlink_itinerary instead — this tool has no connection logic or coverage-ratio ranking. Empty result = route not served by Starlink planes.`
          : `Use when the user asks "which flights between X and Y have Starlink?". Returns ${carrier} Starlink odds for a nonstop route, from which aircraft types fly it. Pass both origin and destination. For a specific flight, use check_flight with the flight number and date.`,
      inputSchema: {
        type: "object",
        properties: {
          origin: {
            type: "string",
            description: "Origin airport IATA code (e.g. 'SFO', 'ORD'). Case-insensitive.",
            examples: ["SFO"],
          },
          destination: {
            type: "string",
            description: "Destination airport IATA code (e.g. 'EWR', 'DEN'). Case-insensitive.",
            examples: ["EWR"],
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum number of flight numbers to return (default 10).",
            examples: [10],
          },
        },
        examples: [{ origin: "SFO", destination: "EWR" }, { origin: "ORD" }],
      },
    },
    {
      name: "search_starlink_flights",
      description:
        'Use when the user asks "what Starlink flights leave from X tomorrow?" or wants confirmed near-term departures. ' +
        "Returns CONFIRMED Starlink flights in the next ~2 days — firm schedule, not prediction. " +
        "Pass at least one of origin or destination (both narrows to a single route). " +
        "Aircraft assignments aren't published further out, so for later dates use " +
        "predict_route_starlink or plan_starlink_itinerary instead.",
      inputSchema: {
        type: "object",
        properties: {
          origin: {
            type: "string",
            description: "Origin airport IATA code (e.g. 'SFO', 'ORD'). Case-insensitive.",
            examples: ["ORD"],
          },
          destination: {
            type: "string",
            description: "Destination airport IATA code (e.g. 'LAX', 'DEN'). Case-insensitive.",
            examples: ["LAX"],
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of flights to return (default 20).",
            examples: [20],
          },
        },
        examples: [{ origin: "ORD" }, { origin: "SFO", destination: "EWR" }],
      },
    },
  ];
  return tools.map(withToolAnnotations);
}

const TOOL_TITLES: Record<string, string> = {
  check_flight: "Check flight for Starlink",
  get_fleet_stats: "Starlink fleet rollout stats",
  list_starlink_aircraft: "List Starlink aircraft",
  predict_flight_starlink: "Predict flight Starlink odds",
  plan_starlink_itinerary: "Plan a Starlink itinerary",
  predict_route_starlink: "Starlink odds by route",
  search_starlink_flights: "Search confirmed Starlink flights",
};

// Only these two can reach FR24 (lookupFlightRoutes / the tail lookup); the
// rest read our own database. Every tool is read-only toward the user — the
// flight_routes cache write is internal bookkeeping. ChatGPT treats a tool
// without readOnlyHint as a write and asks the user to confirm every call.
const OPEN_WORLD_TOOLS = new Set(["check_flight", "predict_flight_starlink"]);

function withToolAnnotations<T extends { name: string }>(tool: T) {
  const title = TOOL_TITLES[tool.name];
  return {
    ...tool,
    title,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: OPEN_WORLD_TOOLS.has(tool.name),
    },
  };
}

const TOOL_NAMES = buildTools("UA").map((t) => t.name);

// Cheap edit-distance for "did you mean" — tool names are short, so O(n*m) is fine.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

function suggestTool(unknown: string): string | null {
  const lower = unknown.toLowerCase();
  // Exact substring match first — catches "predict_flight" → "predict_flight_starlink".
  const sub = TOOL_NAMES.find((t) => t.includes(lower) || lower.includes(t));
  if (sub) return sub;
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of TOOL_NAMES) {
    const d = levenshtein(lower, t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  // Only suggest when plausibly a typo, not for completely unrelated names.
  return bestDist <= Math.max(4, Math.floor(unknown.length / 2)) ? best : null;
}

// ============================================================================
// Tool implementations
// ============================================================================

// Airline scopes use their own config — never United's config against another
// airline's reader. The hub has NO single config: flight-taking tools resolve
// the carrier from the flight number (resolveFlightToolCarrier), route tools
// answer per-airline via compareRoute, and search normalizes per row.
function scopeCfg(scope: Scope): AirlineConfig | null {
  return scope === "ALL" ? null : (AIRLINES[scope] ?? null);
}

type GetReader = (scope: Scope) => ScopedReader;

/** MCP renderer over decideCarrier (check-flight-core owns the policy) for
 * the flight-number-taking tools (check_flight, predict_flight_starlink). */
function resolveFlightToolCarrier(
  reader: ScopedReader,
  getReader: GetReader,
  flightNumber: string,
  pool: "public" | "lookup" = "public"
): { cfg: AirlineConfig; reader: ScopedReader } | ToolResult {
  let pinnedCfg: AirlineConfig | null = null;
  if (reader.scope !== "ALL") {
    pinnedCfg = scopeCfg(reader.scope);
    if (!pinnedCfg) return scopeConfigError(reader.scope);
  }
  const decision = decideCarrier(pinnedCfg, flightNumber, { pool });
  if (decision.outcome === "not_tracked") {
    recordUntrackedLookup(flightNumber, "mcp");
    // Single-airline surface: name only the pinned carrier — never list
    // competitor brands on its server. The hub is multi-airline, so its
    // refusal legitimately enumerates the tracked carriers.
    // The hub matches marketing codes only (OO/SKW fly for several airlines),
    // so an operating-carrier code gets pointed at the number on the ticket.
    const operator = decision.pinnedCfg ? null : detectAirline(flightNumber, decision.tracked);
    const digits = flightNumber.match(/\d+$/)?.[0];
    const text = decision.pinnedCfg
      ? `This server covers ${decision.pinnedCfg.name} flights (${decision.pinnedCfg.iata} + flight number, e.g. ${decision.pinnedCfg.iata}123). For other carriers, use that airline's tracker or airlinestarlinktracker.com.`
      : operator && digits
        ? `${flightNumber} is an operating-carrier code, not the marketing flight number this server looks up. Use the number on the ticket — e.g. ${operator.iata}${digits} if it's sold as ${operator.name}.`
        : `Airline not tracked. Tracked carriers: ${decision.tracked
            .map((a) => `${a.iata} (${a.name})`)
            .join(", ")}. Prefix the flight number with the carrier code, e.g. UA123.`;
    return toolError(text);
  }
  return { cfg: decision.cfg, reader: carrierReader(decision, reader, getReader) };
}

// Verdict first, alternatives second: the firm NO is the answer to the
// question asked, and the table's first row restates it as "your flight, 0%".
// Both firm-no renderings share this and must tolerate an empty block (non-UA
// scopes get no planner table).
function withAlt(altBlock: string, message: string): string {
  return altBlock ? `${message}\n\n${altBlock}` : message;
}

/** Why the person's own flight shows 0%: "assigned N16709, Thales". Takes wifiLabel() words. */
function firmNoLabel(tails: string[], wifiWords: string[]): string {
  const uniq = (xs: string[]) => [...new Set(xs)].join("/");
  return `assigned ${uniq(tails)}, ${uniq(wifiWords.map((w) => (w === "no" ? "no WiFi" : w)))}`;
}

function invalidDateError(): ToolResult {
  return toolError("Error: invalid date format. Use YYYY-MM-DD.");
}

async function toolCheckFlight(
  hostReader: ScopedReader,
  getReader: GetReader,
  args: { flight_number?: unknown; date?: unknown; origin?: unknown; destination?: unknown },
  opts: { undated?: boolean } = {}
): Promise<ToolResult> {
  const flightNumber =
    typeof args.flight_number === "string" ? canonicalFlightInput(args.flight_number) : "";
  const date = typeof args.date === "string" ? args.date.trim() : "";

  if (!flightNumber || !date) {
    return toolError("Error: flight_number and date are required.");
  }
  if (!isRealIsoDate(date)) return invalidDateError();

  // "lookup": the hub's MCP flight tools answer hubFlightLookup carriers
  // (QR), matching /api/check-any-flight.
  const carrier = resolveFlightToolCarrier(hostReader, getReader, flightNumber, "lookup");
  if ("content" in carrier) return carrier;
  const { cfg, reader } = carrier;
  // The hub never does FR24 reverse lookups — same gate as hub REST
  // /api/check-flight and /api/check-any-flight (lookupTail: null), so the
  // same flight+date can't get contradictory verdicts by protocol.
  const verdict = await resolveFlightVerdict(
    cfg,
    reader,
    flightNumber,
    date,
    withLeg(
      hostReader.scope === "ALL" ? { lookupTail: null } : undefined,
      parseLegQuery(
        typeof args.origin === "string" ? args.origin : null,
        typeof args.destination === "string" ? args.destination : null
      )
    )
  );

  if (verdict.kind === "invalid_date") return invalidDateError();
  if (verdict.kind === "invalid_flight_number") {
    return toolError(
      `${verdict.normalized} is not a valid flight number (expected ${cfg.iata} + 1-4 digits).`
    );
  }

  const t = verdictTelemetry(verdict);
  recordFlightLookup("mcp", t.outcome, t.confidence, reader.scope);
  recordLegScope("mcp", verdict, cfg.code, mcpClientTags());
  return renderCheckFlightVerdict(cfg, reader, verdict, date, {
    ...opts,
    liveLookup: hostReader.scope !== "ALL",
  });
}

/** check_flight text for a resolved verdict — exported so AF answers can be
 * rendered before AF is public on the hub. */
export async function renderCheckFlightVerdict(
  cfg: AirlineConfig,
  reader: ScopedReader,
  verdict: Exclude<FlightVerdict, { kind: "invalid_date" } | { kind: "invalid_flight_number" }>,
  date: string,
  /** liveLookup: false when the FR24 tail lookup was skipped (the hub). */
  opts: { undated?: boolean; liveLookup?: boolean } = {}
): Promise<ToolResult> {
  if (
    verdict.kind === "qatar" ||
    verdict.kind === "qatar_no_data" ||
    verdict.kind === "qatar_history"
  ) {
    return renderQatarCheckFlight(verdict, date, opts.undated === true);
  }

  const { mid, start: startOfDay, end: endOfDay } = verdict.window;
  const now = Math.floor(Date.now() / 1000);
  const normalized = verdict.normalized;

  const renderAssignment = (f: FlightAssignmentRow): string => {
    const dep = new Date(f.departure_time * 1000).toISOString();
    const arr = new Date(f.arrival_time * 1000).toISOString();
    const ac = f.aircraft_type || "aircraft";
    return `- ${normalizeAirlineFlightNumber(cfg, f.flight_number)} (${f.departure_airport}→${f.arrival_airport}) on ${ac} tail ${f.tail_number}, operated by ${f.OperatedBy}. Departs ${dep}, arrives ${arr}.`;
  };

  const renderSeg = (s: FallbackSegment): string => {
    const dep = new Date(s.departure_time * 1000).toISOString();
    const ac = s.aircraft_model || "aircraft";
    const conf =
      s.confidence === "verified"
        ? "verified Starlink"
        : s.confidence === "spreadsheet"
          ? "tracked as Starlink (unverified)"
          : s.confidence === "negative"
            ? `verified ${wifiLabel(s.verified_wifi)} WiFi`
            : s.confidence;
    return `- ${normalized} (${s.origin}→${s.destination}) on ${ac} tail ${s.tail_number} — ${conf}. Departs ${dep}.`;
  };

  switch (verdict.kind) {
    case "scheduled": {
      // Firm YES: united.com-verified tail. Likely YES: spreadsheet says
      // Starlink but not yet confirmed (usually right ~80-90%, not firm).
      if (verdict.verified.length > 0) {
        return textResult(
          withLegNote(
            `✈️ Yes! Flight ${legSubject(verdict)} on ${date} is scheduled on a verified Starlink aircraft:\n\n${verdict.verified.map(renderAssignment).join("\n")}\n\nStarlink WiFi is free on all equipped ${cfg.shortName} flights.`,
            verdict
          )
        );
      }
      const unverifiedAgainst = `not yet verified against ${cfg.verifySite}`;
      const source = cfg.communitySource
        ? {
            where: `listed with Starlink in the ${cfg.communitySource.label} (community data, ${unverifiedAgainst})`,
            caveat: "Community data can lag an install or a swap.",
          }
        : {
            where: `tracked as Starlink in the fleet spreadsheet (${unverifiedAgainst})`,
            caveat: "Spreadsheet data is usually accurate but unverified.",
          };
      return textResult(
        withLegNote(
          `Likely yes — ${legSubject(verdict)} on ${date} is assigned to a tail ${source.where}:\n\n${verdict.unverified.map(renderAssignment).join("\n")}\n\n${source.caveat} Check ${cfg.verifySite} or the flight status 24h out to confirm.`,
          verdict
        )
      );
    }

    case "scheduled_no": {
      // Firm NO: we have an assignment but it's a non-Starlink plane. We also
      // already know the route from the assignment — no lookup needed.
      const a = verdictAssignment(verdict);
      const wifi = wifiLabel(a.wifi);
      const altBlock = answersOtherLeg(verdict.leg)
        ? ""
        : buildAlternativesBlock(
            cfg,
            reader,
            [{ origin: a.origin, destination: a.destination }],
            mid,
            { flightNumber: normalized, probability: 0, label: firmNoLabel([a.tail], [wifi]) }
          );
      return textResult(
        withAlt(
          altBlock,
          withLegNote(
            `❌ No Starlink: ${legSubject(verdict)} on ${date} is assigned to tail ${a.tail} (${a.aircraft || "aircraft"}), verified as ${wifi} WiFi — NOT Starlink. Aircraft swaps can happen, but the assignment is currently firm.${verdict.fr24Error ? ` ${SWAP_DEGRADED_NOTE}` : ""}`,
            verdict
          )
        )
      );
    }

    // No upcoming_flights row — the core already ran the same FR24 tail-lookup
    // fallback that /api/check-flight uses (disabled on the hub for both, see
    // toolCheckFlight), so MCP and the extension API converge per host.
    case "fr24": {
      return textResult(
        withLegNote(
          `✈️ Yes! Flight ${legSubject(verdict)} on ${date} is assigned to a Starlink aircraft (via live tail lookup):\n\n${verdict.starlink.map(renderSeg).join("\n")}\n\nStarlink WiFi is free on all equipped ${cfg.shortName} flights.`,
          verdict
        )
      );
    }

    case "fr24_no": {
      const no = verdict.segments.filter((s) => s.hasStarlink === false);
      const altBlock = answersOtherLeg(verdict.leg)
        ? ""
        : buildAlternativesBlock(
            cfg,
            reader,
            no.map((s) => ({ origin: s.origin, destination: s.destination })),
            mid,
            {
              flightNumber: normalized,
              probability: 0,
              label: firmNoLabel(
                no.map((s) => s.tail_number),
                no.map((s) => wifiLabel(s.verified_wifi))
              ),
            }
          );
      return textResult(
        withAlt(
          altBlock,
          withLegNote(
            `❌ No Starlink: ${legSubject(verdict)} on ${date} is assigned to ${no.map((s) => `tail ${s.tail_number} (${s.aircraft_model || "aircraft"}, ${wifiLabel(s.verified_wifi)} WiFi)`).join("; ")} — NOT Starlink. Aircraft swaps can happen, but the assignment is currently firm.`,
            verdict
          )
        )
      );
    }

    case "no_model": {
      // "no assignment data" would be a lie during an FR24 outage — the same
      // couldn't-confirm caveat the prediction branch uses — and for a
      // community carrier's named tail, which is itself the assignment.
      const lead = verdict.fr24Error
        ? `${fr24DegradedNote(verdict)} `
        : noModelConfidence(verdict.answer) === "tail"
          ? ""
          : "no assignment data. ";
      return textResult(
        withLegNote(
          `${normalized} on ${date}: ${lead}${describeCarrierPrediction(cfg, verdict.answer, { date })}`,
          verdict
        )
      );
    }

    case "prediction": {
      // No assignment data at all — probability fallback. If low, look up the
      // route from FR24 (cached) so we can give the agent a concrete next step.
      const pred = verdict.pred;
      recordPrediction(pred, reader.scope);

      const isPast = endOfDay < now - 86400;
      const isNearTerm = startOfDay < now + 3 * 86400;
      // During an FR24 outage we genuinely don't know whether an assignment
      // exists — don't claim it isn't published yet.
      // A past date's assignment isn't "not yet published" — it's gone.
      // Near-term, only a surface that ran the live tail lookup may call a
      // missing assignment unusual; the hub skips that lookup by design.
      // Other legs of the number being assigned contradicts "not yet
      // published"; the leg note names them instead.
      const liveSite = siteForAirline(cfg.code, true)?.canonicalHost;
      const assignmentNote = verdict.fr24Error
        ? fr24DegradedNote(verdict)
        : legOffRoute(verdict)
          ? ""
          : isPast
            ? "This date is in the past; we don't retain historical assignments."
            : !isNearTerm
              ? "Aircraft assignment not yet published — that happens ~2 days out. Check again 1-2 days before departure for a firm answer."
              : opts.liveLookup === false
                ? `No assignment on file — this multi-airline server only sees Starlink-tracked aircraft and doesn't run a live tail lookup.${liveSite ? ` For a live check, use ${liveSite}/mcp.` : ""}`
                : "No assignment published — this is unusual for a near-term flight. The tail may not be in our Starlink-tracked set yet.";

      // Probability context FIRST, alternatives table LAST. Recency bias: the
      // agent's final impression is "here's the table to present", not "no data".
      const probLine = withLegNote(
        `**${normalized} on ${date}**: ${approxPct(pred.probability)} Starlink probability ${pred.n_observations > 0 ? `(${pred.n_observations} historical obs)` : "(no flight history)"}.${assignmentNote ? ` ${assignmentNote}` : ""}`,
        verdict
      );

      let altBlock = "";
      if (pred.probability < 0.2 && !isPast) {
        const routes = await lookupFlightRoutes(cfg, reader, normalized, mid, {
          liveAssignments: opts.liveLookup !== false,
        });
        const alt = buildAlternativesBlock(cfg, reader, routes, mid, {
          flightNumber: normalized,
          probability: pred.probability,
        });
        if (alt) altBlock = `\n\n${alt}`;
      }

      return textResult(`${probLine}${altBlock}`);
    }

    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

// Hub-scope only: QR answers from equipment, not tails, so the ≤2-day rule
// above doesn't apply to it.
const HUB_LOOKUP_INSTRUCTION = hubLookupAirlines().some((a) => a.code === "QR")
  ? "• Qatar Airways (QR…): use check_flight at any date — it answers from the published aircraft type (~6 days) or observed-type history beyond.\n"
  : "";

function renderQatarCheckFlight(
  verdict: QatarVerdict & { leg?: LegResolution },
  date: string,
  undated = false
): ToolResult {
  const text = textResult;
  const legLine = (r: QatarLeg) =>
    `- ${r.flight_number} (${r.departure_airport ?? "?"}→${r.arrival_airport ?? "?"}) on ${qatarEquipmentName(r.equipment_code)}. Departs ${new Date(r.departure_time * 1000).toISOString()}.`;

  if (verdict.kind === "qatar_no_data") {
    return text(
      withLegNote(`${legSubject(verdict)} on ${date}: ${qatarNoDataReason(verdict)}`, verdict)
    );
  }

  const subjectBase = legSubject(verdict);
  if (verdict.kind === "qatar_history") {
    const subject = undated
      ? `${subjectBase} (recent pattern; no date given)`
      : `${subjectBase} on ${date}`;
    const reason = qatarHistoryReason(verdict);
    if (verdict.mostlyRolling)
      return text(withLegNote(`**${subject}**: maybe — ${reason}`, verdict));
    if (verdict.probability === null) return text(withLegNote(`${subject}: ${reason}`, verdict));
    const pct = Math.floor(verdict.probability * 100);
    const basis = verdict.swapRisk
      ? `${verdict.grade} confidence, ${verdict.swapObserved} flown days first published on a fitted type`
      : `${verdict.grade} confidence, ${verdict.nDays} recent and scheduled operating days`;
    // Same bar as the extension badge: a low grade is never "likely".
    const likely = verdict.probability >= 0.8 && verdict.grade !== "low";
    const head =
      verdict.yesDays === 0
        ? `**${subject}**: unlikely (${basis}).`
        : `**${subject}**: ${likely ? "likely" : "uncertain"} — at least ${pct}% Starlink (${basis}).`;
    const sched = verdict.scheduledRow ? `\n\n${legLine(verdict.scheduledRow)}` : "";
    return text(withLegNote(`${head} ${reason}${sched}`, verdict));
  }

  const lines = verdict.rows.map(legLine);
  const headline =
    verdict.hasStarlink === true
      ? `✈️ Yes, by scheduled aircraft type — ${subjectBase} on ${date}.`
      : verdict.hasStarlink === false
        ? `❌ No Starlink: ${subjectBase} on ${date}.`
        : verdict.qclass === "cancelled"
          ? `${subjectBase} on ${date}: cancelled.`
          : `Maybe — ${subjectBase} on ${date}.`;
  return text(
    withLegNote(
      `${headline} ${verdict.reason}${lines.length ? `\n\n${lines.join("\n")}` : ""}`,
      verdict
    )
  );
}

/**
 * Format confidence as a parenthetical qualifier — keeps it visually subordinate
 * to the probability number so they don't get mentally merged.
 * e.g. "92% (4 observed departures · medium confidence)" not "92% Likely — 4 obs, medium"
 */
function confidenceTag(nObs: number, confidence: string): string {
  return `(${nObs} observed departure${nObs === 1 ? "" : "s"} · ${confidence} confidence)`;
}

// Single shared FR24 client for route lookups. Module-level state is fine for
// a long-lived server. Cache is best-effort — failures degrade to "ask the user".
const fr24 = new FlightRadar24API();
type RouteEntry = {
  origin: string;
  destination: string;
  duration_hours?: number;
  /** From route history older than the L1 freshness window — may have changed. */
  stale?: boolean;
};

// Promise-based cache: concurrent requests for the same key await the in-flight
// fetch instead of hammering FR24. Dedupes parallel calls (e.g. 15 agents at once).
const routeCache = new Map<string, { promise: Promise<RouteEntry[]>; at: number; ttl: number }>();
const ROUTE_CACHE_TTL = 3600;
// Empty results are kept briefly: each miss re-ran a ~1.7s FR24 call, while a
// full hour would hide a route that appears minutes later.
const ROUTE_NEGATIVE_CACHE_TTL = 600;
// FR24 schedules reach ~a week ahead; asking about later dates is a guaranteed miss.
const FR24_ROUTE_HORIZON_SEC = 8 * 86400;

// Records which fallback layer answered — surfaces a stale cache or a vendor
// outage that would otherwise just look like silently-degraded results.
function recordRouteLookup(
  scope: Scope,
  source: "memory" | "assignment" | "sqlite" | "fr24" | "upcoming" | "stale" | "miss"
): void {
  metrics.increment(COUNTERS.ROUTE_LOOKUP, { source, airline: normalizeScopeTag(scope) });
}

/**
 * The queried date's legs, inside the same window lookupFlightTailVerdict
 * asks FR24 about. Best-effort: an outage or shed falls through to history.
 */
async function datedAssignmentRoutes(
  flightNumber: string,
  targetDateUnix: number,
  now: number
): Promise<RouteEntry[]> {
  const date = new Date(targetDateUnix * 1000).toISOString().slice(0, 10);
  const window = flightDateWindow(date);
  if (!window || window.end <= now - 86400 || window.start >= now + 3 * 86400) return [];
  let legs: Awaited<ReturnType<typeof cachedFlightAssignments>>;
  try {
    legs = await cachedFlightAssignments(flightNumber, window.mid, now);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: RouteEntry[] = [];
  for (const a of legs) {
    if (!matchesLocalDate(date, a.origin, a.departure_time, window.start, window.end)) continue;
    const key = `${a.origin}-${a.destination}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dur = a.arrival_time - a.departure_time;
    out.push({
      origin: a.origin,
      destination: a.destination,
      duration_hours: dur > 0 ? dur / 3600 : undefined,
    });
  }
  return out;
}

async function lookupFlightRoutes(
  cfg: AirlineConfig,
  reader: ScopedReader,
  uaFlightNumber: string,
  targetDateUnix?: number,
  /** liveAssignments: false on the hub, which never runs the FR24 tail lookup. */
  opts: { liveAssignments: boolean } = { liveAssignments: true }
): Promise<RouteEntry[]> {
  const cacheKey = `${uaFlightNumber}:${targetDateUnix ? Math.floor(targetDateUnix / 86400) : "any"}:${opts.liveAssignments ? "live" : "db"}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = routeCache.get(cacheKey);
  if (cached && now - cached.at < cached.ttl) {
    recordRouteLookup(reader.scope, "memory");
    return cached.promise;
  }

  // Keyspace is flightNumber × day → unbounded over time. Sweep stale entries
  // once the cache gets large (matches assignmentCache in flight-verdict.ts).
  if (routeCache.size > 500) {
    for (const [k, v] of routeCache) {
      if (now - v.at >= v.ttl) routeCache.delete(k);
    }
  }
  const variants = buildAirlineFlightNumberVariants(cfg, uaFlightNumber);

  const promise = (async (): Promise<RouteEntry[]> => {
    // L0: the date's own legs from the tail-lookup cache check_flight's
    // verdict already filled (so usually no extra FR24 call). L1 is keyed by
    // flight number alone, and an express number flies a different route
    // most days — UA5212 read IDA→ORD from history while flying SFO→PSP.
    if (opts.liveAssignments && targetDateUnix !== undefined) {
      const dated = await datedAssignmentRoutes(uaFlightNumber, targetDateUnix, now);
      if (dated.length > 0) {
        recordRouteLookup(reader.scope, "assignment");
        return dated;
      }
    }

    // L1: persistent SQLite cache (builds up over time, survives restarts).
    const sqliteCached = reader.getCachedFlightRoutes(uaFlightNumber, now - 7 * 86400);
    if (sqliteCached.length > 0) {
      recordRouteLookup(reader.scope, "sqlite");
      return sqliteCached.map((r) => ({
        origin: r.origin,
        destination: r.destination,
        duration_hours: r.duration_sec && r.duration_sec > 0 ? r.duration_sec / 3600 : undefined,
      }));
    }

    // L2: live FR24 lookup (best data, ~1wk forward). Persist result.
    const withinFr24Horizon =
      targetDateUnix === undefined || targetDateUnix <= now + FR24_ROUTE_HORIZON_SEC;
    if (withinFr24Horizon) {
      try {
        const found = await fr24.getFlightRoutes(uaFlightNumber, targetDateUnix);
        if (found.length > 0) {
          for (const r of found) {
            reader.cacheFlightRoute(
              uaFlightNumber,
              r.origin,
              r.destination,
              r.duration_sec || null
            );
          }
          recordRouteLookup(reader.scope, "fr24");
          return found.map((r) => ({
            origin: r.origin,
            destination: r.destination,
            duration_hours: r.duration_sec > 0 ? r.duration_sec / 3600 : undefined,
          }));
        }
      } catch {
        // fall through to L3
      }
    }

    // L3: our own upcoming_flights (sparse, ~2-day Starlink-plane snapshot)
    const rows = reader.getRoutesForFlightVariants(variants);
    if (rows.length > 0) {
      recordRouteLookup(reader.scope, "upcoming");
      return rows.map((r) => ({
        origin: r.departure_airport,
        destination: r.arrival_airport,
        duration_hours: r.dur_sec > 0 ? r.dur_sec / 3600 : undefined,
      }));
    }

    // L4: the flight's most recent known route, however old. L1's 7-day
    // freshness filter dropped history we had (UA1 SFO→SIN a month back), so a
    // date past FR24's horizon answered "route lookup failed". Not written
    // back: it is history, not a fresh observation.
    const last = reader.getFlightRoutePairs(variants)[0];
    recordRouteLookup(reader.scope, last ? "stale" : "miss");
    return last
      ? [
          {
            origin: last.departure_airport,
            destination: last.arrival_airport,
            duration_hours: last.dur_sec && last.dur_sec > 0 ? last.dur_sec / 3600 : undefined,
            stale: true,
          },
        ]
      : [];
  })();

  // Set immediately for in-flight dedup. An empty result stays for the short
  // negative TTL; an error is evicted so the next request retries.
  const entry = { promise, at: now, ttl: ROUTE_CACHE_TTL };
  routeCache.set(cacheKey, entry);
  promise.then(
    (result) => {
      if (result.length === 0) entry.ttl = ROUTE_NEGATIVE_CACHE_TTL;
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
  cfg: AirlineConfig,
  reader: ScopedReader,
  routes: RouteEntry[],
  targetDateUnix?: number,
  /**
   * The person's own flight: its row states the flight's own odds (a route
   * baseline would contradict the headline — UA123 ~0% vs "nonstop ~20%"),
   * and it is never offered back as an alternative. `label` marks a firm NO.
   */
  ownFlight?: { flightNumber: string; probability: number; label?: string }
): string {
  // The itinerary planner runs on the flight-history model; embedding its
  // table on a model-less carrier's scope would be foreign priors in
  // disguise. Callers tolerate "".
  if (!cfg.flightHistoryModel) return "";
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

  const notes: string[] = [];

  for (const r of routes.slice(0, 3)) {
    const segment = `${r.origin}→${r.destination}`;
    if (r.stale) {
      notes.push(`${segment} is based on last seen route — confirm the flight still flies it.`);
    }
    // One spare so dropping the person's own firm-NO flight still leaves two.
    const its = planItinerary(reader, r.origin, r.destination, {
      maxStops: 2,
      maxItineraries: 3,
      targetDateUnix,
    })
      .filter(
        (it) => !ownFlight || !it.legs.some((l) => l.flight_number === ownFlight.flightNumber)
      )
      .slice(0, 2);

    // Mainline-heavy nonstops sit below the graph threshold, so the person's
    // ORIGINAL flight is usually absent from the planner. Show it anyway: the
    // tradeoff ("nonstop ~16% of 5.7h → connection 87% of 6.6h") is the answer.
    // Its duration comes from the shared baseline so it never reads "~0 / —".
    const base = routeBaseline(reader, r.origin, r.destination);
    const observed = r.duration_hours ?? null;
    const durH = base && base.duration_source !== "great_circle" ? base.duration_hours : observed;
    const hours = durH ?? base?.duration_hours ?? null;
    const approx = durH === null ? "~" : "";
    const totalH = hours !== null ? `${approx}${fmtH(hours)}` : "?";
    if (ownFlight?.label) {
      rows.push({
        segment,
        flights: ownFlight.flightNumber,
        via: "direct — your flight",
        stops: 0,
        starlinkPct: `0% (${ownFlight.label})`,
        starlinkH: "0",
        totalH,
      });
    } else if (ownFlight) {
      const p = ownFlight.probability;
      rows.push({
        segment,
        flights: ownFlight.flightNumber,
        via: "direct — your flight",
        stops: 0,
        starlinkPct: approxPct(p),
        starlinkH: hours !== null ? approxShare(p, hours, fmtH) : "?",
        totalH,
      });
    } else if (!its.some((it) => it.via.length === 0)) {
      const directProb = base?.probability ?? 0;
      rows.push({
        segment,
        flights: base?.flight_number ? ensureAirlinePrefix(cfg, base.flight_number) : "nonstop",
        via: "direct — baseline",
        stops: 0,
        starlinkPct: approxPct(directProb),
        starlinkH: hours !== null ? approxShare(directProb, hours, fmtH) : "?",
        totalH,
      });
    }

    if (its.length === 0) {
      notes.push(
        hours !== null && ENFORCE_ITINERARY_TIME_BUDGET
          ? `${segment}: no Starlink routing within +${fmtH(itineraryHourBudget(hours) - hours)} of the nonstop.`
          : `${segment}: no Starlink routing found.`
      );
      continue;
    }

    for (const it of its) {
      const legs = it.legs
        .map((l) => (l.flight_number === "(any)" ? "any flight" : l.flight_number))
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
  // Blank line first: GFM would otherwise absorb a trailing text line as a row.
  const notesBlock = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";

  return `<present_verbatim>
| Segment | Flights | Via | Stops | Starlink % | Starlink hrs | Total hrs |
|---|---|---|---|---|---|---|
${tableRows}${notesBlock}
</present_verbatim>

Render the table above in your response EXACTLY — do not summarize it into prose, do not drop columns.${segmentNote} This is the complete answer: no more tool calls, no "download offline" / "use legacy WiFi" / "mobile hotspot" tips (non-responsive — they asked for better FLIGHTS). Connections are built from route history, not same-day schedules — verify they connect on ${cfg.verifySite} before rebooking. Starlink % = coverage ratio (Starlink hrs / total hrs); Total hrs is flying time, excluding layovers.`;
}

/** Format carrierPrediction for MCP — model-less carriers' predict answer. */
function formatCarrierPrediction(
  cfg: AirlineConfig,
  reader: ScopedReader,
  normalized: string
): ToolResult {
  const answer = carrierPrediction(cfg, reader, normalized);
  const t = carrierPredictionTelemetry(answer);
  recordFlightLookup("mcp", t.outcome, t.confidence, reader.scope);
  const text =
    answer.kind === "penetration"
      ? `**${normalized}**: ${joinSentences(describeCarrierPrediction(cfg, answer), "For a firm answer, use check_flight with a date to see the scheduled aircraft")}`
      : joinSentences(
          describeCarrierPrediction(cfg, answer),
          "Use check_flight with a date to see the scheduled aircraft"
        );
  return textResult(text);
}

/** Format carrierRouteAnswer for MCP — model-less carriers' route answer. */
function formatCarrierRoute(
  cfg: AirlineConfig,
  reader: ScopedReader,
  origin: string | null,
  destination: string | null
): ToolResult {
  const r = origin && destination ? carrierRouteAnswer(cfg, reader, origin, destination) : null;
  const t = carrierPredictionTelemetry(r);
  recordFlightLookup("mcp", t.outcome, t.confidence, reader.scope);
  if (!r) {
    return textResult(
      joinSentences(
        `Route-level prediction isn't available for ${cfg.name} — Starlink status is determined by aircraft type, not route history`,
        cfg.rollout.phaseNote,
        "Use check_flight with a flight number and date to see the scheduled aircraft"
      )
    );
  }

  const route = `${origin}→${destination}`;
  const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
  const footer = "For a specific flight, use check_flight with the flight number and date.";
  let text: string;
  if (r.kind === "observed_mixed" && r.lo != null && r.hi != null) {
    const breakdown = r.breakdown
      .map((b) => `- ${b.label}${b.hint ? ` (${b.hint})` : ""}: ${approxPct(b.pct)}`)
      .join("\n");
    text = `**${route} (${cfg.name})**: ${pct(r.lo)}–${pct(r.hi)} Starlink — ${r.reason.toLowerCase()}:\n${breakdown}\n${footer}`;
  } else {
    text = `**${route} (${cfg.name})**: ${joinSentences(`${approxPct(r.probability)} Starlink — ${r.reason}`, footer)}`;
  }
  return textResult(text);
}

// Hub lookup-only carriers (QR): answered per flight, absent from compareRoute's
// public panel, so the route tools would otherwise report "no route data".
const HUB_LOOKUP_ONLY = hubLookupAirlines().filter((a) => !a.publicInHub);

/** QR's nonstop from its published schedule — equipment type decides Starlink. */
function hubLookupRouteLines(getReader: GetReader, origin: string, destination: string): string[] {
  if (!HUB_LOOKUP_ONLY.some((a) => a.code === "QR")) return [];
  const now = Math.floor(Date.now() / 1000);
  const rows = getReader("QR")
    .getQatarScheduleByRoute(
      origin,
      destination,
      now,
      now + (QATAR_PUBLISHED_DAYS_FORWARD + 1) * 86400
    )
    .filter((r) => (r.flight_status ?? "").toUpperCase() !== "CANCELLED");
  if (rows.length === 0) return [];
  const classes = rows.map((r) => qatarEquipmentClass(r.equipment_code));
  const yes = classes.filter((c) => c === "yes").length;
  const rolling = classes.filter((c) => c === "rolling").length;
  const flights = [...new Set(rows.map((r) => r.flight_number))];
  const shown = flights.slice(0, 5).join(", ") + (flights.length > 5 ? ", …" : "");
  const rollingNote = rolling > 0 ? `, ${rolling} more on a type still being fitted` : "";
  return [
    `- **Qatar Airways**: ${yes} of ${rows.length} scheduled departures in the next ~${QATAR_PUBLISHED_DAYS_FORWARD} days on Starlink-fitted aircraft types${rollingNote} (${shown}). Starlink follows the aircraft type, so use check_flight with the QR flight number and date for a per-flight answer.`,
  ];
}

/**
 * Hub route answer: per-airline nonstop odds from the registry/penetration
 * (same engine as the hub's /api/compare-route). The itinerary planner and
 * predictRoute run the UA-trained model — on the ALL-scope reader they would
 * score other airlines' flights with United's priors.
 */
function formatHubRouteComparison(
  getReader: GetReader,
  origin: string | null,
  destination: string | null
): ToolResult {
  if (!origin || !destination) {
    return toolError(
      "On the multi-airline server, route predictions compare carriers on a specific O-D pair — both origin and destination are required. For one-sided searches, use an airline-specific scope (e.g. ?scope=UA on the connector URL)."
    );
  }
  const results = compareRoute(getReader, origin, destination);
  const lookupLines = hubLookupRouteLines(getReader, origin, destination);
  const answered = results.length > 0 || lookupLines.length > 0;
  recordFlightLookup("mcp", answered ? "predicted" : "no_data", answered ? "low" : "none", "ALL");
  if (results.length === 0) {
    const lookupNames = HUB_LOOKUP_ONLY.map((a) => `${a.name} (${a.iata}…)`).join(", ");
    return textResult(
      lookupLines.length > 0
        ? `**${origin}→${destination} — Starlink odds by airline (nonstop)**\n\n${lookupLines.join("\n")}`
        : `No route data for ${origin}→${destination} on any tracked airline yet. For a specific flight, use check_flight with the flight number and date${lookupNames ? ` — ${lookupNames} ${HUB_LOOKUP_ONLY.length === 1 ? "answers" : "answer"} per flight there` : ""}.`
    );
  }
  const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
  const lines = results.map((r) => {
    if (r.kind === "no_data") return `- **${r.name}**: no route data yet`;
    const range =
      r.lo != null && r.hi != null ? `${pct(r.lo)}–${pct(r.hi)}` : approxPct(r.probability);
    return `- **${r.name}**: ${range} Starlink${r.reason ? ` — ${r.reason}` : ""}`;
  });
  lines.push(...lookupLines);
  return textResult(
    `**${origin}→${destination} — Starlink odds by airline (nonstop)**\n\n${lines.join("\n")}\n\nFor itinerary planning or flight-level detail, use an airline-specific scope (e.g. \`?scope=UA\`) or check_flight with a flight number and date.`
  );
}

async function toolPredictFlightStarlink(
  hostReader: ScopedReader,
  getReader: GetReader,
  args: { flight_number?: unknown; date?: unknown }
): Promise<ToolResult> {
  const input =
    typeof args.flight_number === "string" ? canonicalFlightInput(args.flight_number) : "";
  if (!input) {
    return toolError("Error: flight_number is required.");
  }

  const givenDate = typeof args.date === "string" ? args.date.trim() : "";
  if (givenDate && !isRealIsoDate(givenDate)) return invalidDateError();

  const carrier = resolveFlightToolCarrier(hostReader, getReader, input, "lookup");
  if ("content" in carrier) return carrier;
  const { cfg, reader } = carrier;
  // On the hub, QR's answer is date-shaped (published type in the window,
  // observed-type history beyond), so predict routes through the same verdict
  // as check_flight. Without a date, a date just past the window asks for the
  // flight's general history. The QR tenant keeps its registry answer, which
  // its REST /api/predict-flight mirrors.
  if (hostReader.scope === "ALL" && cfg.hubFlightLookup) {
    const given = typeof args.date === "string" ? args.date.trim() : "";
    const nowSec = Math.floor(Date.now() / 1000);
    const date = given || addDaysISO(dohDateISO(nowSec), QATAR_PUBLISHED_DAYS_FORWARD + 1);
    return toolCheckFlight(
      hostReader,
      getReader,
      { flight_number: input, date },
      { undated: !given }
    );
  }
  const forPredict = ensureAirlinePrefix(cfg, input);
  // Same shape check the check-flight core and /api/predict-flight enforce —
  // prevents agents driving FR24 route lookups with junk ("XX", "UA12345").
  if (!isPlausibleFlightNumber(cfg, forPredict)) {
    return toolError(
      `${forPredict} is not a valid flight number (expected ${cfg.iata} + 1-4 digits).`
    );
  }

  // No flight-history model → registry-driven answer, same seam as the core.
  if (!cfg.flightHistoryModel) return formatCarrierPrediction(cfg, reader, forPredict);

  const pred = predictFlight(reader, forPredict);
  recordFlightLookup(
    "mcp",
    pred.n_observations > 0 ? "predicted" : "no_data",
    pred.confidence,
    reader.scope
  );
  recordPrediction(pred, reader.scope);

  let details: string;
  if (pred.method !== "flight_history_smoothed") {
    const fleet = inferSubfleet(cfg, forPredict);
    const fleetLabel = fleet === "express" ? "express (regional)" : "mainline";
    details = `No history for this flight number; our ${fleetLabel} estimate for flights not yet seen on a Starlink aircraft — not flight-specific.`;
  } else {
    details =
      pred.n_observations >= 5 ? "Sample size is solid." : "Limited data — estimate may drift.";
  }

  const probLine = `**${forPredict}**: ${approxPct(pred.probability)} Starlink probability ${pred.method === "flight_history_smoothed" ? confidenceTag(pred.n_observations, pred.confidence) : "(fleet prior)"}. ${details}`;

  // Alternatives LAST so it's the agent's final impression (recency bias).
  let altBlock = "";
  if (pred.probability < 0.2) {
    const date = typeof args.date === "string" ? args.date.trim() : "";
    const window = date ? flightDateWindow(date) : null;
    const dateUnix = window ? window.mid : undefined;
    const routes = await lookupFlightRoutes(cfg, reader, forPredict, dateUnix, {
      liveAssignments: hostReader.scope !== "ALL",
    });
    const own = { flightNumber: forPredict, probability: pred.probability };
    altBlock = `\n\n${buildAlternativesBlock(cfg, reader, routes, dateUnix, own)}`;
  }

  return textResult(`${probLine}${altBlock}`);
}

/** Trimmed airport arg; K/P-prefixed ICAO resolves to IATA, as check_flight's leg params do. */
function airportArg(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return normalizeAirportCode(trimmed) ?? trimmed;
}

function sameAirportError(code: string): ToolResult {
  return toolError(
    `Origin and destination are the same (${code.toUpperCase()}). Please specify a different destination.`
  );
}

function toolPlanStarlinkItinerary(
  reader: ScopedReader,
  getReader: GetReader,
  args: {
    origin?: unknown;
    destination?: unknown;
    max_results?: unknown;
    max_stops?: unknown;
    date?: unknown;
  }
): ToolResult {
  const origin = airportArg(args.origin) ?? "";
  const destination = airportArg(args.destination) ?? "";
  const maxResults =
    typeof args.max_results === "number" && args.max_results > 0
      ? Math.min(args.max_results, 20)
      : 8;
  const maxStops =
    typeof args.max_stops === "number" && args.max_stops >= 0 ? Math.min(args.max_stops, 3) : 2;

  // Optional date for confirmed-edge seeding. Without a date (or outside the
  // ~2-day snapshot window), the planner uses historical prediction only.
  const dateStr = typeof args.date === "string" ? args.date.trim() : "";
  if (dateStr && !isRealIsoDate(dateStr)) return invalidDateError();
  const dateWindow = dateStr ? flightDateWindow(dateStr) : null;
  const targetDateUnix = dateWindow ? dateWindow.mid : undefined;

  if (!origin || !destination) {
    return toolError("Error: both origin and destination are required.");
  }

  if (origin.toUpperCase() === destination.toUpperCase()) return sameAirportError(origin);

  // Hub scope: per-airline comparison — the planner is the UA model and must
  // not score the multi-airline reader's edges.
  if (reader.scope === "ALL") {
    return formatHubRouteComparison(getReader, origin.toUpperCase(), destination.toUpperCase());
  }
  const cfg = scopeCfg(reader.scope);
  if (!cfg) return scopeConfigError(reader.scope);
  const unknown = unknownAirportError(cfg, reader, origin, destination);
  if (unknown) return unknown;
  // The itinerary planner runs on the flight-history model. Model-less
  // carriers answer the nonstop from the registry (route rule / penetration).
  if (!cfg.flightHistoryModel) {
    return formatCarrierRoute(cfg, reader, origin.toUpperCase(), destination.toUpperCase());
  }

  const itineraries = planItinerary(reader, origin, destination, {
    maxItineraries: maxResults,
    maxStops,
    targetDateUnix,
  });

  // Itinerary planning is graph-search prediction; map coverage to confidence
  // so the cross-channel lookup metric still distinguishes "found a path" from
  // "no Starlink routing exists on this O-D pair".
  recordFlightLookup(
    "mcp",
    itineraries.length > 0 ? "predicted" : "no_data",
    itineraries.length === 0
      ? "none"
      : itineraries.some((it) => it.coverage === "full")
        ? "medium"
        : "low",
    reader.scope
  );

  const baseline = routeBaseline(reader, origin, destination);
  const fmtBaseH = (h: number) => (h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(h * 60)}m`);
  const hasNonstop = baseline !== null && baseline.duration_source !== "great_circle";
  const orig = origin.toUpperCase();
  const dest = destination.toUpperCase();
  const sparseNonstop = baseline?.duration_source === "sparse_history";
  const sparseFlight = sparseNonstop
    ? (baseline.flight_number ??
      reader.getRouteFlightNumbers(orig, dest).flightNumbers[0]?.flight_number ??
      null)
    : null;
  const nonstopStats = baseline
    ? `${approxPct(baseline.probability)} Starlink · ${approxShare(baseline.probability, baseline.duration_hours, fmtBaseH, baseline.expected_starlink_hours)} Starlink / ~${fmtBaseH(baseline.duration_hours)} flying`
    : "";
  const baselineLine = !baseline
    ? ""
    : sparseNonstop
      ? `**Occasional nonstop** (${sparseFlight ?? "United nonstop"}, seen only occasionally — it may not operate on the requested date): ${nonstopStats}`
      : hasNonstop
        ? `**Nonstop baseline** (${baseline.flight_number ?? "typical nonstop"}): ${nonstopStats}`
        : `**No United nonstop** ${orig}→${dest} has been observed, so every option connects (straight-line flying time ~${fmtBaseH(baseline.duration_hours)} for reference).`;

  if (itineraries.length === 0) {
    const headline =
      hasNonstop && !sparseNonstop && ENFORCE_ITINERARY_TIME_BUDGET
        ? `No Starlink routing within +${fmtBaseH(itineraryHourBudget(baseline.duration_hours) - baseline.duration_hours)} of the nonstop from ${orig} to ${dest} (up to ${maxStops} stops).`
        : `No Starlink routings found from ${orig} to ${dest} within ${maxStops} stops.`;
    const lastResort = sparseNonstop
      ? `otherwise advise checking whether the occasional nonstop${sparseFlight ? ` (${sparseFlight})` : ""} operates on the date, else the fastest United connection`
      : hasNonstop
        ? "otherwise advise booking the nonstop — no Starlink routing meaningfully improves odds on mainline-only routes"
        : "otherwise advise the fastest United connection — there is no nonstop to fall back on";
    return textResult(
      `${headline}${baselineLine ? `\n\n${baselineLine}` : ""}\n\nNo reasonable path through the Starlink route graph connects these airports. This may be a mainline-only route, where fleet-wide coverage is much lower than on express.\n\n**Fallbacks**: (1) \`search_starlink_flights\` with just \`destination="${dest}"\` or \`origin="${orig}"\` — confirmed near-term assignments may exist even when historical probability is low; (2) if the user has a specific flight, \`predict_flight_starlink\` for a per-flight estimate; (3) ${lastResort}.`
    );
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
      const dur =
        leg.duration_hours !== null ? `~${fmtHours(leg.duration_hours)} est.` : "duration unknown";
      return `position ${from}→${to} (mainline, ~${(leg.probability * 100).toFixed(0)}% Starlink, ${dur})`;
    }
    const pct = (leg.probability * 100).toFixed(0);
    const fleetTag = inferSubfleet(cfg, leg.flight_number) === "mainline" ? " [Mainline]" : "";
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
        ? `**No all-Starlink path found within ${maxStops} stops.** Partial coverage options (one low-probability positioning leg, one Starlink leg):\n`
        : "**Baseline: 1-stop positioning + Starlink connection** (for comparison — what a 'normal' routing gets you):\n";
    sections.push(`${header}
${partialItins.map((it, i) => renderItin(it, fullItins.length + i)).join("\n\n")}`);
  }

  const hasMultiLeg = itineraries.some((it) => it.legs.length > 1);
  const timingNote = hasMultiLeg
    ? `\n\n⚠️ Connection timing NOT validated — verify legs actually connect same-day on ${cfg.verifySite}.`
    : "";

  const hasDirect = itineraries.some((it) => it.via.length === 0);
  const baselineSection = baselineLine && !hasDirect ? `${baselineLine}\n\n` : "";

  const text = `**Starlink routings: ${origin.toUpperCase()} → ${destination.toUpperCase()}**

${baselineSection}${sections.join("\n\n---\n\n")}${timingNote}

**Ranking**: by coverage ratio (expected Starlink hours / total hours), with a small penalty per stop. Connections are limited to ${ENFORCE_ITINERARY_TIME_BUDGET ? "a modest time premium over the nonstop (1h allowed per layover)" : "the geographic detour bound"}. "~1.8h Starlink / ~7h flying (26%)" = 26% of flight time expected on Starlink.`;

  return textResult(text);
}

function toolPredictRouteStarlink(
  reader: ScopedReader,
  getReader: GetReader,
  args: { origin?: unknown; destination?: unknown; limit?: unknown }
): ToolResult {
  const origin = airportArg(args.origin);
  const destination = airportArg(args.destination);
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 50) : 10;

  if (!origin && !destination) {
    return toolError("Error: at least one of origin or destination is required.");
  }

  if (origin && destination && origin.toUpperCase() === destination.toUpperCase()) {
    return sameAirportError(origin);
  }

  // Hub scope: per-airline comparison — predictRoute is the UA model and must
  // not rank other airlines' flights with United's priors.
  if (reader.scope === "ALL") {
    return formatHubRouteComparison(
      getReader,
      origin ? origin.toUpperCase() : null,
      destination ? destination.toUpperCase() : null
    );
  }
  const cfg = scopeCfg(reader.scope);
  if (!cfg) return scopeConfigError(reader.scope);
  const unknown = unknownAirportError(cfg, reader, origin, destination);
  if (unknown) return unknown;
  // predictRoute ranks flights with the flight-history model — model-less
  // carriers get the registry answer (route rule / penetration) instead.
  if (!cfg.flightHistoryModel) {
    return formatCarrierRoute(
      cfg,
      reader,
      origin ? origin.toUpperCase() : null,
      destination ? destination.toUpperCase() : null
    );
  }

  const result = predictRoute(reader, origin || null, destination || null);

  if (result.flights.length === 0) {
    recordFlightLookup("mcp", "no_data", "none", reader.scope);
    // No DIRECT Starlink flights on this route. If both endpoints given,
    // inline the connection-based alternatives so the agent never sees a
    // dead-end that contradicts check_flight's embedded alternatives.
    if (origin && destination) {
      const alt = buildAlternativesBlock(cfg, reader, [
        { origin: origin.toUpperCase(), destination: destination.toUpperCase() },
      ]);
      return textResult(
        `No DIRECT Starlink flight on ${origin.toUpperCase()}→${destination.toUpperCase()} — this tool only finds single-route flights. Connection-based alternatives below:\n\n${alt}`
      );
    }
    return textResult(
      `${result.coverage_note}\n\nIf you have a specific flight number, try predict_flight_starlink for a fleet-prior estimate.`
    );
  }

  const shown = result.flights.slice(0, limit);
  // Top-ranked flight is the headline answer; per-flight points feed the
  // probability distribution so MCP-served route predictions are visible.
  recordFlightLookup("mcp", "predicted", shown[0].confidence, reader.scope);
  for (const f of shown) recordPrediction(f, reader.scope);
  const lines = shown.map((f) => {
    const pct = (f.probability * 100).toFixed(0);
    const fleet = inferSubfleet(cfg, f.flight_number);
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

  return textResult(text);
}

/**
 * isError only when a code can't be an airport or nothing has ever seen it.
 * AIRPORT_COORDS alone would reject real regional airports it lacks, so the
 * schedule snapshot and flight_routes history get a vote too. Without this,
 * origin "XXX" came back as a normal "no routings" answer that told the agent
 * to call search_starlink_flights with origin="XXX".
 */
function unknownAirportError(
  cfg: AirlineConfig,
  reader: ScopedReader,
  ...codes: (string | undefined)[]
): ToolResult | null {
  const prefixes = [cfg.iata, cfg.icao, ...cfg.carrierPrefixes];
  for (const raw of codes) {
    if (!raw) continue;
    const code = raw.toUpperCase();
    const known =
      /^[A-Z]{3}$/.test(code) &&
      (AIRPORT_COORDS[code] !== undefined || reader.airlineServesAirports(prefixes, code));
    if (!known) {
      return toolError(
        `Unknown airport code ${code}. Use a 3-letter IATA airport code (e.g. SFO).`
      );
    }
  }
  return null;
}

// A scope can be registered (VALID_SCOPES) before its airline config exists —
// fail closed with a clean tool error, not a TypeError 500.
function scopeConfigError(scope: Scope): ToolResult {
  return toolError(`Error: no airline registered for scope "${scope}".`);
}

function toolGetFleetStats(reader: ScopedReader): ToolResult {
  const lastUpdated = reader.getLastUpdated();
  const pct = (starlink: number, total: number) =>
    total > 0 ? ((starlink / total) * 100).toFixed(1) : "0.0";

  // Null fleetStats = hub scope: per-airline breakdown — there is no
  // single-airline subfleet split, and the hub must never present one
  // airline's as its own.
  const fleetStats = reader.getFleetStats();
  if (!fleetStats) {
    const per = reader.getPerAirlineStats();
    const agg = aggregatePenetration(per);
    // A community guide lags installs, so its count is a floor.
    const floor = (a: { code: string }) => Boolean(AIRLINES[a.code]?.communitySource);
    const lines = per.map(
      (a) =>
        `**${a.name}**: ${floor(a) ? "at least " : ""}${a.starlink} of ${a.total} aircraft (${pct(a.starlink, a.total)}%)${a.phaseNote ? ` — ${a.phaseNote}` : ""}`
    );
    const text = `Starlink Installation Progress (as of ${lastUpdated}):

**All tracked airlines**: ${per.some(floor) ? "at least " : ""}${agg.starlink} of ${agg.total} aircraft (${pct(agg.starlink, agg.total)}%) have Starlink WiFi

${lines.join("\n")}`;
    return textResult(text);
  }

  // Single-airline scope: branding and rollout prose come from the registry
  // config — no airline literals (this text serves every /mcp host).
  const cfg = AIRLINES[reader.scope];
  if (!cfg) return scopeConfigError(reader.scope);
  const totalCount = reader.getTotalCount();
  const starlinkPlanes = reader.getStarlinkPlanes();
  const subfleetLines = [
    fleetStats.express.total > 0
      ? `**Express (Regional) Fleet**: ${fleetStats.express.starlink} of ${fleetStats.express.total} aircraft (${fleetStats.express.percentage.toFixed(1)}%)`
      : null,
    fleetStats.mainline.total > 0
      ? `**Mainline Fleet**: ${fleetStats.mainline.starlink} of ${fleetStats.mainline.total} aircraft (${fleetStats.mainline.percentage.toFixed(1)}%)`
      : null,
  ].filter((l) => l !== null);
  const familyLines = reader
    .getFleetPageData()
    .families.filter((f) => f.family !== "unknown")
    .map((f) => `- ${f.family}: ${f.starlink} of ${f.total} (${pct(f.starlink, f.total)}%)`);
  const text = [
    `${cfg.name} Starlink Installation Progress (as of ${lastUpdated}):`,
    `**Combined Fleet**: ${starlinkPlanes.length} of ${totalCount} aircraft (${pct(starlinkPlanes.length, totalCount)}%) have Starlink WiFi`,
    subfleetLines.join("\n"),
    familyLines.length > 0 ? `**By Aircraft Type**:\n${familyLines.join("\n")}` : null,
    `**Rollout**: ${cfg.rollout.statusLabel} — ${cfg.rollout.phaseNote}`,
    "Starlink WiFi is free for passengers on equipped aircraft.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return textResult(text);
}

function toolListStarlinkAircraft(
  reader: ScopedReader,
  args: { fleet?: unknown; limit?: unknown }
): ToolResult {
  const fleet = args.fleet === "express" || args.fleet === "mainline" ? args.fleet : undefined;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 50;

  let planes = reader.getStarlinkPlanes();
  // Regional rows carry the operator's own label (AS stores "horizon"), so
  // "express" is everything that isn't mainline — the split get_fleet_stats uses.
  if (fleet) {
    planes = planes.filter((p) => (p.fleet === "mainline") === (fleet === "mainline"));
  }

  const total = planes.length;
  const shown = planes.slice(0, limit);

  // Type-settled rows carry DateFound NULL by design — omit the clause rather
  // than render "first seen null".
  const lines = shown.map(
    (p) =>
      `${p.TailNumber} — ${p.Aircraft || "Unknown type"} (${p.fleet}, ${p.OperatedBy}${p.DateFound ? `, first seen ${p.DateFound}` : ""})`
  );

  const carrier =
    reader.scope === "ALL" ? "tracked airlines" : AIRLINES[reader.scope]?.name || reader.scope;
  const header = fleet
    ? `${total} Starlink-equipped aircraft in the ${carrier} ${fleet} fleet`
    : `${total} Starlink-equipped aircraft (${carrier})`;

  return textResult(`${header} (showing ${shown.length}):\n\n${lines.join("\n")}`);
}

/**
 * The number a traveller books, never a raw callsign: rows are stored as FR24
 * reports them (SKW3490, ASA827 on a Hawaiian tail), which check_flight can't
 * take. Another carrier's own code resolves to that carrier (ASA827 → AS827);
 * a regional operator's code (OO/SKW) carries the row airline's marketing
 * number, the same equivalence UA's carrierPrefixes encode.
 */

// Past the ~48h schedule cache; only a bound, never a window the data fills.
const SEARCH_HORIZON_SEC = 14 * 86400;

/** "~16%", but a plain "0%": a hedge on zero reads as a maybe on a no. */
export function approxPct(p: number): string {
  const n = Number((p * 100).toFixed(0));
  return n === 0 ? "0%" : `~${n}%`;
}

/** Expected Starlink time for a share of `hours`, "0" when the share rounds to 0%. */
function approxShare(
  p: number,
  hours: number,
  fmt: (h: number) => string,
  expected = p * hours
): string {
  return approxPct(p) === "0%" ? "0" : `~${fmt(expected)}`;
}

function toolSearchStarlinkFlights(
  reader: ScopedReader,
  args: { origin?: unknown; destination?: unknown; limit?: unknown }
): ToolResult {
  const origin = airportArg(args.origin)?.toUpperCase();
  const destination = airportArg(args.destination)?.toUpperCase();
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 100) : 20;

  if (!origin && !destination) {
    return toolError("Error: at least one of origin or destination must be provided.");
  }

  const now = Math.floor(Date.now() / 1000);
  // One entry per physical departure: a tail swap leaves the old row behind,
  // so the slot is claimed first and only then tested for Starlink.
  const allFuture = reader
    .getDepartureSlots({ from: now + 1, to: now + SEARCH_HORIZON_SEC, partners: true })
    .filter((f) => f.equipped === 1);

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
    return textResult(
      `No confirmed Starlink flights found for ${routeDesc} in the next ~2 days.\n\nNote: this tool only sees confirmed assignments through ~${dataHorizon}. If you need dates beyond that, use predict_route_starlink or plan_starlink_itinerary for probability-based planning instead — absence from this tool does NOT mean no Starlink.`
    );
  }

  // Hub rows span airlines — normalize each flight number under its OWN
  // carrier's config (never United's against another airline's rows).
  // scopeCfg is null on the hub by design, not a config error.
  const pinnedCfg = scopeCfg(reader.scope);
  if (reader.scope !== "ALL" && !pinnedCfg) return scopeConfigError(reader.scope);
  const lines = shown.map((f) => {
    const rowCfg = pinnedCfg ?? AIRLINES[f.airline] ?? null;
    const fn = rowCfg ? marketingFlightNumber(rowCfg, f.flight_number) : f.flight_number;
    const dep = new Date(f.departure_time * 1000).toISOString().slice(0, 16).replace("T", " ");
    return `${fn} ${f.departure_airport}→${f.arrival_airport} dep ${dep}Z (tail ${f.tail_number})`;
  });

  const routeDesc = origin && destination ? `${origin}→${destination}` : origin || destination;
  return textResult(
    `Found ${total} confirmed Starlink flight${total === 1 ? "" : "s"} for ${routeDesc} (showing ${shown.length}):\n\n${lines.join("\n")}\n\nSchedule data extends through ~${dataHorizon}. For dates beyond that, use predict_route_starlink or plan_starlink_itinerary.`
  );
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
  reader: ScopedReader,
  scope: Scope,
  hostScope: Scope,
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

  const carrier = scopeLabel(scope);
  // serverInfo.name uses the airline's metricTag ("united", "qatar", "alaska",
  // "hawaiian"), with "airline" for ALL — gives stable, recognizable names that
  // don't shift if we ever rename a code.
  const slug =
    scope === "ALL" ? "airline" : (AIRLINES[scope as AirlineCode]?.metricTag ?? "airline");

  // Include LIVE fleet stats in instructions so the agent has accurate priors
  // and doesn't hallucinate about coverage levels. UA-specific fleet realities
  // only make sense for UA scope; for other single-airline scopes the
  // express/mainline split may be empty, and on the hub there is no split at
  // all (getFleetStats is null) — so omit it.
  let fleetParagraph = "";
  const fleetStats = reader.getFleetStats();
  if (fleetStats) {
    const expressPct = fleetStats.express.percentage.toFixed(0);
    const mainlinePct = fleetStats.mainline.percentage.toFixed(1);
    const hasFleetSplit = fleetStats.express.total > 0 || fleetStats.mainline.total > 0;
    fleetParagraph =
      scope === "UA"
        ? `Fleet reality:\n• Express/regional (UA3000-6999): ~${expressPct}% Starlink\n• Mainline (UA1-2999, 737/787/etc): only ~${mainlinePct}% — assume NO Starlink on long-haul\n\n`
        : hasFleetSplit
          ? `Fleet reality (${carrier}):\n• Mainline: ~${mainlinePct}% Starlink\n• Express/regional: ~${expressPct}% Starlink\n\n`
          : "";
  }

  const scopeNotice =
    scope === hostScope
      ? `Scope: ${carrier}.`
      : `Scope: ${carrier} (override of host default via ?scope=${scope}).`;

  const planner = scopeHasPlanner(scope);
  // The hub embeds the table too: its UA flight answers run on UA's planner.
  const embedsAlternatives = planner || scope === "ALL";

  const overrideOptions = VALID_SCOPES.filter((s) => s !== scope).join("|");
  const overrideHint = `To change scope, append \`?scope=${overrideOptions}\` to the connector URL.`;

  return rpcResult(id, {
    protocolVersion,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: `${slug}-starlink-tracker`,
      title: `${scopeTitle(scope)} Starlink Tracker`,
      version: MCP_SERVER_VERSION,
      websiteUrl: mcpWebsiteUrl(hostScope),
    },
    instructions: `${scopeTitle(scope)} Starlink tracker. ${scopeNotice} ${overrideHint}

${fleetParagraph}People who install this connector care about Starlink hours, but not at any cost. When presenting connections, show each option's total time and stops next to the nonstop, and recommend a connection only when the extra time is modest for the Starlink gained. Compare coverage ratio (expected Starlink hours / total hours), not leg percentages. Connections are built from route history, not same-day schedules — say they should be confirmed on the airline's site before booking.

Tool selection:
• Routing/tradeoff → plan_starlink_itinerary (${planner ? "multi-stop, coverage ratio" : scope === "ALL" ? "per-airline nonstop comparison" : "nonstop odds by aircraft type"})
• Specific flight number → check_flight (≤2 days out) or predict_flight_starlink (further out, pass date)
${scope === "ALL" ? HUB_LOOKUP_INSTRUCTION : ""}• Route without flight number → predict_route_starlink
• search_starlink_flights = next ~2 days confirmed only
${
  embedsAlternatives
    ? `
⚠️ Low/no Starlink flight: check_flight and predict_flight_starlink EMBED a markdown table of alternatives (route looked up + planItinerary run for you). RENDER THE TABLE — don't summarize it into prose, don't ask which segment (both are shown), don't re-call predict_route_starlink (only finds directs, misses the connections in the table), don't add "download offline" / "use legacy WiFi" / "mobile hotspot" tips (non-responsive — they asked for better FLIGHTS).
`
    : ""
}
When a tool wraps content in <present_verbatim>...</present_verbatim>, copy that content into your response unchanged. This is a hard constraint, not a suggestion.`,
  });
}

function recordMcpToolCall(
  tool: string,
  scope: Scope,
  outcome: "success" | "error" | "unknown_tool",
  startMs: number
): void {
  // Bound the `tool` tag — /mcp is public and `params.name` is caller-controlled.
  const tags = {
    tool: TOOL_NAMES.includes(tool) ? tool : "unknown",
    airline: normalizeScopeTag(scope),
    outcome,
  };
  metrics.increment(COUNTERS.MCP_TOOL_CALL, tags);
  // unknown_tool durations are just switch overhead — meaningless distribution noise.
  if (outcome !== "unknown_tool") {
    metrics.distribution(DISTRIBUTIONS.MCP_TOOL_DURATION_MS, performance.now() - startMs, tags);
  }
}

async function handleToolsCall(
  reader: ScopedReader,
  getReader: GetReader,
  scope: Scope,
  id: string | number | null,
  params: Record<string, unknown> | undefined
): Promise<JsonRpcResponse> {
  const toolName = typeof params?.name === "string" ? params.name : undefined;
  const args = (params?.arguments as Record<string, unknown>) || {};

  if (!toolName) {
    return rpcError(id, -32602, "Missing required param: name");
  }

  const startMs = performance.now();
  let result: ToolResult;
  try {
    switch (toolName) {
      case "check_flight":
        result = await toolCheckFlight(reader, getReader, args);
        break;
      case "predict_flight_starlink":
        result = await toolPredictFlightStarlink(reader, getReader, args);
        break;
      case "predict_route_starlink":
        result = toolPredictRouteStarlink(reader, getReader, args);
        break;
      case "plan_starlink_itinerary":
        result = toolPlanStarlinkItinerary(reader, getReader, args);
        break;
      case "get_fleet_stats":
        result = toolGetFleetStats(reader);
        break;
      case "list_starlink_aircraft":
        result = toolListStarlinkAircraft(reader, args);
        break;
      case "search_starlink_flights":
        result = toolSearchStarlinkFlights(reader, args);
        break;
      default: {
        recordMcpToolCall(toolName, scope, "unknown_tool", startMs);
        const suggestion = suggestTool(toolName);
        const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
        return rpcError(
          id,
          -32602,
          `Unknown tool "${toolName}".${hint} Available tools: ${TOOL_NAMES.join(", ")}.`
        );
      }
    }
  } catch (err) {
    recordMcpToolCall(toolName, scope, "error", startMs);
    throw err;
  }

  recordMcpToolCall(toolName, scope, result.isError ? "error" : "success", startMs);
  return rpcResult(id, result);
}

async function dispatch(
  reader: ScopedReader,
  getReader: GetReader,
  scope: Scope,
  hostScope: Scope,
  msg: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize":
      return handleInitialize(reader, scope, hostScope, id, msg.params);
    case "notifications/initialized":
      return null;
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: buildTools(scope) });
    case "tools/call":
      return handleToolsCall(reader, getReader, scope, id, msg.params);
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
 *
 * @param hostScope The scope derived from the host header (UA, HA, AS, QR, ALL).
 * @param getReader Factory minting a reader for any scope; used to honor
 *                  `?scope=` overrides without bypassing the dispatcher's
 *                  scoping guarantees.
 */
export async function handleMcpRequest(
  req: Request,
  hostScope: Scope,
  getReader: (scope: Scope) => ScopedReader,
  analytics: AnalyticsConfig | null = DEFAULT_ANALYTICS
): Promise<Response> {
  // Stateless and tools-only: no SSE stream to open on GET, no session to end
  // on DELETE. POST is the whole protocol.
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

  const { scope } = resolveScope(req, hostScope);
  const reader = getReader(scope);

  // Dispatch
  let response: JsonRpcResponse | null;
  try {
    response = await dispatch(reader, getReader, scope, hostScope, msg);
  } catch (err) {
    // The detail stays in the log: an exception message can carry SQL or paths.
    logError(`MCP handler error in ${msg.method}`, err);
    response = rpcError(msg.id ?? null, -32603, "Internal error");
  }

  // Track meaningful MCP usage in Plausible (skip ping & notifications — noise)
  if (msg.method === "initialize" || msg.method === "tools/list") {
    trackMcpEvent(req, analytics, { method: msg.method });
  } else if (msg.method === "tools/call") {
    const toolName = typeof msg.params?.name === "string" ? msg.params.name : "unknown";
    trackMcpEvent(req, analytics, { method: "tools/call", tool: toolName });
  }

  // Notification (no id) → 202 Accepted, empty body
  if (response === null) {
    return new Response(null, { status: 202 });
  }

  // Request → 200 OK with JSON-RPC response
  return new Response(JSON.stringify(response), { status: 200, headers: JSON_HEADERS });
}
