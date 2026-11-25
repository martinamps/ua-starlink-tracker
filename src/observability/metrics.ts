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
 *   reason:          breaker | bucket | queue | budget — fr24 assignments
 *                    status:shed only (normalizeLookupShedReason)      (4)
 *   caller:          page | api | extension | mcp | other — fr24 assignments
 *                    status:shed only (classifyLookupCaller; mcp from the route) (5)
 *   bucket:          api | mcp | page — http.rate_limited only (the limiter's meter) (3)
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
 *                    bingbot | gptbot | perplexity | seo-crawler | meta-ai |
 *                    social | scraper | extension | bot | browser |
 *                    unknown; mcp for /mcp                           (16)
 *                    mcp.tool_call/tool_duration_ms use classifyMcpClient:
 *                    claude | chatgpt | cursor | vscode | bot | other |
 *                    unknown                                         (+3 new)
 *   ext_version:     1.x | 2.0 | 2.x | other | none — only when
 *                    client_class:extension                          (5)
 *   visit_source:    http.request only (classifyVisitSource): extension |
 *                    search | assistant | social | calendar | own | direct |
 *                    other | none                                    (9)
 *   confidence:      high | medium | low | none                      (4)
 *   outcome:         verified_yes | verified_no | type_yes | type_no |
 *                    predicted | no_data | error                     (7)
 *   tool:            7 MCP tool names (TOOL_NAMES) | unknown         (~8)
 *   state:           watch.feed_fetch: prediction | yes | no | swap | none |
 *                    flown | flown_unknown                           (7)
 *   surface:         watch.cta_shown: check_flight                   (1)
 *   source:          source.* metrics only: SourceId in database/source-health.ts (15).
 *                    (scraper.sync and others carry their own `source` values)
 *   kind:            source.failure: error | timeout | blocked | empty | refused |
 *                    partial                                         (6)
 */

import { detectAirline } from "../airlines/flight-number";
import { AIRLINES, SUBFLEET_KEYS, operatorIatas, resolveSite } from "../airlines/registry";
import { CHROME_EXTENSION_ID } from "../utils/chrome-extension";
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
const UA_OPERATING_CARRIERS = new Set(operatorIatas("UA"));
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
  // Meta's AI crawlers (training, Meta AI search, Meta AI's live fetcher) sat
  // in `social` and were nearly all of it; `social` is now link previews only.
  ["meta-ai", /meta-externalagent|meta-externalfetcher|meta-webindexer/i],
  ["social", /facebookexternalhit|Twitterbot|Slackbot|Discordbot/i],
];

// Agents that dress as a browser but are one known scraper, matched as the
// whole string so a real browser on the same version is never caught by a
// looser pattern. The first: ~20,000 flight and route pages a week from ~1,600
// addresses, all with this exact Chrome 139 agent (Nov 2026). It undercounts by
// design: the scraper leaves `scraper` the day it changes one character, and
// the few people still on that exact Chrome build are counted here with it.
const KNOWN_SCRAPER_AGENTS: ReadonlySet<string> = new Set([
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
]);
// Scrapers that give their own name, which no browser carries, so the name is
// enough and a version bump stays in the class. PageIndexer sends "Mozilla/5.0
// (compatible; PageIndexer/1.0)": 2,497 requests to Alaska's site from one
// address on 25 Nov 2026, counted as `browser` for the "Mozilla".
const NAMED_SCRAPER_AGENTS = /\bPageIndexer\b/i;

// The header is a stranger's text. Real agents run under ~300 characters;
// past this cap the rest is never read, so a huge value costs nothing to class.
const MAX_UA_LENGTH = 512;

