# Data Integrity Audit — 2026-03-21

Snapshot: `plane-data.sqlite` at `meta.lastUpdated=2026-03-21T21:54:12Z`. 354 starlink_planes, 1578 united_fleet, 2836 upcoming_flights, 29244 verification_log rows. All background jobs confirmed running.

**48 confirmed findings, 4 killed as false-positives. 38 agents, 6 audit dimensions.**

---

## 1. Critical — accuracy-affecting, ship this week

### 1.1 Partial sheet fetch silently drops planes + their preserved state
**`src/utils/utils.ts:189-191`** swallows per-gid fetch errors and continues. If one of 23 gids fails (Google rate limit, network blip), `fetchAllSheets()` returns a partial list. **`src/database/database.ts:331`** then runs `DELETE FROM starlink_planes WHERE sheet_gid != 'discovery'` and re-inserts only the partial set. Every plane from the failed gid vanishes — and its `verified_wifi`, `last_flight_check`, `DateFound` are lost. Prod DB shows only 6 of 23 gids populated.

**Fix:** Track failed gids in `fetchAllSheets()`. Either throw if any failed (skip `updateDatabase` entirely) or scope the DELETE to `sheet_gid IN (<successfully-fetched-gids>)`.

### 1.2 `updateDatabase` DELETE+INSERT not transactional
**`src/database/database.ts:331-412`** — DELETE and INSERT loop run as separate autocommit statements. During the ~100ms-5s window, flight-updater/verifier/discovery/`/api/data` all see an empty or partial table. A crash mid-loop leaves half-populated.

**Fix:** Wrap in `db.transaction(() => { ... })()`. Also fixes 1.3.

### 1.3 Race: hourly scrape reverts concurrent `verified_wifi` writes
Snapshot-then-DELETE-then-reINSERT window lets verifier writes get lost. **Prod evidence:** 20 planes with `verified_at` timestamps but `verified_wifi=NULL`.

**Fix:** Same transaction as 1.2. Long-term: change DELETE+INSERT to UPSERT.

### 1.4 Empty FR24 response wipes cached flights, marks success
**`flight-updater.ts:71`** calls `updateFlights()` unconditionally on empty result → DELETEs good cache → marks `success=true` → no backoff. Transient FR24 emptiness cascades to `/api/check-flight` returning empty.

**Fix:** If `flights.length === 0`, skip `updateFlights()`, bump `last_flight_check` with `success=false`.

### 1.5 Promise cache poisoning — FR24 errors cached as "no Starlink" for 1 hour
**`server.ts:354-355`** caches promise before resolve. FR24 returns `[]` on 402/429/network error → cached 1hr → Chrome extension users see "No Starlink" on flights that have it.

**Fix:** On empty-due-to-error, evict cache or set 60s negative TTL.

### 1.6 `syncSpreadsheetToFleet` fabricates `verified_wifi='Starlink'` on INSERT
**`database.ts:1393`** writes `plane.verified_wifi || 'Starlink'`. Brand-new sheet plane appears fully verified with zero observations. **Prod evidence:** N792YX confirmed with zero log entries.

**Fix:** Remove `|| 'Starlink'` default. Add CASE guard so INSERT bootstraps to `'unknown'`.

### 1.7 Discovery false-positives immortal in `starlink_planes`
DELETE only removes `sheet_gid != 'discovery'`. **8 tails stuck** (N797SK, N788SK, N17423, N14228, N77539, N625UX, N758YX, N14731). 3 with NULL wifi are **visible on website**.

**Fix:** Add purge: `DELETE FROM starlink_planes WHERE sheet_gid='discovery' AND verified_wifi IS NOT NULL AND verified_wifi != 'Starlink'`.

### 1.8 Discovered planes never upgrade to spreadsheet metadata
`if (discoveredTails.has(tailNumber)) continue;` drops sheet data forever.

**Fix:** Instead of `continue`, UPDATE discovery row's sheet-sourced columns.

---

## 2. Vendor citizenship — rate-limit risks

### 2.1 Four FR24 client instances defeat the 2s global rate-limit
`lastRequestTime` is instance state but 4 instances exist. When all align: 4 FR24 requests in <2s.

**Fix:** Singleton client or module-scope `lastRequestTime`.

