# UA Starlink Tracker

An open-source tracker of which airline flights and aircraft have Starlink Wi-Fi. It began with United's rollout and now answers for four airlines at flight level, with a hub that compares airlines' Starlink plans.

| Site | What it covers |
|---|---|
| [unitedstarlinktracker.com](https://unitedstarlinktracker.com) | United and United Express, tail by tail |
| [alaskastarlinktracker.com](https://alaskastarlinktracker.com) | Alaska and Horizon |
| [airlinestarlinktracker.com](https://airlinestarlinktracker.com) | The hub: [every airline's rollout](https://airlinestarlinktracker.com/airlines), side-by-side comparisons, and flight lookups for United, Alaska, Hawaiian and Qatar Airways |

All three are served by one process from one database; the site is picked by the request's host (`src/airlines/registry.ts`).

## What it does

Live counts are on the sites, not here, because they change daily.

- **[Flight check](https://unitedstarlinktracker.com/check-flight)** — a flight number and date gives a firm answer once the aircraft is assigned (about two days out), and odds before that.
- **[Route planner](https://unitedstarlinktracker.com/route-planner)** — which flights on a route have Starlink, including connections that trade a little time for more connected hours.
- **[Fleet](https://unitedstarlinktracker.com/fleet)** — every aircraft by tail number, with a page per aircraft type.
- **[Newly equipped](https://unitedstarlinktracker.com/newly-equipped)** — a log of aircraft as they are found, with an [Atom feed](https://unitedstarlinktracker.com/feed.xml).
- **[Install pace](https://unitedstarlinktracker.com/install-rate)** and **[timeline](https://unitedstarlinktracker.com/timeline)** — how fast the rollout is going against what the airline said.
- **Calendar feeds** — subscribe to one flight (`/cal/{flight}/{date}.ics`) and the event updates when its aircraft is assigned.
- **[Embeddable badge](https://unitedstarlinktracker.com/embed)** — an SVG with the live count, for other sites.
- **[Open data](https://unitedstarlinktracker.com/methodology)** — the tail list as [CSV](https://unitedstarlinktracker.com/data/starlink-tails.csv) and JSON.

Not every site has every page: each one serves only the pages its data supports.

## Use it from your own code

Everything below is open: no key, no account, CORS enabled, rate-limited per IP. Responses are served from the database; a request never triggers a scrape.

### MCP server

A stateless Streamable HTTP server with seven tools: `check_flight`, `predict_flight_starlink`, `plan_starlink_itinerary`, `predict_route_starlink`, `search_starlink_flights`, `get_fleet_stats` and `list_starlink_aircraft`.

| Address | Scope |
|---|---|
| `https://unitedstarlinktracker.com/mcp` | United |
| `https://alaskastarlinktracker.com/mcp` | Alaska |
| `https://airlinestarlinktracker.com/mcp` | United, Alaska, Hawaiian and Qatar Airways |

```bash
claude mcp add --transport http starlink https://unitedstarlinktracker.com/mcp
```

Open any of those addresses in a browser for setup steps for Claude, ChatGPT, Cursor and VS Code. Append `?scope=UA`, `HA`, `AS`, `QR` or `ALL` to pin or widen the scope. Only United has a per-flight history model, so itinerary planning with connections is United's; the other airlines answer per flight and per aircraft type. Registry entries are in [`registry/`](registry).

### JSON API

```
GET https://unitedstarlinktracker.com/api/check-flight?flight_number=UA4680&date=YYYY-MM-DD
```

returns `{ "hasStarlink": true, "flights": [...] }`. The main endpoints:

| Endpoint | Answers |
|---|---|
| `/api/check-flight` | One flight on one date, on that site's airline |
| `/api/check-any-flight` (hub) | The same for any tracked airline, detected from the flight number |
| `/api/predict-flight` | Odds for a flight number before an aircraft is assigned |
| `/api/plan-route` | Itineraries between two airports, ranked by Starlink coverage |
| `/api/compare-route` (hub) | Odds per airline on one route |
| `/api/routes` | Routes flown by Starlink aircraft in the current schedule window |
| `/api/data`, `/api/fleet-summary` | The equipped fleet and its totals |

`/api/check-flight` and `/api/check-any-flight` accept optional `origin` and `destination` to answer one leg of a multi-leg flight number. Each site's [`/llms.txt`](https://unitedstarlinktracker.com/llms.txt) carries current examples. The shapes of `check-flight`, `check-any-flight` and the MCP tools are pinned byte-for-byte by tests (`tests/golden/`) and only ever gain fields.

### Chrome extension

[`chrome-extension/`](chrome-extension) adds Starlink badges to Google Flights results. The code in this repository answers for United, Alaska (including Hawaiian-operated flights) and Qatar Airways, and separates a verified aircraft, an equipped one and a prediction; its [README](chrome-extension/README.md) explains each badge. The published build can be older than this code: the [extension page](https://unitedstarlinktracker.com/chrome) says what the store version covers and links to it.

## Where the data comes from

The full account, per airline, is the [methodology page](https://unitedstarlinktracker.com/methodology) ([Alaska's](https://alaskastarlinktracker.com/methodology)). In short:

- **United** — the tracker checks one aircraft a minute against the Wi-Fi United.com lists for its upcoming flight. Only that check marks an aircraft verified. A community-kept fleet spreadsheet is read hourly, and its Starlink entries count as reports until the tracker's own check confirms or contradicts them.
- **Alaska and Horizon** — alaskaair.com shows which aircraft flies a flight; Alaska's own newsroom tracker gives counts per aircraft type.
- **Hawaiian and Qatar Airways** — Starlink follows the aircraft type, so the answer comes from the type scheduled on the flight. Qatar publishes that about a week ahead.
- **Schedules and fleet lists** — [Flightradar24](https://www.flightradar24.com/), for every airline.

"Equipped" has one definition in the code, `src/database/sql/equipped.ts`, which the pages, the API and the MCP server share.

## Run it

```bash
bun install
cp plane-data.sqlite.example plane-data.sqlite
bun run dev
```

The example database is a small sample, enough to boot and render. Set `DISABLE_JOBS=1` to serve without contacting any upstream. Tests run against a snapshot:

```bash
bun run test:setup && bun run test
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers scripts, architecture and deployment, and [CLAUDE.md](CLAUDE.md) lists the conventions a change is expected to follow. Issues and pull requests are welcome.

## Who runs it

Built and run by [@martinamps](https://x.com/martinamps), as one process on one server. Corrections are welcome as issues: a tail that is wrong on the site is a bug.

## License

MIT
