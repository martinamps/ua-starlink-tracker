@./ops/CLAUDE.md

# UA Starlink Tracker

Tracks United Airlines' Starlink WiFi rollout and answers "does my flight have Starlink?" Live at [unitedstarlinktracker.com](https://unitedstarlinktracker.com). See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full setup.

## Commands

```bash
bun run dev                    # Dev server with hot reload
bun run test:setup             # Snapshot DB → .test-snapshot.sqlite (run before tests)
bun run test                   # ~2,000 tests (unit + integration against the readonly snapshot)
bun run db-status              # Database overview (--full for details)
bun run scrape                 # Fetch fleet data from Google Sheets
bun run lint / format          # Biome
bun run knip                   # Dead files/exports (knip.json lists the entries)
bun run capture-golden         # Regenerate tests/golden/mcp-tools-list.json (intentional changes only)
```

See `package.json` for the full script list (verification, discovery, sync, backtest helpers).

## Architecture

Bun + SQLite + server-rendered React, multi-tenant by Host (`src/airlines/registry.ts`: per-airline sites plus the hub). `server.ts` opens one DB handle (`openDatabase` + `migrate` once), serves `createApp(db).dispatch`, and shares the handle with every background job (`DISABLE_JOBS=1` turns them off):

| Job | Interval | Purpose |
|---|---|---|
| Sheet scrape + consensus reconcile | 1 hr | Sync sheet → fleet, settle wifi status |
| Flight updater | 22.5 s | Keep `upcoming_flights` fresh (1–8 hr smart cache) |
| Starlink verifier | 60 s | Verify UA tails against United.com |
| Fleet discovery | 90 s | Find newly-equipped UA tails |
| Alaska verifier | 90 s | HA/AS wifi from alaskaair.com |
| Qatar schedule ingester | 1 hr | Per-flight QR equipment → `qatar_schedule` |
| Archive departures / first-flight watch | 5 min | `departure_log`, `first_flights` |
| Fleet sync | 24 hr | Full FR24 fleet pull, every enabled airline |
| Daily jobs | 24 hr | Ship numbers, fleet progress (+ tails), FAA registry, SEC anchors, BTS, geofeed, crash-row prune |
| ADS-B sweep, data-freshness gauges | 5 min | Metrics only (FR24 stays the serving source) |

