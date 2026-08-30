# Cost Analysis — current stack (2026-08)

Rewritten for the FR24-era architecture. The previous version of this file was a
2025 FlightAware AeroAPI optimization memo; that vendor is no longer in the
request path (the code path survives behind `FLIGHT_DATA_SOURCE=flightaware` +
`AEROAPI_KEY`, both unset in production) and its $108–120/month line item is
gone entirely.

Figures below are **estimated from code, config, and public price lists**.
Anything not verifiable from this repo is marked *unknown — check the bill*.
Never quote this file as actuals.

## Summary

| Line item | Est. monthly | Confidence |
|---|---|---|
| Flight/fleet data (FR24, unofficial endpoints) | $0 cash | High — no API key, no contract |
| Verification scraping (united.com, alaskaair.com, QR, Google Sheets) | $0 cash | High |
| VPS (single OVH box: app container + Datadog agent) | ~$10–40 | Low — plan *unknown, check the bill* |
| Datadog (APM + custom metrics) | $0–low hundreds | Low — plan, site, and billable series count *unknown, check usage page* |
| Plausible analytics (5 site domains) | ~$9–19 | Low — tier *unknown* |
| Domains (6: 5 sites + 1 parked redirect) | ~$6 (≈$70/yr) | Medium |
| GitHub Actions (CI + nightly OG images) | $0 | High — public repo |
| **Total cash** | **~$25–75 + Datadog** | |

The real costs of this stack are not cash: they are **reliability risk** on
unofficial data sources and **Datadog custom-metric cardinality**, which is the
only line item with organic growth.

## 1. Flight data — FR24 (was: FlightAware)

`FLIGHT_DATA_SOURCE` defaults to `flightradar24`
(`src/utils/constants.ts`), served through a Playwright-Chromium browser
transport with stealth (`src/api/fr24-browser-transport.ts`) against FR24's
free JSON endpoints. There is no API contract and no per-call fee.

What replaced the dollar cost:

- **Block risk.** Cloudflare/rate-limit responses are classified and breakered
  (`vendor.request` metrics, outage breakers in the jobs). A hard block means
  degraded freshness, not a bill.
- **Compute.** A headless Chromium per scrape burst on the VPS — covered by the
  VPS line, but it is why the box can't be the smallest tier.
- **Volume control** is still engineering-owned: the 22.5 s trickle updates one
  tail per tick with a 1–8 h smart cache, so FR24 sees a slow drip, not a
  crawl. Keep it that way; it is the upstream-citizenship convention as much as
  a cost lever.

## 2. Verification scraping — $0 cash, paid in fragility

- **united.com** verifier (60 s cadence, subprocess Chromium) and **fleet
  discovery** (90 s).
- **alaskaair.com** JSON status endpoint for AS/HA (90 s round-robin, no
  browser).
- **Qatar** flight-status API (hourly).
- **Google Sheets CSV export** for the UA community sheet + ship numbers +
  fleet-progress workbooks (hourly/daily; retried with backoff since Wave 0 —
  the export endpoint returns transient 429/5xx near the end of the 23-tab
  serial burst. Rate *unknown*: nothing counts sheet-fetch failures, so add a
  counter before quoting one).
- **FlyerTalk** QR/AS scrapes run from a residential IP via
  `residential-sync` (the OVH IP gets 403) — someone's home machine, $0.

None of these bill. All of them can break silently, which is what the
freshness gauges + deadman ratio exist for (docs/OBSERVABILITY.md).

## 3. Hosting — single VPS, Docker

One OVH VPS runs the app container (`Dockerfile`: `oven/bun:1.3.13-slim` +
Playwright Chromium, `bun --smol`) and a host-level Datadog agent
(`DD_TRACE_AGENT_HOSTNAME=host.docker.internal`). SQLite lives on a bind mount
— no managed database, no object storage, no CDN spend in this repo
(Cloudflare headers appear in `clientIp`, so DNS/proxy is likely on
Cloudflare's free tier — *unknown*).

Exact plan/price: *unknown — check the OVH bill*. The Chromium requirement puts
a realistic floor around a 2 vCPU / 4 GB tier (~$10–20/mo at OVH's 2026 list
prices; up to ~$40 for comfortable headroom).

## 4. Datadog — the growing line item

Service `ua-starlink-tracker`. The Datadog site is *unknown from this repo* —
`DD_SITE` appears in neither the code nor `.env.example`, so it lives in the
deploy environment; read it off the agent config before reasoning about
regional pricing. Three billable surfaces:

1. **APM** (dd-trace, opt-in via `DD_TRACE_ENABLED`) — per-host APM pricing,
   one host. *Unknown plan.*
2. **Custom metrics via DogStatsD** — the one with growth. Billing counts
   unique series (metric name × tag-value combination).
3. **Log management** — only if `logs/app.log` is shipped by the agent;
   *unknown whether enabled*.

Code-side inventory (`src/observability/metrics.ts`, counted from the
`COUNTERS`/`GAUGES`/`DISTRIBUTIONS` blocks): 16 counters, 15 gauges, 4
distributions, all under a documented per-tag cardinality budget (each tag
≤ ~25 values). The big multipliers are `http.request`
(method × ≤25 routes × status × 5 tenants × 12 client classes — bounded in
code but easily the largest family), `flight.lookup_result` (outcome ×
confidence × days_out × airline), and `vendor.request`. Recent deliberate
growth: the `client_class` named-crawler split, the `days_out` bucket, the
`dataset` tag mirror, per-airline tagging as HA/AS/QR shipped, and (Wave 0)
`data.freshness_ratio`, which roughly doubles the freshness family (~7 jobs ×
≤4 airlines ≈ +30 series — noise next to `http.request`).

Rules that keep this bounded — treat them as billing controls, not style:

- every tag goes through a normalizer; free-text never becomes a tag value;
- unmatched routes collapse to the literal tag value `unmatched` — never `/*`:
  Datadog strips `*` from tag values, so `/*` arrived as `/` and merged every
  unmatched-path request into the homepage series (see `metricRoute` in
  `src/server/app.ts`, which records the measurement). Unknown enums bucket to
  `other`/`unknown`;
- new tags need a budget line in the metrics.ts header comment.

If the cardinality alert fires again, the first place to look is whichever tag
family most recently gained a dimension — multiply its budget lines before
shipping, and check DD's "Metrics without Limits" usage page for the actual
billable count (*unknown from code*).

## 5. Analytics, domains, CI

- **Plausible** — per-brand `analyticsDomain` for 5 sites; Plausible bills by
  total pageviews across sites. Tier *unknown* (entry tiers ~$9–19/mo).
- **Domains** — 6 registrations (united/hawaiian/alaska/airline/qatar
  starlinktracker.com + parked deltastarlinktracker.com): ≈$70/yr.
- **GitHub Actions** — `test.yml` CI plus the nightly OG-image workflow
  (`og-images.yml`, ~09:10 UTC, Playwright render + commit). Public repo →
  free minutes, $0.
- **IndexNow** pings — free.

## 6. What changed vs the old analysis

| | 2025 (old file) | Now |
|---|---|---|
| Flight data | FlightAware AeroAPI, $0.005/call, $108–120/mo | FR24 unofficial, $0 cash |
| Biggest cost lever | API call frequency | Datadog metric cardinality |
| Update cadence | 30 min → 8 h to save money | 22.5 s trickle, cost-free |
| Infra | (not covered) | 1 VPS + Docker + DD agent |

The old memo's lesson ("update frequency is the bill") inverted: data is now
free and frequent, and the meter to watch is observability, not ingestion.
