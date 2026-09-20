/**
 * Single check-flight verdict engine. /api/check-flight, the hub's
 * /api/check-any-flight, and MCP check_flight are thin formatters over
 * resolveFlightVerdict — the date-window math, local-date matching, row
 * classification, FR24 fallback, and prediction ladder live only here.
 *
 * Date semantics: callers pass the traveler's printed LOCAL departure date.
 * The SQL window is widened to cover every UTC instant that can carry that
 * local date (UTC-12..UTC+14), then rows are filtered by the departure
 * airport's local date; unmapped airports keep the strict UTC window.
 */

import {
  CANONICAL_FLIGHT_PERMALINK,
  buildAirlineFlightNumberVariants,
  detectMarketingCarrier,
  ensureAirlinePrefix,
  prefixBelongsTo,
} from "../airlines/flight-number";
import {
  type AirlineConfig,
  COMMUNITY_SOURCE_UPDATED_META,
  enabledAirlines,
  hubLookupAirlines,
  programTypeOf,
  publicAirlines,
} from "../airlines/registry";
import type { FlightAssignmentRow, UnequippedAssignment } from "../database/database";
import type { Scope, ScopedReader } from "../database/reader";
import {
  COUNTERS,
  type Tags,
  bucketDaysOut,
  metrics,
  normalizeAirlineTag,
  normalizeCarrierPrefix,
  normalizeLegEffect,
  normalizeLegMatch,
  normalizeLegReason,
} from "../observability";
import {
  type CarrierPrediction,
  carrierPrediction,
  carrierPredictionTelemetry,
  predictFlight,
} from "../scripts/starlink-predictor";
import { AIRPORT_COORDS } from "../utils/airport-geo";
import {
  AIRPORT_TZ,
  type FlightDateWindow,
  flightDateWindow,
  matchesLocalDate,
} from "../utils/airport-tz";
import { type FallbackSegment, lookupFlightTailVerdict } from "./flight-verdict";
import { Fr24UnavailableError } from "./flightradar24-api";
import {
  type QatarLeg,
  type QatarVerdict,
  qatarLiveLegs,
  resolveQatarVerdict,
} from "./qatar-verdict";

// flightDateWindow lives in airport-tz next to its partner matchesLocalDate;
// re-exported here so check-flight surfaces keep one import site.
export { flightDateWindow, type FlightDateWindow };

type Prediction = ReturnType<typeof predictFlight>;

// Outage caveat copy shared by the REST and MCP renderers so the two surfaces
// can't drift. FR24_OUTAGE_NOTE replaces "no assignment data / not yet
// published" claims; SWAP_DEGRADED_NOTE qualifies a firm no whose swap
// re-check couldn't run.
export const FR24_OUTAGE_NOTE =
  "We couldn't confirm the aircraft assignment right now — try again shortly.";
// A request-path shed never reached FR24: nothing is down, we just didn't ask.
export const FR24_SHED_NOTE = "Live assignment lookup is busy; showing our estimate.";
export const SWAP_DEGRADED_NOTE =
  "Note: aircraft-swap detection is degraded right now — the live assignment check couldn't run.";

/** The caveat for an estimate served because FR24 wasn't consulted. */
export function fr24DegradedNote(verdict: { fr24Shed?: boolean }): string {
  return verdict.fr24Shed ? FR24_SHED_NOTE : FR24_OUTAGE_NOTE;
}

/**
 * One carrier-resolution decision shared by the flight-number-taking API
 * surfaces it owns — REST /api/check-flight, /api/check-any-flight,
 * /api/predict-flight and MCP check_flight / predict_flight_starlink — whose
 * entry points are renderers over this (404 Response vs tool error). The
 * SEO/permalink routing (resolveFlightCfg in app.ts) is deliberately looser
 * and NOT covered.
 *
 *  - Pinned scope (tenant host / airline MCP scope): a flight number carrying
 *    ANOTHER registered airline's marketing prefix is refused — answering it
 *    under this carrier's branding is the cross-tenant leak. Digits-only,
 *    own-prefix, and operating-carrier (OO/SKW/YX…) numbers proceed.
 *  - Unpinned (hub): detect the marketing carrier across publicly-tracked
 *    airlines; undetectable numbers (incl. digits-only and shared operating
 *    prefixes) fail closed rather than defaulting to any carrier.
 *
 * `pinned: false` tells the caller to swap readers via carrierReader.
 * `not_tracked` carries what a renderer needs (the pinned carrier, if any,
 * and the publicly-tracked list) so renderers don't re-derive policy.
 */
export type CarrierDecision =
  | { outcome: "resolved"; cfg: AirlineConfig; pinned: boolean }
  | {
      outcome: "not_tracked";
      pinnedCfg: AirlineConfig | null;
      tracked: readonly AirlineConfig[];
    };

// Registry is process-static — snapshot the airline lists once.
const ENABLED_AIRLINES: readonly AirlineConfig[] = enabledAirlines();
const PUBLIC_AIRLINES: readonly AirlineConfig[] = publicAirlines();
const HUB_LOOKUP_AIRLINES: readonly AirlineConfig[] = hubLookupAirlines();

/**
 * `pool` picks the unpinned (hub) population: "public" for surfaces that sit
 * beside the fleet model (hub REST check-flight / predict-flight), "lookup"
 * for the cross-carrier lookup surfaces that also answer hubFlightLookup
 * airlines. A pinned scope ignores it — tenant isolation is not pool-shaped.
 */
export function decideCarrier(
  pinnedCfg: AirlineConfig | null,
  flightNumber: string,
  opts: { pool?: "public" | "lookup" } = {}
): CarrierDecision {
  if (pinnedCfg) {
    const marketing = detectMarketingCarrier(flightNumber, ENABLED_AIRLINES);
    if (marketing && marketing.code !== pinnedCfg.code) {
      return { outcome: "not_tracked", pinnedCfg, tracked: PUBLIC_AIRLINES };
    }
    // An unrecognised carrier prefix is not this carrier's flight either.
    // Without this, untracked carriers (DL, AA, B6) fell through to the pinned
    // airline's model and were answered with its priors.
    if (!marketing && !prefixBelongsTo(pinnedCfg, flightNumber)) {
      return { outcome: "not_tracked", pinnedCfg, tracked: PUBLIC_AIRLINES };
    }
    return { outcome: "resolved", cfg: pinnedCfg, pinned: true };
  }
  const pool = opts.pool === "lookup" ? HUB_LOOKUP_AIRLINES : PUBLIC_AIRLINES;
  const cfg = detectMarketingCarrier(flightNumber, pool);
  if (!cfg) return { outcome: "not_tracked", pinnedCfg: null, tracked: pool };
  return { outcome: "resolved", cfg, pinned: false };
}

