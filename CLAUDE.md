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
bun run capture-golden         # Regenerate both contract goldens in tests/golden (intentional changes only)
```

See `package.json` for the full script list (verification, discovery, sync, backtest helpers).

## Architecture

Bun + SQLite + server-rendered React, multi-tenant by Host (`src/airlines/registry.ts`: per-airline sites plus the hub). `server.ts` opens one DB handle (`openDatabase` + `migrate` once), serves `createApp(db).dispatch`, and shares the handle with every background job (`DISABLE_JOBS=1` turns them off):

| Job | Interval | Purpose |
|---|---|---|
| Sheet scrape + consensus reconcile | 1 hr | Sync sheet → fleet, hangar notes, sub-fleet check order, settle wifi status |
| Flight updater | 22.5 s | Keep `upcoming_flights` fresh (1–8 hr smart cache) |
| Starlink verifier | 60 s | Verify UA tails against United.com, longest-waiting first, inside the shared check budget |
| Fleet discovery | 90 s | Find newly-equipped UA tails; shares the 364-a-day United check budget with the verifier (`src/scripts/united-check-budget.ts`) and leaves settled tails the verifier has just confirmed |
| Alaska verifier | 90 s | HA/AS wifi from alaskaair.com |
| Alaska tracker | 24 hr | AS per-type counts from Alaska's newsroom tracker → `fleet_progress`; complete types settle per tail, unless the chart fails its bounds (`src/database/chart-bounds.ts`), which settles none |
| Qatar schedule ingester | 1 hr | Per-flight QR equipment → `qatar_schedule` |
| Archive departures / first-flight watch | 5 min | `departure_log`, `first_flights`; week-old assignment rows move to `flown_assignments` (kept a year) |
| Fleet sync | 24 hr | Full FR24 fleet pull, every enabled airline |
| Daily jobs | 24 hr | Ship numbers, fleet progress (+ tails), FAA registry, SEC anchors, BTS, geofeed, crash-row prune |
| ADS-B sweep, data-freshness gauges | 5 min | Metrics only (FR24 stays the serving source) |
| Source health | 5 min | Per-source last good read and last failure, kept in `meta`; gauges, and one Slack notice when a source goes quiet and one when it returns (`src/database/source-health.ts`) |
| Passenger dedupe-key sweep | 6 hr | Blanks passenger-report dedupe keys past their window |
| IndexNow new tails | 5 min | Reads the equipped list; when a tail is new, submits that tail's changed pages for each live site, and again at a later pass if the send was capped, paused or failed (40 addresses a site a day; INDEXNOW_DISABLED=1 or true turns it off) |

Community tail lists are no longer imported: QR rides its type rule + schedule ingester, AS its verifier, and AF serves its last stored guide, dated.

**Tables (30):** core `starlink_planes`, `united_fleet`, `upcoming_flights`, `starlink_verification_log`, `departure_log`, `flight_routes`, `flight_assignment_log`, `flown_assignments`, `unread_aircraft_log`, `first_flights`, `meta`; pipeline `fleet_progress`, `fleet_progress_tails`, `fleet_guide_tails`, `fleet_anchors`, `pipeline_events`, `starlink_prefixes`, `faa_registry`, `sec_filings_seen`, `sheet_mod_notes`; Qatar `qatar_schedule`, `qatar_equipment_history`, `qatar_fetch_coverage`; ADS-B `adsb_sweeps`, `adsb_observations`, `adsb_flight_draws`; BTS `bts_monthly_operators`, `bts_monthly_routes`, `bts_monthly_tails`; `passenger_reports`. DDL lives in `setupTables` (`src/database/database.ts`).

**Routes:** exact entries in `createApp(db).routes`, prefixes in `prefixRoutes` (`src/server/app.ts`; each entry declares its methods and feature flag). Pages `/`, `/fleet`, `/fleet/{type}`, `/check-flight[/…]`, `/route-planner[/…]`, `/routes`, `/routes/{airport}`, `/airlines[/…]`, `/compare[/…]`, `/newly-equipped`, `/methodology`, `/timeline`, `/how-to-check`, `/is-starlink-free`, `/live-tv`, `/install-rate`, `/embed`, `/mcp` · APIs `/api/data`, `/api/fleet-summary`, `/api/routes`, `/api/check-flight`, `/api/check-any-flight`, `/api/compare-route`, `/api/predict-flight`, `/api/plan-route`, `/api/mismatches`, `/api/fleet-discovery`, `/api/passenger-probe` · feeds `/feed.xml`, `/cal/…` (.ics), `/badge.svg`, `/data/starlink-tails.csv`, `/sitemap.xml`, `/llms.txt`, `/robots.txt`. `app.routeTags` is the `route` metric tag budget (docs/OBSERVABILITY.md).

**MCP:** stateless Streamable HTTP at `/mcp` exposing 7 tools (`check_flight`, `predict_flight_starlink`, `plan_starlink_itinerary`, `predict_route_starlink`, `search_starlink_flights`, `get_fleet_stats`, `list_starlink_aircraft`). See `src/api/mcp-server.ts`.

## Public contracts — do not break

- **`GET /api/check-flight?flight_number=UA123&date=YYYY-MM-DD`** → `{ hasStarlink: boolean, flights: [] }` with CORS for Google Flights. The Chrome extension depends on this exact shape.
- **`GET /api/check-any-flight?flight_number=HA50&date=YYYY-MM-DD`** (hub host) — extension non-UA surface since v2; top-level `hasStarlink`, `confidence`, `probability`, `airline`, `error`, `flights`. Additive only.
- **MCP tool names and result shapes** — clients cache schemas at connect time.
- **Goldens pin all three byte-for-byte:** `tests/golden/api-contracts.json` (check-flight, check-any-flight, MCP `check_flight`, .ics) and `tests/golden/mcp-tools-list.json`. A diff there is a contract change; regenerate both with `bun run capture-golden` only on purpose. A missing fixture fails the test rather than being written.
- **`GET /api/routes`** — `rows[].flight_numbers` counts marketing flight slots (distinct `slot_flight`), so UA5212 and its operating spelling SKW5212 are one number. It once counted stored spellings, which double-counted every regional codeshare; that was a bug, and the field's name and type are unchanged.
- **Leg scoping** — both endpoints and MCP `check_flight` accept optional `origin`/`destination` (IATA; K/P ICAO accepted). Absent → the response is byte-identical to the unscoped one; `leg` appears only when a param is sent. Invalid input never errors: it answers unscoped with `leg.match: "unscoped"` and a `reason` (invalid_airport, same_airport, no_timezone, ambiguous_leg).

## Conventions

- **No obvious comments** — comment the *why*, not the *what*; clear names over prose
- **Tests assert shapes, not values** — integration tests run against a real data snapshot and must survive data drift
- **Logging** — `import { info, error, debug } from "./utils/logger"` (auto-tags filename, writes console + `logs/app.log`)
- **Metrics** — route every metric tag through the normalizers in `src/observability/metrics.ts`; always set the `airline` tag
- **Upstream citizenship** — public endpoints serve from the DB; never proxy live scraping to callers
- **Database** — `openDatabase()` opens, `migrate()` runs schema work once per process; jobs take the shared handle, never open their own. CLI scripts use `initializeDatabase()`. Readers take a required `airline`
- **"Equipped" has one definition** — `src/database/sql/equipped.ts` (`equippedSql` SQL predicate and its JS twin `isEquipped`/`tailEvidence`); a listing nobody has observed is held out while the sheet's own hangar note says the jet is in for its fit (`modHoldSql`/`modNoteHolds`, parsed strictly in `src/utils/sheet-mod-note.ts`); fleet denominators come from `programmeRoster()` (`src/database/roster.ts`), UA's headline total included: the sheet's own tally is only the floor for an airline with no roster rows, and `refreshFleetMeta` overwrites it; shared SQL in `sql/fragments.ts`, time windows in `sql/windows.ts`. Never re-derive either inline
- **Responses** — build with `json`/`jsonError`/`text`/`xml`/`methodNotAllowed` and `CACHE` from `src/server/respond.ts`; verdict wording goes through `verdictSummary` in `src/api/check-flight-core.ts`; flight numbers through `src/airlines/flight-number.ts`; TTL caches via `src/utils/ttl-cache.ts`, delays via `src/utils/sleep.ts`
- **UI primitives** — pages compose `PageShell`, `Panel`, `Eyebrow`, `SectionTitle`, `StatValue`, `ButtonLink`, `Chip` from `src/components/layout.tsx`, `Meter`/`Pill`/tones from `src/components/ui/`, one `Faq` + JSON-LD builders (`components/faq.tsx`) and one `FlightSearchForm`. Numbers and dates only via `components/ui/format.ts` (`fmt`, `pct`, `longDate`…). Browser JS lives in `src/client/entries/*` (bundled at boot, served content-hashed), never inline
- **Tailwind is compiled, not JIT** — `bun run build:css` emits gitignored `static/tailwind.css`; a class only works if the scanner finds it verbatim in `index.html` or `src/`, so never build one at runtime (`` `text-${x}-500` ``). `tests/stylesheet.test.ts` enforces it
