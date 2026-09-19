/**
 * Shared FR24 tail-lookup fallback for check-flight surfaces.
 *
 * When upcoming_flights has no row for a flight+date (we only track Starlink
 * tails there), this asks FR24 fetchBy=flight for the actual tail registration
 * and resolves a Starlink verdict from our own tables. Used by both
 * /api/check-flight and MCP check_flight so the two surfaces converge.
 */

import { OBSERVED_WIFI_SOURCES } from "../airlines/registry";
import type { ScopedReader } from "../database/reader";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability";
import { matchesLocalDate } from "../utils/airport-tz";
import { warn } from "../utils/logger";
import {
  FR24_QUEUE_SHED_MESSAGE,
  FlightRadar24API,
  Fr24UnavailableError,
  MIN_REQUEST_INTERVAL,
} from "./flightradar24-api";

const fr24 = new FlightRadar24API();
type Assignment = Awaited<ReturnType<FlightRadar24API["getFlightAssignments"]>>;
type AssignmentFetcher = (flightNumber: string, targetDateUnix: number) => Promise<Assignment>;

// Request path: no inline retry, since a throttled FR24 answers again minutes
// later, not after a 30s sleep the caller is stuck waiting on. Likewise no deep
// queue: slots are 2s apart and the bucket admits a burst of 15, so uncapped the
// last of a burst (plus any slots the background jobs hold) waits ~30s — past
// the extension's 10s fetch timeout. One slot of wait is the floor, though:
// below it any miss within 2s of another claim sheds, e.g. leg 2 of a connecting
// itinerary the extension checks in parallel. 2s wait + 8s fetch fits in 10s.
export const FR24_REQUEST_MAX_QUEUE_MS = MIN_REQUEST_INTERVAL;
const defaultFetcher: AssignmentFetcher = (flightNumber, targetDateUnix) =>
  fr24.getFlightAssignments(flightNumber, targetDateUnix, {
    maxRetries: 0,
    maxWaitMs: FR24_REQUEST_MAX_QUEUE_MS,
  });
let fetchAssignments: AssignmentFetcher = defaultFetcher;

// Test seam as a setter (not an injected param) because the cache is already
// module-global: a swapped fetcher must clear it or stale entries leak across.
// null restores the default.
export function setAssignmentFetcher(fetcher: AssignmentFetcher | null): void {
  fetchAssignments = fetcher ?? defaultFetcher;
  assignmentCache.clear();
  resetFr24RequestGuards();
}

interface AssignmentCacheEntry {
  promise: Promise<Assignment>;
  at: number;
  failedAt?: number;
  empty?: boolean;
}
const assignmentCache = new Map<string, AssignmentCacheEntry>();
const ASSIGNMENT_CACHE_TTL = 3600;
// During an outage, replay the rejection briefly instead of re-running the
// full retry ladder on every request.
export const ASSIGNMENT_FAILURE_TTL = 60;
// FR24 publishes a tail close to departure, so an empty answer for a flight
// hours away is re-polled; far out, a repeat asker gets the cached empty.
export const ASSIGNMENT_EMPTY_TTL = 600;
export const ASSIGNMENT_EMPTY_CACHE_MIN_LEAD = 6 * 3600;

function entryTtl(entry: AssignmentCacheEntry): number {
  if (entry.failedAt !== undefined) return ASSIGNMENT_FAILURE_TTL;
  return entry.empty ? ASSIGNMENT_EMPTY_TTL : ASSIGNMENT_CACHE_TTL;
}

