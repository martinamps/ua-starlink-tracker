/**
 * Datadog Metrics Module
 *
 * Provides typed helpers for emitting metrics via DogStatsD.
 * All metrics are prefixed with "starlink." for consistency.
 *
 * Naming Convention: starlink.{category}.{action}
 *
 * Tag cardinality budget (keep each tag ≤ ~20 values):
 *   airline:         united | hawaiian | alaska | qatar | all | unmapped | unknown  (~7)
 *                    `all` = hub-scope emits (db.table_rows, mcp.tool_call)
 *   tenant:          UA | HA | AS | QR | ALL  (~5) — used on http.* only; the
 *                    hub host serves all carriers under scope ALL, which isn't
 *                    an airline, so http metrics carry tenant in addition to the
 *                    per-call default `airline:unmapped` injected by withDefaultAirline.
 *   fleet:           express | mainline | unknown                    (3)
 *   aircraft_type:   normalized families (B737-800, E175, etc)      (~19)
 *   wifi_provider:   starlink | viasat | panasonic | thales | none | other | unknown  (7)
 *   starlink_status: confirmed | negative | unknown                  (3)
 *   vendor:          fr24 | flightaware | united | qatar | alaska    (5)
 *   status:          success | error | rate_limited | timeout | killed |
 *                    exit_error | parse_error | spawn_error | partial |
 *                    aborted | scrape_error                          (~11)
 *   result:          success | error | aircraft_mismatch | tail_unknown  (4)
 *   client_class:    bot | claude | extension | browser | unknown    (5)
 *   confidence:      high | medium | low | none                      (4)
 *   outcome:         verified_yes | verified_no | predicted | no_data | error  (5)
 *   tool:            7 MCP tool names (TOOL_NAMES) | unknown         (~8)
 */

import { AIRLINES } from "../airlines/registry";
import { tracer } from "./tracer";

export type Tags = Record<string, string | number>;

// Default `airline` injected per-call instead of globally in tracer.init(),
// because DogStatsD concatenates global + per-call tags (`airline:hawaiian,united`).
function withDefaultAirline(tags?: Tags): Tags {
  if (tags && "airline" in tags) return tags;
  return { ...tags, airline: "unmapped" };
}

export const metrics = {
  increment: (name: string, tags?: Tags) => {
    tracer.dogstatsd.increment(`starlink.${name}`, 1, withDefaultAirline(tags));
  },

  gauge: (name: string, value: number, tags?: Tags) => {
    tracer.dogstatsd.gauge(`starlink.${name}`, value, withDefaultAirline(tags));
  },

  /**
   * Distribution — server-side aggregated, globally accurate percentiles.
   * Use for: latencies, sizes, and periodic state snapshots you want to
   * sum/avg across tag dimensions in Datadog.
   */
  distribution: (name: string, value: number, tags?: Tags) => {
    tracer.dogstatsd.distribution(`starlink.${name}`, value, withDefaultAirline(tags));
  },
};

// ============ Tag normalizers ============

/**
 * Collapse raw aircraft type strings to a bounded set of families.
 * Input examples (44 distinct in prod):
 *   "Boeing 737-924(ER)", "Boeing 737-924", "Boeing 737-932(ER)" → all B737-900
 *   "ERJ-175", "E175SC", "Embraer E-175", "Embraer E175LR"       → all E175
 *   "Mitsubishi CRJ-701ER", "CRJ-700"                            → all CRJ-700
 *
 * Ordered from most-specific to least-specific pattern — first match wins.
 */