/** Count a not_tracked lookup by the prefix asked for — every renderer of a
 * not_tracked decision calls this, so REST and MCP demand land in one series. */
export function recordUntrackedLookup(
  flightNumber: string,
  route: "check_flight" | "check_any_flight" | "predict_flight" | "mcp"
): void {
  metrics.increment(COUNTERS.FLIGHT_LOOKUP_UNTRACKED, {
    airline: "unmapped",
    prefix: normalizeCarrierPrefix(flightNumber),
    route,
  });
}

/**
 * Is this a shape a real flight number could take for `cfg`?
 *
 * Exactly `{IATA}` + 1-4 digits. An unbounded number would let callers drive
 * arbitrary FR24 lookups through the public surfaces, and a trailing-letter
 * form (UA4680A) parsed as subfleet "unknown" and returned the express/mainline
 * midpoint for a string that is not a flight number. Shared by the verdict path
 * and /api/predict-flight so the two cannot drift.
 */
export function isPlausibleFlightNumber(cfg: AirlineConfig, normalized: string): boolean {
  // Same shape the permalink router and the sitemap enumerator accept, so the
  // three surfaces cannot drift into advertising a URL no page can answer.
  return CANONICAL_FLIGHT_PERMALINK.test(normalized) && normalized.startsWith(cfg.iata);
}

/** The reader a resolved decision answers from: the pinned scope's own, or a
 * swap to the detected carrier's. Shared by the REST and MCP renderers so the
 * security-relevant swap isn't copy-pasted. */
export function carrierReader(
  decision: Extract<CarrierDecision, { outcome: "resolved" }>,
  pinnedReader: ScopedReader,
  getReader: (scope: Scope) => ScopedReader
): ScopedReader {
  return decision.pinned ? pinnedReader : getReader(decision.cfg.code);
}

/** Why a row landed in the firm-no bucket. */
export type NegativeReason = "settled" | "verified_other";
export type ScheduledNoRow = FlightAssignmentRow & { negativeReason: NegativeReason };

/** Display name for the WiFi a firm-no row actually carries. */
export function negativeWifi(row: ScheduledNoRow): string {
  return wifiLabel(row.negativeReason === "settled" ? row.settled_wifi : row.verified_wifi);
}

/**
 * Provider word for "{x} WiFi" prose. The fleet stores verified_wifi 'None'
 * for no-WiFi tails, which rendered as "None WiFi". A missing value means we
 * know it isn't Starlink but not what it is, so it stays "non-Starlink".
 */
export function wifiLabel(provider: string | null | undefined): string {
  const w = (provider ?? "").trim();
  if (!w) return "non-Starlink";
  return /^none$/i.test(w) ? "no" : w;
}

export type FlightVerdict =
  | { kind: "invalid_date" }
  | { kind: "invalid_flight_number"; normalized: string }
  | (AnsweredVerdict & { leg?: LegResolution });

export type AnsweredVerdict =
  | {
      kind: "scheduled";
      window: FlightDateWindow;
      normalized: string;
      verified: FlightAssignmentRow[];
      unverified: FlightAssignmentRow[];
    }
  | {
      kind: "scheduled_no";
      window: FlightDateWindow;
      normalized: string;
      flights: ScheduledNoRow[];
      /** Swap detection degraded — the firm no stands, but FR24 couldn't be consulted. */
      fr24Error: boolean;
    }
  | { kind: "fr24"; window: FlightDateWindow; normalized: string; starlink: FallbackSegment[] }
  | { kind: "fr24_no"; window: FlightDateWindow; normalized: string; segments: FallbackSegment[] }
  | {
      kind: "no_model";
      window: FlightDateWindow;
      normalized: string;
      /** Registry-driven answer for carriers without a flight-history model. */
      answer: CarrierPrediction;
      fr24Error: boolean;
      /** fr24Error came from our own request-path shed, not from FR24. */
      fr24Shed?: boolean;
    }
  | {
      kind: "prediction";
      window: FlightDateWindow;
      normalized: string;
      pred: Prediction;
      fr24Error: boolean;
      fr24Shed?: boolean;
    }
  | QatarVerdict;

/** Equipped rows merged for display, departure_time ascending. */
export function scheduledFlights(
  verdict: Extract<FlightVerdict, { kind: "scheduled" }>
): FlightAssignmentRow[] {
  return [...verdict.verified, ...verdict.unverified].sort(
    (a, b) => a.departure_time - b.departure_time
  );
}

/** Response-facing confidence label for firm-yes verdicts. */
export function verdictConfidence(
  verdict: Extract<FlightVerdict, { kind: "scheduled" } | { kind: "fr24" }>
): "verified" | "likely" {
  const allVerified =
    verdict.kind === "scheduled"
      ? verdict.unverified.length === 0
      : verdict.starlink.every((s) => s.confidence === "verified");
  return allVerified ? "verified" : "likely";
}

export interface VerdictTelemetry {
  /** type_yes/type_no: answered from a scheduled aircraft TYPE (QR), kept
   * apart from tail-verified answers. */
  outcome:
    | "verified_yes"
    | "verified_no"
    | "type_yes"
    | "type_no"
    | "predicted"
    | "no_data"
    | "error";
  confidence: "high" | "medium" | "low" | "none";
}

