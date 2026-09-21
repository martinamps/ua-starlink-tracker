/**
 * ADS-B shadow sweep: every few minutes, ask the community ADS-B aggregators
 * which Starlink-equipped tails are airborne and what callsign they're flying,
 * then compare against the FR24-derived upcoming_flights assignments. The
 * comparison is shadow only — delta metrics in Datadog and rows in
 * adsb_observations. The one thing that does reach serving is the
 * adsb_flight_draws rollup: callsign-derived flight-to-tail departures the
 * predictor counts as unbiased tail draws (PREDICTOR_ADSB_DRAWS).
 */

import type { Database } from "bun:sqlite";
import { looksLikeValidTailNumber, operatorStoragePrefixes } from "../airlines/registry";
import {
  type AdsbFlightSighting,
  countAdsbFlightDraws,
  pruneAdsbFlightDraws,
  upsertAdsbFlightDraws,
} from "../database/adsb-flight-draws";
import { getFleetTailsWithStatus, getMeta, recordAdsbSweep, setMeta } from "../database/database";
import {
  COUNTERS,
  DISTRIBUTIONS,
  GAUGES,
  metrics,
  normalizeAirlineTag,
  withSpan,
} from "../observability";
import type { AdsbObservationRecord } from "../types";
import { BROWSER_USER_AGENT } from "../utils/constants";
import { type JobHandle, createOutageBreaker, startJob } from "../utils/job-runner";
import { debug, info, error as logError, warn } from "../utils/logger";

interface AdsbProvider {
  name: string;
  buildUrl: (regs: string[]) => string;
  /** Measured: airplanes.live takes the whole fleet in one URL; the others 414 past ~100 regs. */
  maxRegsPerRequest: number;
}

// Order is failover order, and it is measured, not alphabetical: over 24h in
// production airplanes.live and adsb.lol failed on essentially every sweep
// (~1,470 failures/day between them) while adsb.fi served it. Trying the two
// dead ones first meant every sweep paid both timeouts before doing any work.
// The others stay as fallbacks — they are free when adsb.fi answers.
const PROVIDERS: AdsbProvider[] = [
  {
    name: "adsb.fi",
    buildUrl: (regs) => `https://opendata.adsb.fi/api/v2/registration/${regs.join(",")}`,
    maxRegsPerRequest: 100,
  },
  {
    name: "airplanes.live",
    buildUrl: (regs) => `https://api.airplanes.live/v2/reg/${regs.join(",")}`,
    maxRegsPerRequest: 500,
  },
  {
    name: "adsb.lol",
    buildUrl: (regs) => `https://api.adsb.lol/v2/reg/${regs.join(",")}`,
    maxRegsPerRequest: 100,
  },
];

const PROVIDER_RATE_GAP_MS = 1100;
/** Per-request ceiling. Failover is serial across three providers and each may
 * page through the fleet, so an unbounded request is what let one slow upstream
 * push a whole sweep past its 5-minute interval. */
const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;

export interface AdsbAircraft {
  tail: string;
  hex: string | null;
  callsign: string | null;
  airborne: boolean;
  gs: number | null;
  lat: number | null;
  lon: number | null;
  aircraftType: string | null;
}