export function classifyUserAgent(raw: string | null | undefined): string {
  if (!raw) return "unknown";
  const ua = raw.length > MAX_UA_LENGTH ? raw.slice(0, MAX_UA_LENGTH) : raw;
  if (/UA-Starlink-Extension|starlink-tracker-ext/i.test(ua)) return "extension";
  if (KNOWN_SCRAPER_AGENTS.has(ua) || NAMED_SCRAPER_AGENTS.test(ua)) return "scraper";
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
const OWN_EXTENSION_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}`;
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

// ============ Visit source ============

/**
 * Where a request came from, as one of nine fixed words. The referrer, origin
 * and utm_source are read here and nowhere else, and only the word leaves:
 * no host, path or query of the referring page reaches a metric, span or log.
 */
export const VISIT_SOURCES = [
  "extension",
  "search",
  "assistant",
  "social",
  "calendar",
  "own",
  "direct",
  "other",
  "none",
] as const;
export type VisitSource = (typeof VISIT_SOURCES)[number];
const VISIT_SOURCE_SET: ReadonlySet<string> = new Set(VISIT_SOURCES);
type OutsideSource = "search" | "assistant" | "social";

// Registrable domains; a host matches as the domain itself or any subdomain.
const SOURCE_DOMAINS: ReadonlyArray<
  readonly [Exclude<OutsideSource, "search">, readonly string[]]
> = [
  [
    "assistant",
    [
      "chatgpt.com",
      "chat.openai.com",
      "claude.ai",
      "perplexity.ai",
      "gemini.google.com",
      "copilot.microsoft.com",
      "grok.com",
      "meta.ai",
      "chat.mistral.ai",
      "chat.deepseek.com",
      "poe.com",
      "you.com",
      "phind.com",
    ],
  ],
  [
    "social",
    [
      "facebook.com",
      "instagram.com",
      "threads.net",
      "threads.com",
      "t.co",
      "twitter.com",
      "x.com",
      "reddit.com",
      "linkedin.com",
      "lnkd.in",
      "youtube.com",
      "tiktok.com",
      "bsky.app",
      "pinterest.com",
      "news.ycombinator.com",
      "flyertalk.com",
    ],
  ],
];

// "search" is watched week by week, so it has to mean a results page as far
// as a host can say: these exact hosts (a leading "www." aside), never their
// subdomains. A portal's mail, finance, news, blog and forum hosts are "other".
const SEARCH_HOSTS: ReadonlySet<string> = new Set([
  "bing.com",
  "cn.bing.com",
  "duckduckgo.com",
  "html.duckduckgo.com",
  "lite.duckduckgo.com",
  "search.yahoo.com",
  "search.yahoo.co.jp",
  "yandex.com",
  "yandex.ru",
  "yandex.com.tr",
  "ya.ru",
  "baidu.com",
  "m.baidu.com",
  "ecosia.org",
  "search.brave.com",
  "kagi.com",
  "startpage.com",
  "qwant.com",
  "search.naver.com",
  "m.search.naver.com",
  "search.aol.com",
]);
// Yahoo serves results from per-country hosts (uk.search.yahoo.com).
const YAHOO_SEARCH_SUFFIX = ".search.yahoo.com";
// google.com and Google's country hosts (google.de, google.co.uk,
// google.com.au, google.cat), bare or www. Every other google.* host, and
// every other subdomain (mail., news., docs.), is not search.
const GOOGLE_SEARCH_HOST = /^google\.(?:com|[a-z]{2}|com?\.[a-z]{2}|cat)$/;

// Maps, not object literals: a visitor chooses the key, and a plain object
// also answers for the names it inherits ("constructor", "__proto__").
// An Android app's referrer names its package where a site would name a host.
const ANDROID_PACKAGES: ReadonlyMap<string, OutsideSource> = new Map([
  ["com.google.android.googlequicksearchbox", "search"],
  ["com.reddit.frontpage", "social"],
  ["com.twitter.android", "social"],
  ["com.facebook.katana", "social"],
  ["com.linkedin.android", "social"],
]);

// utm_source is free text; a bare product name counts like its host.
const UTM_ALIASES: ReadonlyMap<string, OutsideSource> = new Map([
  ["chatgpt", "assistant"],
  ["openai", "assistant"],
  ["perplexity", "assistant"],
  ["claude", "assistant"],
  ["copilot", "assistant"],
  ["gemini", "assistant"],
  ["reddit", "social"],
  ["twitter", "social"],
  ["facebook", "social"],
  ["linkedin", "social"],
]);
// The one utm_source this site writes itself: the link inside a calendar event (utils/ics.ts).
const OWN_CALENDAR_UTM = "cal";

function outsideSourceOfHost(host: string): OutsideSource | null {
  for (const [source, domains] of SOURCE_DOMAINS) {
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return source;
  }
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  const search =
    SEARCH_HOSTS.has(bare) || bare.endsWith(YAHOO_SEARCH_SUFFIX) || GOOGLE_SEARCH_HOST.test(bare);
  return search ? "search" : null;
}

/** own | search | assistant | social | other for a Referer or Origin value, null when it names nothing. */
function sourceOfReferrer(raw: string | null): VisitSource | null {
  if (!raw || raw === "null") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return null;
  if (parsed.protocol === "android-app:") return ANDROID_PACKAGES.get(host) ?? "other";
  if (resolveSite(host)) return "own";
  return outsideSourceOfHost(host) ?? "other";
}

function sourceOfUtm(raw: string | null): VisitSource | null {
  if (!raw) return null;
  const value = raw.slice(0, 64).trim().toLowerCase();
  if (!value) return null;
  if (value === OWN_CALENDAR_UTM) return "calendar";
  // A utm_source never proves a search visit (ads and newsletters say "google" too).
  const named = UTM_ALIASES.get(value) ?? outsideSourceOfHost(value);
  return named && named !== "search" ? named : "other";
}

/**
 * The first rule that fires wins:
 *  1. our extension, or another one, by `clientClass`                → extension
 *  2. Referer (else Origin) names a search engine, assistant or
 *     social site. A search engine on /api/* is some script on that
 *     engine's page: not a search visit, and not our extension
 *     either, which sends no referrer and is known by rule 1 alone   → that class | other
 *  3. Referer/Origin is one of our own hosts                         → own
 *  4. utm_source: ours (cal), an assistant's or a social site's      → calendar | assistant | social
 *  5. Sec-Fetch-Site same-origin/same-site. Our pages send no
 *     referrer (Referrer-Policy: no-referrer), so this is how
 *     in-site clicks and our own scripts' calls are seen             → own
 *  6. any other referrer, origin or utm_source, or Sec-Fetch-Site
 *     cross-site with nothing named                                  → other
 *  7. Sec-Fetch-Site none: typed, bookmarked or opened from an app   → direct
 *  8. no signal at all: most robots and scripts                      → none
 *
 * A user agent alone never makes a request "assistant": an assistant's
 * fetcher is already `client_class` claude | gptbot | perplexity, and this
 * tag is about where a visit came from, not who is asking.
 */
export function classifyVisitSource(req: Request, url: URL, clientClass: string): VisitSource {
  // The type promises one of nine words; this holds it at run time too,
  // whatever a later edit to the rules or lists lets through.
  const source: unknown = visitSourceByRule(req, url, clientClass);
  return typeof source === "string" && VISIT_SOURCE_SET.has(source)
    ? (source as VisitSource)
    : "other";
}

function visitSourceByRule(req: Request, url: URL, clientClass: string): VisitSource {
  if (clientClass === "extension" || clientClass === "other-extension") return "extension";
  const referred =
    sourceOfReferrer(req.headers.get("referer")) ?? sourceOfReferrer(req.headers.get("origin"));
  if (referred === "search") return url.pathname.startsWith("/api/") ? "other" : "search";
  if (referred && referred !== "other") return referred;
  const utm = sourceOfUtm(url.searchParams.get("utm_source"));
  if (utm && utm !== "other") return utm;
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin" || fetchSite === "same-site") return "own";
  if (referred || utm || fetchSite === "cross-site") return "other";
  return fetchSite === "none" ? "direct" : "none";
}

const LOOKUP_CALLERS = ["page", "api", "extension", "mcp", "other"] as const;
export type LookupCaller = (typeof LOOKUP_CALLERS)[number];
const LOOKUP_CALLER_SET: ReadonlySet<string> = new Set(LOOKUP_CALLERS);

export function normalizeLookupCaller(raw: string | null | undefined): LookupCaller {
  return raw && LOOKUP_CALLER_SET.has(raw) ? (raw as LookupCaller) : "other";
}

const LOOKUP_SHED_REASONS = ["breaker", "bucket", "queue", "budget"] as const;
export type LookupShedReason = (typeof LOOKUP_SHED_REASONS)[number];
const LOOKUP_SHED_REASON_SET: ReadonlySet<string> = new Set(LOOKUP_SHED_REASONS);

/** An unknown reason reads as `queue`, the reason every shed had before the others existed. */
export function normalizeLookupShedReason(raw: string | null | undefined): LookupShedReason {
  return raw && LOOKUP_SHED_REASON_SET.has(raw) ? (raw as LookupShedReason) : "queue";
}

/**
 * Who a shed live lookup was for, on /api/*. `extension` is our own store
 * build only (classifyRequest); `page` is a browser on one of our own pages,
 * by the same rule that makes a visit `own`; `api` is any other request with a
 * browser's agent: the API opened directly, called from someone else's page,
 * or a script dressed as a browser. The rest, a copycat extension, a named
 * tool or crawler, a bare script, is `other`. `mcp` is never returned here:
 * the /mcp route sets it. A script can forge any of these headers, so read
 * `page` as "says it is our page".
 */
export function classifyLookupCaller(req: Request, url: URL): LookupCaller {
  const clientClass = classifyRequest(req, url);
  if (clientClass === "extension") return "extension";
  if (clientClass !== "browser") return "other";
  return classifyVisitSource(req, url, clientClass) === "own" ? "page" : "api";
}

/** `client_class` for /mcp tool calls, which carry no request of their own to classify. */
export function mcpClientTags(): Tags {
  return { client_class: "mcp" };
}

// MCP is stateless here, so a tools/call never carries the initialize
// handshake's clientInfo — the user agent is the only per-call signal.
// Patterns from production /mcp spans: Claude-User (claude.ai connectors),
// claude-code/x, the Claude desktop app's "Claude/x" Electron UA,
// openai-mcp/x (ChatGPT and Codex), Cursor/x.
const MCP_CLIENTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["claude", /Claude-User|claude-code|\bClaude\/|anthropic/i],
  ["chatgpt", /openai-mcp|ChatGPT/i],
  ["cursor", /^Cursor\//i],
  ["vscode", /vscode|Visual Studio Code|Copilot/i],
];

/** claude | chatgpt | cursor | vscode | bot | other | unknown */
export function classifyMcpClient(ua: string | null | undefined): string {
  if (!ua) return "unknown";
  for (const [bucket, re] of MCP_CLIENTS) {
    if (re.test(ua)) return bucket;
  }
  return BOT_UA.test(ua) ? "bot" : "other";
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

/** airline tag for a flight number by its carrier prefix (SKW5212 → united). */
export function flightAirlineTag(flightNumber: string): string {
  return detectAirline(flightNumber)?.metricTag ?? "unmapped";
}

/** airline tag for a reader/tenant scope: the hub scope is `all`, not an airline. */
export function normalizeScopeTag(scope: string): string {
  return scope === "ALL" ? "all" : normalizeAirlineTag(scope);
}

const MCP_ERROR_REASONS = new Set([
  "missing_argument",
  "invalid_argument",
  "unknown_airport",
  "same_airport",
  "not_tracked",
  "config",
  "exception",
]);

/** `reason` on mcp.tool_call: why a call ended in an error, `none` otherwise. */
export function normalizeMcpErrorReason(raw: string | null | undefined): string {
  if (!raw) return "none";
  return MCP_ERROR_REASONS.has(raw) ? raw : "other";
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

export const SETTLE_RULES = [
  "insufficient",
  "retrofit_streak",
  "majority_starlink",
  "majority_other",
  "ambiguous",
  "disputed_hold",
  "sustained_other",
  "regional_flap",
  "legacy_only",
] as const;
export type SettleRule = (typeof SETTLE_RULES)[number];
const SETTLE_RULE_SET: ReadonlySet<string> = new Set(SETTLE_RULES);

export function normalizeSettleRule(raw: string | null | undefined): string {
  return raw && SETTLE_RULE_SET.has(raw) ? raw : "other";
}

const CHART_REJECT_REASONS: ReadonlySet<string> = new Set([
  "date_invalid",
  "date_future",
  "date_old",
  "count_invalid",
  "type_size",
  "types_left_out",
]);

export function normalizeChartRejectReason(raw: string | null | undefined): string {
  return raw && CHART_REJECT_REASONS.has(raw) ? raw : "other";
}

// ============ Metric Names ============

/**
 * Counter metrics — increment on events
 */
export const COUNTERS = {
  // Scraper events
  SCRAPER_SYNC: "scraper.sync", // tags: source, airline, status (success|partial|aborted|error|noop|timeout)
  PLANES_DISCOVERED: "planes.discovered", // tags: source, airline
  // A fleet write refused at the membership gate (fleet-admission.ts) —
  // tags: source (FleetSource), reason (invalid_registration|non_airliner), airline
  FLEET_ROW_REJECTED: "fleet.row_rejected",
  // An airline's own chart failed its bounds (database/chart-bounds.ts), so
  // it was not stored (parse), cannot stand in a headline (sync, read), or
  // had a complete type's tails left unsettled (settle) —
  // tags: stage (parse|sync|settle|read), reason (normalizeChartRejectReason), airline
  CHART_REJECTED: "fleet_progress.chart_rejected",
  // Sheet tab list drifted from the gids we know (utils.ts reconcileSheetTabs) —
  // tags: state (vanished_empty|vanished_listed|new), airline
  SHEET_TAB_DRIFT: "sheet.tab_drift",
  // A scheduled read of an outside source failed, counting "answered with
  // nothing usable" as a failure (utils/source-health.ts) — tags: source
  // (SourceId), kind (error|timeout|blocked|empty|refused|partial), airline
  SOURCE_FAILURE: "source.failure",

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
  // fr24/flightaware/adsb status values: success | error | rate_limited
  // indexnow (type:ping, airline) status values: success | rate_limited | timeout |
  //   error | shed (our own daily cap, or a 429 pause still running)
  // fr24 assignments adds status:shed (request-path guard refused), tagged
  //   reason (breaker|bucket|queue), caller (page|extension|other) and airline
  // qatar status values: success | error | partial
  VENDOR_REQUEST: "vendor.request",

  // HTTP requests
  // tags: method, route (allowlisted), status_code, tenant, client_class,
  //   visit_source (classifyVisitSource)
  HTTP_REQUEST: "http.request",

  // A Host header that is not a host at all, answered 400 before any tenant
  // or route exists to tag — tags: method, airline (always "unknown").
  // A well-formed Host we don't serve is a 421 and is not counted here.
  HTTP_BAD_HOST: "http.bad_host",

  // A new SEC filing surfaced for anchor review — tags: company, form, airline
  SEC_FILING_SEEN: "sec.filing_seen",

  // Per-IP rate limit triggered on a metered surface — tags: route, tenant,
  //   airline, bucket (api|mcp|page), client_class, ext_version (extension traffic)
  HTTP_RATE_LIMITED: "http.rate_limited",
  // Over the page limit but served: a reverse-DNS-verified search crawler —
  //   the http.rate_limited tags plus crawler (googlebot|bingbot)
  HTTP_RATE_LIMIT_EXEMPT: "http.rate_limit_exempt",

  // united_fleet.starlink_status changed (consensus verdict flipped)
  // tags: fleet, from (confirmed|negative|unknown), to, airline
  FLEET_STATUS_CHANGE: "fleet.status_change",

  // A listing's settled wifi crossed the equipped line (verified_wifi between
  // Starlink/unverified and another provider). tags: direction (to_starlink|
  //   from_starlink), reason (normalizeSettleRule), path (reconcile|verifier),
  //   airline. Normal is ~0–1 from_starlink a day; a burst means upstream noise.
  CONSENSUS_SETTLE_TRANSITION: "consensus.settle_transition",

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

  // MCP tool dispatch — tags: tool, airline, outcome (success|error|unknown_tool),
  //   client_class (classifyMcpClient)
  MCP_TOOL_CALL: "mcp.tool_call",

  // Route lookup fallback chain hit source — tags: source (memory|assignment|sqlite|fr24|upcoming|stale|miss), airline
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
  // /fleet/{tail} page request — tags: airline, outcome (ok|redirect),
  //   answer (verified|listed|reported|observed|other|unchecked|n/a), indexable (true|false).
  //   Never the tail: a registration is not a tag value.
  TAIL_PAGE_VIEW: "tail_page.view",
  // /static/share/* picture request — tags: airline, kind (flight|tail|airport|invalid),
  //   outcome (drawn|cached|moved|site_card|shed|error). moved: a dated flight address
  //   answered by the undated picture; site_card: no picture, the site's card;
  //   shed: over the drawing budget; error: the drawing threw. Never the
  //   flight, tail or airport.
  SHARE_PICTURE: "share_picture.request",
  // "Every flight on this route" board served — tags: airline, surface (api|page),
  //   outcome (nonstop|no_nonstop), dated (true|false)
  ROUTE_FLIGHTS_VIEW: "route_flights.view",
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
  // Hours since an outside source last gave us usable data, from the stored
  // per-source record (utils/source-health.ts), sampled every 5 minutes.
  // tags: source (SourceId), airline
  SOURCE_HOURS_SINCE_SUCCESS: "source.hours_since_success",
  // 1 while that source is past its own quiet threshold, else 0: one monitor
  // covers every source without repeating the thresholds. tags: source, airline
  SOURCE_QUIET: "source.quiet",

  // Backtest precision of firm "yes/no Starlink" calls — tags: airline, window, call
  PRECISION_FIRM_CALL: "precision.firm_call",
  PRECISION_FIRM_CALL_N: "precision.firm_call.n",
  // Misses by cause — tags: airline, window, call, cause (swap|stale|unattributed)
  PRECISION_FIRM_CALL_MISS: "precision.firm_call.miss",
  PRECISION_LEGACY_PRIOR_PCT: "precision.legacy_prior_pct",

  // Headline equipped count (equippedSql over the listings) — tags: airline
  FLEET_EQUIPPED: "fleet.equipped",
  // Tails with both a Starlink and a named other-provider clean read in the
  // last 7 days — upstream feed disagreement. tags: airline
  CONSENSUS_CONFLICTING_TAILS: "consensus.conflicting_tails",
  // Listed tails the consensus sweep kept on Starlink against a non-Starlink
  // window (established history, not yet sustained-negative). tags: airline
  CONSENSUS_DISPUTED_TAILS: "consensus.disputed_tails",

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

  // Airline-published connected count per type minus the tails of that type we
  // list as equipped: aircraft the airline counts but we can't name yet. A
  // persistent positive value is the manual-attribution backlog.
  // tags: aircraft_type (family), airline
  FLEET_PROGRESS_UNATTRIBUTED: "fleet_progress.unattributed",

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

  // Flight draws that began 6-30 hours ago, by which ends an aircraft-on-the-
  // ground report put on an airport. tags: ends (both|origin_only|
  // destination_only|neither), airline
  ADSB_DRAWS_PLACED: "adsb_draws.placed",

  // Share of tails at the upcoming_flights row cap whose first row is more than
  // an hour after their refresh — the signature of a cap keeping the furthest
  // flights instead of the nearest. tags: airline
  UPCOMING_CAPPED_FUTURE_SHARE: "upcoming.capped_future_share",

  // Community fleet guide (AF) with no live import: seconds since the guide's
  // own date. Deliberately not a data.freshness_seconds job — it ages by
  // design, and the freshness monitors would page on it forever.
  // tags: airline, stale (true|false — past GUIDE_MARK_TTL_DAYS)
  COMMUNITY_GUIDE_AGE_SECONDS: "community_guide.age_seconds",
  // Roster tails (freighters dropped) by what an answer may still say about
  // them under the aging policy. tags: airline, state (starlink_listed|
  // not_starlink_current|not_starlink_expired|not_in_guide)
  COMMUNITY_GUIDE_TAILS: "community_guide.tails",

  // Exited children of the server not yet reaped (state Z, parent = server).
  // 0 under the image's tini init; a climb means the server is PID 1 again and
  // every United check's orphaned Chromium helpers pile up. tags: airline:all
  PROCESS_ZOMBIES: "process.zombies",
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

  // MCP tool latency in milliseconds — tags: tool, airline, outcome, client_class
  MCP_TOOL_DURATION_MS: "mcp.tool_duration_ms",

  // Distribution of probabilities served to users — surfaces cold-start floods.
  // tags: confidence (high|medium|low), method (flight_history|fleet_prior), airline
  PREDICTION_PROBABILITY: "prediction.probability",

  // Past-dated upcoming_flights rows pruned per sweep (graph as sum) — tags: airline
  UPCOMING_PRUNED: "upcoming.pruned",
} as const;
