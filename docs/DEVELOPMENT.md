# Development

## Setup

```bash
# Install dependencies
bun install

# Start development server with hot reloading
bun run dev

# Run production server
bun run start
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FLIGHTAWARE_API_KEY` | Yes | FlightAware AeroAPI key for flight tracking |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Set to "production" for production mode |

## Scripts

```bash
bun run dev              # Development server with hot reload
bun run start            # Production server
bun run scrape           # Manually fetch fleet data from source spreadsheets
bun run db-status        # View database statistics
bun run verify-starlink  # Run Starlink verification against United.com
```

## Architecture

### Data Flow

1. **Scraping**: Fetches fleet data from public Google Sheets
2. **Processing**: Identifies aircraft with Starlink (marked "StrLnk" in WiFi column)
3. **Flight Data**: FlightAware API provides upcoming flights for each aircraft
4. **Verification**: Background process cross-checks data against United.com
5. **Storage**: SQLite database with caching and rate limiting
6. **API**: Serves data to web frontend and Chrome extension

### Key Files

- `server.ts` - HTTP server and API routes
- `src/utils/utils.ts` - Data fetching and processing
- `src/database/database.ts` - SQLite operations
- `src/api/flight-updater.ts` - FlightAware integration
- `src/components/page.tsx` - React frontend component

## API

### Check Flight Starlink Status

Used by the Chrome extension to annotate Google Flights.

```
GET /api/check-flight?flight_number=UA123&date=2025-06-07
```

**Response:**
```json
{
  "hasStarlink": true,
  "flights": [{
    "tail_number": "N127SY",
    "aircraft_type": "737-900",
    "flight_number": "UA123",
    "departure_airport": "ORD",
    "arrival_airport": "LAX",
    "departure_time_formatted": "2025-06-07T12:00:00.000Z",
    "starlink_installed_date": "2025-03-07"
  }]
}
```

### Get All Starlink Aircraft

```
GET /api/data
```

Returns complete fleet data including all Starlink-equipped aircraft and their upcoming flights.

## Deployment

```bash
docker build -t ua-starlink-tracker .
docker run -p 3000:3000 -v /path/to/data:/srv/ua-starlink-tracker ua-starlink-tracker
```

The container expects a mounted volume for the SQLite database.

## Chrome Extension Compatibility

The `/api/check-flight` endpoint is used by the [Chrome extension](https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi). When modifying the API, maintain backwards compatibility:

- Accept `flight_number` and `date` query parameters
- Return `hasStarlink` (boolean) and `flights` (array) in response
- Include CORS headers for Google Flights domains
