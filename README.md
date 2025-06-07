# UA Starlink Tracker

Track United Airlines' Starlink WiFi installation progress across their fleet.

## Overview

This web application monitors which United Airlines aircraft have Starlink WiFi installed, providing real-time flight tracking and installation statistics. Data is sourced from public fleet information and updated hourly.

## Features

- **Live Fleet Statistics**: Track Starlink installations across mainline and express fleets
- **Flight Tracking**: See upcoming flights for each Starlink-equipped aircraft
- **Installation Timeline**: Historical data showing when each aircraft received Starlink
- **API Access**: Check if specific flights have Starlink capability

## Development

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Run production server
bun run start

# Manually update aircraft data
bun run scrape
```

## API

### Check Flight Starlink Status

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

The application runs on Bun and uses SQLite for data storage. For production deployment:

```bash
docker build -t ua-starlink-tracker .
docker run -p 3000:3000 -v /path/to/data:/srv/ua-starlink-tracker ua-starlink-tracker
```

## Environment Variables

- `FLIGHTAWARE_API_KEY` - Required for flight tracking data
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Set to "production" for production mode

## License

MIT