export interface AdsbSweepStats {
  provider: string;
  requests: number;
  latencyMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function queryProvider(
  provider: AdsbProvider,
  tails: string[],
  fetcher: typeof fetch
): Promise<{ aircraft: AdsbAircraft[]; requests: number }> {
  const aircraft: AdsbAircraft[] = [];
  let requests = 0;
  for (let i = 0; i < tails.length; i += provider.maxRegsPerRequest) {
    if (i > 0) await sleep(PROVIDER_RATE_GAP_MS);
    const chunk = tails.slice(i, i + provider.maxRegsPerRequest);
    const res = await fetcher(provider.buildUrl(chunk), {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
      // Without this a hung upstream parked the whole sweep. Failover is serial,
      // so one unresponsive provider could push a sweep past its own interval
      // and then past the 15-minute job watchdog.
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    });
    requests++;
    if (!res.ok) throw new Error(`${provider.name} HTTP ${res.status}`);
    const json = (await res.json()) as { ac?: any[] };
    for (const ac of json.ac ?? []) {
      const tail = typeof ac.r === "string" ? ac.r.trim().toUpperCase() : "";
      if (!tail) continue;
      aircraft.push({
        tail,
        hex: ac.hex ?? null,
        callsign: typeof ac.flight === "string" && ac.flight.trim() ? ac.flight.trim() : null,
        // alt_geom fallback: MLAT/degraded targets can be airborne without alt_baro.
        airborne: ac.alt_baro === "ground" ? false : ac.alt_baro != null || ac.alt_geom != null,
        gs: typeof ac.gs === "number" ? ac.gs : null,
        lat: typeof ac.lat === "number" ? ac.lat : null,
        lon: typeof ac.lon === "number" ? ac.lon : null,
        aircraftType: typeof ac.t === "string" ? ac.t : null,
      });
    }
  }
  return { aircraft, requests };
}

/** One full sweep with provider failover. */
export async function sweepAdsbProviders(
  tails: string[],
  fetcher: typeof fetch = fetch,
  airlineTag = "unmapped"
): Promise<{ aircraft: AdsbAircraft[]; stats: AdsbSweepStats }> {
  let lastErr: unknown = null;
  // Timed around the whole failover, not around the winning provider. The old
  // placement reported only the successful attempt, so a sweep that burned two
  // provider timeouts before succeeding reported the last leg's few seconds —
  // p95 read 22.9s while the real sweep span was 319.8s, past its own interval.
  const started = Date.now();
  for (const provider of PROVIDERS) {
    try {
      const { aircraft, requests } = await queryProvider(provider, tails, fetcher);
      return {
        aircraft,
        stats: { provider: provider.name, requests, latencyMs: Date.now() - started },
      };
    } catch (err) {
      lastErr = err;
      // Per-provider failures previously emitted only a warn, so the metric a
      // monitor watches (vendor.request{vendor:adsb,status:error}) fired only on
      // a total blackout — ~1,470 real failures/day read as zero.
      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        vendor: "adsb",
        type: "provider",
        status: "error",
        provider: provider.name,
        airline: airlineTag,
      });
      warn(`adsb-sweep: ${provider.name} failed, trying next provider`, err);
    }
  }
  throw new Error(`all ADS-B providers failed: ${lastErr}`);
}

// Callsign ICAO prefix → how upcoming_flights codes that operator's rows. The
// pairing matters: SKW#### must never match a marketing UA#### that shares the number.
const OPERATOR_DB_PREFIXES = operatorStoragePrefixes("UA");
const UA_CALLSIGN_RE = new RegExp(`^(${Object.keys(OPERATOR_DB_PREFIXES).join("|")})(\\d+)$`);

export function deriveCallsignFlight(
  callsign: string | null
): { prefix: string; num: number } | null {
  const m = callsign?.match(UA_CALLSIGN_RE);
  return m ? { prefix: m[1], num: Number(m[2]) } : null;
}

export function callsignMatchesAssignment(
  callsign: string | null,
  assignedFlight: string
): boolean {
  const derived = deriveCallsignFlight(callsign);
  if (!derived) return false;
  const assigned = assignedFlight.toUpperCase();
  // Prefix-by-prefix instead of a letters/digits regex split: IATA codes with a
  // digit (G7, C5) would otherwise be unsplittable from the flight number.
  return (OPERATOR_DB_PREFIXES[derived.prefix] ?? []).some((prefix) => {
    if (!assigned.startsWith(prefix)) return false;
    const rest = assigned.slice(prefix.length);
    return /^\d+$/.test(rest) && Number(rest) === derived.num;
  });
}

export type ShadowResult =
  | "match"
  | "mismatch"
  | "no_assignment"
  | "no_callsign"
  | "non_revenue"
  | "low_speed";