const AIRCRAFT_FAMILIES: Array<[RegExp, string]> = [
  [/737.?MAX.?10/i, "B737-MAX10"],
  [/737.?MAX.?8/i, "B737-MAX8"],
  [/737.?MAX.?9/i, "B737-MAX9"],
  [/737-?7/i, "B737-700"],
  [/737-?8/i, "B737-800"],
  [/737-?9/i, "B737-900"],
  [/757/i, "B757"],
  [/767/i, "B767"],
  [/777/i, "B777"],
  [/787/i, "B787"],
  [/A319/i, "A319"],
  [/A320/i, "A320"],
  [/A321/i, "A321"],
  [/A350/i, "A350"],
  [/E-?17[05]|ERJ.?17[05]/i, "E175"],
  [/ERJ.?145/i, "ERJ-145"],
  [/CRJ.?2/i, "CRJ-200"],
  [/CRJ.?550/i, "CRJ-550"],
  [/CRJ.?7/i, "CRJ-700"],
];

export function normalizeAircraftType(raw: string | null | undefined): string {
  if (!raw || /^unknown$/i.test(raw.trim())) return "unknown";
  for (const [pattern, family] of AIRCRAFT_FAMILIES) {
    if (pattern.test(raw)) return family;
  }
  return "other";
}

/**
 * Normalize wifi provider to a bounded lowercase set.
 * Handles blank strings (common in DB) and case variance.
 */
export function normalizeWifiProvider(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "") return "unknown";
  const lower = raw.trim().toLowerCase();
  // Known providers pass through; anything unexpected buckets to "other"
  if (["starlink", "viasat", "panasonic", "thales", "none"].includes(lower)) {
    return lower;
  }
  return "other";
}

export function normalizeFleet(raw: string | null | undefined): string {
  if (raw === "express" || raw === "mainline") return raw;
  return "unknown";
}

export function normalizeStarlinkStatus(raw: string | null | undefined): string {
  if (raw === "confirmed" || raw === "negative") return raw;
  return "unknown";
}

// Bounded user-agent classification (≤6 buckets, never the raw UA).
const BOT_UA = /bot|spider|crawler|curl|wget|python-requests|go-http-client|headless|httpclient/i;
export function classifyUserAgent(ua: string | null | undefined): string {
  if (!ua) return "unknown";
  if (/Claude-User|ClaudeBot|anthropic/i.test(ua)) return "claude";
  if (/UA-Starlink-Extension|starlink-tracker-ext/i.test(ua)) return "extension";
  if (BOT_UA.test(ua)) return "bot";
  if (/Mozilla|AppleWebKit|Gecko|Chrome|Safari|Firefox/i.test(ua)) return "browser";
  return "unknown";
}

/**
 * Canonical lowercase-name airline tag for metrics. Preserves Datadog history
 * (the global default has always been `airline:united`, not `airline:UA`).
 * Reads from AirlineConfig.metricTag so the registry stays the single source.
 */
export function normalizeAirlineTag(code: string | null | undefined): string {
  if (!code) return "unknown";
  return AIRLINES[code.toUpperCase()]?.metricTag ?? "unmapped";
}

// ============ Metric Names ============

/**
 * Counter metrics — increment on events
 */
