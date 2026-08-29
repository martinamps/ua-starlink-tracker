@./ops/CLAUDE.md

# UA Starlink Tracker

Tracks United Airlines' Starlink WiFi rollout and answers "does my flight have Starlink?" Live at [unitedstarlinktracker.com](https://unitedstarlinktracker.com). See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full setup.

## Commands

```bash
bun run dev                    # Dev server with hot reload
bun run test:setup             # Snapshot DB → .test-snapshot.sqlite (run before tests)
bun run test                   # Integration tests (49, against readonly snapshot)
bun run db-status              # Database overview (--full for details)
bun run scrape                 # Fetch fleet data from Google Sheets
bun run lint / format          # Biome
```

See `package.json` for the full script list (verification, discovery, sync, backtest helpers).

## Architecture

Bun + SQLite + server-rendered React, multi-tenant by Host header (UA/HA/AS sites + the hub; see `src/airlines/registry.ts`). `server.ts` serves pages/APIs and starts background jobs:

| Job | Interval | Purpose |
|---|---|---|
| `sheet_scrape` | 1 hr | UA community sheet → fleet, consensus + type reconcile, precision gauges |
| Flight updater | 22.5 s | Keep `upcoming_flights` fresh (1–8 hr smart cache) |
| Starlink verifier | 60 s | Verify UA tails against united.com |
| Fleet discovery | 90 s | Find newly-equipped UA tails |
| Alaska verifier | 90 s | AS/HA tail/type checks via alaskaair.com (round-robin) |
| Qatar schedule ingester | 1 hr | QR per-flight equipment → `qatar_schedule` |
| Fleet sync | 24 hr | Full FR24 fleet pull, all enabled airlines |
| Freshness emitter | 5 min | `data.freshness_seconds`/`_ratio` gauges from DB write timestamps |
| `archive_departures` | 5 min | Departed flights → `departure_log` |
| Ship-number sync | 24 hr | United ship→tail mapping sheet |
| Fleet progress | 24 hr | UA install-pipeline counts from the fleet-site workbooks |
| FAA registry | 24 hr | Registration existence/dereg hygiene + Mode-S hex |
| SEC anchors | 24 hr | UAL/SkyWest/Republic filings watcher (official count anchors) |
| ADS-B sweep | 5 min | Shadow-compare live callsigns vs FR24 assignments (metrics-only) |
| BTS sync | 24 hr | Monthly BTS shadow ingest when a new month posts |
| Geofeed | 24 hr | Starlink RFC 8805 geofeed (passenger-verify probe; env-gated) |
| `prune_crash_rows` | 24 hr | Drop subprocess-crash log noise |

**Core tables:** `starlink_planes`, `united_fleet`, `upcoming_flights`, `starlink_verification_log`, `departure_log`, `flight_routes`, `meta` — plus per-job side tables (`qatar_schedule`, `faa_registry`, `fleet_progress`, `adsb_*`, `bts_*`, `sec_filings_seen`, `starlink_prefixes`)

**Routes** (feature-gated per site via `SITE_PAGES`/`SiteFeatures`): pages `/`, `/fleet`, `/routes`, `/airlines[/{slug}]`, `/check-flight[/{fn}]`, `/route-planner[/{o}/{d}]`, `/methodology`, `/mcp` · APIs `/api/data`, `/api/fleet-summary`, `/api/routes`, `/api/check-flight`, `/api/check-any-flight`, `/api/compare-route`, `/api/predict-flight`, `/api/plan-route`, `/api/mismatches`, `/api/fleet-discovery`, `/api/passenger-probe` · ops/SEO `/healthz`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`

**MCP:** stateless Streamable HTTP at `/mcp` exposing 7 tools (`check_flight`, `predict_flight_starlink`, `plan_starlink_itinerary`, `predict_route_starlink`, `search_starlink_flights`, `get_fleet_stats`, `list_starlink_aircraft`). See `src/api/mcp-server.ts`.

## Public contracts — do not break

- **`GET /api/check-flight?flight_number=UA123&date=YYYY-MM-DD`** → `{ hasStarlink: boolean, flights: [] }` with CORS for Google Flights. The Chrome extension depends on this exact shape.
- **MCP tool names and result shapes** — clients cache schemas at connect time.

## Conventions

- **No obvious comments** — comment the *why*, not the *what*; clear names over prose
- **Tests assert shapes, not values** — integration tests run against a real data snapshot and must survive data drift
- **Logging** — `import { info, error, debug } from "./utils/logger"` (auto-tags filename, writes console + `logs/app.log`)
- **Metrics** — route every metric tag through the normalizers in `src/observability/metrics.ts`; always set the `airline` tag
- **Upstream citizenship** — public endpoints serve from the DB; never proxy live scraping to callers
