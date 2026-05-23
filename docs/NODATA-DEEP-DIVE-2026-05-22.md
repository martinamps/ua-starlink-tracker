# Why 60% of /api/check-flight lookups return no_data

Investigation date: 2026-05-22. Data: Datadog metrics (7-day window), prod SQLite,
code paths in `src/server/app.ts` / `src/api/flight-verdict.ts` / `src/api/mcp-server.ts`,
and a simulation of the lookup chain over all 5,489 known UA flight numbers.

## The number

Over the last 7 days, the United `/api/check-flight` endpoint (the Chrome extension's
backend) served 6,144 lookups:

| outcome | count | % | what the user sees |
|---|---|---|---|
| no_data | 3,749 | **61%** | nothing (extension only badges `hasStarlink: true`) |
| verified_no | 2,028 | 33% | nothing |
| verified_yes | 313 | 5% | a Starlink badge |
| predicted | 54 | 1% | a badge |

96% of requests are `client_class:browser` — real extension users, not bots.
The practical effect: a user shopping for flights on Google Flights sees a badge on
~1 in 20 flight cards. For trips more than 3 days out, they see no badges at all.

## The lookup chain and where it dies

`/api/check-flight` has two data paths:

1. **`upcoming_flights ⨝ starlink_planes`** — only contains flights operated by the
   385 Starlink-equipped tails (24% of the 1,603-aircraft fleet), and only extends
   ~2 days into the future (day+0: 896 legs, day+1: 1,515, day+2: 826, day+3: 1, day+4+: 0).
   Simulated hit rate over all 5,489 known UA flight numbers: 17% at day+0, 30% at
   day+1, 25% at day+2, **0% at day+7**.
2. **Live FR24 tail lookup** (`lookupFlightTailVerdict`) — only runs when the queried
   date is within **[-1 day, +3 days]** of now (`flight-verdict.ts:129`). 2,424
   invocations in 7 days produced ~2,150 answers (mostly verified_no) and 400 errors.
3. **There is no third path.** Both misses → `no_data` → `{ hasStarlink: false,
   message: "No Starlink-equipped aircraft found..." }`.

## Root cause

**Aircraft tail assignments do not exist more than ~2–3 days before departure.**
United assigns tails day-of or day-before; FR24 reflects that. Google Flights users
shop days to weeks ahead. For the majority of real queries, *no tail-assignment-based
lookup can ever produce an answer* — the data doesn't exist yet anywhere on Earth.

Bounding it from the metrics: 3,749 no_data vs at most ~500 in-window lookups that
reached FR24 and got nothing (400 errors + a handful of empty results — empty results
aren't cached, so each one is a distinct FR24 call). **≥85% of the no_data responses
(≈52% of all queries) are for dates outside the ±3-day window** and never even reach
the FR24 fallback.

## The fix already exists in the codebase

The MCP `check_flight` tool (`mcp-server.ts:621-644`) has a third stage: when no tail
assignment exists, it calls `predictFlight()` — the historical tail-assignment
probability for that flight number — and answers "~85% Starlink probability
(n historical obs). Aircraft assignment not yet published — that happens ~2 days out."

**The MCP tool's no_data rate is 4%. The HTTP endpoint's is 61%. Same database, same
question — the HTTP endpoint just never got the third stage.**

Predictor coverage, simulated over all 5,489 known UA flight numbers:
- 60% get a history-based prediction (`flight_history_smoothed`, n_observations > 0)
- 56% land at high or medium confidence
- The probability distribution is strongly bimodal: 43% of flight numbers predict
  <10% (confident no) and 25% predict >80% (confident yes). Only 8% fall in the
  uninformative 30–70% band. These are decisive answers, not coin flips.
- The remaining 40% get the fleet-prior cold start (no history for that number) —
  mostly codeshares, seasonal routes, and numbers we haven't observed.

## Secondary findings

1. **The date window is UTC but users pass local dates.** The endpoint windows on
   `[date T00:00Z, +24h)`. 406 of 3,238 upcoming UA flights (12.5%) depart between
   00:00–08:00 UTC — i.e., US-evening local departures whose UTC calendar date is one
   day after the date Google Flights displays. For those flights the user's date and
   our window disagree by a day → guaranteed miss even when the data exists. Same bug
   class as the united.com lookup-window fix in PR #44.
2. **`verified_no` conflates "verified non-Starlink" with "tail we know nothing
   about"** (`app.ts:531`): any non-empty FR24 segment list with no Starlink segments
   returns `hasStarlink: false` tagged verified_no — including segments whose tail
   resolves to `hasStarlink: null / confidence: unknown`. The MCP version filters on
   `hasStarlink === false` explicitly and falls through to the predictor otherwise.
   Only ~4% of the fleet is status=unknown, so the impact is small, but it is another
   case of "unknown presented as no".
3. The no_data response body (`hasStarlink: false`, "No Starlink-equipped aircraft
   found for this flight on the specified date") is semantically a "no" when the
   truth is "we don't know yet". The extension happens not to render negatives, so
   no user currently sees a wrong "no" — but any other API consumer would.

## Recommendations

1. **Port the MCP predictor fallback to `/api/check-flight`.** When both lookup paths
   miss, return the prediction as additive fields (`prediction: { probability,
   confidence, n_observations }`, `confidence: "predicted"`) without changing the
   `hasStarlink: boolean` contract. Update the extension to render a "likely
   Starlink" badge for high-probability predictions. Converts ~85% of today's
   no_data into an answer. Pure DB lookup (the model is cached) — no new vendor load.
2. **Threshold the displayed prediction.** The audience fact-checks percentages.
   Until the predictor's calibration (not just the firm-call precision) is
   backtested, only badge ≥80%-probability/high-confidence predictions as "likely"
   and render nothing below that — which still covers the 25% of flight numbers in
   the >80% bucket.
3. **Make the date window local-date-aware** (widen by ±8h or resolve the departure
   airport's UTC offset). Recovers the 12.5% of flights that straddle the UTC
   boundary.
4. **Tag `flight.lookup_result` with a `days_out` bucket** so the query-date
   distribution — the one number this investigation could not measure historically —
   becomes observable, and the improvement from #1 is measurable.
5. Fix the verified_no/unknown conflation (#2 above) while in the handler.
