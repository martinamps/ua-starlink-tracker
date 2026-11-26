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
import { inLookupWindow, unixNow } from "../database/sql/windows";
import {
  COUNTERS,
  type LookupCaller,
  type LookupShedReason,
  flightAirlineTag,
  metrics,
  normalizeLookupCaller,
  normalizeLookupShedReason,
} from "../observability";
import { matchesLocalDate } from "../utils/airport-tz";
import { warn } from "../utils/logger";
import { isAirportCode, isRegistration, plainTypeName } from "../utils/outside-text";
import { memoPromise } from "../utils/ttl-cache";
import {
  FR24_QUEUE_SHED_MESSAGE,
  FlightRadar24API,
  Fr24UnavailableError,
  MIN_REQUEST_INTERVAL,
} from "./flightradar24-api";
import { LookupBudget, currentLookupAsker, lookupAllowance } from "./lookup-budget";

const fr24 = new FlightRadar24API();
type Assignment = Awaited<ReturnType<FlightRadar24API["getFlightAssignments"]>>;
type AssignmentFetcher = (flightNumber: string, targetDateUnix: number) => Promise<Assignment>;

// Request path: no inline retry, since a throttled FR24 answers again minutes
// later, not after a 30s sleep the caller is stuck waiting on. Likewise no deep
// queue: slots are 2s apart and the bucket admits a burst of 15, so uncapped the
// last of a burst (plus any slots the background jobs hold) waits ~30s — past
// the extension's 10s fetch timeout. Two slots of wait, because the extension
// checks three cards at a time: the first goes now, the second waits 2s, the
// third 4s. With one slot the third was shed (636 of 3,837 lookups, 18-24 Nov
// 2026). The wait is longer; the slots stay 2s apart, so FR24 is asked no
// more often.
export const FR24_REQUEST_MAX_QUEUE_MS = 2 * MIN_REQUEST_INTERVAL;
// Wait and fetch together end inside this, so the answer still beats the
// extension's 10s timeout (FETCH_TIMEOUT_MS, chrome-extension/background.js)
// with 1s left for the trip there and back: a lookup that waited the full 4s
// has 5s to fetch (FR24 answers in 2.1s at p99), one that waited nothing
// keeps the usual 8s. tests/flight-verdict-budget.test.ts pins the sum.
export const FR24_REQUEST_DEADLINE_MS = 9000;
const defaultFetcher: AssignmentFetcher = (flightNumber, targetDateUnix) =>
  fr24.getFlightAssignments(flightNumber, targetDateUnix, {
    maxRetries: 0,
    maxWaitMs: FR24_REQUEST_MAX_QUEUE_MS,
    deadlineMs: FR24_REQUEST_DEADLINE_MS,
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

const ASSIGNMENT_CACHE_TTL = 3600;
const assignmentCache = memoPromise<Assignment>({ ttlSec: ASSIGNMENT_CACHE_TTL, maxEntries: 500 });
// During an outage, replay the rejection briefly instead of re-running the
// full retry ladder on every request.
export const ASSIGNMENT_FAILURE_TTL = 60;
// FR24 publishes a tail close to departure, so an empty answer for a flight
// hours away is re-polled; far out, a repeat asker gets the cached empty.
export const ASSIGNMENT_EMPTY_TTL = 600;
export const ASSIGNMENT_EMPTY_CACHE_MIN_LEAD = 6 * 3600;

export function cachedFlightAssignments(
  flightNumber: string,
  targetDateUnix: number,
  nowSec = unixNow(),
  callerOverride?: LookupCaller
): Promise<Assignment> {
  const key = `${flightNumber}:${Math.floor(targetDateUnix / 86400)}`;
  const now = nowSec;
  const cached = assignmentCache.get(key, now);
  if (cached) return cached;

  // Joining a lookup already under way (above) costs a caller nothing; only a
  // lookup of its own counts against its share.
  const asker = currentLookupAsker();
  const caller = callerOverride ?? asker?.caller ?? "other";
  const shareKey = asker?.key ?? null;
  if (shareKey !== null && !lookupBudget.take(shareKey, lookupAllowance(caller), now)) {
    countShed(flightNumber, "budget", caller);
    return Promise.reject(new Fr24UnavailableError("shed: budget"));
  }
  const settleShare = (asked: boolean) => {
    if (shareKey !== null) lookupBudget.settle(shareKey, { asked });
  };

  const shed = fr24RequestShedReason(now);
  if (shed) {
    settleShare(false);
    countShed(flightNumber, shed, caller);
    return Promise.reject(new Fr24UnavailableError(`shed: ${shed}`));
  }

  let promise: Promise<Assignment>;
  try {
    promise = fetchAssignments(flightNumber, targetDateUnix).then((raw) => {
      const legs = readableLegs(raw);
      fetchedAt.set(legs, now);
      return legs;
    });
  } catch (err) {
    settleShare(true);
    throw err;
  }
  // A failure replays briefly instead of re-running the retry ladder per
  // request. A queue shed never reached FR24, so there is no outage to replay:
  // the next ask may find a free slot. An empty answer near departure is
  // re-polled, since FR24 publishes the tail close to it.
  assignmentCache.set(key, promise, now, (s) => {
    if (!s.ok) return isQueueShed(s.error) ? 0 : ASSIGNMENT_FAILURE_TTL;
    if (s.value.length > 0) return ASSIGNMENT_CACHE_TTL;
    return targetDateUnix - now > ASSIGNMENT_EMPTY_CACHE_MIN_LEAD ? ASSIGNMENT_EMPTY_TTL : 0;
  });
  // Counted once FR24 was actually asked: a queue shed refunds its token.
  const countLookup = () =>
    metrics.increment(COUNTERS.FR24_LOOKUP, {
      airline: flightAirlineTag(flightNumber),
    });
  promise.then(
    () => {
      settleShare(true);
      countLookup();
      fr24ThrottleStreak = 0;
    },
    (err) => {
      if (isQueueShed(err)) {
        settleShare(false);
        refundFr24Token();
        // Requests that joined this promise are not counted: one FR24 slot
        // was refused, and the tag names who asked for it.
        countShed(flightNumber, "queue", caller);
        return;
      }
      settleShare(true);
      countLookup();
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

/** A leg that named an aircraft we could not read, kept by departure alone. */
interface UnreadLeg {
  origin: string;
  departure_time: number;
}
const unreadLegs = new WeakMap<Assignment, UnreadLeg[]>();
/** When each cached answer was asked for: what it says was true then, not when it is replayed. */
const fetchedAt = new WeakMap<Assignment, number>();
const unreadCounts = new WeakMap<FallbackSegment[], number>();

const trimmed = (text: string | null | undefined): string | null =>
  typeof text === "string" ? text.trim() : null;

/**
 * The lookup's strings are an outside service's text, and every reader of the
 * cache prints some of them, so they are checked once here: trimmed, then a
 * leg whose airports aren't shaped like airports is dropped, and a tail that
 * isn't shaped like one is blanked. A leg that named an aircraft and lost it
 * either way is remembered: the flight has an aircraft we know nothing about,
 * which is not the same as no aircraft named yet.
 */
function readableLegs(raw: Assignment): Assignment {
  const legs: Assignment = [];
  const unread: UnreadLeg[] = [];
  for (const a of raw) {
    const tail = trimmed(a.tail_number);
    const origin = trimmed(a.origin);
    const destination = trimmed(a.destination);
    const route = isAirportCode(origin) && isAirportCode(destination);
    const named = isRegistration(tail);
    if (tail && !(named && route)) {
      unread.push({
        origin: isAirportCode(origin) ? origin : "",
        departure_time: a.departure_time,
      });
    }
    if (!route) continue;
    legs.push({
      ...a,
      origin,
      destination,
      tail_number: named ? tail : null,
      aircraft_model: trimmed(a.aircraft_model),
    });
  }
  unreadLegs.set(legs, unread);
  return legs;
}

/**
 * How many aircraft the lookup named for that date and we could not read: a
 * tail or airport that failed its shape check, or a type name that did on a
 * tail whose type we don't hold ourselves. Callers must not answer such a
 * flight as if its aircraft were the one its number usually means.
 */
export function unreadAircraft(segments: FallbackSegment[] | null | undefined): number {
  return (segments && unreadCounts.get(segments)) || 0;
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
const lookupBudget = new LookupBudget();

function countShed(flightNumber: string, reason: LookupShedReason, caller: LookupCaller): void {
  metrics.increment(COUNTERS.VENDOR_REQUEST, {
    vendor: "fr24",
    type: "assignments",
    status: "shed",
    reason: normalizeLookupShedReason(reason),
    caller: normalizeLookupCaller(caller),
    airline: flightAirlineTag(flightNumber),
  });
}

function resetFr24RequestGuards(): void {
  fr24Tokens = FR24_REQUEST_BUCKET_PER_MIN;
  fr24TokensAt = 0;
  fr24ThrottledUntil = 0;
  fr24ThrottleStreak = 0;
  lookupBudget.clear();
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

function isQueueShed(err: unknown): boolean {
  return err instanceof Error && err.message === FR24_QUEUE_SHED_MESSAGE;
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
  scope: ScopedReader,
  tail: string,
  nowSec = unixNow()
): TailVerdict {
  // The tail was found on one of the scope's flights, so it may be an
  // operating partner's: a listed Hawaiian A330 on an Alaska number.
  const reader = scope.assignedTails;
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
  reader: ScopedReader["assignedTails"],
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
  nowSec = unixNow(),
  caller?: LookupCaller
): Promise<FallbackSegment[] | null> {
  if (!inLookupWindow(startOfDay, endOfDay, nowSec)) return null;

  const assignments = await cachedFlightAssignments(
    normalizedFlightNumber,
    startOfDay + 43200,
    nowSec,
    caller
  );
  const segments: FallbackSegment[] = [];
  const onDate = (a: UnreadLeg) =>
    matchesLocalDate(date, a.origin, a.departure_time, startOfDay, endOfDay);
  let unread = (unreadLegs.get(assignments) ?? []).filter(onDate).length;

  for (const a of assignments) {
    // readableLegs has checked the airports, and blanked a tail that isn't one.
    if (!a.tail_number || !onDate(a)) continue;

    const v = resolveTailVerdict(reader, a.tail_number, nowSec);
    const aircraftModel = v.aircraft_model || plainTypeName(a.aircraft_model);
    // The type name was there and unprintable. Our own fleet list's type
    // for the tail stands in for it downstream; with neither, the aircraft
    // is one we can't place.
    const ownType = () => reader.assignedTails.getFleetEntryByTail(a.tail_number ?? "");
    if (!aircraftModel && a.aircraft_model && !ownType()?.aircraft_type) unread++;
    segments.push({
      tail_number: a.tail_number,
      aircraft_model: aircraftModel,
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

  // The log goes by when the lookup was fetched: replayed from the cache, it
  // must not outrank what a newer lookup of another date has since logged.
  const asOf = fetchedAt.get(assignments) ?? nowSec;
  // Before the log: a tail the lookup still names is seen again just below.
  reader.withdrawUnreturnedSightings(
    normalizedFlightNumber,
    [
      ...assignments,
      ...(unreadLegs.get(assignments) ?? []).map((u) => ({ ...u, tail_number: null })),
    ],
    asOf
  );
  reader.noteUnreadAircraft(
    normalizedFlightNumber,
    [
      ...assignments.map((a) => ({ ...a, unread: false })),
      ...(unreadLegs.get(assignments) ?? []).map((u) => ({ ...u, unread: true })),
    ],
    asOf
  );
  if (segments.length > 0) reader.logResolvedAssignments(normalizedFlightNumber, segments, asOf);
  unreadCounts.set(segments, unread);
  return segments;
}
