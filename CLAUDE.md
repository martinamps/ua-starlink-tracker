# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

UA-Starlink-Tracker is a web application that tracks United Airlines' Starlink WiFi installation progress. It scrapes data from Google Sheets containing fleet information, processes it to identify aircraft with Starlink WiFi, and displays the information on a responsive web interface with statistics and real-time flight tracking.

## Commands

### Development

```bash
# Start the development server with hot reloading
bun run dev

# Run the server without hot reloading
bun run start

# Manually run the scraper to get current data (outputs to console)
bun run scrape

# Run Starlink verification manually (checks N planes against United.com)
bun run verify-starlink         # Check up to 5 planes
bun run verify-starlink 10      # Check up to 10 planes
bun run verify-starlink --force # Force re-check all planes (ignore rate limits)
bun run verify-starlink --tail=N12345  # Check a specific tail number

# Check a single flight's Starlink status on United.com
bun run check-starlink <flightNumber> <date> <origin> <destination>
# Example: bun run check-starlink 4680 2026-01-01 AUS DEN

# View database status including verification stats
bun run db-status
```

## Architecture

### Core Components

1. **Data Fetching & Processing**
   - `src/utils/utils.ts` - Contains `fetchAllSheets()` which scrapes Google Sheets for aircraft data
   - `scrape.ts` - Command-line script to run data scraping and view results

2. **Database**
   - `src/database/database.ts` - SQLite database operations for storing aircraft, statistics, and flight data
   - `plane-data.sqlite` - Local SQLite database file with tables for aircraft, flights, and metadata
   - Database includes `last_flight_check` column for smart flight data caching

3. **API & Flight Data Integration**
   - `src/api/flightaware-api.ts` - FlightAware AeroAPI integration with rate limiting and retry logic
   - `src/api/flight-updater.ts` - Smart flight data updates with 6-hour caching and staggered checks
   - Includes exponential backoff with jitter for API rate limiting (429 errors)

4. **Starlink Verification System**
   - `src/scripts/starlink-verifier.ts` - Background verification runner that checks Starlink status against United.com
   - `src/scripts/united-starlink-checker.ts` - Playwright-based scraper that visits United.com flight status pages to extract WiFi provider info
   - Uses Playwright with stealth plugin to avoid detection
   - Verifies spreadsheet data by checking actual flight status pages for WiFi provider (Starlink, Panasonic, Viasat, Gogo, or None)
   - Stores verification results in `starlink_verification_log` table with `verified_wifi` column on planes

5. **Unified Logger** (`src/utils/logger.ts`)
   - Auto-detects calling filename from stack trace - no manual prefixes needed
   - Consistent format: `2026-01-01T21:18:03.610Z [filename] message`
   - Log levels: `info`, `warn`, `error`, `debug`
   - Writes to both console and `logs/app.log`
   - Usage: `import { info, error } from "../utils/logger"; info("message");`

6. **Type System**
   - `src/types.ts` - Shared TypeScript interfaces for Aircraft, Flight, FleetStats, and ApiResponse
   - Ensures type safety across the entire application

7. **Web Server**
   - `server.ts` - Bun HTTP server with improved template handling using `Bun.file()` and `import.meta.dir`
   - `src/utils/constants.ts` - Configuration values, content strings, and security settings
   - `src/utils/not-found.ts` - 404 page generator

8. **Frontend**
   - `src/components/page.tsx` - React component with responsive design and mobile-optimized flight display
   - `index.html` - Simplified HTML template for server-side rendering
   - Desktop: Table layout with full flight information
   - Mobile: Card-based layout with collapsible flight details

### Data Flow

1. **Data Collection**: Application periodically scrapes Google Sheets containing United Airlines fleet data
2. **Aircraft Identification**: Identifies aircraft with Starlink WiFi (marked as "StrLnk" in WiFi column)
3. **Flight Data**: FlightAware API provides real-time upcoming flight information for each aircraft
4. **Database Storage**: Data stored in SQLite with installation date preservation and flight caching
5. **API Endpoints**: 
   - `/api/data` - Returns all Starlink aircraft data with grouped flight information
   - `/api/check-flight` - Checks if a specific flight number has Starlink on a given date
6. **Frontend Rendering**: Server-side React rendering with minimal client-side JavaScript

### Key Features

#### Flight Tracking Integration
- Real-time upcoming flights for each Starlink-equipped aircraft
- Smart caching prevents API overuse (6-hour refresh threshold)
- Links to FlightAware for detailed flight tracking
- Clean airport code display (removes ICAO prefixes K, C, M)