export const COUNTERS = {
  // Scraper events
  SCRAPER_SYNC: "scraper.sync", // tags: source, airline, status (success|partial|aborted|error)
  PLANES_DISCOVERED: "planes.discovered", // tags: source, airline

  // New Starlink installation detected on an aircraft
  // tags: fleet, aircraft_type
  PLANES_STARLINK_DETECTED: "planes.starlink_detected",

  // Per-tail verification check outcome
  // tags: result (success|error|aircraft_mismatch|tail_unknown), fleet,
  //   aircraft_type, wifi_provider, source (united|alaska), airline
  VERIFICATION_CHECK: "verification.check",

  // External API calls
  // tags: vendor (fr24|flightaware|united|qatar|alaska), type, status
  // united status values: success | timeout | killed | exit_error | parse_error | spawn_error
  // fr24/flightaware status values: success | error | rate_limited
  // qatar status values: success | error | partial
  VENDOR_REQUEST: "vendor.request",

  // HTTP requests
  // tags: method, route (allowlisted), status_code, tenant, client_class
  HTTP_REQUEST: "http.request",

  // Per-IP rate limit triggered on /api/* — tags: route, tenant
  HTTP_RATE_LIMITED: "http.rate_limited",

  // united_fleet.starlink_status changed (consensus verdict flipped)
  // tags: fleet, from (confirmed|negative|unknown), to, airline
  FLEET_STATUS_CHANGE: "fleet.status_change",

  // Consensus verdict disagrees with the Google Sheet's wifi claim
  // tags: fleet, sheet_says (starlink|not_starlink), crawler_says
  // When this goes quiet for a full 30-day cycle, the crawler is at least as
  // accurate as the sheet.
  FLEET_SHEET_DISAGREEMENT: "fleet.sheet_disagreement",

  // A discovery check was skipped (couldn't run the United.com scrape)
  // tags: fleet, reason (no_flights)
  FLEET_CHECK_SKIPPED: "fleet.check_skipped",

  // User-facing flight lookup outcome — how often we actually answer the question.
  // tags: endpoint (api_check|api_predict|mcp), outcome (verified_yes|verified_no|
  //   predicted|no_data|error), confidence (high|medium|low|none), airline
  FLIGHT_LOOKUP_RESULT: "flight.lookup_result",

  // MCP tool dispatch — tags: tool, airline, outcome (success|error|unknown_tool)
  MCP_TOOL_CALL: "mcp.tool_call",

  // Route lookup fallback chain hit source — tags: source (memory|sqlite|fr24|upcoming|miss), airline
  ROUTE_LOOKUP: "route.lookup",
} as const;

/**
 * Gauge metrics — periodic state snapshots, last-write-wins per flush window
 */
export const GAUGES = {
  // Seconds since the last successful data write per pipeline, derived from the
  // DB itself (MAX(timestamp)) — not from a "last ran at" heartbeat. Heartbeats
  // prove the loop is alive; this proves it's still producing data.
  // tags: job (flight_updater|verifier|departures), airline
  DATA_FRESHNESS_SECONDS: "data.freshness_seconds",

  // Backtest precision of firm "yes/no Starlink" calls — tags: airline, window, call
  PRECISION_FIRM_CALL: "precision.firm_call",
  PRECISION_FIRM_CALL_N: "precision.firm_call.n",
  // Misses by cause — tags: airline, window, call, cause (swap|stale|unattributed)
  PRECISION_FIRM_CALL_MISS: "precision.firm_call.miss",
  PRECISION_LEGACY_PRIOR_PCT: "precision.legacy_prior_pct",

  // Surface contradiction sweep — tags: airline, vector
  SURFACE_CONTRADICTION_TOTAL: "surface_contradiction.total",
  SURFACE_CONTRADICTION_COUNT: "surface_contradiction.count",

  // Row counts for key tables, sampled with the 5-min freshness sweep.
  // tags: table, airline (or "all" if the table has no airline column)
  DB_TABLE_ROWS: "db.table_rows",
} as const;

/**
 * Distribution metrics — server-side aggregated, graph p50/p95/p99/sum/avg
 */
export const DISTRIBUTIONS = {
  // Fleet size snapshot, emitted per heartbeat.
  // tags: fleet, starlink_status (confirmed|negative|unknown), airline
  // Graph as sum-by-fleet-and-status to see rollout progress over time.
  FLEET_PLANES: "fleet.planes",

  // Vendor request latency in milliseconds
  // tags: vendor, type, status
  VENDOR_DURATION_MS: "vendor.duration_ms",

  // MCP tool latency in milliseconds — tags: tool, airline, outcome
  MCP_TOOL_DURATION_MS: "mcp.tool_duration_ms",

  // Distribution of probabilities served to users — surfaces cold-start floods.
  // tags: confidence (high|medium|low), method (flight_history|fleet_prior), airline
  PREDICTION_PROBABILITY: "prediction.probability",
} as const;
