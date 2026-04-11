/**
 * Shared FR24 tail-lookup fallback for check-flight surfaces.
 *
 * When upcoming_flights has no row for a flight+date (we only track Starlink
 * tails there), this asks FR24 fetchBy=flight for the actual tail registration
 * and resolves a Starlink verdict from our own tables. Used by both
 * /api/check-flight and MCP check_flight so the two surfaces converge.
 */

import type { Database } from "bun:sqlite";
import { bumpDiscoveryPriority, computeWifiConsensus } from "../database/database";
import { FlightRadar24API } from "./flightradar24-api";

const fr24 = new FlightRadar24API();
type Assignment = Awaited<ReturnType<FlightRadar24API["getFlightAssignments"]>>;
const assignmentCache = new Map<string, { promise: Promise<Assignment>; at: number }>();
const ASSIGNMENT_CACHE_TTL = 3600;

export function cachedFlightAssignments(
  flightNumber: string,
  targetDateUnix: number
): Promise<Assignment> {
  const key = `${flightNumber}:${Math.floor(targetDateUnix / 86400)}`;
  const now = Math.floor(Date.now() / 1000);
  const cached = assignmentCache.get(key);
  if (cached && now - cached.at < ASSIGNMENT_CACHE_TTL) return cached.promise;

  if (assignmentCache.size > 500) {
    for (const [k, v] of assignmentCache) {
      if (now - v.at >= ASSIGNMENT_CACHE_TTL) assignmentCache.delete(k);
    }
  }

  const promise = fr24.getFlightAssignments(flightNumber, targetDateUnix);
  assignmentCache.set(key, { promise, at: now });
  promise.then(
    (result) => {
      if (result.length === 0) assignmentCache.delete(key);
    },
    () => assignmentCache.delete(key)
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
  db: Database,
  tail: string,
  nowSec = Math.floor(Date.now() / 1000)
): {
  hasStarlink: boolean | null;
  confidence: SegmentConfidence;
  aircraft_model?: string | null;
  operated_by?: string | null;
  fleet_type?: string | null;
  verified_wifi?: string | null;
  verified_at?: number | null;
} {
  const sp = db
    .query("SELECT Aircraft, OperatedBy, fleet FROM starlink_planes WHERE TailNumber = ?")
    .get(tail) as { Aircraft: string; OperatedBy: string; fleet: string } | null;

  if (sp) {
    const consensus = computeWifiConsensus(db, tail);
    const hasStarlink = consensus.verdict === "Starlink" || consensus.verdict === null;
    return {
      hasStarlink,
      confidence:
        consensus.verdict === "Starlink"
          ? "verified"
          : consensus.verdict === null
            ? "spreadsheet"
            : "disputed",
      aircraft_model: sp.Aircraft,
      operated_by: sp.OperatedBy,
      fleet_type: sp.fleet,
    };
  }

  const uf = db
    .query(
      "SELECT starlink_status, verified_wifi, verified_at FROM united_fleet WHERE tail_number = ?"
    )
    .get(tail) as {
    starlink_status: string;
    verified_wifi: string | null;
    verified_at: number | null;
  } | null;

  if (uf?.starlink_status === "confirmed") {
    return { hasStarlink: true, confidence: "verified" };
  }
  if (uf?.starlink_status === "negative") {
    const stale = uf.verified_at && nowSec - uf.verified_at > 7 * 86400;
    if (stale) bumpDiscoveryPriority(db, tail);
    return {
      hasStarlink: false,
      confidence: "negative",
      verified_wifi: uf.verified_wifi,
      verified_at: uf.verified_at,
    };
  }
  bumpDiscoveryPriority(db, tail);
  return { hasStarlink: null, confidence: "unknown" };
}

/**
 * FR24 reverse-lookup fallback. Returns null when the date is outside FR24's
 * useful window (~24h past to ~3d future), [] when in-window but FR24 found no
 * tail-assigned legs on that UTC day, otherwise one FallbackSegment per leg.
 */
export async function lookupFlightTailVerdict(
  db: Database,
  normalizedFlightNumber: string,
  startOfDay: number,
  endOfDay: number,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<FallbackSegment[] | null> {
  const inLookupWindow = endOfDay > nowSec - 86400 && startOfDay < nowSec + 3 * 86400;
  if (!inLookupWindow) return null;

  const assignments = await cachedFlightAssignments(normalizedFlightNumber, startOfDay + 43200);
  const segments: FallbackSegment[] = [];

  for (const a of assignments) {
    if (!a.tail_number) continue;
    if (a.departure_time < startOfDay || a.departure_time >= endOfDay) continue;

    const v = resolveTailVerdict(db, a.tail_number, nowSec);
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
