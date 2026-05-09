/**
 * Datadog Metrics Module
 *
 * Provides typed helpers for emitting metrics via DogStatsD.
 * All metrics are prefixed with "starlink." for consistency.
 *
 * Naming Convention: starlink.{category}.{action}
 *
 * Tag cardinality budget (keep each tag ≤ ~20 values):
 *   airline:         united (auto-applied globally via tracer.init)  (1, future: N)
 *   fleet:           express | mainline | unknown                    (3)
 *   aircraft_type:   normalized families (B737-800, E175, etc)      (~19)
 *   wifi_provider:   starlink | viasat | panasonic | thales | none | unknown  (6)
 *   starlink_status: confirmed | negative | unknown                  (3)
 *   vendor:          fr24 | flightaware | united                     (3)
 *   status:          success | error | rate_limited | timeout | ...  (~7)
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
  SCRAPER_SYNC: "scraper.sync", // tags: source
  PLANES_DISCOVERED: "planes.discovered", // tags: source

  // New Starlink installation detected on an aircraft
  // tags: fleet, aircraft_type
  PLANES_STARLINK_DETECTED: "planes.starlink_detected",

  // United.com verification check outcome
  // tags: result (success|error|aircraft_mismatch), fleet, aircraft_type, wifi_provider
  VERIFICATION_CHECK: "verification.check",

  // External API calls
  // tags: vendor (fr24|flightaware|united), type, status
  // united status values: success | timeout | killed | exit_error | parse_error | spawn_error
  // fr24/flightaware status values: success | error | rate_limited
  VENDOR_REQUEST: "vendor.request",

  // HTTP requests
  // tags: method, route (allowlisted), status_code
  HTTP_REQUEST: "http.request",

  // Per-IP rate limit triggered on /api/* — tags: route, tenant
  HTTP_RATE_LIMITED: "http.rate_limited",

  // united_fleet.starlink_status changed (consensus verdict flipped)
  // tags: fleet, from (confirmed|negative|unknown), to
  FLEET_STATUS_CHANGE: "fleet.status_change",

  // Consensus verdict disagrees with the Google Sheet's wifi claim
  // tags: fleet, sheet_says (starlink|not_starlink), crawler_says
  // When this goes quiet for a full 30-day cycle, the crawler is at least as
  // accurate as the sheet.
  FLEET_SHEET_DISAGREEMENT: "fleet.sheet_disagreement",

  // A discovery check was skipped (couldn't run the United.com scrape)
  // tags: fleet, reason (no_flights)
  FLEET_CHECK_SKIPPED: "fleet.check_skipped",
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
} as const;

/**
 * Distribution metrics — server-side aggregated, graph p50/p95/p99/sum/avg
 */
export const DISTRIBUTIONS = {
  // Fleet size snapshot, emitted per heartbeat.
  // tags: fleet, starlink_status (confirmed|negative|unknown)
  // Graph as sum-by-fleet-and-status to see rollout progress over time.
  FLEET_PLANES: "fleet.planes",

  // Vendor request latency in milliseconds
  // tags: vendor, type, status
  VENDOR_DURATION_MS: "vendor.duration_ms",
} as const;
