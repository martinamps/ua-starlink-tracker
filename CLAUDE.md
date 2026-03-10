# UA Starlink Tracker

**Open source project** - keep documentation clean and concise. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for detailed setup.

Tracks United Airlines' Starlink WiFi installation progress across their fleet. Live at [unitedstarlinktracker.com](https://unitedstarlinktracker.com).

## Commands

```bash
bun run dev                    # Dev server with hot reload
bun run db-status              # Database overview (--full for details)
bun run scrape                 # Fetch fleet data from Google Sheets
bun run test                   # Run integration tests (requires test:setup first)
bun run test:setup             # Copy prod DB snapshot to /tmp/ua-test.sqlite
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
bun run reset-flights          # Reset flight cache, force re-fetch all
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
| Flight updater | 22.5 sec | Keep flight data fresh (1-8hr smart caching) |
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

## MCP Server

Stateless Streamable HTTP MCP at `/mcp`. Exposes 7 tools for AI agents to answer
"does my United flight have Starlink?" questions. Live at
`https://unitedstarlinktracker.com/mcp`.

### Tools

| Tool | Purpose |
|------|---------|
| `check_flight` | Firm YES/NO for a flight on a date (≤2 days out), else probability + **embedded alternatives** |
| `predict_flight_starlink` | Probability from historical assignments (date-agnostic) + embedded alternatives when low |
| `plan_starlink_itinerary` | Multi-stop graph search, ranked by coverage ratio (Starlink hrs / total hrs) |
| `predict_route_starlink` | Single-route flight-number lookup. Empty = embeds connections (never a dead-end) |
| `search_starlink_flights` | Next ~2 days confirmed assignments only |
| `get_fleet_stats`, `list_starlink_aircraft` | Aggregate/listing |

### Local testing workflow

**Always test against the prod DB snapshot locally before pushing.** MCP clients
cache tool schemas + instructions at connect time, so iterating against prod is slow.

1. **Refresh prod snapshot** (when data drift matters):
   ```bash
   ssh llc "cd /srv/ua-starlink-tracker && sqlite3 plane-data.sqlite 'PRAGMA wal_checkpoint(TRUNCATE);'"
   scp llc:/srv/ua-starlink-tracker/plane-data.sqlite ./plane-data.production.sqlite
   bun run test:setup  # copies to /tmp/ua-test.sqlite, sets journal_mode=DELETE
   ```

2. **Call a tool directly** (show me this output before pushing):
   ```bash
   bun -e '
   import { Database } from "bun:sqlite";
   import { handleMcpRequest } from "./src/api/mcp-server.ts";
   const db = new Database("/tmp/ua-test.sqlite", { readonly: true });
   const req = new Request("http://localhost/mcp", {
     method: "POST", headers: { "Content-Type": "application/json" },
     body: JSON.stringify({
       jsonrpc: "2.0", id: 1, method: "tools/call",
       params: { name: "check_flight", arguments: { flight_number: "UA737", date: "2026-03-13" } }
     })
   });
   console.log((await (await handleMcpRequest(req, db)).json()).result.content[0].text);
   '
   ```

3. **Dump all tool descriptions + instructions** (to see what the agent sees):
   ```bash
   bun -e '
   import { Database } from "bun:sqlite";
   import { handleMcpRequest } from "./src/api/mcp-server.ts";
   const db = new Database("/tmp/ua-test.sqlite", { readonly: true });
   const call = async (m, p) => (await (await handleMcpRequest(
     new Request("http://localhost/mcp", {method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})}), db)).json()).result;
   const init = await call("initialize", {protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"t",version:"1"}});
   console.log("INSTRUCTIONS:\n" + init.instructions);
   for (const t of (await call("tools/list")).tools) console.log(`\n${t.name}:\n${t.description}`);
   '
   ```

4. **Run integration tests** (33 tests locking API contracts + tool behaviors):
   ```bash
   bun run test
   ```

5. **Unbiased agent behavioral test**: spawn a subagent with the MCP tools,
   give it a real user question, see if it answers correctly. This catches
   failures that unit tests miss (wrong tool selection, ignoring directives, etc.)

### Design principles (learned the hard way)

- **Embed, don't direct.** Telling agents "call tool X next" is unreliable.
  If a low-probability flight needs alternatives, embed them in the output.
  `check_flight` and `predict_flight_starlink` call `planItinerary()` internally.

- **Every tool path must converge.** If `check_flight` embeds connection-based
  alternatives but `predict_route_starlink` returns "UNOBSERVED" for the same
  route, agents trust the contradiction. Make all tools give consistent answers.

- **Look things up server-side.** Don't ask users for info we can fetch (FR24
  `fetchBy=flight` gives routes from flight number). `lookupFlightRoutes()` is
  cached 1hr.

- **Coverage ratio, not raw hours.** Ranking by expected Starlink hours
  pathologically prefers 10h 3-stops over 1h 92% directs. Rank by
  `expected_starlink_hours / total_flight_hours` instead.

- **Confirmed > predicted.** When a flight is in `upcoming_flights` on a
  verified-Starlink tail, that's a near-term firm answer (0.95) — ignore the
  flight number's historical probability.

### Data patching workflow (local → verify → prod)

When data integrity issues are found (e.g. planes with `verified_wifi IS NULL`),
use the consensus-based patch workflow instead of live scraping:

```bash
# 1. Refresh prod snapshot (test:setup copies to /tmp/ua-test.sqlite)
bun run test:setup

# 2. Generate patch from log consensus (preview mode)
bun run wifi-patch
# → writes patches/verified-wifi-YYYY-MM-DD.sql
# → shows decision table: Tail | Fleet | Recent | Verdict | Reason

# 3. Apply locally + verify
bun run wifi-patch -- --apply-local
bun run test  # all 33 integration tests should still pass

# 4. Review the .sql file, then apply to prod
cat patches/verified-wifi-YYYY-MM-DD.sql  # review UPDATE statements
scp patches/verified-wifi-YYYY-MM-DD.sql llc:/tmp/
ssh llc "sqlite3 /srv/ua-starlink-tracker/plane-data.sqlite < /tmp/verified-wifi-YYYY-MM-DD.sql"
```

**Consensus rules** (`src/scripts/verified-wifi-patch.ts`):
- 30-day recent window, ≥2 clean observations, ≥70% agreement
- Starlink if ≥70% recent obs are Starlink
- Viasat/None/etc if ≥70% recent obs NOT Starlink (uses most-common provider)
- Otherwise left NULL (ambiguous — likely mid-retrofit; background verifier will catch)
- `AND verified_wifi IS NULL` in UPDATE makes it idempotent-safe

The `patches/` dir is gitignored — patches are ephemeral, regenerated from fresh data.

### Integration test structure

`tests/integration.test.ts` runs against `/tmp/ua-test.sqlite` (readonly prod
snapshot). Tests assert on **response shapes**, not specific values, so they
don't break as data changes. Locks down:
- `/api/check-flight` Chrome extension contract (`{ hasStarlink, flights[] }`)
- `/api/data` website contract
- MCP JSON-RPC protocol + all 7 tool behaviors
- Predictor sanity bounds + flight-number normalization


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

## Code Style

- **No obvious comments** - don't add comments that just restate what the code does
- **Self-documenting code** - use clear variable/function names instead of comments
- **Comments for why, not what** - only comment non-obvious decisions or edge cases
