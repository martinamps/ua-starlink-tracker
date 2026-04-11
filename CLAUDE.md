@./ops/CLAUDE.md

# UA Starlink Tracker

Tracks United Airlines' Starlink WiFi rollout and answers "does my flight have Starlink?" Live at [unitedstarlinktracker.com](https://unitedstarlinktracker.com). See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full setup.

## Commands

```bash
bun run dev                    # Dev server with hot reload
bun run test:setup             # Snapshot DB → /tmp/ua-test.sqlite (run before tests)
bun run test                   # Integration tests (49, against readonly snapshot)
bun run db-status              # Database overview (--full for details)
bun run scrape                 # Fetch fleet data from Google Sheets
bun run lint / format          # Biome
```

See `package.json` for the full script list (verification, discovery, sync, backtest helpers).

## Architecture

Bun + SQLite + server-rendered React. `server.ts` serves pages/APIs and starts background jobs:

| Job | Interval | Purpose |
|---|---|---|
| Spreadsheet scrape + consensus reconcile | 1 hr | Sync sheet → fleet, settle wifi status |
| Flight updater | 22.5 s | Keep `upcoming_flights` fresh (1–8 hr smart cache) |
| Starlink verifier | 60 s | Verify tails against United.com |
| Fleet discovery | 90 s | Find newly-equipped tails |
| Fleet sync | 24 hr | Full FR24 fleet pull |
| Ship-number sync | 24 hr | United ship→tail mapping sheet |

**Tables:** `starlink_planes`, `united_fleet`, `upcoming_flights`, `starlink_verification_log`, `departure_log`, `flight_routes`, `meta`

**Routes:** `/`, `/fleet`, `/check-flight`, `/route-planner`, `/mcp` · `/api/data`, `/api/check-flight`, `/api/predict-flight`, `/api/plan-route`, `/api/mismatches`, `/api/fleet-discovery`

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
