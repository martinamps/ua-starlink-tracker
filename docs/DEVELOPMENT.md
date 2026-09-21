# Development

## Setup

```bash
bun install
cp plane-data.sqlite.example plane-data.sqlite
bun run dev    # Development server with hot reload
```

The example database is a small sampled subset (≈50 aircraft) so the app boots and renders. Background jobs will populate it further over time, or point `DB_PATH` at your own snapshot.

## Environment Variables

Every variable the code reads is listed, one line each with its default, in
[`.env.example`](../.env.example) — none is required for local dev. The ones you
will reach for: `DB_PATH` (point at a snapshot), `DISABLE_JOBS=1` (serve only, no
upstream scraping), `DEV_SITE` / `DEV_TENANT` (which tenant localhost serves).

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
bun run dev              # Dev server with hot reload (recompiles CSS on source change)
bun run start            # Production server
bun run build:css        # Compile Tailwind → static/tailwind.css
bun run lint             # Check code with Biome
bun run format           # Auto-format
bun run knip             # Unused files and exports (entries in knip.json)
```

### Tests
```bash
bun run test:setup       # Snapshot plane-data.sqlite → .test-snapshot.sqlite (readonly)
bun run test             # Everything under tests/
```

Shared fixtures live in `tests/helpers.ts`: `openSnapshot()` / `makeSyntheticDb()`,
`req` / `jsonOf` for app dispatch, and `postMcp` / `mcpTool` / `mcpDirect` /
`toolText` for MCP JSON-RPC. Tests read structure from runtime data
(`createApp(db).routes`, `app.routeTags`, registry objects), not by parsing source.

Contract goldens pin the public wire formats byte-for-byte:
`tests/golden/api-contracts.json` (check-flight, check-any-flight, MCP
`check_flight`, .ics feeds; hermetic synthetic DB) and
`tests/golden/mcp-tools-list.json`. Regenerate only for an intentional contract
change: `bun run capture-golden` rewrites and formats both, then review the
diff. JSON bodies are stored parsed and .ics bodies as lines; each must
re-encode to the live bytes.

### Styling

Tailwind utilities are compiled from `src/styles/tailwind.css` by `bun run build:css`
into `static/tailwind.css` — a build artifact, gitignored, produced by the Docker
build (and by `dev`, `start`, `pretest`, `preview-hosts`). The server fingerprints
it and serves it from `/static/tailwind.<hash>.css`; in production it refuses to
boot if the file is missing, since an unstyled render fails no test.

The practical consequence: a class only works if Tailwind's scanner can see it in
`index.html` or under `src/`. Classes assembled at runtime (`` `text-${color}-500` ``)
compile to nothing. `tests/stylesheet.test.ts` fails on any rendered class the
scanner can't find, and separately asserts the served CSS actually contains rules
for the utilities the pages render — a build that compiles to a valid but
empty-of-utilities stylesheet leaves every page unstyled and would otherwise pass
every other check.

In `dev`, the recompile is **not** sequenced ahead of the server reload: `bun --watch`
restarts the server on the same save that schedules the compile, so the server
regularly comes up on the previous build. It absorbs that itself — outside
production it re-reads `static/tailwind.css` whenever the file changes, so the
compile is picked up on the next request instead of the next save.

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

### Air France (FlyerTalk fleet guide)
Air France is hub-only (no tenant site). Per-tail status comes from the curated
FlyerTalk "Complete Guide to the Air France Fleet" wikipost, stored as
`starlink_planes.sheet_gid = 'flyertalk_af'` at the **community** evidence tier:
`verified_wifi` stays NULL, answers say "likely", never "verified", and nothing is
ever written negative. FlyerTalk blocks the prod ASN, so it ships through
residential-sync like AS/QR; `AF:lastUpdated` is owned by `community-sync` and
carries the curator's own date.

```bash
bun run flyertalk-airfrance --dry-run           # fetch + parse, print per-type counts
bun run flyertalk-airfrance                     # apply to DB_PATH (needs the FR24 roster)
bun run flyertalk-airfrance --demote-delisted   # also move un-starred tails back to unknown
bun run residential-sync --dry-run              # AF rides along as flyertalk_af
```

The apply refuses when the AF roster is below `minFleetSanity` or more than 10
ingested tails lost their star. Per-type counts (`fleet_guide_tails` +
`getTypeProgress`) key on the registry's `programTypes`, so the 777-200ER and
777-300ER are separate rows; A318/A319/A330 (`programExclusions`) and freighters
are outside every denominator.

## Architecture

### Background Jobs

`server.ts` opens one database handle (`openDatabase()`, then `migrate()` once)
and passes it to `createApp(db)` and to every job; jobs never open or migrate
their own. One-shot CLI scripts call `initializeDatabase()` (open + migrate).
`DISABLE_JOBS=1` starts none of them. The full job table is in
[CLAUDE.md](../CLAUDE.md#architecture); the core loop:

| Job | Interval | Purpose |
|-----|----------|---------|
| Spreadsheet scrape | 1 hour | Update Starlink plane list from Google Sheets |
| Flight updater | 22.5 sec | Keep flight data fresh (smart caching: 1-8hr based on proximity) |
| Starlink verifier | 60 sec | Verify planes against United.com (48-96hr per plane) |
| Fleet discovery | 90 sec | Find new Starlink planes across entire fleet |
| Fleet sync | 24 hours | Sync full fleet from FlightRadar24 |

### Database Tables

27 tables, all created by `setupTables` in `src/database/database.ts` (CLAUDE.md
lists them by area). The ones most code touches:

| Table | Purpose |
|-------|---------|
| `starlink_planes` | Aircraft with Starlink (from spreadsheet + discovery) |
| `united_fleet` | Full fleet per airline for discovery tracking |
| `upcoming_flights` | Cached flight schedules |
| `starlink_verification_log` | Audit trail of all verification attempts |
| `departure_log` / `flight_assignment_log` | Past departures and tail assignments |
| `flight_routes` | Accumulated flight-number → route pairs |
| `meta` | Key-value store for stats (keys namespaced `AIRLINE:key`) |
| `fleet_guide_tails` | Per-tail marks from a community fleet guide (AF) |

"Equipped" is defined once in `src/database/sql/equipped.ts` (the `equippedSql`
predicate and its JS twin), and fleet denominators come from `programmeRoster()`
in `src/database/roster.ts`. Count queries use those rather than re-deriving.

### Key Files

```
server.ts                           # Boot: one DB handle, Bun.serve, job orchestration
src/server/app.ts                   # createApp(db): route table, pages, APIs
src/server/respond.ts               # json/text/xml response helpers, CACHE headers
src/api/check-flight-core.ts        # Flight verdicts (verdictSummary) shared by REST + MCP
src/api/mcp-server.ts               # MCP tools
src/api/flightradar24-api.ts        # FR24 flight data (primary)
src/api/flightaware-api.ts          # FlightAware fallback
src/api/flight-updater.ts           # Smart flight data caching
src/database/database.ts            # SQLite operations, schema (setupTables)
src/database/sql/                   # equipped predicate, shared fragments, time windows
src/scripts/starlink-verifier.ts    # Background verification
src/scripts/fleet-discovery.ts      # New plane discovery
src/scripts/united-starlink-checker.ts  # Playwright scraper
src/utils/utils.ts                  # Google Sheets scraping
src/components/layout.tsx           # PageShell + UI primitives (Panel, Eyebrow, StatValue, ButtonLink…)
src/components/ui/                  # tone palette, Meter, number/date format
src/components/home/, page.tsx      # Homepage
src/client/entries/                 # Browser bundles, built at boot and served content-hashed
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