/** One outcome/confidence mapping for FLIGHT_LOOKUP_RESULT so REST and MCP tags can't drift. */
export function verdictTelemetry(
  verdict: Exclude<FlightVerdict, { kind: "invalid_date" } | { kind: "invalid_flight_number" }>
): VerdictTelemetry {
  switch (verdict.kind) {
    case "scheduled":
      return {
        outcome: "verified_yes",
        confidence: verdictConfidence(verdict) === "verified" ? "high" : "medium",
      };
    case "scheduled_no":
      return { outcome: "verified_no", confidence: "high" };
    case "fr24":
      return verdictConfidence(verdict) === "verified"
        ? { outcome: "verified_yes", confidence: "high" }
        : { outcome: "predicted", confidence: "medium" };
    case "fr24_no":
      return { outcome: "verified_no", confidence: "medium" };
    case "prediction": {
      const informative = verdict.pred.n_observations > 0;
      return {
        outcome:
          verdict.fr24Error && !verdict.fr24Shed ? "error" : informative ? "predicted" : "no_data",
        confidence: informative ? verdict.pred.confidence : "none",
      };
    }
    case "no_model":
      if (verdict.fr24Error && !verdict.fr24Shed) return { outcome: "error", confidence: "none" };
      return carrierPredictionTelemetry(verdict.answer);
    case "qatar_no_data":
      return { outcome: "no_data", confidence: "none" };
    case "qatar":
      if (verdict.qclass === "yes") return { outcome: "type_yes", confidence: "medium" };
      if (verdict.qclass === "no") return { outcome: "type_no", confidence: "medium" };
      if (verdict.qclass === "cancelled") return { outcome: "no_data", confidence: "none" };
      return { outcome: "predicted", confidence: "low" };
    case "qatar_history":
      return {
        outcome: verdict.probability === null ? "no_data" : "predicted",
        confidence: verdict.grade,
      };
  }
}

export interface ResolveDeps {
  now?: number;
  /** The booking's aircraft type, for carriers whose answer is per programme
   * type (community-source); used only when no tail is known. */
  aircraftType?: string | null;
  /** Override the FR24 reverse lookup; pass null to disable it (hub check-any-flight). */
  lookupTail?: typeof lookupFlightTailVerdict | null;
  predict?: typeof predictFlight;
  /** The traveller's own leg. Absent = every leg of the number (the unscoped answer). */
  leg?: LegQuery;
  /** A leg was asked for but can't be used: answer unscoped and say why. */
  unscoped?: UnscopedLeg;
}

export async function resolveFlightVerdict(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string,
  date: string,
  deps: ResolveDeps = {}
): Promise<FlightVerdict> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const window = flightDateWindow(date, now);
  if (!window) return { kind: "invalid_date" };

  const normalized = ensureAirlinePrefix(cfg, flightNumber);
  if (!isPlausibleFlightNumber(cfg, normalized)) {
    return { kind: "invalid_flight_number", normalized };
  }

  if (cfg.code === "QR") return resolveQatarLeg(reader, normalized, date, window, now, deps);

  const variants = buildAirlineFlightNumberVariants(cfg, normalized);

  // Query is last_updated DESC, so dedupe by departure_time keeps the
  // most-recent row after an aircraft swap; then keep only rows whose
  // departure-airport local date matches the queried date.
  const seen = new Set<number>();
  const onDate = (r: { departure_airport: string; departure_time: number }) =>
    matchesLocalDate(date, r.departure_airport, r.departure_time, window.start, window.end);
  const unequipped = cfg.communitySource
    ? reader.getUnequippedAssignments(variants, window.queryStart, window.queryEnd).filter(onDate)
    : [];
  // Only community carriers poll non-★ tails, so only they can hold a newer
  // non-★ row that supersedes a ★ row for the same departure (a swap).
  const supersededAt = new Map<number, number>();
  for (const u of unequipped) {
    supersededAt.set(
      u.departure_time,
      Math.max(u.last_updated, supersededAt.get(u.departure_time) ?? 0)
    );
  }
  const rows = reader
    .getFlightAssignments(variants, window.queryStart, window.queryEnd)
    .filter((r) => {
      if (seen.has(r.departure_time)) return false;
      seen.add(r.departure_time);
      return true;
    })
    .filter(onDate)
    .filter((r) => r.last_updated >= (supersededAt.get(r.departure_time) ?? 0));

  const leg = deps.leg;
  if (!leg) {
    const { verdict } = await verdictFromRows(
      cfg,
      reader,
      normalized,
      date,
      window,
      rows,
      unequipped,
      deps,
      now
    );
    return deps.unscoped ? { ...verdict, leg: unscopedResolution(deps.unscoped) } : verdict;
  }

  // A leg that matches more than one (origin, destination) pair would mix
  // legs under a scoped label; the honest answer is the unscoped one. One
  // FR24 fetch serves both the scoped attempt and that fallback.
  const shared: ResolveDeps = { ...deps, lookupTail: onceLookup(deps.lookupTail) };
  const unscopedAnswer = async (): Promise<FlightVerdict> => {
    const { verdict } = await verdictFromRows(
      cfg,
      reader,
      normalized,
      date,
      window,
      rows,
      unequipped,
      shared,
      now
    );
    return { ...verdict, leg: unscopedResolution(ambiguousLeg(leg)) };
  };
  const sel = selectLeg(rows, rowDeparture, rowArrival, leg);
  // Community carriers also hold rows for unequipped tails; they scope the same way.
  const unequippedSel = selectLeg(unequipped, rowDeparture, rowArrival, leg);
  if (sel.match === "ambiguous" || unequippedSel.match === "ambiguous") return unscopedAnswer();
  const scoped = await verdictFromRows(
    cfg,
    reader,
    normalized,
    date,
    window,
    sel.items,
    unequippedSel.items,
    shared,
    now,
    leg
  );
  if (scoped.segmentMatch === "ambiguous") return unscopedAnswer();
  const answeredSel: LegSelection<{ departure_airport: string; arrival_airport: string }> =
    sel.items.length > 0 ? sel : unequippedSel;
  const resolution = legResolution(
    leg,
    rows.length + unequipped.length,
    answeredSel,
    otherLegsOf(rows, sel.items, rowDeparture, rowArrival, (r) => ({
      departure_time: r.departure_time,
      tail_number: r.tail_number,
      hasStarlink: rowOutcome(r) === "yes",
    })),
    unscopedRowsOutcome(rows, scoped.segments),
    scoped.answeredSegment
  );
  if (scoped.segmentMatch === "exact" || scoped.segmentMatch === "origin") {
    resolution.segmentMatch = scoped.segmentMatch;
  }
  const liveLegs = scoped.segments ? fr24OtherLegs(scoped.segments, resolution) : [];
  if (liveLegs.length > 0) resolution.liveLegs = liveLegs;

  // The history model is per flight number, so on a through flight whose legs
  // change aircraft it says nothing firm about one leg we couldn't find.
  let verdict = scoped.verdict;
  if (
    verdict.kind === "prediction" &&
    (resolution.match === "no_data" || resolution.match === "unmatched") &&
    isThroughFlightLeg(reader, normalized, leg, now) &&
    changesAircraftEnRoute(reader, normalized, now)
  ) {
    resolution.multiRoute = true;
    verdict = { ...verdict, pred: { ...verdict.pred, confidence: "low" } };
  }
  return { ...verdict, leg: resolution };
}