#### Installation Date Preservation
- Maintains historical installation dates through data updates
- Prevents accidental overwrites during scraping operations
- Special handling for first Starlink installation (N127SY - Mar 7, 2025)

#### Responsive Design
- **Desktop**: Full table with flight information column showing 3 flights per aircraft
- **Mobile**: Card-based layout with all aircraft details and 2 flights per card
- Clean typography and visual hierarchy optimized for aviation enthusiasts

#### Starlink Verification System
The verifier cross-checks spreadsheet data against United.com to confirm WiFi providers:

- **Background Process**: `startStarlinkVerifier()` runs automatically when the server starts
- **Scheduling**: Checks 1 plane every ~60 seconds (±15s jitter) to distribute load
- **Rate Limiting**: Each plane is re-verified every 48-96 hours (jittered around 72h)
- **Data Source**: Fetches plane/flight data from the `/api/data` endpoint, then visits United.com flight status pages
- **Playwright Scraping**: Uses `united-starlink-checker.ts` with stealth plugin to scrape flight status pages
- **URL Pattern**: `https://www.united.com/en/us/flightstatus/details/{flightNumber}/{date}/{origin}/{destination}/UA`
- **Detection**: Looks for "Internet by Starlink", "Internet by Panasonic", etc. in page content
- **Storage**: Results stored in `starlink_verification_log` table; `verified_wifi` column updated on planes
- **Mismatch Detection**: `getWifiMismatches()` finds planes where spreadsheet and United.com disagree
- **Logging**: Writes to `logs/verifier.log` with structured JSON output

#### Data Integrity
- Database migration logic for schema updates
- Automatic preservation of existing installation dates
- Error handling and retry logic for external API calls

### Configuration

The application has different behaviors based on domain and environment:
- When accessed via "unitedstarlinktracker" domains, it displays United-specific content
- Production mode uses specific database paths and environment settings
- Security headers are configured for production use
- FlightAware API key required for flight data (set via environment variable)

### Important Implementation Notes

1. **Installation Date Bug Fix**: The scraper no longer overwrites DateFound - database handles date preservation
2. **Bun-Native File Handling**: Uses `Bun.file()` and `import.meta.dir` instead of Node.js fs operations
3. **Server-Side Rendering**: Minimal client-side JavaScript, primarily server-rendered for performance
4. **Type Safety**: Shared types ensure consistency between database, API, and frontend components

### Deployment

The application can be deployed using Docker:
```bash
# Build the Docker image
docker build -t ua-starlink-tracker .

# Run the container
docker run -p 3000:3000 -v /path/to/data:/srv/ua-starlink-tracker ua-starlink-tracker
```

The Docker container runs in production mode and expects a mounted volume for the database file.

### Environment Variables

- `FLIGHTAWARE_API_KEY` - Required for flight data integration
- `NODE_ENV` - Set to "production" for production deployment
- `PORT` - Server port (default: 3000)

### API Documentation

#### `/api/check-flight`

Checks if a specific flight has Starlink capability on a given date. Perfect for browser extensions that want to highlight Starlink-capable flights on Google Flights or similar services.

**Method:** GET

**Parameters:**
- `flight_number` (required): The flight number (e.g., "UA123")
- `date` (required): The date in YYYY-MM-DD format

**Example Request:**
```
GET /api/check-flight?flight_number=UA123&date=2025-06-07
```

**Success Response (200 OK):**
```json
{
  "hasStarlink": true,
  "flights": [
    {
      "tail_number": "N127SY",
      "aircraft_type": "737-900",
      "flight_number": "UA123",
      "departure_airport": "ORD",
      "arrival_airport": "LAX",
      "departure_time": 1749225600,
      "arrival_time": 1749240000,
      "departure_time_formatted": "2025-06-07T12:00:00.000Z",
      "arrival_time_formatted": "2025-06-07T16:00:00.000Z",
      "starlink_installed_date": "2025-03-07",
      "operated_by": "United Airlines",
      "fleet_type": "mainline"
    }
  ]
}
```

**No Starlink Response (200 OK):**
```json
{
  "hasStarlink": false,
  "message": "No Starlink-equipped aircraft found for this flight on the specified date",
  "flights": []
}
```

**Error Responses:**
- 400 Bad Request: Missing parameters or invalid date format
- 405 Method Not Allowed: Non-GET request