Two endpoints power the [Chrome extension](https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi). Installed copies update on Google's schedule, not ours, so both shapes are backwards-compatible-only — add keys, never rename or drop them.

`/api/check-flight` (per-airline hosts) — United lookups:

- Accept `flight_number` and `date` query parameters
- Optionally accept `origin` / `destination` (IATA; K/P ICAO accepted) to scope the answer to one leg — also on `/api/check-any-flight` and MCP `check_flight`. The response then gains `leg: { origin, destination, match, reason?, otherLegs }`; bad input answers unscoped with `match: "unscoped"`, never an error
- Return `hasStarlink` (boolean) and `flights` (array)
- Include CORS headers for Google Flights domains

`/api/check-any-flight` (hub host only) — Hawaiian/Alaska and any future carrier. The extension (`chrome-extension/lib.js`, `normalizeClaim`) reads exactly these top-level keys:

- `hasStarlink` — `true` / `false` / `null`. `false` means a *verified* negative; `null` means "no assignment yet", never "no".
- `confidence` — `"verified"` separates the verified rung from the installed rung on a `true`; predictor grades `"high" | "medium" | "low"`; `"type"` marks a registry-derived answer.
- `probability` — 0–1, top-level (NOT nested under `prediction`). Present on prediction and no_model penetration answers; absence keeps type-split answers off the badge.
- `airline` — display name for badge tooltips.
- `error` — settled answer body (untracked carrier / bad input), not an outage.
- `flights` — array; present on every branch.

Both endpoints ignore unknown query parameters. v2.0.1+ appends `client=ext-<version>` so request metrics can separate extension traffic (`client_class:extension`, `ext_version:1.x|2.0|2.1|2.x|other|none`) from website visitors; the service worker's fetch otherwise carries a stock Chrome user agent. Requests whose `Origin` is the extension's own `chrome-extension://jjfljoifenkfdbldliakmmjhdkbhehoi` also count as `extension` (with `ext_version:none` when no param is sent); other extension origins land in `other-extension`. v2.1.0+ also sends `origin`/`destination` for each itinerary-decoded leg, so a through flight gets one lookup per leg.

### Releasing the extension

Published CWS version: 1.2.0 (2025-06-08). Update this line after each upload.

1. Bump `version` in `chrome-extension/manifest.json`. Never add a `permissions` or `host_permissions` entry: an update that asks for new permissions is disabled for every existing user until they re-approve it.
2. `bun run ext:package` builds `dist/ext-<version>.zip` from the files the manifest references (no docs).
3. Load `chrome-extension/` unpacked and run [QA-CHECKLIST.md](../chrome-extension/QA-CHECKLIST.md).
4. Owner: upload the zip in the Chrome Web Store developer dashboard and the Edge Add-ons dashboard.
5. Once review passes, `bun run ext:store-version` (warn-only; scrapes the public listing) should report the new version. Then update the "Published CWS version" line above.
