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
 *   fleet:           registry subfleet keys (SUBFLEET_KEYS) | unknown  (~5)
 *   aircraft_type:   normalized families (B737-800, E175, etc)      (~30)
 *   wifi_provider:   starlink | viasat | panasonic | thales | none | other | unknown  (7)
 *   starlink_status: confirmed | negative | unknown                  (3)
 *   vendor:          fr24 | flightaware | united | qatar | alaska | adsb | indexnow (7)
 *   op_carrier:      ua | oo | yx | g7 | c5 | yv | zw | other | unknown      (9)
 *   kind:            missing_from_fleet | inactive_in_fleet                 (2)
 *   status:          success | error | rate_limited | timeout | killed |
 *                    exit_error | parse_error | spawn_error | partial |
 *                    aborted | scrape_error | noop | shed            (~13)
 *   reason:          breaker | bucket | queue — fr24 assignments status:shed only (3)
 *   http_status:     upstream HTTP status code on vendor.request error/
 *                    rate_limited emits (fr24 only)                  (~10)
 *   result:          three disjoint enums share this key, so a `sum by {result}`
 *                    across starlink.* blends unrelated things:
 *                    verification.check       success | error | aircraft_mismatch |
 *                                             tail_unknown | not_published        (5)
 *                    adsb_shadow.observations match | mismatch | no_assignment |
 *                                             no_callsign | non_revenue |
 *                                             low_speed | airborne_total          (7)
 *                    flight.lookup_result     mirrors `outcome`                   (+4 new)
 *                                                                          union (16)
 *   dataset:         mirrors `job` on data.freshness_seconds             (~7)
 *   prefix:          flight_lookup.untracked: registry IATA codes + 20 named
 *                    carriers | other (~26)
 *   client_class:    classifyRequest: extension | other-extension, else
 *                    classifyUserAgent: claude | googleother | googlebot |
 *                    bingbot | gptbot | perplexity | seo-crawler | social |
 *                    extension | bot | browser | unknown; mcp for /mcp  (14)
 *   ext_version:     1.x | 2.0 | 2.x | other | none — only when
 *                    client_class:extension                          (5)
 *   confidence:      high | medium | low | none                      (4)
 *   outcome:         verified_yes | verified_no | type_yes | type_no |
 *                    predicted | no_data | error                     (7)
 *   tool:            7 MCP tool names (TOOL_NAMES) | unknown         (~8)
 *   state:           watch.feed_fetch: prediction | yes | no | swap | none  (5)
 *   surface:         watch.cta_shown: check_flight                   (1)
 */

import { AIRLINES, SUBFLEET_KEYS } from "../airlines/registry";
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

// The aircraft_type tag rides the shared free-text normalizer (one matcher
// for metrics, fleet pages, and the registry's type→wifi tables).
export { normalizeAircraftType } from "../airlines/aircraft-families";

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
  return raw && SUBFLEET_KEYS.has(raw) ? raw : "unknown";
}

export function normalizeStarlinkStatus(raw: string | null | undefined): string {
  if (raw === "confirmed" || raw === "negative") return raw;
  return "unknown";
}

// UA mainline plus its Express operators; anything else buckets to "other".
const UA_OPERATING_CARRIERS = new Set(["UA", "OO", "YX", "G7", "C5", "YV", "ZW"]);
export function normalizeOpCarrier(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "") return "unknown";
  const code = raw.trim().toUpperCase();
  return UA_OPERATING_CARRIERS.has(code) ? code.toLowerCase() : "other";
}

// passenger.probe outcome is client-supplied — closed enum or it's a cardinality bomb.
const PROBE_OUTCOMES = new Set([
  "onboard_reachable",
  "onboard_unreachable",
  "timeout",
  "manual_report",
  "unknown",
]);
export function normalizeProbeOutcome(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  return PROBE_OUTCOMES.has(raw) ? raw : "other";
}