const RECENT_ROUTES_SEC = 30 * 86400;

/**
 * Recent routes that chain (SFO→DEN + DEN→SAN) mark a through flight; routes
 * that don't (SFO→EWR some days, SFO→IAD others) are alternative routings,
 * where the whole-flight history is still about the traveller's aircraft. The
 * leg counts when it is a chained route or one we have never seen.
 */
function isThroughFlightLeg(
  reader: ScopedReader,
  normalized: string,
  leg: LegQuery,
  now: number
): boolean {
  const routes = reader.getCachedFlightRoutes(normalized, now - RECENT_ROUTES_SEC).map((r) => ({
    origin: normalizeAirportCode(r.origin),
    destination: normalizeAirportCode(r.destination),
  }));
  const chained = routes.filter((r) =>
    routes.some(
      (s) =>
        s !== r &&
        ((r.destination !== null && r.destination === s.origin) ||
          (s.destination !== null && s.destination === r.origin))
    )
  );
  if (chained.length === 0) return false;
  const isLeg = (r: (typeof routes)[number]) =>
    (!leg.origin || r.origin === leg.origin) &&
    (!leg.destination || r.destination === leg.destination);
  const matched = routes.filter(isLeg);
  return matched.length === 0 || matched.some((r) => chained.includes(r));
}

const TAIL_CHANGE_WINDOW_SEC = 60 * 86400;
// Legs of one trip turn within hours; the next day's first leg is overnight.
export const TRIP_GAP_SEC = 6 * 3600;
export const TAIL_CHANGE_MIN_TRIPS = 5;
export const TAIL_CHANGE_RATE_MIN = 0.2;

/**
 * Share of a number's trips (ADS-B departures chained by short turns) flown
 * on more than one tail, or null with too few trips to say. A same-aircraft
 * through flight often rolls up into one draw, and counts as a kept tail.
 */
export function tailChangeRate(
  draws: readonly { tail_number: string; first_seen: number; last_seen: number }[]
): number | null {
  const trips: Set<string>[] = [];
  let lastSeen = Number.NEGATIVE_INFINITY;
  for (const d of [...draws].sort((a, b) => a.first_seen - b.first_seen)) {
    if (d.first_seen - lastSeen > TRIP_GAP_SEC) trips.push(new Set());
    trips[trips.length - 1].add(d.tail_number);
    lastSeen = Math.max(lastSeen, d.last_seen);
  }
  if (trips.length < TAIL_CHANGE_MIN_TRIPS) return null;
  return trips.filter((t) => t.size > 1).length / trips.length;
}

/** No ADS-B evidence either way keeps the cautious answer. */
function changesAircraftEnRoute(reader: ScopedReader, normalized: string, now: number): boolean {
  const rate = tailChangeRate(
    reader.getAdsbFlightDrawsFor(normalized, now - TAIL_CHANGE_WINDOW_SEC)
  );
  return rate === null || rate >= TAIL_CHANGE_RATE_MIN;
}

const segDeparture = (s: FallbackSegment) => normalizeAirportCode(s.origin);
const segArrival = (s: FallbackSegment) => normalizeAirportCode(s.destination);

/** FR24 legs neither answered nor already listed from our rows. */
function fr24OtherLegs(segments: FallbackSegment[], resolution: LegResolution): OtherLeg[] {
  const key = (o: string | null, d: string | null) => `${o}>${d}`;
  const listed = new Set(resolution.otherLegs.map((l) => key(l.origin, l.destination)));
  const answered = resolution.answered
    ? key(resolution.answered.origin, resolution.answered.destination)
    : null;
  return otherLegsOf(
    segments,
    segments.filter((s) => key(segDeparture(s), segArrival(s)) === answered),
    segDeparture,
    segArrival,
    (s) => ({
      departure_time: s.departure_time,
      tail_number: s.tail_number,
      hasStarlink: s.hasStarlink,
    })
  ).filter((l) => !listed.has(key(l.origin, l.destination)));
}

function onceLookup(lookupTail: ResolveDeps["lookupTail"]): ResolveDeps["lookupTail"] {
  if (lookupTail === null) return null;
  const lookup = lookupTail ?? lookupFlightTailVerdict;
  let pending: ReturnType<typeof lookupFlightTailVerdict> | undefined;
  return (...args) => {
    pending ??= lookup(...args);
    return pending;
  };
}

type RowClass = "settled" | "verified_other" | "verified" | "unverified";

// settled_negative (united_fleet 'negative') outranks the spreadsheet row,
// whatever verified_wifi says — same rule as database.ts equippedFilter.
function classifyRow(r: FlightAssignmentRow): RowClass {
  if (r.settled_negative) return "settled";
  if (r.verified_wifi !== null && r.verified_wifi !== "Starlink") return "verified_other";
  if (r.verified_wifi === "Starlink") return "verified";
  return "unverified";
}

function rowOutcome(r: FlightAssignmentRow): "yes" | "no" {
  const c = classifyRow(r);
  return c === "verified" || c === "unverified" ? "yes" : "no";
}

const rowDeparture = (r: { departure_airport: string | null }) =>
  normalizeAirportCode(r.departure_airport);
const rowArrival = (r: { arrival_airport: string | null }) =>
  normalizeAirportCode(r.arrival_airport);

interface RowsAnswer {
  verdict: AnsweredVerdict;
  segments: FallbackSegment[] | null;
  /** How FR24 segments scoped to the leg; "ambiguous" means `verdict` must not be served. */
  segmentMatch?: LegSelection<FallbackSegment>["match"];
  answeredSegment?: FallbackSegment;
}