// ≥8000 idents are ferry/maintenance/repo across UA + Express operators.
const NON_REVENUE_MIN_NUM = 8000;
// FMS may still show the previous leg's ident through taxi/climb-out.
const MIN_IDENT_GROUND_SPEED_KT = 120;

export function classifyObservation(
  aircraft: AdsbAircraft,
  assignedFlights: string[]
): { result: ShadowResult; assignedFlight: string | null } {
  if (aircraft.gs != null && aircraft.gs < MIN_IDENT_GROUND_SPEED_KT) {
    return { result: "low_speed", assignedFlight: null };
  }
  const derived = deriveCallsignFlight(aircraft.callsign ?? null);
  if (!derived) {
    return { result: "no_callsign", assignedFlight: assignedFlights[0] ?? null };
  }
  if (derived.num >= NON_REVENUE_MIN_NUM) {
    return { result: "non_revenue", assignedFlight: null };
  }
  if (assignedFlights.length === 0) {
    return { result: "no_assignment", assignedFlight: null };
  }
  const hit = assignedFlights.find((f) => callsignMatchesAssignment(aircraft.callsign, f));
  return hit
    ? { result: "match", assignedFlight: hit }
    : { result: "mismatch", assignedFlight: assignedFlights[0] };
}

// 1h lookahead (was 4h) — tighter than rotation-slip noise but still covers
// scheduled-vs-actual departure lag from FR24's stale rows.
const ASSIGNMENT_LOOKAHEAD_SEC = 3600;
const ASSIGNMENT_ARRIVAL_GRACE_SEC = 3600;

export interface AdsbShadowResult {
  outcome: "success" | "error";
  observed: number;
  airborne: number;
  counts: Record<ShadowResult, number>;
}