// Bounded user-agent classification, most-specific first. Still a fixed enum —
// never the raw UA — but the named crawlers are split out: collapsing every
// crawler into one `bot` bucket meant no metric could see a single engine's
// behaviour change, so a Bingbot surge that was a third of all traffic was
// invisible to every dashboard and monitor.
const BOT_UA = /bot|spider|crawler|curl|wget|python-requests|go-http-client|headless|httpclient/i;

/** Order matters: GoogleOther/Google-Extended must be tested before Googlebot. */
const NAMED_CRAWLERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["claude", /Claude-User|ClaudeBot|anthropic/i],
  ["googleother", /GoogleOther|Google-Extended/i],
  ["googlebot", /Googlebot|Storebot-Google|Google-InspectionTool/i],
  ["bingbot", /bingbot|adidxbot|BingPreview/i],
  ["gptbot", /GPTBot|OAI-SearchBot|ChatGPT-User/i],
  ["perplexity", /PerplexityBot|Perplexity-User/i],
  ["seo-crawler", /AhrefsBot|SemrushBot|DotBot|MJ12bot|PetalBot|DataForSeoBot|BLEXBot/i],
  ["social", /facebookexternalhit|meta-externalagent|Twitterbot|Slackbot|Discordbot/i],
];

export function classifyUserAgent(ua: string | null | undefined): string {
  if (!ua) return "unknown";
  if (/UA-Starlink-Extension|starlink-tracker-ext/i.test(ua)) return "extension";
  for (const [bucket, re] of NAMED_CRAWLERS) {
    if (re.test(ua)) return bucket;
  }
  if (BOT_UA.test(ua)) return "bot";
  if (/Mozilla|AppleWebKit|Gecko|Chrome|Safari|Firefox/i.test(ua)) return "browser";
  return "unknown";
}

// The extension's service worker fetches with the stock Chrome UA, so the UA
// regex above never fires for it: v2.0.1+ says so with `client=ext-<version>`,
// and any extension fetch may carry its Origin. Only our own store ID counts
// as "extension" — a copycat reusing the API is a different audience.
const OWN_EXTENSION_ORIGIN = "chrome-extension://jjfljoifenkfdbldliakmmjhdkbhehoi";
const EXT_CLIENT_RE = /^ext-(\d{1,2})\.(\d{1,3})\.(\d{1,3})$/;
const FOREIGN_EXTENSION_ORIGIN_RE = /^(chrome|moz|safari-web)-extension:\/\//;

export function classifyRequest(req: Request, url: URL): string {
  if (EXT_CLIENT_RE.test(url.searchParams.get("client") ?? "")) return "extension";
  const origin = req.headers.get("origin");
  if (origin === OWN_EXTENSION_ORIGIN) return "extension";
  if (origin && FOREIGN_EXTENSION_ORIGIN_RE.test(origin)) return "other-extension";
  return classifyUserAgent(req.headers.get("user-agent"));
}

/** `none` is an extension request with no client param: every build before 2.0.1. */
export function normalizeExtVersion(client: string | null | undefined): string {
  if (!client) return "none";
  const m = client.match(EXT_CLIENT_RE);
  if (!m) return "other";
  if (m[1] === "1") return "1.x";
  // 2.1 is the first leg-scoped build; its own bucket keeps the leg-scope
  // rollout readable against 2.0 without re-bucketing any shipped series.
  if (m[1] === "2") return m[2] === "0" ? "2.0" : m[2] === "1" ? "2.1" : "2.x";
  return "other";
}

/** `client_class`, plus `ext_version` on extension traffic only. */
export function requestClientTags(req: Request, url: URL): Tags {
  const clientClass = classifyRequest(req, url);
  if (clientClass !== "extension") return { client_class: clientClass };
  return {
    client_class: clientClass,
    ext_version: normalizeExtVersion(url.searchParams.get("client")),
  };
}