async function verdictFromRows(
  cfg: AirlineConfig,
  reader: ScopedReader,
  normalized: string,
  date: string,
  window: FlightDateWindow,
  rows: FlightAssignmentRow[],
  unequipped: readonly UnequippedAssignment[],
  deps: ResolveDeps,
  now: number,
  leg?: LegQuery
): Promise<RowsAnswer> {
  const verified: FlightAssignmentRow[] = [];
  const unverified: FlightAssignmentRow[] = [];
  const nonStarlink: ScheduledNoRow[] = [];
  for (const r of rows) {
    const c = classifyRow(r);
    if (c === "settled" || c === "verified_other") {
      nonStarlink.push({ ...r, negativeReason: c });
    } else if (c === "verified") {
      verified.push(r);
    } else {
      unverified.push(r);
    }
  }

  if (verified.length > 0 || unverified.length > 0) {
    return {
      verdict: { kind: "scheduled", window, normalized, verified, unverified },
      segments: null,
    };
  }

  // A community-source carrier's non-equipped tail is still an answer: name
  // it with its guide status, and skip the live lookup that would only find
  // the same tail.
  if (cfg.communitySource) {
    const assigned = assignedFromDb(cfg, reader, unequipped);
    if (assigned) {
      return {
        verdict: { kind: "no_model", window, normalized, answer: assigned, fr24Error: false },
        segments: null,
      };
    }
  }

  // FR24 runs whenever there are no equipped rows: with firm-no rows it can
  // still discover an aircraft swap onto a Starlink tail; with no rows at all
  // it is the primary fallback.
  let fr24Error = false;
  let fr24Shed = false;
  let raw: FallbackSegment[] | null = null;
  let scopedTo: Pick<RowsAnswer, "segmentMatch" | "answeredSegment"> = {};
  if (deps.lookupTail !== null) {
    const lookup = deps.lookupTail ?? lookupFlightTailVerdict;
    try {
      raw = await lookup(reader, normalized, date, window.start, window.end, now);
    } catch (err) {
      // FR24 outage ≠ "no assignment published" — never a confident no.
      // Anything else (e.g. a DB error) must not masquerade as an outage.
      if (!(err instanceof Fr24UnavailableError)) throw err;
      // Not logged here. cachedFlightAssignments caches a rejection for
      // ASSIGNMENT_FAILURE_TTL and replays it to every request in that window,
      // and concurrent requests await the same promise — so a consumer-side log
      // fired 3-4 times per real failure. It is logged once, at the producer,
      // in flight-verdict.ts. The degradation is still visible to the caller
      // via fr24Error -> FR24_OUTAGE_NOTE.
      fr24Error = true;
      fr24Shed = err.message.startsWith("shed:");
    }
    // The FR24 cache holds every leg of the number; scope after the fetch so
    // all legs share one call. An ambiguous selection is the caller's to
    // answer unscoped, never a mix of legs under this leg's label.
    const segSel = raw !== null && leg ? scopeSegments(raw, leg) : null;
    if (segSel) scopedTo = { segmentMatch: segSel.match, answeredSegment: segSel.items[0] };
    const segments = segSel && segSel.match !== "ambiguous" ? segSel.items : raw;
    if (segments !== null) {
      const starlink = segments.filter((s) => s.hasStarlink);
      if (starlink.length > 0) {
        return {
          verdict: { kind: "fr24", window, normalized, starlink },
          segments: raw,
          ...scopedTo,
        };
      }
      const assigned =
        cfg.communitySource && segments.length > 0
          ? assignedFromSegments(cfg, reader, segments)
          : null;
      if (assigned) {
        return {
          verdict: { kind: "no_model", window, normalized, answer: assigned, fr24Error: false },
          segments: raw,
          ...scopedTo,
        };
      }
      // Segments whose tail we know nothing about are not a "no" — only a
      // verified non-Starlink tail is. With our own firm-no rows in hand,
      // prefer those (they carry per-row reasons); otherwise fr24_no.
      if (nonStarlink.length === 0 && segments.some((s) => s.hasStarlink === false)) {
        return {
          verdict: { kind: "fr24_no", window, normalized, segments },
          segments: raw,
          ...scopedTo,
        };
      }
    }
  }

  if (nonStarlink.length > 0) {
    return {
      verdict: { kind: "scheduled_no", window, normalized, flights: nonStarlink, fr24Error },
      segments: raw,
      ...scopedTo,
    };
  }

  // Carriers without a flight-history model get the registry-driven answer
  // (type rules / subfleet penetration) — never another carrier's priors.
  if (!cfg.flightHistoryModel) {
    return {
      verdict: {
        kind: "no_model",
        window,
        normalized,
        answer: carrierPrediction(cfg, reader, normalized, { aircraftType: deps.aircraftType }),
        fr24Error,
        ...(fr24Shed ? { fr24Shed } : {}),
      },
      segments: raw,
      ...scopedTo,
    };
  }

  const predict = deps.predict ?? predictFlight;
  return {
    verdict: {
      kind: "prediction",
      window,
      normalized,
      pred: predict(reader, normalized),
      fr24Error,
      ...(fr24Shed ? { fr24Shed } : {}),
    },
    segments: raw,
    ...scopedTo,
  };
}

function scopeSegments(segments: FallbackSegment[], leg: LegQuery): LegSelection<FallbackSegment> {
  return selectLeg(segments, segDeparture, segArrival, leg);
}

/** What the unscoped engine would have answered from the same rows and FR24 fetch. */
function unscopedRowsOutcome(
  rows: FlightAssignmentRow[],
  segments: FallbackSegment[] | null
): LegOutcome {
  const outcomes = rows.map(rowOutcome);
  if (outcomes.includes("yes")) return "yes";
  if (segments?.some((s) => s.hasStarlink)) return "yes";
  if (outcomes.length > 0) return "no";
  if (segments?.some((s) => s.hasStarlink === false)) return "no";
  return "none";
}

type AssignedAnswer = Extract<
  CarrierPrediction,
  { kind: "assigned_unconfirmed" } | { kind: "partner_operated" }
>;

function assignedFromDb(
  cfg: AirlineConfig,
  reader: ScopedReader,
  unequipped: readonly UnequippedAssignment[]
): AssignedAnswer | null {
  // Before the first guide sync every tail would read "not yet listed".
  const guideUpdated = reader.getMeta(COMMUNITY_SOURCE_UPDATED_META);
  const row = unequipped[0];
  if (!guideUpdated || !row) return null;
  return {
    kind: "assigned_unconfirmed",
    tail: row.tail_number,
    aircraftType: row.aircraft_type,
    programLabel: programTypeOf(cfg, row.aircraft_type).label,
    mark: row.mark,
    guideUpdated,
  };
}