export async function runAdsbSweepShadow(
  db: Database,
  fetcher: typeof fetch = fetch
): Promise<AdsbShadowResult> {
  return withSpan(
    "scraper.adsb_sweep",
    async (span): Promise<AdsbShadowResult> => {
      span.setTag("job.type", "background");
      const airlineTag = normalizeAirlineTag("UA");
      const counts: Record<ShadowResult, number> = {
        match: 0,
        mismatch: 0,
        no_assignment: 0,
        no_callsign: 0,
        non_revenue: 0,
        low_speed: 0,
      };
      // Full UA fleet — Starlink-only is blind to wrong-yes tail swaps.
      const tails = getFleetTailsWithStatus(db, "UA")
        .map((r) => r.tail_number)
        .filter((t) => looksLikeValidTailNumber(t));
      if (tails.length === 0) {
        return { outcome: "success", observed: 0, airborne: 0, counts };
      }

      // The vendor call gets its own try/catch so a later DB failure can't be
      // double-counted as a vendor error.
      let swept: Awaited<ReturnType<typeof sweepAdsbProviders>>;
      try {
        swept = await sweepAdsbProviders(tails, fetcher, airlineTag);
      } catch (err) {
        logError("adsb-shadow sweep failed", err);
        metrics.increment(COUNTERS.VENDOR_REQUEST, {
          vendor: "adsb",
          type: "sweep",
          status: "error",
          airline: airlineTag,
        });
        span.setTag("error", true);
        return { outcome: "error", observed: 0, airborne: 0, counts };
      }

      try {
        const { aircraft, stats } = swept;
        metrics.increment(COUNTERS.VENDOR_REQUEST, {
          vendor: "adsb",
          type: "sweep",
          status: "success",
          airline: airlineTag,
        });
        metrics.distribution(DISTRIBUTIONS.VENDOR_DURATION_MS, stats.latencyMs, {
          vendor: "adsb",
          type: "sweep",
          status: "success",
          airline: airlineTag,
        });

        const now = Math.floor(Date.now() / 1000);
        // One window query for the whole sweep, keyed by tail (closest departure first).
        const assignmentsByTail = new Map<string, string[]>();
        const assignmentRows = db
          .query(
            `SELECT tail_number, flight_number FROM upcoming_flights
             WHERE departure_time <= ? AND arrival_time >= ? AND airline = 'UA'
             ORDER BY ABS(departure_time - ?) ASC`
          )
          .all(now + ASSIGNMENT_LOOKAHEAD_SEC, now - ASSIGNMENT_ARRIVAL_GRACE_SEC, now) as Array<{
          tail_number: string;
          flight_number: string;
        }>;
        for (const row of assignmentRows) {
          const list = assignmentsByTail.get(row.tail_number) ?? [];
          list.push(row.flight_number);
          assignmentsByTail.set(row.tail_number, list);
        }

        const observations: Array<Omit<AdsbObservationRecord, "id">> = [];
        for (const ac of aircraft) {
          let result: ShadowResult | null = null;
          let assignedFlight: string | null = null;
          if (ac.airborne) {
            const assigned = assignmentsByTail.get(ac.tail) ?? [];
            const classified = classifyObservation(ac, assigned);
            result = classified.result;
            assignedFlight = classified.assignedFlight;
            counts[result]++;
            if (result === "mismatch") {
              // debug: this re-fired every sweep for the same aircraft (top
              // offender 43x/week) and was 11% of all log volume. The count is
              // already carried by adsb_shadow.observations{result:mismatch},
              // and the per-aircraft detail is written to adsb_observations.
              debug(
                `adsb-shadow: ${ac.tail} flying ${ac.callsign} but upcoming_flights says ${assignedFlight}`
              );
            }
          }
          observations.push({
            observed_at: now,
            tail_number: ac.tail,
            callsign: ac.callsign,
            hex: ac.hex,
            airborne: ac.airborne ? 1 : 0,
            ground_speed: ac.gs,
            lat: ac.lat,
            lon: ac.lon,
            aircraft_type: ac.aircraftType,
            provider: stats.provider,
            shadow_result: result,
            assigned_flight: assignedFlight,
          });
        }

        const airborne = aircraft.filter((a) => a.airborne).length;
        recordAdsbSweep(
          db,
          {
            swept_at: now,
            provider: stats.provider,
            requests: stats.requests,
            latency_ms: stats.latencyMs,
            tails_queried: tails.length,
            observed: aircraft.length,
            airborne,
            matched: counts.match,
            mismatched: counts.mismatch,
            no_assignment: counts.no_assignment,
            no_callsign: counts.no_callsign,
            non_revenue: counts.non_revenue,
            low_speed: counts.low_speed,
          },
          observations
        );
        recordFlightDraws(db, observations, now);

        for (const [result, value] of Object.entries(counts)) {
          metrics.gauge(GAUGES.ADSB_SHADOW_OBSERVATIONS, value, { result, airline: airlineTag });
        }
        metrics.gauge(GAUGES.ADSB_SHADOW_OBSERVATIONS, airborne, {
          result: "airborne_total",
          airline: airlineTag,
        });
        emitShadowKpis(db, observations, airlineTag);

        span.setTag("observed", aircraft.length);
        span.setTag("airborne", airborne);
        span.setTag("mismatches", counts.mismatch);
        if (airborne > 0) {
          info(
            `adsb-shadow sweep: ${airborne} airborne of ${aircraft.length} seen — ` +
              `${counts.match} match, ${counts.mismatch} mismatch, ${counts.no_assignment} no assignment`
          );
        }
        return { outcome: "success", observed: aircraft.length, airborne, counts };
      } catch (err) {
        // Classification/DB-side failure — the vendor call already succeeded.
        logError("adsb-shadow classification/write failed", err);
        span.setTag("error", true);
        return { outcome: "error", observed: swept.aircraft.length, airborne: 0, counts };
      }
    },
    { "job.type": "background" }
  );
}

export interface ShadowKpis {
  accuracy: number | null;
  blindShare: number | null;
}

/** accuracy over answered legs; blind share over tails the updater tracks,
 * since a tail with no upcoming_flights rows at all can never match. */