/** `client_class` for /mcp tool calls, which carry no request of their own to classify. */
export function mcpClientTags(): Tags {
  return { client_class: "mcp" };
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

const LEG_MATCHES = new Set(["exact", "origin", "unmatched", "no_data", "unscoped"]);
const LEG_REASONS = new Set([
  "none",
  "invalid_airport",
  "same_airport",
  "no_timezone",
  "ambiguous_leg",
]);
const LEG_OUTCOMES = ["yes", "no", "none"] as const;
const LEG_EFFECTS = new Set([
  "same",
  ...LEG_OUTCOMES.flatMap((from) =>
    LEG_OUTCOMES.filter((to) => to !== from).map((to) => `${from}_to_${to}`)
  ),
]);

export function normalizeLegMatch(raw: string | null | undefined): string {
  return raw && LEG_MATCHES.has(raw) ? raw : "other";
}

export function normalizeLegReason(raw: string | null | undefined): string {
  if (!raw) return "none";
  return LEG_REASONS.has(raw) ? raw : "other";
}

/** `same`, or `<unscoped>_to_<scoped>` over yes/no/none. */
export function normalizeLegEffect(raw: string | null | undefined): string {
  return raw && LEG_EFFECTS.has(raw) ? raw : "other";
}

/** IATA equipment codes are three alphanumerics; anything else is upstream
 * junk and must not mint a tag value. */
export function normalizeEquipmentCodeTag(code: string | null | undefined): string {
  const c = (code ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{3}$/.test(c) ? c : "invalid";
}

// Carriers people ask about most, beyond the registry's own codes. Anything
// else is "other": the prefix is caller-supplied text.
const UNTRACKED_PREFIXES = new Set([
  "DL",
  "AA",
  "WN",
  "B6",
  "AC",
  "WS",
  "BA",
  "LH",
  "KL",
  "EK",
  "EY",
  "TK",
  "SQ",
  "CX",
  "QF",
  "NH",
  "JL",
  "VS",
  "SK",
  "LX",
]);

/** IATA designator of a caller-typed flight number, bounded to the registry
 * codes plus UNTRACKED_PREFIXES; "other" otherwise. */
export function normalizeCarrierPrefix(flightNumber: string | null | undefined): string {
  const m = (flightNumber ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-.]/g, "")
    .match(/^([A-Z][A-Z0-9]|\d[A-Z])\d/);
  if (!m) return "other";
  return UNTRACKED_PREFIXES.has(m[1]) || AIRLINES[m[1]] ? m[1] : "other";
}

/** Bounded-cardinality bucket for how many calendar days ahead a flight lookup's date is. */
export function bucketDaysOut(days: number): string {
  if (!Number.isFinite(days)) return "unknown";
  const d = Math.floor(days);
  if (d < 0) return "past";
  if (d <= 3) return String(d);
  if (d <= 7) return "4_7";
  if (d <= 14) return "8_14";
  if (d <= 30) return "15_30";
  return "31_plus";
}

// ============ Metric Names ============

/**
 * Counter metrics — increment on events
 */
export const COUNTERS = {
  // Scraper events
  SCRAPER_SYNC: "scraper.sync", // tags: source, airline, status (success|partial|aborted|error|noop)
  PLANES_DISCOVERED: "planes.discovered", // tags: source, airline

  // Trusted positive Starlink verification. Fires on EVERY positive re-check,
  // not only new installs (~50x the install count) — for installs use
  // fleet.status_change{to:confirmed}. Kept as-is: a dashboard plots it
  // against verification.check as a positive-check rate.
  // tags: fleet, aircraft_type, airline
  PLANES_STARLINK_DETECTED: "planes.starlink_detected",

  // Per-tail verification check outcome
  // tags: result (success|error|aircraft_mismatch|tail_unknown|not_published), fleet,
  //   aircraft_type, wifi_provider, source (united|alaska), airline
  VERIFICATION_CHECK: "verification.check",

  // External API calls
  // tags: vendor (fr24|flightaware|united|qatar|alaska|adsb|indexnow), type, status
  // united status values: success | timeout | killed | exit_error | parse_error | spawn_error
  // fr24/flightaware/adsb/indexnow status values: success | error | rate_limited
  // fr24 assignments adds status:shed (request-path guard refused), tagged
  //   reason (breaker|bucket|queue) and airline
  // qatar status values: success | error | partial
  VENDOR_REQUEST: "vendor.request",

  // HTTP requests
  // tags: method, route (allowlisted), status_code, tenant, client_class
  HTTP_REQUEST: "http.request",

  // A new SEC filing surfaced for anchor review — tags: company, form, airline
  SEC_FILING_SEEN: "sec.filing_seen",

  // Per-IP rate limit triggered on /api/* — tags: route, tenant
  HTTP_RATE_LIMITED: "http.rate_limited",

  // united_fleet.starlink_status changed (consensus verdict flipped)
  // tags: fleet, from (confirmed|negative|unknown), to, airline
  FLEET_STATUS_CHANGE: "fleet.status_change",

  // Consensus verdict disagrees with the Google Sheet's wifi claim
  // tags: fleet, sheet_says (starlink|not_starlink), crawler_says, airline
  // When this goes quiet for a full 30-day cycle, the crawler is at least as
  // accurate as the sheet.
  FLEET_SHEET_DISAGREEMENT: "fleet.sheet_disagreement",

  // A discovery check was skipped (couldn't run the United.com scrape)
  // tags: fleet, reason (no_flights), airline
  FLEET_CHECK_SKIPPED: "fleet.check_skipped",

  // User-facing flight lookup outcome — how often we actually answer the question.
  // tags: endpoint (api_check|api_predict|mcp), outcome (verified_yes|verified_no|type_yes|type_no|
  //   predicted|no_data|error), result (mirrors outcome — DD monitors group by
  //   result), confidence (high|medium|low|none), airline,
  //   days_out (past|0..3|4_7|8_14|15_30|31_plus — only the /api/check-flight handler, non-QR)
  FLIGHT_LOOKUP_RESULT: "flight.lookup_result",

  // A flight lookup that named its leg (origin/destination). Fires only then.
  // tags: endpoint (api_check|api_check_any|mcp), airline, match (exact|origin|
  //   unmatched|no_data|unscoped), reason (none|invalid_airport|same_airport|
  //   no_timezone|ambiguous_leg), effect (same|<unscoped>_to_<scoped> over
  //   yes/no/none), days_out, client_class, ext_version (extension traffic)
  FLIGHT_LEG_SCOPE: "flight.leg_scope",

  // MCP tool dispatch — tags: tool, airline, outcome (success|error|unknown_tool)
  MCP_TOOL_CALL: "mcp.tool_call",

  // Route lookup fallback chain hit source — tags: source (memory|sqlite|fr24|upcoming|miss), airline
  ROUTE_LOOKUP: "route.lookup",

  // Passenger-verify dark launch: HTML request whose cf-connecting-ip is in the
  // Starlink geofeed — tags: tenant, client_class
  PASSENGER_DETECT: "passenger.detect",
  // Probe beacon outcome — tags: outcome (onboard_api|cors_blocked|csp_blocked|
  //   fetch_error|timeout|onboard_http_*|onboard_noflight|unknown), in_geofeed (0|1), airline
  PASSENGER_PROBE: "passenger.probe",

  // A flight-number lookup for a carrier we don't answer (web, REST, MCP) —
  // demand for the next airline. tags: airline (always unmapped),
  // prefix (normalizeCarrierPrefix), route (check_flight|check_any_flight|
  // predict_flight|mcp)
  FLIGHT_LOOKUP_UNTRACKED: "flight_lookup.untracked",
  // A request-path live FR24 assignment lookup that reached FR24 (queue sheds
  // are refunded and not counted) — each airline's share. tags: airline
  FR24_LOOKUP: "flight_verdict.fr24_lookup",

  // Starlink Watch calendar-feed fetch (calendar apps re-poll ~hourly, so this
  // counts polls, not subscribers) — tags: airline, state (prediction|yes|no|swap|none)
  WATCH_FEED_FETCH: "watch.feed_fetch",
  // Watch row rendered on a check-flight result — tags: airline, surface (check_flight)
  WATCH_CTA_SHOWN: "watch.cta_shown",

  // /fleet/{slug} aircraft-type page request — tags: airline, family (normalizeAircraftType),
  //   outcome (ok|redirect|not_found), verdict (all|all_checked|most|some|verifying|installing|none|
  //   official_none|unknown|n/a), indexable (true|false)
  AIRCRAFT_PAGE_VIEW: "aircraft_page.view",
  // A QR answer hit an equipment code missing from QATAR_EQUIPMENT (answered
  // as unknown, never no) — tags: airline, code (3-char IATA code | invalid)
  QATAR_UNKNOWN_EQUIPMENT: "qatar.unknown_equipment",
} as const;

/**
 * Gauge metrics — periodic state snapshots, last-write-wins per flush window
 */
export const GAUGES = {
  // Seconds since the last successful data write per pipeline, derived from the
  // DB itself (MAX(timestamp)) — not from a "last ran at" heartbeat. Heartbeats
  // prove the loop is alive; this proves it's still producing data.
  // tags: job (see FRESHNESS_QUERIES in data-freshness.ts for the full set),
  //   dataset (mirrors job — DD monitors group by dataset), airline
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

  // Install-pipeline rollup from the fleet-progress sheets.
  // tags: segment (mainline_nb|mainline_wb|express), state (total|complete|in_mod|verification_needed), airline
  FLEET_PROGRESS_COUNT: "fleet_progress.count",

  // Per-tail pipeline states decoded from the progress sheets' cell colors —
  // only states that survived the count-validation gate.
  // tags: segment, state (in_mod|verification_needed|scheduled), airline
  FLEET_PROGRESS_TAILS: "fleet_progress.tails",

  // FAA registry sync results. tags: state (resolved|not_in_master|starlink_flagged), airline
  FAA_REGISTRY_TAILS: "faa_registry.tails",

  // ADS-B shadow sweep vs upcoming_flights assignments.
  // tags: result (match|mismatch|no_assignment|no_callsign|airborne_total), airline
  ADSB_SHADOW_OBSERVATIONS: "adsb_shadow.observations",

  // BTS monthly shadow ingest. tags: op_carrier, airline / kind (missing_from_fleet|inactive_in_fleet), airline
  BTS_ACTIVE_TAILS: "bts.active_tails",
  BTS_FLEET_DELTA: "bts.fleet_delta",

  // Starlink RFC 8805 geofeed prefix count — tags: airline:all
  GEOFEED_PREFIXES: "geofeed.prefixes",

  // ADS-B shadow KPIs per sweep. accuracy = match/(match+mismatch); blind_share
  // = no_assignment share of airborne tails that have any upcoming_flights row
  // (untracked non-Starlink tails can never match, so they'd swamp it). tags: airline
  ADSB_SHADOW_ACCURACY: "adsb_shadow.accuracy",
  ADSB_SHADOW_BLIND_SHARE: "adsb_shadow.blind_share",

  // Share of tails at the upcoming_flights row cap whose first row is more than
  // an hour after their refresh — the signature of a cap keeping the furthest
  // flights instead of the nearest. tags: airline
  UPCOMING_CAPPED_FUTURE_SHARE: "upcoming.capped_future_share",
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

  // Past-dated upcoming_flights rows pruned per sweep (graph as sum) — tags: airline
  UPCOMING_PRUNED: "upcoming.pruned",
} as const;
