/**
 * ADS-B shadow sweep: every few minutes, ask the community ADS-B aggregators
 * which Starlink-equipped tails are airborne and what callsign they're flying,
 * then compare against the FR24-derived upcoming_flights assignments. Shadow
 * only — nothing here feeds the serving path; the point is delta metrics in
 * Datadog (and rows in adsb_observations) so we can audit agreement before
 * ever leaning on this source.
 */

import type { Database } from "bun:sqlite";
import { looksLikeValidTailNumber } from "../airlines/registry";
import { getFleetTailsWithStatus, recordAdsbSweep } from "../database/database";
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
import { info, error as logError, warn } from "../utils/logger";

interface AdsbProvider {
  name: string;
  buildUrl: (regs: string[]) => string;
  /** Measured: airplanes.live takes the whole fleet in one URL; the others 414 past ~100 regs. */
  maxRegsPerRequest: number;
}

const PROVIDERS: AdsbProvider[] = [
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
  {
    name: "adsb.fi",
    buildUrl: (regs) => `https://opendata.adsb.fi/api/v2/registration/${regs.join(",")}`,
    maxRegsPerRequest: 100,
  },
];

const PROVIDER_RATE_GAP_MS = 1100;

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
  fetcher: typeof fetch = fetch
): Promise<{ aircraft: AdsbAircraft[]; stats: AdsbSweepStats }> {
  let lastErr: unknown = null;
  for (const provider of PROVIDERS) {
    const started = Date.now();
    try {
      const { aircraft, requests } = await queryProvider(provider, tails, fetcher);
      return {
        aircraft,
        stats: { provider: provider.name, requests, latencyMs: Date.now() - started },
      };
    } catch (err) {
      lastErr = err;
      warn(`adsb-sweep: ${provider.name} failed, trying next provider`, err);
    }
  }
  throw new Error(`all ADS-B providers failed: ${lastErr}`);
}

// Callsign ICAO prefix → how upcoming_flights codes that operator's rows. The
// pairing matters: SKW#### must never match a marketing UA#### that shares the number.
const OPERATOR_DB_PREFIXES: Record<string, string[]> = {
  UAL: ["UAL", "UA"],
  SKW: ["SKW", "OO"],
  GJS: ["GJS", "G7"],
  RPA: ["RPA", "YX"],
  ASH: ["ASH", "YV"],
  UCA: ["UCA", "C5"],
  AWI: ["AWI", "ZW"],
};
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

export function classifyObservation(
  aircraft: AdsbAircraft,
  assignedFlights: string[]
): { result: ShadowResult; assignedFlight: string | null } {
  // FMS may still show the previous leg's ident through taxi/climb-out.
  if (aircraft.gs != null && aircraft.gs < 120) {
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
        swept = await sweepAdsbProviders(tails, fetcher);
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
              warn(
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

        for (const [result, value] of Object.entries(counts)) {
          metrics.gauge(GAUGES.ADSB_SHADOW_OBSERVATIONS, value, { result, airline: airlineTag });
        }
        metrics.gauge(GAUGES.ADSB_SHADOW_OBSERVATIONS, airborne, {
          result: "airborne_total",
          airline: airlineTag,
        });

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
    run: async () => {
      if (breaker.shouldSkip()) return;
      const result = await runAdsbSweepShadow(db);
      if (breaker.record(result.outcome === "error" ? "failure" : "success")) {
        warn("adsb-sweep: repeated failures — pausing sweeps for 30 minutes");
      }
    },
  });
}