export function computeShadowKpis(
  observations: ReadonlyArray<Pick<AdsbObservationRecord, "tail_number" | "shadow_result">>,
  trackedTails: ReadonlySet<string>
): ShadowKpis {
  let match = 0;
  let mismatch = 0;
  let trackedJudged = 0;
  let trackedBlind = 0;
  for (const o of observations) {
    const r = o.shadow_result;
    if (r !== "match" && r !== "mismatch" && r !== "no_assignment") continue;
    if (r === "match") match++;
    if (r === "mismatch") mismatch++;
    if (!trackedTails.has(o.tail_number)) continue;
    trackedJudged++;
    if (r === "no_assignment") trackedBlind++;
  }
  return {
    accuracy: match + mismatch > 0 ? match / (match + mismatch) : null,
    blindShare: trackedJudged > 0 ? trackedBlind / trackedJudged : null,
  };
}

function emitShadowKpis(
  db: Database,
  observations: ReadonlyArray<Pick<AdsbObservationRecord, "tail_number" | "shadow_result">>,
  airlineTag: string
): void {
  const tracked = new Set(
    (
      db.query("SELECT DISTINCT tail_number FROM upcoming_flights WHERE airline = 'UA'").all() as {
        tail_number: string;
      }[]
    ).map((r) => r.tail_number)
  );
  const { accuracy, blindShare } = computeShadowKpis(observations, tracked);
  if (accuracy !== null) {
    metrics.gauge(GAUGES.ADSB_SHADOW_ACCURACY, accuracy, { airline: airlineTag });
  }
  if (blindShare !== null) {
    metrics.gauge(GAUGES.ADSB_SHADOW_BLIND_SHARE, blindShare, { airline: airlineTag });
  }
}

// Pause for 30 minutes after three consecutive failures so a provider outage
// doesn't get hammered every 5 minutes.
const ADSB_OUTAGE_FAILURES = 3;
const ADSB_OUTAGE_SKIP_TICKS = 6;

export function startAdsbSweepJob(db: Database): JobHandle {
  const breaker = createOutageBreaker(ADSB_OUTAGE_FAILURES, ADSB_OUTAGE_SKIP_TICKS);
  return startJob({
    name: "adsb_sweep",
    intervalMs: 5 * 60 * 1000,
    initialDelayMs: 2 * 60 * 1000,
    // A sweep now has a bounded worst case: 3 providers x their paging, each
    // request capped at PROVIDER_REQUEST_TIMEOUT_MS. The default 15-minute
    // watchdog fired twice in 24h and abandons without aborting, leaving an
    // orphaned run writing alongside its successor — the exact overlap the
    // runner exists to prevent. Sized above the real worst case, not the
    // observed p95, so it only trips on a genuine hang.
    stuckTimeoutMs: 8 * 60 * 1000,
    run: async () => {
      await backfillAdsbFlightDraws(db);
      if (breaker.shouldSkip()) return;
      const result = await runAdsbSweepShadow(db);
      if (breaker.record(result.outcome === "error" ? "failure" : "success")) {
        warn("adsb-sweep: repeated failures — pausing sweeps for 30 minutes");
      }
    },
  });
}

// UCA's callsign number matched the marketing number on only 22% of logged
// departures (every other operator 49-69%), so its idents are not a flight
// number we can attribute a draw to.
const DRAW_EXCLUDED_PREFIXES = new Set(["UCA"]);

type SightingSource = Pick<
  AdsbObservationRecord,
  "observed_at" | "tail_number" | "callsign" | "airborne" | "ground_speed"
>;

/** The marketing flight a sighting is evidence for, or null when the callsign
 * cannot name one. Same speed and non-revenue rules as classifyObservation. */
