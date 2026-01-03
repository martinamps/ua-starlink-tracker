# Development

## Setup

```bash
bun install
bun run dev    # Development server with hot reload
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AEROAPI_KEY` | No | FlightAware API key (fallback, not used by default) |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Set to "production" for production mode |

## Data Sources

| Source | Purpose | Rate Limit |
|--------|---------|------------|
| **Google Sheets** | Starlink installation status (source of truth) | Hourly scrape |
| **FlightRadar24 API** | Flight schedules (free, no auth) | 2s between requests |
| **United.com** | Verification via Playwright scraping | 60s between checks |
| **FlightAware AeroAPI** | Fallback for flight data (paid) | 1s between requests |

## Scripts

### Development
```bash
bun run dev              # Dev server with hot reload
bun run start            # Production server
bun run lint             # Check code with Biome
bun run format           # Auto-format
```

### Data & Debugging
```bash
bun run scrape           # Fetch fleet data from Google Sheets
bun run db-status        # Database overview
bun run db-status --full # Detailed per-plane status (alias: -f)
bun run update-flights   # Bulk update flight data for all planes
```

### Verification
```bash
# Check a single flight on United.com
bun run check-starlink <flight> <date> <origin> <dest>
bun run check-starlink 4680 2026-01-01 AUS DEN

# Batch verify planes against United.com
bun run verify-starlink           # Verify up to 5 planes (default)
bun run verify-starlink 20        # Verify up to 20 planes
bun run verify-starlink --force   # Ignore rate limits, re-verify all
bun run verify-starlink --tail=N12345  # Verify specific aircraft
```

### Fleet Discovery
```bash
bun run discover                  # Background mode (90s intervals)
bun run discover --discovery      # Fast mode (30s intervals)
bun run discover --batch=10       # Run single batch for N planes
bun run discover --tail=N12345    # Verify specific tail, add if Starlink
bun run discover --stats          # Show discovery statistics only
```

### Fleet Sync
```bash
bun run sync-fleet                # Full sync (FR24 + spreadsheet)
bun run sync-fleet fr24           # Only sync from FlightRadar24
bun run sync-fleet spreadsheet    # Only sync from spreadsheet
bun run scrape-fr24               # Scrape FR24 fleet to JSON file
```

## Architecture

### Background Jobs

The server starts several background processes:

| Job | Interval | Purpose |
|-----|----------|---------|
| Spreadsheet scrape | 1 hour | Update Starlink plane list from Google Sheets |
| Flight updater | 30 sec | Keep flight data fresh (smart caching: 1-8hr based on proximity) |
| Starlink verifier | 60 sec | Verify planes against United.com (48-96hr per plane) |
| Fleet discovery | 90 sec | Find new Starlink planes across entire fleet |
| Fleet sync | 24 hours | Sync full fleet from FlightRadar24 |

### Database Tables

| Table | Purpose |
|-------|---------|
| `starlink_planes` | Aircraft with Starlink (from spreadsheet + discovery) |
| `upcoming_flights` | Cached flight schedules |
| `starlink_verification_log` | Audit trail of all verification attempts |
| `united_fleet` | Full fleet for discovery tracking |
| `meta` | Key-value store for stats |

### Key Files

```
server.ts                           # HTTP server, API routes, job orchestration
src/api/flightradar24-api.ts        # FR24 flight data (primary)
src/api/flightaware-api.ts          # FlightAware fallback
src/api/flight-updater.ts           # Smart flight data caching
src/database/database.ts            # SQLite operations
src/scripts/starlink-verifier.ts    # Background verification
src/scripts/fleet-discovery.ts      # New plane discovery
src/scripts/united-starlink-checker.ts  # Playwright scraper
src/utils/utils.ts                  # Google Sheets scraping
src/components/page.tsx             # React frontend
```

## API

### Check Flight Starlink Status

Used by the Chrome extension.

```
GET /api/check-flight?flight_number=UA123&date=2025-06-07
```

```json
{
  "hasStarlink": true,
  "flights": [{
    "tail_number": "N127SY",
    "aircraft_type": "737-900",
    "flight_number": "UA123",
    "departure_airport": "ORD",
    "arrival_airport": "LAX"
  }]
}
```

### Get All Starlink Aircraft

```
GET /api/data
```

Returns all Starlink aircraft with upcoming flights.

## Deployment

```bash
docker build -t ua-starlink-tracker .
docker run -p 3000:3000 -v /path/to/data:/srv/ua-starlink-tracker ua-starlink-tracker
```

## Chrome Extension Compatibility

The `/api/check-flight` endpoint powers the [Chrome extension](https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi). Maintain backwards compatibility:

- Accept `flight_number` and `date` query parameters
- Return `hasStarlink` (boolean) and `flights` (array)
- Include CORS headers for Google Flights domains