FlyerTalk QR/AS/AF data arrives via `bun run residential-sync` from a laptop (prod's IP is blocked).

**Tables (27):** core `starlink_planes`, `united_fleet`, `upcoming_flights`, `starlink_verification_log`, `departure_log`, `flight_routes`, `flight_assignment_log`, `first_flights`, `meta`; pipeline `fleet_progress`, `fleet_progress_tails`, `fleet_guide_tails`, `fleet_anchors`, `pipeline_events`, `starlink_prefixes`, `faa_registry`, `sec_filings_seen`; Qatar `qatar_schedule`, `qatar_equipment_history`, `qatar_fetch_coverage`; ADS-B `adsb_sweeps`, `adsb_observations`, `adsb_flight_draws`; BTS `bts_monthly_operators`, `bts_monthly_routes`, `bts_monthly_tails`; `passenger_reports`. DDL lives in `setupTables` (`src/database/database.ts`).

**Routes:** exact entries in `createApp(db).routes`, prefixes in `prefixRoutes` (`src/server/app.ts`; each entry declares its methods and feature flag). Pages `/`, `/fleet`, `/fleet/{type}`, `/check-flight[/…]`, `/route-planner[/…]`, `/routes`, `/airlines[/…]`, `/compare[/…]`, `/newly-equipped`, `/methodology`, `/timeline`, `/how-to-check`, `/is-starlink-free`, `/live-tv`, `/install-rate`, `/embed`, `/mcp` · APIs `/api/data`, `/api/fleet-summary`, `/api/routes`, `/api/check-flight`, `/api/check-any-flight`, `/api/compare-route`, `/api/predict-flight`, `/api/plan-route`, `/api/mismatches`, `/api/fleet-discovery`, `/api/passenger-probe` · feeds `/feed.xml`, `/cal/…` (.ics), `/badge.svg`, `/data/starlink-tails.csv`, `/sitemap.xml`, `/llms.txt`, `/robots.txt`. `app.routeTags` is the `route` metric tag budget (docs/OBSERVABILITY.md).

**MCP:** stateless Streamable HTTP at `/mcp` exposing 7 tools (`check_flight`, `predict_flight_starlink`, `plan_starlink_itinerary`, `predict_route_starlink`, `search_starlink_flights`, `get_fleet_stats`, `list_starlink_aircraft`). See `src/api/mcp-server.ts`.

## Public contracts — do not break

- **`GET /api/check-flight?flight_number=UA123&date=YYYY-MM-DD`** → `{ hasStarlink: boolean, flights: [] }` with CORS for Google Flights. The Chrome extension depends on this exact shape.
- **`GET /api/check-any-flight?flight_number=HA50&date=YYYY-MM-DD`** (hub host) — extension non-UA surface since v2; top-level `hasStarlink`, `confidence`, `probability`, `airline`, `error`, `flights`. Additive only.
- **MCP tool names and result shapes** — clients cache schemas at connect time.
- **Goldens pin all three byte-for-byte:** `tests/golden/api-contracts.json` (check-flight, check-any-flight, MCP `check_flight`, .ics) and `tests/golden/mcp-tools-list.json`. A diff there is a contract change; regenerate (`UPDATE_GOLDEN=1 bun test tests/api-contract-golden.test.ts`, `bun run capture-golden`) only on purpose.
- **Leg scoping** — both endpoints and MCP `check_flight` accept optional `origin`/`destination` (IATA; K/P ICAO accepted). Absent → the response is byte-identical to the unscoped one; `leg` appears only when a param is sent. Invalid input never errors: it answers unscoped with `leg.match: "unscoped"` and a `reason` (invalid_airport, same_airport, no_timezone, ambiguous_leg).

## Conventions

- **No obvious comments** — comment the *why*, not the *what*; clear names over prose
- **Tests assert shapes, not values** — integration tests run against a real data snapshot and must survive data drift
- **Logging** — `import { info, error, debug } from "./utils/logger"` (auto-tags filename, writes console + `logs/app.log`)
- **Metrics** — route every metric tag through the normalizers in `src/observability/metrics.ts`; always set the `airline` tag
- **Upstream citizenship** — public endpoints serve from the DB; never proxy live scraping to callers
- **Database** — `openDatabase()` opens, `migrate()` runs schema work once per process; jobs take the shared handle, never open their own. CLI scripts use `initializeDatabase()`. Readers take a required `airline`
- **"Equipped" has one definition** — `src/database/sql/equipped.ts` (`equippedSql` SQL predicate and its JS twin `isEquipped`/`tailEvidence`); fleet denominators come from `programmeRoster()` (`src/database/roster.ts`); shared SQL in `sql/fragments.ts`, time windows in `sql/windows.ts`. Never re-derive either inline
- **Responses** — build with `json`/`jsonError`/`text`/`xml`/`methodNotAllowed` and `CACHE` from `src/server/respond.ts`; verdict wording goes through `verdictSummary` in `src/api/check-flight-core.ts`; flight numbers through `src/airlines/flight-number.ts`; TTL caches via `src/utils/ttl-cache.ts`, delays via `src/utils/sleep.ts`
- **UI primitives** — pages compose `PageShell`, `Panel`, `Eyebrow`, `SectionTitle`, `StatValue`, `ButtonLink`, `Chip` from `src/components/layout.tsx`, `Meter`/`Pill`/tones from `src/components/ui/`, one `Faq` + JSON-LD builders (`components/faq.tsx`) and one `FlightSearchForm`. Numbers and dates only via `components/ui/format.ts` (`fmt`, `pct`, `longDate`…). Browser JS lives in `src/client/entries/*` (bundled at boot, served content-hashed), never inline
- **Tailwind is compiled, not JIT** — `bun run build:css` emits gitignored `static/tailwind.css`; a class only works if the scanner finds it verbatim in `index.html` or `src/`, so never build one at runtime (`` `text-${x}-500` ``). `tests/stylesheet.test.ts` enforces it
