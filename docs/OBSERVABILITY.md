# Observability

This document describes the Datadog APM integration for the UA-Starlink-Tracker application.

## Overview

The application uses [dd-trace](https://github.com/DataDog/dd-trace-js) to provide:
- **JSON structured logging** with trace correlation
- **Custom metrics** (counters and gauges) via DogStatsD
- **APM tracing** with manual spans for background jobs and HTTP requests

## Bun Compatibility

dd-trace works with Bun v1.1.6+ but with important limitations:

| Feature | Status | Notes |
|---------|--------|-------|
| Manual tracing (`tracer.trace()`) | ✅ Works | Use the `withSpan` helper |
| DogStatsD metrics | ✅ Works | Use `metrics.increment()`, `metrics.gauge()` |
| Log injection | ✅ Works | Automatic trace ID injection in JSON logs |
| Automatic instrumentation | ❌ Does not work | ESM import hooks not supported |
| Profiling | ❌ Must disable | Set `profiling: false` |
| Runtime metrics | ❌ Must disable | Set `runtimeMetrics: false` |

## Configuration

### Docker (Production)

The Dockerfile pre-configures most Datadog settings. You only need to enable tracing:

```bash
docker run -e DD_TRACE_ENABLED=true ...
```

The Dockerfile sets these automatically:
- `DD_ENV=production`
- `DD_SERVICE=ua-starlink-tracker`
- `DD_VERSION=<git-hash>` (from the `SOURCE_COMMIT` build arg)
- `DD_TRACE_AGENT_HOSTNAME=host.docker.internal`

**Agent Setup:** The container connects to the Datadog agent on the Docker host via `host.docker.internal`. Run one agent on the host machine - no need for a sidecar per container.

### Building

Pass the commit hash as a build arg so `DD_VERSION` is tagged correctly:

```bash
docker build --build-arg SOURCE_COMMIT=$(git rev-parse --short HEAD) -t ua-starlink-tracker .
```

Most container platforms can inject the git SHA as a build arg automatically; set `DD_TRACE_ENABLED=true` in the runtime environment to enable APM.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DD_TRACE_ENABLED` | `false` | **Set this to `true` to enable tracing** |
| `DD_ENV` | `development` | Environment tag (set by Dockerfile in prod) |
| `DD_SERVICE` | `ua-starlink-tracker` | Service name (set by Dockerfile) |
| `DD_VERSION` | `unknown` | Version tag (from `SOURCE_COMMIT` build arg) |
| `DD_TRACE_AGENT_HOSTNAME` | `localhost` | Agent hostname (set by Dockerfile to `host.docker.internal`) |
| `DD_TRACE_AGENT_PORT` | `8126` | APM trace agent port |
| `DD_DOGSTATSD_PORT` | `8125` | DogStatsD metrics port |

## Metrics Reference

All metrics are prefixed with `starlink.` for easy filtering in Datadog.

### Counters (Low Cardinality Tags)

| Metric | Tags | Description |
|--------|------|-------------|
| `starlink.scraper.sync` | `source:spreadsheet\|fr24\|ship_numbers\|…`, `airline`, `status:success\|partial\|noop\|error` | Sync operation completed |
| `starlink.planes.discovered` | `source:spreadsheet\|fr24` | New plane discovered |
| `starlink.planes.starlink_detected` | `fleet`, `aircraft_type`, `airline` | Trusted positive Starlink verification — fires on every positive re-check, not just new installs. For installs use `starlink.fleet.status_change{to:confirmed}` |
| `starlink.verification.check` | `result:success\|error` | Verification attempt |
| `starlink.verification.mismatch` | - | Spreadsheet/United.com WiFi mismatch |
| `starlink.vendor.request` | `vendor:flightaware\|fr24\|united`, `type:flights\|fleet\|verification`, `status:success\|rate_limited\|error` | External API call. A live aircraft lookup refused by the request-path guard is `vendor:fr24 type:assignments status:shed`, with `reason:breaker\|bucket\|queue` and `caller:page\|extension\|other` (our own pages, our own extension, anything else: outside tools, scripts, MCP). Requests that joined a lookup already under way are not counted, so `caller` names who asked for the refused slot |
| `starlink.http.request` | `method`, `route`, `status_code`, `tenant`, `client_class`, `ext_version` (extension only), `visit_source` | HTTP request served (`route` is the matched route-table entry, or `unmatched`) |
| `starlink.http.rate_limited` | `route`, `tenant`, `airline`, `bucket:api\|ext\|mcp\|page`, `client_class`, `ext_version` (extension only) | Per-IP limiter returned a 429 (also counted in `http.request` as `status_code:429`). `/api/*` calls classified `client_class:extension` use the `ext` bucket (`EXTENSION_RATE_LIMIT`, 300/min); every other bucket allows `API_RATE_LIMIT` (100/min) |
| `starlink.http.rate_limit_exempt` | the `http.rate_limited` tags plus `crawler:googlebot\|bingbot` | Over the `page` limit but served: the UA claims Googlebot/Bingbot and the IP's reverse DNS (forward-confirmed) is in the engine's domain. Cached per IP |
| `starlink.route_flights.view` | `airline`, `surface:api\|page`, `outcome:nonstop\|no_nonstop`, `dated:true\|false` | "Every flight on this route" board served (`/api/route-flights`, route pages) |
| `starlink.consensus.settle_transition` | `direction:to_starlink\|from_starlink`, `reason` (settle rule), `path:reconcile\|verifier`, `airline` | A listing's settled wifi crossed the equipped line. Normal is ~0–1 `from_starlink` a day; a burst means upstream feed noise |
| `starlink.mcp.tool_call` | `tool`, `airline`, `outcome:success\|error\|unknown_tool`, `reason:none\|missing_argument\|invalid_argument\|unknown_airport\|same_airport\|not_tracked\|config\|exception`, `client_class` (MCP enum below) | MCP tool dispatched; `starlink.mcp.tool_duration_ms` carries the same tags. `reason` says why an `outcome:error` call failed: only `config` and `exception` are the server's fault, the rest are correct refusals of a bad call (registry crawlers call every tool with no arguments daily, which is `missing_argument`). Read a tool's health as `outcome:error AND reason:(config OR exception)` |

### Client tags

`client_class` is always a fixed enum, never the raw user agent:

- **HTTP metrics** (`classifyRequest`): `extension`, `other-extension`, the named crawlers (`claude`, `googlebot`, `bingbot`, `meta-ai`, …), `social`, `scraper`, `bot`, `browser`, `unknown`.
  - `meta-ai` is Meta's AI crawlers (`meta-externalagent`, `meta-externalfetcher`, `meta-webindexer`). They were counted as `social` (and `meta-webindexer` as `bot`) until this class shipped, so `social` drops to link previews (`facebookexternalhit`, X, Slack, Discord) on that day.
  - `scraper` is a known scraper that sends a browser's agent, matched on the whole agent string (`KNOWN_SCRAPER_AGENTS`). Today that is one fixed Mac Chrome 139 agent. It was counted as `browser` until this class shipped. It only counts, nothing is blocked, and it is a floor: the scraper leaves the class when it changes its agent, other browser-dressed scrapers (rotating versions, proxies) are still `browser`, and a person on that exact Chrome build lands in `scraper`.
  - `browser` therefore still means "sends a browser's agent and isn't a scraper we know by name", not "a person". `browser` and `social` counts from before and after the deploy of these two classes are not comparable.
- **MCP tool metrics** (`classifyMcpClient`): `claude`, `chatgpt` (includes Codex), `cursor`, `vscode`, `bot`, `other`, `unknown`. MCP here is stateless, so tool calls carry no `clientInfo`; the user agent is the only signal.
- **`ext_version`** rides along only with `client_class:extension`, from the extension's `client=ext-<version>` param: `1.x`, `2.0`, `2.1`, `2.x` (2.2+), `other`, `none` (pre-2.0.1 builds, which sent no param). Graph adoption with `sum:starlink.http.request{client_class:extension} by {ext_version}`.

### Visit source (`http.request` only)

`visit_source` says where a request came from, as one of nine fixed words
(`classifyVisitSource` in `src/observability/metrics.ts`). The first rule that
fires wins:

| Value | Rule |
|---|---|
| `extension` | `client_class` is `extension` or `other-extension`: the extension's own marks (its version param or its origin) and nothing else |
| `search` | Referer (else Origin) host is a search engine's results host, on any path but `/api/*`: `google.com` and Google's country hosts (bare or `www.`), Bing, DuckDuckGo, `search.yahoo.com` and its country hosts, Yandex, Baidu, Ecosia, Brave Search, Kagi, Startpage, Qwant, `search.naver.com`, `search.aol.com`, or the Google app on Android. Exact hosts: a portal's mail, news, finance, blog and forum hosts are `other` |
| `assistant` | Referer host or `utm_source` names an assistant: ChatGPT, Claude, Perplexity, Gemini, Copilot, Grok, Meta AI, Mistral, DeepSeek, Poe, You, Phind |
| `social` | Referer host or `utm_source` names a social site or forum: Facebook, Instagram, Threads, X/Twitter, Reddit, LinkedIn, YouTube, TikTok, Bluesky, Pinterest, Hacker News, FlyerTalk |
| `calendar` | `utm_source=cal`, the link this site writes into its own calendar events |
| `own` | Referer/Origin is one of our hosts, or `Sec-Fetch-Site` is `same-origin`/`same-site`. Our pages send `Referrer-Policy: no-referrer`, so the fetch-metadata header is what marks in-site clicks, assets and our own scripts' API calls |
| `other` | Any other referrer, origin or `utm_source`, or `Sec-Fetch-Site: cross-site` with nothing named. Also a search engine's page as referrer/origin of an `/api/*` call: some script on that page, which is neither a search visit nor our extension (the extension sends no referrer) |
| `direct` | `Sec-Fetch-Site: none`: typed, bookmarked, or opened from an app outside the browser |
| `none` | No signal at all: most robots and scripts, and browsers too old to send fetch metadata |

**Budget: 9 values, closed.** An unknown host or `utm_source` is `other`, never a
new value; to recognise a new site, add its host to one of the lists. The lists
a visitor's value is looked up in are `Map`s and `Set`s, and
`classifyVisitSource` turns anything outside the nine into `other` before it
returns.
Only the word is emitted: the referrer's host, path and query are read inside
`classifyVisitSource` and go to no metric, span or log.

A user agent alone never makes a request `assistant`. An assistant's fetcher is
already `client_class:claude|gptbot|perplexity`; `visit_source:assistant` is a
person who followed a link out of an assistant. Robots can send any referrer,
so read the tag with `client_class:browser`, and leave out `visit_source:own`
(a page view's own assets and API calls) to count arrivals. The query keeps
pages only: GETs, without the API, static files, feeds, robots and sitemap
files, the badge, the CSV, calendar files and the embed route. `/mcp` stays in
as a page, since `method:get` leaves its POSTed tool calls out. A new route
that isn't a page needs its own `NOT route:` here.

```
sum:starlink.http.request{client_class:browser AND method:get AND status_code:200 AND NOT route:unmatched AND NOT route:/api* AND NOT route:/static AND NOT route:/feed.xml AND NOT route:/robots.txt AND NOT route:/sitemap.xml AND NOT route:/llms.txt AND NOT route:/badge.svg AND NOT route:/data/starlink-tails.csv AND NOT route:/cal AND NOT route:/embed AND NOT route:/.well-known/mcp-registry-auth AND NOT visit_source:own} by {visit_source,tenant}.as_count().rollup(sum, 604800)
```

### Rate-limit log

Each 429 also writes a `warn` line, message `rate limited`, carrying the `http.rate_limited` tags plus `suppressed`. It's throttled to one line per distinct tag set per minute; `suppressed` counts the 429s folded into that line since the previous one. IPs and raw user agents are never logged.

### Route Tag Cardinality (`http.request` and friends)

There is no `KNOWN_ROUTES` allowlist any more — it was replaced by
`metricRoute()` in `src/server/app.ts`, which tags every request with the
**route table entry that matched it**, never the raw path. Bots and scrapers
hitting random URLs therefore cannot inflate cardinality: an unmatched path
tags `unmatched`, and the prefix families collapse to their prefix
(`/check-flight/UA123` → `/check-flight`, `/static/x.png` → `/static`).

That makes the `route` tag's cardinality exactly *(exact routes) + (prefix tags not already in the table) + 1 (`unmatched`)*, and
the route table is the thing to watch:

| Source | Count |
|---|---|
| Exact entries in `routes` | 36 |
| Prefix families in `prefixRoutes` | 7 (5 of which reuse an exact entry's tag) |
| `unmatched` | 1 |
| **Distinct `route` tag values** | **39** |

**Budget: keep it under 40.** The old "max 25" predates the distribution
surfaces (`/newly-equipped`, `/feed.xml`, `/badge.svg`, `/embed`,
`/install-rate`), the hub `/compare` family, and the per-airline API families,
and was already exceeded by the routes it did not list. 40 leaves room for a new URL family without a
re-audit while staying well inside a sane per-metric tag budget.

The share pictures (`/static/share/{flight|tail|airport}/….png`, the og:image
of a flight, tail or airport page) are drawn per request but ride the
`/static` family and its tag, for that reason. Tell them apart with
`share_picture.request` (tags: `airline`, `kind`, `outcome`): `drawn` and
`cached` are pictures, `moved` a dated flight address answered by the undated
picture, `site_card` an address with no picture (redirected to the site's
card), `shed` a request over the process-wide drawing budget
(`SHARE_PICTURE_LIMITS` in `src/server/app.ts`), and `error` a drawing that
threw (logged; the request still gets the site's card). A rising `shed` count
means something is enumerating picture addresses.

To add a route, add it to `routes` (or `prefixRoutes`) in
`src/server/app.ts` — the metric tag follows automatically. If a change would
push the table past the budget, group the new URLs behind a prefix family
rather than raising the number. Pure redirects (the www aliases, `/extension`
→ `/chrome`) are answered in `dispatch` before the table and take no tag.

### Gauges

| Metric | Description |
|--------|-------------|
| `starlink.planes.total` | Total tracked planes |
| `starlink.planes.verified_starlink` | Verified Starlink-equipped count |
| `starlink.planes.pending` | Planes pending verification |
| `starlink.data.freshness_seconds` | Age of each pipeline's newest write, tagged `job`/`dataset`, `airline`. `job:fleet_progress,airline:alaska` is the Alaska tracker ingest (daily; ages only when it fails) |
| `starlink.fleet_progress.count` | Per-segment `total`/`complete` rollups, `UA` from the progress sheets, `AS` from Alaska's newsroom tracker |
| `starlink.fleet_progress.unattributed` | `aircraft_type`, `airline`: aircraft Alaska counts as connected that we can't yet name by registration (its connected count minus our equipped listings). Persistently above 0 = manual tail attribution backlog |
| `starlink.fleet.equipped` | `airline`: the headline equipped count (5-min sweep) |
| `starlink.consensus.conflicting_tails` | `airline`: tails with both a Starlink and a named other-provider read in the last 7 days (5-min sweep) |
| `starlink.consensus.disputed_tails` | `airline`: listed tails held on Starlink against a non-Starlink window by their established history (hourly reconcile) |
| `starlink.community_guide.age_seconds` | Age of a frozen community fleet guide (AF), from its own date; tags `airline`, `stale`. Not a `data.freshness_seconds` job: it ages by design, so the freshness monitors would page forever |
| `starlink.community_guide.tails` | Roster tails by what answers may still say under the aging policy; tags `airline`, `state` (`starlink_listed`, `not_starlink_current`, `not_starlink_expired`, `not_in_guide`) |

The Alaska tracker ingest also counts `starlink.scraper.sync{source:alaska_tracker}` with `status:success|error`; `error` means the page failed to fetch or its table no longer parses, and the last good chart keeps serving.

### Source health

Every outside source a job reads on a schedule keeps a record in `meta` (`<scope>:source_health.<source>`): its last good read, its last failure and that failure's kind. A good read means usable data came back. A page that loads and parses to nothing is a failure of kind `empty` or `refused`. The record lives in the database, so a restart does not reset it. The ADS-B sweep is the one exception: its last good read is taken from its own `adsb_sweeps` table (the newest sweep that observed any aircraft). Code: `src/database/source-health.ts`.

| Metric | Description |
|--------|-------------|
| `starlink.source.hours_since_success` | Gauge, 5-min sweep. Tags `source`, `airline` (`all` for a source every airline shares). Hours since that source last gave usable data; for a source that has never succeeded, hours since it was first watched |
| `starlink.source.quiet` | Gauge, same sweep and tags. `1` while the source is past its own threshold, else `0` |
| `starlink.source.failure` | Count. Tags `source`, `airline`, `kind:error\|timeout\|blocked\|empty\|refused\|partial`. One per failed read. `source:flight_schedule,kind:empty` includes parked tails that have no schedule, so read that pair as a rate, not as errors |

Thresholds, in hours: `sheet_scrape` 6, `united_site` 6, `flight_schedule` 3, `adsb` 3, `qatar_schedule` 6, `alaska_site` 72 (its good reads come in bursts with ordinary gaps of about two days), `bts` 1488 (62 days; the file is monthly), and 72 for the daily jobs (`fleet_roster`, `alaska_tracker`, `fleet_progress`, `fleet_progress_tails`, `ship_numbers`, `faa_registry`, `sec_filings`, `starlink_geofeed`).

When a source passes its threshold the server posts one notice to `SLACK_WEBHOOK_URL`, and one more when the source returns. Without the webhook nothing is posted; the outage is still logged once at error level (`source-health: … Data source quiet …`) and shows in the gauges. A Datadog monitor that does not depend on Slack:

```
max(last_15m):max:starlink.source.quiet{*} by {source,airline} >= 1
```

Set it to notify on missing data after 30 minutes: the sweep emits every 5, so silence means the server or its jobs are down.

While a source behind an airline's pages is quiet (`sheet_scrape`, `united_site`, `flight_schedule`, `fleet_roster`, `alaska_site`, `alaska_tracker`, `qatar_schedule`), that airline's "last updated" date is held at the source's last good read.

## Tracing

### Span Names

Background job spans:
- `scraper.update_data` - Hourly spreadsheet scrape and database update
- `flight_updater.run` - Flight data update cycle (trickle, every 30s)
- `flight_updater.update_tail` - Single tail number update
- `flight_updater.check_new_planes` - Check flights for newly discovered planes
- `starlink_verifier.run` - Verification batch cycle
- `starlink_verifier.verify_plane` - Single plane verification
- `fleet_sync.run` - FR24 fleet sync cycle (daily)
- `fleet_sync.fr24` - FR24 scrape operation
- `fleet_discovery.run` - Discovery batch cycle
- `fleet_discovery.verify_plane` - Single plane discovery check

HTTP spans:
- `http.request` - All incoming HTTP requests (API routes and home page)

### Common Tags

All spans include these tags where applicable:
- `tail_number` - Aircraft tail number
- `flight_number` - Flight number (e.g., UA123)
- `route` - Origin-destination (e.g., SFO-LAX)
- `result` - Outcome (success, error, starlink, not_starlink)
- `error` - Error flag on failures

## Local Development

### Testing Without Datadog Agent

The tracer gracefully handles missing agents. To verify the integration works:

1. Enable tracing temporarily:
   ```bash
   DD_TRACE_ENABLED=true bun run dev
   ```

2. Look for startup logs:
   ```
   dd-trace initialized (not connected to agent)
   ```

3. Check JSON logs have trace fields:
   ```json
   {
     "timestamp": "2024-01-01T00:00:00.000Z",
     "level": "info",
     "logger": "server",
     "message": "Server running at http://localhost:3000",
     "dd": {
       "trace_id": "1234567890",
       "span_id": "0987654321"
     }
   }
   ```

4. Set back to false:
   ```bash
   DD_TRACE_ENABLED=false
   ```

### Viewing Logs

Logs are written to `logs/app.log` in JSON format:

```bash
tail -f logs/app.log | jq .
```

## Usage Examples

### Adding Metrics

```typescript
import { metrics, COUNTERS } from "../observability";

// Increment a counter
metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: "success" });

// Set a gauge
metrics.gauge("planes.total", 150);

// Record a histogram value
metrics.histogram("request.duration", 125);
```

### Adding Spans

```typescript
import { withSpan } from "../observability";

// Wrap async operations with tracing
async function fetchData() {
  return withSpan("my_operation.fetch", async (span) => {
    span.setTag("custom_tag", "value");
    const result = await doWork();
    span.setTag("result.count", result.length);
    return result;
  });
}

// For background jobs, use withSpan with job.type tag
async function runBackgroundJob() {
  await withSpan(
    "my_job.run",
    async (span) => {
      span.setTag("job.type", "background");
      await doWork();
      span.setTag("result", "success");
    },
    { "job.type": "background" }
  );
}
```

## Troubleshooting

### "Cannot connect to agent" Errors

This is expected when `DD_TRACE_ENABLED=true` but no agent is running. The tracer continues to work and logs traces, but they won't be sent anywhere. This is safe for local development.

### High Memory Usage

If you see memory issues with dd-trace:
1. Ensure `profiling: false` is set
2. Ensure `runtimeMetrics: false` is set
3. Consider reducing sampling rate in production

### Logs Not Showing Trace IDs

Trace IDs only appear when there's an active span. Background logs during startup won't have trace context.

### Bun Crash on Import

If Bun crashes when importing dd-trace:
1. Update Bun to v1.1.6 or later: `bun upgrade`
2. Ensure the tracer is imported first in `server.ts`
3. Check that profiling and runtimeMetrics are disabled