// FR24's tail, which resolveTailVerdict could not place: ours (not on the
// Starlink list) or another airline's metal on a codeshare.
function assignedFromSegments(
  cfg: AirlineConfig,
  reader: ScopedReader,
  segments: readonly FallbackSegment[]
): AssignedAnswer | null {
  const own = segments.find((s) => cfg.tailPattern.test(s.tail_number));
  if (!own) return { kind: "partner_operated", tail: segments[0].tail_number };
  const guideUpdated = reader.getMeta(COMMUNITY_SOURCE_UPDATED_META);
  if (!guideUpdated) return null;
  const guide = reader.getFleetGuideTails().find((t) => t.tail === own.tail_number);
  const aircraftType = guide?.aircraftType ?? own.aircraft_model;
  return {
    kind: "assigned_unconfirmed",
    tail: own.tail_number,
    aircraftType,
    programLabel: programTypeOf(cfg, aircraftType).label,
    mark: guide?.mark ?? null,
    guideUpdated,
  };
}

/**
 * QR answers per type, so a leg scopes the live legs the verdict is built
 * from; history beyond the published window stays flight-number level.
 */
function resolveQatarLeg(
  reader: ScopedReader,
  normalized: string,
  date: string,
  window: FlightDateWindow,
  now: number,
  deps: ResolveDeps
): FlightVerdict {
  const leg = deps.leg;
  if (!leg) {
    const verdict = resolveQatarVerdict(reader, normalized, date, window, now);
    return deps.unscoped ? { ...verdict, leg: unscopedResolution(deps.unscoped) } : verdict;
  }
  const rows = qatarLiveLegs(reader, normalized, date, window);
  const unscoped = resolveQatarVerdict(reader, normalized, date, window, now, rows);
  const dep = (r: QatarLeg) => normalizeAirportCode(r.departure_airport);
  const arr = (r: QatarLeg) => normalizeAirportCode(r.arrival_airport);
  const sel = selectLeg(rows, dep, arr, leg);
  if (sel.match === "ambiguous") return { ...unscoped, leg: unscopedResolution(ambiguousLeg(leg)) };
  return {
    ...resolveQatarVerdict(reader, normalized, date, window, now, sel.items),
    leg: legResolution(
      leg,
      rows.length,
      sel,
      otherLegsOf(rows, sel.items, dep, arr, (r) => ({
        departure_time: r.departure_time,
        tail_number: null,
        hasStarlink: r.klass === "yes" ? true : r.klass === "no" ? false : null,
      })),
      verdictOutcome(unscoped)
    ),
  };
}

// ── leg scoping ──────────────────────────────────────────────────────────────
//
// Google Flights (and any client that knows the itinerary) can name the
// traveller's own leg of a multi-leg flight number. Without it, a sibling
// leg's Starlink tail answered "yes" for a leg flown by a different aircraft.
// Everything here is inert when no leg is passed: the no-param answer is the
// same bytes as before leg scoping existed.

export interface LegQuery {
  origin?: string;
  destination?: string;
}

export type UnscopedReason = "invalid_airport" | "same_airport" | "no_timezone" | "ambiguous_leg";

export interface UnscopedLeg {
  reason: UnscopedReason;
  origin: string | null;
  destination: string | null;
}

export type LegParse =
  | { leg: LegQuery; unscoped?: undefined }
  | { leg: undefined; unscoped?: UnscopedLeg };

export type LegMatch = "exact" | "origin" | "unmatched" | "no_data" | "unscoped";
export type LegOutcome = "yes" | "no" | "none";

export interface OtherLeg {
  origin: string;
  destination: string | null;
  departure_time: number | null;
  tail_number: string | null;
  hasStarlink: boolean | null;
}

export interface LegResolution {
  origin: string | null;
  destination: string | null;
  /** From our own rows only — FR24 never changes it, so every host agrees. */
  match: LegMatch;
  reason?: UnscopedReason;
  /**
   * Other legs of this number we hold assignments for. Best-effort: only
   * tracked tails have rows, so this is never a complete itinerary.
   */
  otherLegs: OtherLeg[];
  /** Internal from here down, never serialized. FR24 legs not in otherLegs, for copy only. */
  liveLegs?: OtherLeg[];
  /** An FR24 segment answered the leg: the telemetry `match` (the wire's stays rows-only). */
  segmentMatch?: "exact" | "origin";
  /** A leg we couldn't find on a through flight (chained recent routes): confidence is low. */
  multiRoute?: boolean;
  /** The (origin, destination) the answer is about. */
  answered: { origin: string | null; destination: string | null } | null;
  /** What the unscoped engine would have said — telemetry only, never serialized. */
  unscopedOutcome: LegOutcome;
}

/**
 * Canonical IATA for a leg endpoint, or null. 4-letter K/P codes are the
 * US/Alaska/Hawaii/Pacific ICAO forms (KSFO, PANC, PHNL, PGUM) and are only
 * mapped when the result is an airport we know, so an arbitrary 4-letter
 * string can't become a real code. Request params, our rows and FR24
 * segments all pass through this, so both sides compare identically.
 */
export function normalizeAirportCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) return code;
  if (/^[KP][A-Z]{3}$/.test(code) && AIRPORT_TZ[code.slice(1)]) return code.slice(1);
  return null;
}

// Reflected back in `leg`; bounded so a caller can't echo arbitrary text.
const echo = (raw: string): string => raw.toUpperCase().slice(0, 4);

/**
 * Lenient by design: bad input never errors. It answers unscoped and says why,
 * because the extension caches a 400 as a settled answer for its full TTL, and
 * a caller that sent stray params before this existed got an answer then.
 */
export function parseLegQuery(origin: string | null, destination: string | null): LegParse {
  const o = origin?.trim() ?? "";
  const d = destination?.trim() ?? "";
  if (!o && !d) return { leg: undefined };

  const no = o ? normalizeAirportCode(o) : null;
  const nd = d ? normalizeAirportCode(d) : null;
  const echoed = {
    origin: o ? (no ?? echo(o)) : null,
    destination: d ? (nd ?? echo(d)) : null,
  };
  if ((o && !no) || (d && !nd)) {
    return { leg: undefined, unscoped: { reason: "invalid_airport", ...echoed } };
  }
  if (no && no === nd) return { leg: undefined, unscoped: { reason: "same_airport", ...echoed } };
  // Origin drives the local-date window; without its zone a scoped answer
  // could be the previous evening's tail labelled as exact. A code we know
  // nothing about at all is unrecognized rather than zone-less.
  if (no && !AIRPORT_TZ[no]) {
    const reason = AIRPORT_COORDS[no] ? "no_timezone" : "invalid_airport";
    return { leg: undefined, unscoped: { reason, ...echoed } };
  }
  return {
    leg: { ...(no ? { origin: no } : {}), ...(nd ? { destination: nd } : {}) },
  };
}