export function cachedFlightAssignments(
  flightNumber: string,
  targetDateUnix: number,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<Assignment> {
  const key = `${flightNumber}:${Math.floor(targetDateUnix / 86400)}`;
  const now = nowSec;
  const cached = assignmentCache.get(key);
  if (cached) {
    const age = now - (cached.failedAt ?? cached.at);
    if (age < entryTtl(cached)) return cached.promise;
  }

  const shed = fr24RequestShedReason(now);
  if (shed) {
    countShed(flightNumber, shed);
    return Promise.reject(new Fr24UnavailableError(`shed: ${shed}`));
  }

  if (assignmentCache.size > 500) {
    for (const [k, v] of assignmentCache) {
      if (now - v.at >= ASSIGNMENT_CACHE_TTL) assignmentCache.delete(k);
    }
  }

  const promise = fetchAssignments(flightNumber, targetDateUnix);
  const entry: AssignmentCacheEntry = { promise, at: now };
  assignmentCache.set(key, entry);
  // Rejections become a short-TTL failure marker stamped from the injected
  // clock, so the stamp and the TTL compare share one timebase; this rejection
  // handler also keeps the stored promise from ever surfacing as an unhandled
  // rejection.
  promise.then(
    (result) => {
      fr24ThrottleStreak = 0;
      if (result.length > 0) return;
      if (targetDateUnix - now > ASSIGNMENT_EMPTY_CACHE_MIN_LEAD) entry.empty = true;
      else if (assignmentCache.get(key) === entry) assignmentCache.delete(key);
    },
    (err) => {
      // FR24 was never called, so there is no outage to replay: the next ask
      // may find a free slot.
      if (err instanceof Error && err.message === FR24_QUEUE_SHED_MESSAGE) {
        if (assignmentCache.get(key) === entry) assignmentCache.delete(key);
        refundFr24Token();
        countShed(flightNumber, "queue");
        return;
      }
      if (assignmentCache.get(key) === entry) {
        entry.failedAt = now;
      }
      if (isFr24Throttle(err)) openFr24Breaker(now);
      // Logged here — where the failure is PRODUCED — not in the consumer.
      // A rejection is cached for ASSIGNMENT_FAILURE_TTL and replayed to every
      // request in that window, and concurrent requests all await this same
      // promise, so logging at the consumer produced 3-4 identical lines per
      // real failure (observed: three at the same millisecond). This handler
      // runs exactly once per actual fetch.
      warn(`FR24 assignment lookup failed for ${flightNumber}; degrading to prediction path`, err);
    }
  );
  return promise;
}

// Request-path FR24 guards, separate from the background updater's own
// breaker. Scripted enumeration (173 sequential flight numbers in 30 min on
// 2026-09-06) got FR24 throttling the shared session and stalled the updater;
// a shed request degrades to the prediction path exactly like an FR24 outage.
export const FR24_REQUEST_BUCKET_PER_MIN = 15;
export const FR24_BREAKER_BASE_SEC = 5 * 60;
export const FR24_BREAKER_MAX_SEC = 30 * 60;

let fr24Tokens = FR24_REQUEST_BUCKET_PER_MIN;
let fr24TokensAt = 0;
let fr24ThrottledUntil = 0;
let fr24ThrottleStreak = 0;

function countShed(flightNumber: string, reason: "breaker" | "bucket" | "queue"): void {
  metrics.increment(COUNTERS.VENDOR_REQUEST, {
    vendor: "fr24",
    type: "assignments",
    status: "shed",
    reason,
    airline: normalizeAirlineTag(flightNumber.slice(0, 2)),
  });
}

function resetFr24RequestGuards(): void {
  fr24Tokens = FR24_REQUEST_BUCKET_PER_MIN;
  fr24TokensAt = 0;
  fr24ThrottledUntil = 0;
  fr24ThrottleStreak = 0;
}

function fr24RequestShedReason(nowSec: number): "breaker" | "bucket" | null {
  if (nowSec < fr24ThrottledUntil) return "breaker";
  const elapsed = Math.max(0, nowSec - fr24TokensAt);
  fr24Tokens = Math.min(
    FR24_REQUEST_BUCKET_PER_MIN,
    fr24Tokens + (elapsed * FR24_REQUEST_BUCKET_PER_MIN) / 60
  );
  fr24TokensAt = nowSec;
  if (fr24Tokens < 1) return "bucket";
  fr24Tokens -= 1;
  return null;
}

// A queue shed never reached FR24, so it must not drain the budget that
// later misses need.
function refundFr24Token(): void {
  fr24Tokens = Math.min(FR24_REQUEST_BUCKET_PER_MIN, fr24Tokens + 1);
}

// FR24 throttles a busy session with bare 400s as well as 402/429.
function isFr24Throttle(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(?:^|\D)(400|402|429)$/.test(message);
}

function openFr24Breaker(nowSec: number): void {
  // Concurrent lookups already in flight when the first throttle lands are one
  // throttle event, not N consecutive ones escalating the backoff.
  if (nowSec < fr24ThrottledUntil) return;
  const backoff = Math.min(FR24_BREAKER_MAX_SEC, FR24_BREAKER_BASE_SEC * 2 ** fr24ThrottleStreak);
  fr24ThrottleStreak++;
  fr24ThrottledUntil = Math.max(fr24ThrottledUntil, nowSec + backoff);
  warn(`FR24 throttled the request path; shedding live lookups for ${backoff / 60} min`);
}

export type SegmentConfidence = "verified" | "spreadsheet" | "disputed" | "negative" | "unknown";

export interface FallbackSegment {
  tail_number: string;
  aircraft_model: string | null;
  origin: string;
  destination: string;
  departure_time: number;
  arrival_time: number;
  hasStarlink: boolean | null;
  confidence: SegmentConfidence;
  verified_wifi?: string | null;
  verified_at?: number | null;
  operated_by?: string | null;
  fleet_type?: string | null;
}

/**
 * Resolve a Starlink verdict for one FR24-reported tail using our own tables.
 * No network — pure DB lookup. Exported separately so it can be tested without
 * hitting FR24.
 */
export function resolveTailVerdict(
  reader: ScopedReader,
  tail: string,
  nowSec = Math.floor(Date.now() / 1000)
): TailVerdict {
  const sp = reader.getStarlinkPlaneByTail(tail);

  if (sp) {
    const base = { aircraft_model: sp.Aircraft, operated_by: sp.OperatedBy, fleet_type: sp.fleet };
    // "verified" is reserved for actually-observed wifi evidence. Type-derived
    // sources (alaska-json/qatar equipment inference) may still settle the
    // verdict, but at the spreadsheet/'likely' tier — a type rule must never
    // wear the same label as a united.com-observed banner.
    const observed = reader.computeWifiConsensus(tail, { sources: OBSERVED_WIFI_SOURCES });
    if (observed.verdict === "Starlink") {
      return { hasStarlink: true, confidence: "verified", ...base };
    }
    const consensus = observed.verdict !== null ? observed : reader.computeWifiConsensus(tail);
    if (consensus.verdict === "Starlink") {
      return { hasStarlink: true, confidence: "spreadsheet", ...base };
    }
    if (consensus.verdict !== null) {
      return { hasStarlink: false, confidence: "disputed", ...base };
    }
    // Consensus unsettled: a settled negative in united_fleet (the verifier's
    // direct observation) outranks the spreadsheet listing.
    const uf = reader.getFleetEntryByTail(tail);
    if (uf?.starlink_status === "negative") {
      return negativeTailVerdict(reader, tail, uf, nowSec, "disputed", base);
    }
    return { hasStarlink: true, confidence: "spreadsheet", ...base };
  }

  const uf = reader.getFleetEntryByTail(tail);

  if (uf?.starlink_status === "confirmed") {
    // Same tier rule as the sp branch above: alaska-verifier writes
    // type-derived 'confirmed' (registry typeDeterministicWifi), so without
    // observed-wifi evidence this is a type rule, not a united.com banner.
    const observed = reader.computeWifiConsensus(tail, { sources: OBSERVED_WIFI_SOURCES });
    return {
      hasStarlink: true,
      confidence: observed.verdict === "Starlink" ? "verified" : "spreadsheet",
    };
  }
  if (uf?.starlink_status === "negative") {
    return negativeTailVerdict(reader, tail, uf, nowSec, "negative");
  }
  reader.bumpDiscoveryPriority(tail);
  return { hasStarlink: null, confidence: "unknown" };
}

interface TailVerdict {
  hasStarlink: boolean | null;
  confidence: SegmentConfidence;
  aircraft_model?: string | null;
  operated_by?: string | null;
  fleet_type?: string | null;
  verified_wifi?: string | null;
  verified_at?: number | null;
}

/** Shared united_fleet-negative verdict: re-queue stale settles for discovery. */
function negativeTailVerdict(
  reader: ScopedReader,
  tail: string,
  uf: { verified_wifi: string | null; verified_at: number | null },
  nowSec: number,
  confidence: SegmentConfidence,
  base: Partial<TailVerdict> = {}
): TailVerdict {
  const stale = uf.verified_at && nowSec - uf.verified_at > 7 * 86400;
  if (stale) reader.bumpDiscoveryPriority(tail);
  return {
    hasStarlink: false,
    confidence,
    verified_wifi: uf.verified_wifi,
    verified_at: uf.verified_at,
    ...base,
  };
}

/**
 * FR24 reverse-lookup fallback. Returns null when the date is outside FR24's
 * useful window (~24h past to ~3d future), [] when in-window but FR24 found no
 * tail-assigned legs on the queried local date, otherwise one FallbackSegment
 * per leg. Legs are matched on the origin airport's local date, falling back
 * to the [startOfDay, endOfDay) UTC window for unmapped airports.
 *
 * Throws when FR24 itself is unavailable — callers must degrade to the
 * prediction path, not a confident no.
 */
export async function lookupFlightTailVerdict(
  reader: ScopedReader,
  normalizedFlightNumber: string,
  date: string,
  startOfDay: number,
  endOfDay: number,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<FallbackSegment[] | null> {
  const inLookupWindow = endOfDay > nowSec - 86400 && startOfDay < nowSec + 3 * 86400;
  if (!inLookupWindow) return null;

  const assignments = await cachedFlightAssignments(
    normalizedFlightNumber,
    startOfDay + 43200,
    nowSec
  );
  const segments: FallbackSegment[] = [];

  for (const a of assignments) {
    if (!a.tail_number) continue;
    if (!matchesLocalDate(date, a.origin, a.departure_time, startOfDay, endOfDay)) continue;

    const v = resolveTailVerdict(reader, a.tail_number, nowSec);
    segments.push({
      tail_number: a.tail_number,
      aircraft_model: v.aircraft_model || a.aircraft_model,
      origin: a.origin,
      destination: a.destination,
      departure_time: a.departure_time,
      arrival_time: a.arrival_time,
      hasStarlink: v.hasStarlink,
      confidence: v.confidence,
      verified_wifi: v.verified_wifi,
      verified_at: v.verified_at,
      operated_by: v.operated_by,
      fleet_type: v.fleet_type,
    });
  }

  return segments;
}