export function flightSightingFromObservation(o: SightingSource): AdsbFlightSighting | null {
  if (!o.airborne) return null;
  if (o.ground_speed != null && o.ground_speed < MIN_IDENT_GROUND_SPEED_KT) return null;
  const derived = deriveCallsignFlight(o.callsign);
  if (!derived || DRAW_EXCLUDED_PREFIXES.has(derived.prefix)) return null;
  if (derived.num <= 0 || derived.num >= NON_REVENUE_MIN_NUM) return null;
  return {
    flight_number: `UA${derived.num}`,
    tail_number: o.tail_number,
    observed_at: o.observed_at,
  };
}

function toSightings(rows: readonly SightingSource[]): AdsbFlightSighting[] {
  const out: AdsbFlightSighting[] = [];
  for (const r of rows) {
    const s = flightSightingFromObservation(r);
    if (s) out.push(s);
  }
  return out;
}

/** Best-effort: the rollup is predictor input, never a reason to lose a sweep. */
function recordFlightDraws(db: Database, observations: readonly SightingSource[], now: number) {
  try {
    upsertAdsbFlightDraws(db, toSightings(observations));
    pruneAdsbFlightDraws(db, now);
  } catch (err) {
    logError("adsb-sweep: flight-draw rollup failed", err);
  }
}

const BACKFILL_META_KEY = "adsbFlightDrawsBackfill";
const BACKFILL_CHUNK_ROWS = 50_000;
/** Per job tick. Each chunk is synchronous SQLite, so the budget plus a yield
 * between chunks keeps the backfill from holding the event loop for longer
 * than one chunk at a time. */
const BACKFILL_BUDGET_MS = 3_000;

type BackfillState = { cursor: number; highWater: number } | "done";

function readBackfillState(db: Database): BackfillState | null {
  const raw = getMeta(db, BACKFILL_META_KEY);
  if (!raw) return null;
  if (raw === "done") return "done";
  try {
    const parsed = JSON.parse(raw) as { cursor: number; highWater: number };
    return Number.isFinite(parsed.cursor) && Number.isFinite(parsed.highWater) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One-time rollup of the adsb_observations history that predates the live
 * upsert. Starts only while the rollup is empty, stops at the id high-water
 * mark captured at start (later rows arrive through the live sweep), and
 * resumes across ticks and restarts from a cursor in meta. Runs from the
 * sweep job, never from a request.
 */
export async function backfillAdsbFlightDraws(
  db: Database,
  opts: { budgetMs?: number; chunkRows?: number } = {}
): Promise<"done" | "partial" | "skipped"> {
  const budgetMs = opts.budgetMs ?? BACKFILL_BUDGET_MS;
  const chunkRows = opts.chunkRows ?? BACKFILL_CHUNK_ROWS;
  try {
    let state = readBackfillState(db);
    if (state === "done") return "skipped";
    if (state === null) {
      if (countAdsbFlightDraws(db) > 0) {
        setMeta(db, BACKFILL_META_KEY, "done");
        return "skipped";
      }
      const hw = db.query("SELECT MAX(id) AS id FROM adsb_observations").get() as {
        id: number | null;
      };
      state = { cursor: 0, highWater: hw.id ?? 0 };
      info(`adsb-draws backfill: starting over observations up to id ${state.highWater}`);
    }
    const started = Date.now();
    const chunk = db.query(
      `SELECT id, observed_at, tail_number, callsign, airborne, ground_speed
       FROM adsb_observations WHERE id > ? AND id <= ? AND airborne = 1
       ORDER BY id LIMIT ?`
    );
    while (Date.now() - started < budgetMs) {
      const rows = chunk.all(state.cursor, state.highWater, chunkRows) as Array<
        SightingSource & { id: number }
      >;
      if (rows.length === 0) {
        setMeta(db, BACKFILL_META_KEY, "done");
        info("adsb-draws backfill: complete");
        return "done";
      }
      upsertAdsbFlightDraws(db, toSightings(rows));
      state = { cursor: rows[rows.length - 1].id, highWater: state.highWater };
      setMeta(db, BACKFILL_META_KEY, JSON.stringify(state));
      await sleep(0);
    }
    return "partial";
  } catch (err) {
    logError("adsb-draws backfill failed", err);
    return "partial";
  }
}
