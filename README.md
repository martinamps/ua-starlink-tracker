# UA Starlink Tracker

Tracks United Airlines' Starlink WiFi installation progress across their fleet.

**[unitedstarlinktracker.com](https://unitedstarlinktracker.com)**

## Features

- Maintains statistics on Starlink installations across mainline and regional fleets
- Upcoming flights for each Starlink-equipped aircraft
- Installation timeline showing when each aircraft was upgraded

## Data Sources

- Starlink installation status from public Google Sheets tracking United's WiFi rollout
- Flight schedules from [FlightRadar24](https://www.flightradar24.com/) — switched from [FlightAware AeroAPI](https://www.flightaware.com/aeroapi/) after it hit $1xxs/mo (accepted some accuracy trade-off)
- Verification cross-checked against United.com flight status pages

## Chrome Extension

See Starlink availability directly in Google Flights search results.

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi)

## API

Check if a flight has Starlink:

```
GET https://unitedstarlinktracker.com/api/check-flight?flight_number=UA123&date=2025-06-07
```

Returns `{ "hasStarlink": true, "flights": [...] }`

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup, architecture, and deployment.

## License

MIT
