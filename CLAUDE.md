# UA Starlink Tracker

**Open source project** - keep documentation clean and concise. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for detailed setup.

Tracks United Airlines' Starlink WiFi installation progress across their fleet. Live at [unitedstarlinktracker.com](https://unitedstarlinktracker.com).

## Commands

```bash
bun run dev                    # Dev server with hot reload
bun run db-status              # Database overview (--full for details)
bun run scrape                 # Fetch fleet data from Google Sheets
```

### Verification & Discovery
```bash
bun run check-starlink 4680 2026-01-04 AUS DEN  # Check single flight
bun run verify-starlink 10                       # Verify N planes against United.com
bun run verify-starlink --tail=N12345            # Verify specific aircraft
bun run discover --batch=5                       # Discover new Starlink planes
bun run discover --stats                         # Show discovery statistics
```

### Fleet Sync
```bash
bun run sync-fleet             # Full sync (FR24 + spreadsheet)
bun run update-flights         # Bulk update flight data
```

## Data Sources

| Source | Purpose | Notes |
|--------|---------|-------|
| Google Sheets | Starlink status (source of truth) | Hourly scrape |
| FlightRadar24 API | Flight schedules | Free, primary |
| United.com | Verification | Playwright scraping |
| FlightAware | Flight fallback | Paid, optional |

## Architecture

### Background Jobs (started by server.ts)

| Job | Interval | Purpose |
|-----|----------|---------|
| Spreadsheet scrape | 1 hour | Update plane list from Google Sheets |
| Flight updater | 30 sec | Keep flight data fresh (1-8hr smart caching) |
| Starlink verifier | 60 sec | Verify planes against United.com |
| Fleet discovery | 90 sec | Find new Starlink planes |
| Fleet sync | 24 hours | Sync full fleet from FR24 |

### Database Tables

| Table | Purpose |
|-------|---------|
| `starlink_planes` | Aircraft with Starlink |
| `upcoming_flights` | Cached flight schedules |
| `starlink_verification_log` | Verification audit trail |
| `united_fleet` | Full fleet for discovery |
| `meta` | Stats and timestamps |

### Key Files

```
server.ts                              # HTTP server, routes, job orchestration
src/api/flightradar24-api.ts           # FR24 flight data (primary)
src/api/flight-updater.ts              # Smart flight caching with backoff
src/database/database.ts               # SQLite operations
src/scripts/starlink-verifier.ts       # Background verification
src/scripts/fleet-discovery.ts         # New plane discovery
src/scripts/united-starlink-checker.ts # Playwright United.com scraper
src/utils/utils.ts                     # Google Sheets scraping
src/components/page.tsx                # React SSR frontend
```

## API

### `/api/check-flight` (Chrome extension uses this)

```
GET /api/check-flight?flight_number=UA123&date=2025-06-07
```

**Do not break this contract:**
- Accept `flight_number` and `date` params
- Return `{ hasStarlink: boolean, flights: [] }`
- CORS headers for Google Flights domains

### `/api/data`

Returns all Starlink aircraft with upcoming flights.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Set to "production" for prod |
| `AEROAPI_KEY` | No | FlightAware fallback (not used by default) |

## Important Notes

- **FlightRadar24 is primary** - switched from FlightAware to save $1xxs/mo
- **Smart caching** - flight data refreshes based on proximity (1hr if flight <6hr away, up to 8hr otherwise)
- **Verification jitter** - each plane re-verified every 48-96hr (deterministic per tail)
- **Playwright stealth** - United.com scraping uses stealth plugin to avoid detection
- **SSR only** - minimal client JS, server-rendered React

## Chrome Extension

[Chrome Web Store](https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi) - annotates Google Flights with Starlink badges.

## Logging

```typescript
import { info, error, debug } from "./utils/logger";
info("message");  // Auto-detects filename, writes to console + logs/app.log
```

Format: `2026-01-03T21:18:03.610Z [filename] message`