### 2.2 `getFlightRoutes` + `getFlightAssignments` bypass rate-limit entirely
User-triggered paths call `fetch()` without `waitForRateLimit()`. Cold-cache surge goes unthrottled.

**Fix:** Route both through `waitForRateLimit()` + `retryWithBackoff`.

### 2.3 Two Playwright jobs can hit United.com concurrently
No shared semaphore between verifier (60s) and discovery (90s). Two simultaneous headless Chromes from one IP is a detection signal.

**Fix:** Module-level mutex, or stagger to coprime intervals (60s, 97s).

### 2.4 Missing `VENDOR_REQUEST` metric on `getFlightRoutes`
Only FR24 path with zero metrics. MCP route-lookup traffic invisible in Datadog.

**Fix:** Add `metrics.increment(COUNTERS.VENDOR_REQUEST, {vendor:'fr24', type:'routes', status})`.

### 2.5 CLI batch commands unbounded
`--batch=100` = 100 United.com scrapes in 8 min. Operator-error risk.

**Fix:** Clamp to 20 with `--force` override.

**Rate summary:** FR24 background ~25-60/hr (3-11% of implied limit). United.com steady ~5/hr, cold-start 100/hr. Both within bounds; risk is in unthrottled user-triggered paths.

---

## 3. Data hygiene — fix on next touch

- 22 orphan upcoming_flights rows (4 deleted tails, oldest 62d stale)
- 27 NULL verified_wifi in starlink_planes (up from 7 — 23 awaiting consensus, 4 architecturally unverifiable)
- 22 tails: NULL in starlink_planes but set in united_fleet (discovery backfill gap)
- 1223/1578 (77.5%) united_fleet NULL operated_by (FR24 source doesn't provide)
- 21 confirmed-Starlink tails with zero upcoming_flights (3 are bugs: N513GJ/N776YX/N632SY have FR24 flights but DB empty)
- 14 tails >96h past verification (all downstream of no-flights issue)
- 766 past-departure upcoming_flights rows (27% of table, needs periodic GC)
- meta `*Unverified=0` hardcoded (actual: 27)
- Tail last-resort extraction yields garbage (`'ERJ-175'` as TailNumber)
- CLI `verifySpecificTail` hardcodes `fleet='express'`, skips consensus
- 51 united_fleet tails never verified (all 'No upcoming flights' — expected)
- flight_routes cache 5 days stale, 26 rows (possibly dead table)

---

## 4. Opportunities — ranked by accuracy-value / effort

| Opportunity | Value | Effort | Gate |
|---|---|---|---|
| **User error-report endpoint** + Chrome extension "Report incorrect?" | High | ~3-4h | None |
| **Cross-validate FR24 aircraft.model vs stored type** — zero new calls | Medium | ~1h | None |
| **FR24 fetchBy=route** for itinerary planner | Medium | ~1-2h | None |
| **OpenSky as FR24 fallback** — 4000 req/day free | Medium | ~4-5h | Mode-S hex codes |
| Planespotters photos | Low | ~2h | Deprioritize |

---

## 5. Already-handled / working as designed

- Ship-number → tail mapping (user decided 2026-03-21 to consensus-gate instead)
- Discovery trusts non-Starlink when tail not extracted (intentional per project_verifier_trust_asymmetry)
- Schema integrity: zero duplicates, valid enums, zero cross-table mismatches
- Zero discovery-only confirmed tails — sync holding
- Background job cadence healthy
- 210-aircraft gap sheet vs united_fleet (expected for grounded/stored)
- Killed false-positives: Sheet-disagreement KPI, meta undercount, FAA registry, ICAO→IATA

---

## Recommended sequencing

**PR 1 (~4h):** §1.1+1.2+1.3 transaction wrapper + failed-gid guard. §1.4 skip-empty. §1.6 remove default. §1.7 discovery purge. All in `database.ts`+`utils.ts`.

**PR 2 (~2h):** §2.1 singleton + §2.2 rate-limit + §2.4 metric in `flightradar24-api.ts`. §1.5 cache-eviction in `server.ts`/`mcp-server.ts`.

**Patches after code ships:** orphan DELETE, `bun run wifi-patch`, N792YX status reset.