/**
 * A surface's deps plus the parsed leg. With no leg asked for it returns
 * `base` itself — the very object (or undefined) passed before leg scoping —
 * so the no-param answer cannot drift.
 */
export function withLeg<T extends ResolveDeps | undefined>(
  base: T,
  parsed: LegParse
): T | ResolveDeps {
  if (parsed.leg) return { ...base, leg: parsed.leg };
  if (parsed.unscoped) return { ...base, unscoped: parsed.unscoped };
  return base;
}

export interface LegSelection<T> {
  items: T[];
  match: "exact" | "origin" | "ambiguous" | null;
}

/**
 * The items belonging to one leg. Getters return normalizeAirportCode output;
 * an item with no departure never matches a requested origin.
 *
 *  - origin then destination narrow the set; a non-empty result spanning one
 *    (dep, arr) pair is "exact".
 *  - origin + destination with no arrival match falls back to the origin's
 *    leg ("origin"): a diversion, a stale arrival code, or a whole-journey
 *    request whose later hops we hold nothing for.
 *  - a whole-journey request like SFO→SAN on SFO→DEN→SAN, where another
 *    item does arrive at the destination, spans legs that can fly different
 *    tails: "ambiguous", never the first hop answered as the whole trip.
 *  - anything spanning several pairs is "ambiguous" and selects nothing,
 *    so legs are never mixed under one label.
 */
export function selectLeg<T>(
  items: readonly T[],
  dep: (t: T) => string | null,
  arr: (t: T) => string | null,
  leg: LegQuery
): LegSelection<T> {
  const pairCount = (xs: T[]) => new Set(xs.map((t) => `${dep(t)}>${arr(t)}`)).size;
  const byOrigin = leg.origin ? items.filter((t) => dep(t) === leg.origin) : [...items];
  const byBoth = leg.destination ? byOrigin.filter((t) => arr(t) === leg.destination) : byOrigin;
  if (byBoth.length > 0) {
    return pairCount(byBoth) > 1
      ? { items: [], match: "ambiguous" }
      : { items: byBoth, match: "exact" };
  }
  if (leg.origin && leg.destination && byOrigin.length > 0) {
    const continues = items.some((t) => arr(t) === leg.destination);
    return continues || pairCount(byOrigin) > 1
      ? { items: [], match: "ambiguous" }
      : { items: byOrigin, match: "origin" };
  }
  return { items: [], match: null };
}

function ambiguousLeg(leg: LegQuery): UnscopedLeg {
  return {
    reason: "ambiguous_leg",
    origin: leg.origin ?? null,
    destination: leg.destination ?? null,
  };
}

function unscopedResolution(u: UnscopedLeg): LegResolution {
  return {
    origin: u.origin,
    destination: u.destination,
    match: "unscoped",
    reason: u.reason,
    otherLegs: [],
    answered: null,
    unscopedOutcome: "none",
  };
}

function otherLegsOf<T>(
  all: readonly T[],
  selected: readonly T[],
  dep: (t: T) => string | null,
  arr: (t: T) => string | null,
  detail: (t: T) => Omit<OtherLeg, "origin" | "destination">
): OtherLeg[] {
  const key = (t: T) => `${dep(t)}>${arr(t)}`;
  const answered = new Set(selected.map(key));
  const seen = new Set<string>();
  const legs: OtherLeg[] = [];
  // Sorted before the dedupe so a pair with several rows shows its earliest.
  const byDeparture = all
    .map((t) => ({ t, d: detail(t) }))
    .sort((a, b) => (a.d.departure_time ?? 0) - (b.d.departure_time ?? 0));
  for (const { t, d } of byDeparture) {
    const origin = dep(t);
    if (!origin || answered.has(key(t)) || seen.has(key(t))) continue;
    seen.add(key(t));
    legs.push({ origin, destination: arr(t), ...d });
  }
  return legs;
}

function legResolution<T>(
  leg: LegQuery,
  rowCount: number,
  sel: LegSelection<T>,
  otherLegs: OtherLeg[],
  unscopedOutcome: LegOutcome,
  answeredSegment?: FallbackSegment
): LegResolution {
  const match: LegMatch =
    sel.match === "exact" || sel.match === "origin"
      ? sel.match
      : rowCount > 0
        ? "unmatched"
        : "no_data";
  const first = sel.items[0] as
    | { departure_airport?: string | null; arrival_airport?: string | null }
    | undefined;
  return {
    origin: leg.origin ?? null,
    destination: leg.destination ?? null,
    match,
    otherLegs,
    answered: first
      ? {
          origin: normalizeAirportCode(first.departure_airport),
          destination: normalizeAirportCode(first.arrival_airport),
        }
      : answeredSegment
        ? {
            origin: normalizeAirportCode(answeredSegment.origin),
            destination: normalizeAirportCode(answeredSegment.destination),
          }
        : null,
    unscopedOutcome,
  };
}

/** yes/no/none for the answer actually served — the `to` side of the leg-scope effect. */
export function verdictOutcome(verdict: AnsweredVerdict): LegOutcome {
  switch (verdict.kind) {
    case "scheduled":
    case "fr24":
      return "yes";
    case "scheduled_no":
    case "fr24_no":
      return "no";
    case "qatar":
      return verdict.hasStarlink === true ? "yes" : verdict.hasStarlink === false ? "no" : "none";
    default:
      return "none";
  }
}

/** Raw FLIGHT_LEG_SCOPE tag values (normalized by the metrics allowlists). */
export function legScopeTelemetry(verdict: AnsweredVerdict & { leg: LegResolution }): {
  match: LegMatch;
  reason: string;
  effect: string;
} {
  const from = verdict.leg.match === "unscoped" ? "none" : verdict.leg.unscopedOutcome;
  const to = verdict.leg.match === "unscoped" ? "none" : verdictOutcome(verdict);
  const rowsMissed = verdict.leg.match === "unmatched" || verdict.leg.match === "no_data";
  return {
    match: rowsMissed ? (verdict.leg.segmentMatch ?? verdict.leg.match) : verdict.leg.match,
    reason: verdict.leg.reason ?? "none",
    effect: from === to ? "same" : `${from}_to_${to}`,
  };
}

/**
 * FLIGHT_LEG_SCOPE for REST and MCP alike. days_out is the tag that matters:
 * firm corrections only exist where assignment data does (~0-3 days out), so
 * the 4+ day population reads as `same` by design.
 */
