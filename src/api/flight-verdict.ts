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
import { matchesLocalDate } from "../utils/airport-tz";
import { FlightRadar24API } from "./flightradar24-api";

const fr24 = new FlightRadar24API();
type Assignment = Awaited<ReturnType<FlightRadar24API["getFlightAssignments"]>>;
type AssignmentFetcher = (flightNumber: string, targetDateUnix: number) => Promise<Assignment>;

const defaultFetcher: AssignmentFetcher = (flightNumber, targetDateUnix) =>
  fr24.getFlightAssignments(flightNumber, targetDateUnix);
let fetchAssignments: AssignmentFetcher = defaultFetcher;

// Test seam as a setter (not an injected param) because the cache is already
// module-global: a swapped fetcher must clear it or stale entries leak across.
// null restores the default.
export function setAssignmentFetcher(fetcher: AssignmentFetcher | null): void {
  fetchAssignments = fetcher ?? defaultFetcher;
  assignmentCache.clear();
}

const assignmentCache = new Map<
  string,
  { promise: Promise<Assignment>; at: number; failedAt?: number }
>();
const ASSIGNMENT_CACHE_TTL = 3600;
// During an outage, replay the rejection briefly instead of re-running the
// full retry ladder on every request.
export const ASSIGNMENT_FAILURE_TTL = 60;

export function cachedFlightAssignments(
  flightNumber: string,
  targetDateUnix: number,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<Assignment> {
  const key = `${flightNumber}:${Math.floor(targetDateUnix / 86400)}`;
  const now = nowSec;
  const cached = assignmentCache.get(key);
  if (cached) {
    const failed = cached.failedAt !== undefined;
    const age = now - (failed ? (cached.failedAt as number) : cached.at);
    if (age < (failed ? ASSIGNMENT_FAILURE_TTL : ASSIGNMENT_CACHE_TTL)) return cached.promise;
  }

  if (assignmentCache.size > 500) {
    for (const [k, v] of assignmentCache) {
      if (now - v.at >= ASSIGNMENT_CACHE_TTL) assignmentCache.delete(k);
    }
  }

  const promise = fetchAssignments(flightNumber, targetDateUnix);
  const entry: { promise: Promise<Assignment>; at: number; failedAt?: number } = {
    promise,
    at: now,
  };
  assignmentCache.set(key, entry);
  // Empties don't stay cached — unpublished assignments appear close to
  // departure, so re-polling is intentional. Rejections become a short-TTL
  // failure marker stamped from the injected clock, so the stamp and the TTL
  // compare share one timebase; this rejection handler also keeps the stored
  // promise from ever surfacing as an unhandled rejection.
  promise.then(
    (result) => {
      if (result.length === 0) assignmentCache.delete(key);
    },
    () => {
      if (assignmentCache.get(key) === entry) {
        entry.failedAt = now;
      }
    }
  );
  return promise;
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