export function recordLegScope(
  endpoint: "api_check" | "api_check_any" | "mcp",
  verdict: AnsweredVerdict & { leg?: LegResolution },
  airlineCode: string,
  clientTags: Tags
): void {
  if (!verdict.leg) return;
  const t = legScopeTelemetry({ ...verdict, leg: verdict.leg });
  metrics.increment(COUNTERS.FLIGHT_LEG_SCOPE, {
    endpoint,
    airline: normalizeAirlineTag(airlineCode),
    match: normalizeLegMatch(t.match),
    reason: normalizeLegReason(t.reason),
    effect: normalizeLegEffect(t.effect),
    days_out: bucketDaysOut(verdict.window.daysOut),
    ...clientTags,
  });
}

/** The additive `leg` wire field; `{}` when no leg was asked for. */
export function legField(verdict: { leg?: LegResolution }): {
  leg?: {
    origin: string | null;
    destination: string | null;
    match: LegMatch;
    reason?: UnscopedReason;
    otherLegs: OtherLeg[];
  };
} {
  const l = verdict.leg;
  if (!l) return {};
  return {
    leg: {
      origin: l.origin,
      destination: l.destination,
      match: l.match,
      ...(l.reason ? { reason: l.reason } : {}),
      otherLegs: l.otherLegs,
    },
  };
}

const UNSCOPED_WORDS: Record<UnscopedReason, string> = {
  invalid_airport: "unrecognized airport code",
  same_airport: "origin and destination are the same",
  no_timezone: "no timezone on file for that airport",
  ambiguous_leg: "that matches more than one leg",
};

const pairLabel = (origin: string | null | undefined, destination: string | null | undefined) =>
  destination ? `${origin ?? "?"} → ${destination}` : `from ${origin ?? "?"}`;

/** "SFO → DEN" for the leg the answer is actually about, which may not be the one asked for. */
export function legLabel(leg: LegResolution): string {
  return pairLabel(
    leg.answered?.origin ?? leg.origin,
    leg.answered?.destination ?? leg.destination
  );
}

// "SFO → DEN leg", or "leg from SFO" when only the origin was sent.
const requestedLeg = (leg: LegResolution) =>
  leg.destination
    ? `${pairLabel(leg.origin, leg.destination)} leg`
    : `leg from ${leg.origin ?? "?"}`;

/**
 * The answer is about a different leg than the one requested: an "origin"
 * fallback from our rows or from FR24. Its copy names the answered leg, and
 * it offers no same-day alternatives, which would be for that hop alone.
 */
export function answersOtherLeg(leg: LegResolution | undefined): boolean {
  return !!leg?.answered && !!leg.destination && leg.answered.destination !== leg.destination;
}

function isScopedMatch(leg: LegResolution | undefined): leg is LegResolution {
  if (leg?.match === "no_data") return leg.answered !== null;
  return leg?.match === "exact" || leg?.match === "origin" || leg?.match === "unmatched";
}

/** "UA540 SFO → DEN" when the answer is about one leg, else just the number. */
export function legSubject(verdict: { normalized: string; leg?: LegResolution }): string {
  return isScopedMatch(verdict.leg)
    ? `${verdict.normalized} ${legLabel(verdict.leg)}`
    : verdict.normalized;
}

/** "UA540 SFO → DEN: " prefix for firm-yes copy; "" when unscoped. */
export function legPrefix(verdict: { normalized: string; leg?: LegResolution }): string {
  return isScopedMatch(verdict.leg) ? `${legSubject(verdict)}: ` : "";
}

// Every leg we see the number flying, by departure.
const flownLegs = (l: LegResolution): OtherLeg[] =>
  [...l.otherLegs, ...(l.liveLegs ?? [])].sort(
    (a, b) => (a.departure_time ?? 0) - (b.departure_time ?? 0)
  );

// "RDU → ORD → IAH" when the legs connect, else "SFO → DEN, LAX → ORD".
function routeChain(legs: OtherLeg[]): string {
  const connected = legs.every((l, i) => i === 0 || legs[i - 1].destination === l.origin);
  if (connected) return [legs[0].origin, ...legs.map((l) => l.destination ?? "?")].join(" → ");
  return legs.map((l) => pairLabel(l.origin, l.destination)).join(", ");
}

/**
 * An estimate for a leg we can't find on a number we do see flying other legs
 * that day. Its note names those legs, so renderers drop "assignment not yet
 * published", which those very legs contradict.
 */
export function legOffRoute(verdict: AnsweredVerdict & { leg?: LegResolution }): boolean {
  const l = verdict.leg;
  return (
    (verdict.kind === "prediction" || verdict.kind === "no_model") &&
    (l?.match === "unmatched" || l?.match === "no_data") &&
    l.answered === null &&
    flownLegs(l).length > 0
  );
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The one sentence a leg adds to an answer's copy, or "". A prediction stays
 * at flight-number level, so a leg we hold no row for says so rather than
 * implying the estimate is about that leg.
 */
export function legNote(verdict: AnsweredVerdict & { leg?: LegResolution }): string {
  const l = verdict.leg;
  if (!l) return "";
  if (l.match === "unscoped") {
    return `Couldn't scope to one leg (${UNSCOPED_WORDS[l.reason ?? "invalid_airport"]}); this answer covers every leg of ${verdict.normalized}.`;
  }
  if (verdict.kind === "prediction" || verdict.kind === "no_model") {
    const fn = verdict.normalized;
    const overall = l.multiRoute
      ? `this estimate is for flight ${fn} overall, a through flight whose legs can fly different aircraft, so it's low confidence for any one leg.`
      : `this estimate is for flight ${fn} overall.`;
    if (legOffRoute(verdict)) {
      return `We have no ${requestedLeg(l)} for ${fn} on this date; we see it flying ${routeChain(flownLegs(l))}. ${capitalized(overall)}`;
    }
    if (l.otherLegs.length > 0) {
      return `Your ${requestedLeg(l)} isn't in our assignment data yet; ${overall}`;
    }
    if (l.multiRoute) return capitalized(overall);
  }
  if (answersOtherLeg(l)) {
    return `We hold no ${requestedLeg(l)} for ${verdict.normalized}; this answer is for its ${legLabel(l)} leg only.`;
  }
  return "";
}

/** `base` plus the leg sentence, if any — byte-identical to `base` without a leg. */
export function withLegNote(
  base: string,
  verdict: AnsweredVerdict & { leg?: LegResolution }
): string {
  const note = legNote(verdict);
  return note ? `${base} ${note}` : base;
}
