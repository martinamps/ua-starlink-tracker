/**
 * Airline-scoped data access. Minted per-scope; consumers receive ONLY this
 * reader, never the raw Database. Every method has the airline filter baked
 * in, so a UA-host request cannot see HA/QR rows even if a caller forgets to
 * filter. Lives in database/ so api/, scripts/, and server/ can all depend on
 * it without crossing into the HTTP layer.
 */

import type { Database } from "bun:sqlite";
import {
  AIRLINES,
  type AirlineCode,
  airlineHomeUrl,
  publicAirlines,
  uiAccent,
  withOperatingPartners,
} from "../airlines/registry";
import type {
  Aircraft,
  AircraftTypePageData,
  AirportDepartures,
  FirstFlight,
  FleetDiscoveryStats,
  FleetPageData,
  FleetStats,
  Flight,
  PerAirlineStat,
  RecentInstall,
  RouteSchedule,
} from "../types";
import { memo } from "../utils/ttl-cache";
import {
  type AdsbFlightDraw,
  getAdsbFlightDraws,
  getAdsbFlightDrawsFor,
} from "./adsb-flight-draws";
import {
  type AssignmentLogRow,
  type ResolvedLeg,
  type SameDayAlternative,
  type SameDayAlternativesQuery,
  getAssignmentHistory,
  getSameDayStarlinkAlternatives,
  logResolvedAssignments,
} from "./assignment-log";
import {
  type ConfirmedEdge,
  type DepartureSlot,
  type DepartureSlotQuery,
  type DirectRouteEdge,
  type FleetGuideTail,
  type FleetRosterEntry,
  type FlightAssignmentRow,
  type FlightHistorySummary,
  type FlightRoutePair,
  type HubAirlineStat,
  type PopularFlight,
  type QatarHistoryRow,
  type QatarScheduleRow,
  type RouteDepartureRow,
  type RouteEntryRow,
  type RouteFlightNumbers,
  type RouteFlightRow,
  type RouteGraphEdge,
  type RouteSummary,
  type SitemapFlight,
  type SitemapRoute,
  type SubfleetPenetration,
  type TypeProgress,
  type UnequippedAssignment,
  type VerificationObservation,
  type VerificationSource,
  type WifiConsensus,
  type WifiMismatch,
  airlineServesAirports,
  bumpDiscoveryPriority,
  cacheFlightRoute,
  computeWifiConsensus,
  countStarlinkPlanes,
  flightNumberHasData,
  getAircraftTypeGate,
  getAircraftTypePageData,
  getAirlineByTail,
  getAirportDepartures,
  getCachedFlightRoutes,
  getConfirmedFleetTails,
  getConfirmedStarlinkEdges,
  getDailyInstalls,
  getDepartureSlots,
  getDirectRouteEdge,
  getFirstFlights,
  getFleetAnchors,
  getFleetDiscoveryStats,
  getFleetEntryByTail,
  getFleetGuideTails,
  getFleetPageData,
  getFleetRoster,
  getFleetStats,
  getFlightAssignments,
  getFlightHistorySummary,
  getFlightRoutePairs,
  getHubStats,
  getLastUpdated,
  getMeta,
  getObservationAnchor,
  getObservedDirectFlightNumbers,
  getPendingFleetTails,
  getPopularFlights,
  getQatarEquipmentHistory,
  getQatarEquipmentHistoryByWindow,
  getQatarFetchCoverage,
  getQatarHistoryRoutes,
  getQatarScheduleByFlight,
  getQatarScheduleByRoute,
  getQatarScheduleStats,
  getRankedStarlinkRoutePairs,
  getRecentInstalls,
  getRouteDepartures,
  getRouteFlightNumbers,
  getRouteFlights,
  getRouteGraphEdges,
  getRouteStarlinkSchedule,
  getRouteSummary,
  getRoutesForFlightVariants,
  getServedRoutePairs,
  getSitemapFlights,
  getSitemapRoutes,
  getStarlinkPlaneByTail,
  getStarlinkPlanes,
  getSubfleetPenetration,
  getTotalCount,
  getTypeProgress,
  getUnequippedAssignments,
  getUpcomingFlights,
  getVerificationObservations,
  getVerificationSummary,
  getWifiMismatches,
  routeHasData,
  routeIsHistorical,
} from "./database";
import { getRouteFlightLastSeen } from "./route-history";

export type { Database };

/**
 * The 48h departure aggregates rebuild the whole slot table (~15ms for UA on
 * production data) and back the homepage, /routes and the planner hub. The
 * schedule refreshes every 22.5s per tail, so a minute of staleness is
 * invisible and keeps the build off the request path.
 */
const DEPARTURE_AGGREGATE_MEMO = { ttlSec: 60, maxEntries: 64 };

export type Scope = AirlineCode | "ALL";

export interface ScopedReader {
  readonly scope: Scope;
  /** Airline codes covered by this reader (single-element for per-airline hosts, enabled set for hub). */
  readonly airlines: readonly AirlineCode[];
  getStarlinkPlanes(): Aircraft[];
  /** Equipped-tail count without hydrating the roster — for callers that only
   * wanted `.length` (the install/badge gates, on every HTML render). */
  countStarlinkPlanes(): number;
  getAirlineByTail(): Record<string, string>;
  getRecentInstalls(limit?: number, perAirlineCap?: number): RecentInstall[];
  /** First observed post-install revenue departures for the given tails (sparse). */
  getFirstFlights(tails: readonly string[]): FirstFlight[];
  /** Organic installs per calendar day (labelled bulk seeds excluded); ascending. */
  getDailyInstalls(): { day: string; installs: number }[];
  getPerAirlineStats(): PerAirlineStat[];
  getUpcomingFlights(tailNumber?: string): Flight[];
  /** Per-airline subfleet split; null on the hub (no cross-airline aggregate exists). */
  getFleetStats(): FleetStats | null;
  /** Typed airframe roster; empty on the hub (no cross-airline roster exists). */
  getFleetRoster(): FleetRosterEntry[];
  getTotalCount(): number;
  getLastUpdated(): string;
  /** Raw lastUpdated stamp — null when never stamped. getLastUpdated's now()
   * fallback is fine for display copy but would let sitemaps stamp request
   * time; freshness surfaces must use this and omit the field when null. */
  getLastUpdatedRaw(): string | null;
  /** Flight permalinks worth advertising, with real per-flight lastmod; empty on the hub (permalinks are tenant pages). */
  getSitemapFlights(): SitemapFlight[];
  /** Most-observed flight numbers for "popular flights" link blocks; empty on the hub (permalinks are tenant pages). */
  getPopularFlights(limit?: number): PopularFlight[];
  /** Officially-reported fleet/Starlink figures (SEC filings) for this scope. */
  getFleetAnchors(): ReturnType<typeof getFleetAnchors>;
  /** Route permalinks worth advertising, with real per-route lastmod; empty on the hub (route pages are tenant pages). */
  getSitemapRoutes(): SitemapRoute[];
  /** Meta keys are namespaced per-airline; null on the hub (no single namespace). */
  getMeta(key: string): string | null;
  /** Check-flight assignments without the verified_wifi filter (the core classifies tiers).
   * The one read that also spans operatingPartners (AS numbers on HA metal). */
  getFlightAssignments(
    variants: string[],
    startOfDay: number,
    endOfDay: number
  ): FlightAssignmentRow[];
  /** Assigned tails that are on the roster but not equipped (community-source
   * airlines name them instead of discarding them). */
  getUnequippedAssignments(
    variants: readonly string[],
    startOfDay: number,
    endOfDay: number
  ): UnequippedAssignment[];
  /** Equipped/total per programme type; single-airline scope only. */
  getTypeProgress(): TypeProgress[];
  /** Roster plus guide-only tails with their guide marks; single-airline scope only. */
  getFleetGuideTails(): FleetGuideTail[];
  getFleetPageData(): FleetPageData;
  /** Physical departures in a window, newest row per slot, with the equipped
   * test the headline counts use. `partners` adds operatingPartners' rows that
   * carry this scope's marketed numbers. */
  getDepartureSlots(q: DepartureSlotQuery): DepartureSlot[];
  getAirportDepartures(): AirportDepartures;
  getRouteStarlinkSchedule(): RouteSchedule;
  /** Route pairs in getRouteStarlinkSchedule order, past `offset`. */
  getRankedStarlinkRoutePairs(
    offset: number,
    limit: number
  ): Array<{ origin: string; destination: string }>;
  getFleetDiscoveryStats(): FleetDiscoveryStats;
  getConfirmedFleetTails(): ReturnType<typeof getConfirmedFleetTails>;
  getPendingFleetTails(): ReturnType<typeof getPendingFleetTails>;
  getVerificationSummary(): ReturnType<typeof getVerificationSummary>;
  getWifiMismatches(): WifiMismatch[];

  // Predictor / route-graph
  getVerificationObservations(): VerificationObservation[];
  /** ADS-B departures since `sinceTs`. UA only: the callsign-to-marketing-number
   * mapping and the fleet sweep behind it exist for no other scope. */
  getAdsbFlightDraws(sinceTs: number): AdsbFlightDraw[];
  /** getAdsbFlightDraws for one flight number, by departure. UA only. */
  getAdsbFlightDrawsFor(flightNumber: string, sinceTs: number): AdsbFlightDraw[];
  getRouteFlights(origin: string | null, destination: string | null): RouteFlightRow[];
  getRouteGraphEdges(): RouteGraphEdge[];
  /** Every ORIG-DEST the carrier flies; null when no route census exists for the scope. */
  getServedRoutePairs(): ReadonlySet<string> | null;
  getConfirmedStarlinkEdges(queryStart: number, queryEnd: number): ConfirmedEdge[];
  airlineServesAirports(prefixes: readonly string[], ...airports: string[]): boolean;
  getSubfleetPenetration(): Map<string, SubfleetPenetration>;
  getObservedDirectFlightNumbers(
    prefixes: readonly string[],
    origin: string,
    destination: string
  ): string[];
  getDirectRouteEdge(origin: string, destination: string): DirectRouteEdge | null;

  // flight_routes cache (airline-agnostic; PK carries IATA prefix)
  getCachedFlightRoutes(flightNumber: string, freshAfter: number): RouteEntryRow[];
  cacheFlightRoute(
    flightNumber: string,
    origin: string,
    destination: string,
    durationSec: number | null
  ): void;
  getRoutesForFlightVariants(
    variants: string[]
  ): { departure_airport: string; arrival_airport: string; dur_sec: number }[];

  // Flight-permalink SSR: existence gate + observed history + route census.
  flightNumberHasData(variants: string[]): boolean;
  /** Existence gate for /route-planner/{origin}/{destination}; mirrors getSitemapRoutes. */
  routeHasData(origin: string, destination: string): boolean;
  /** Unseen for ROUTE_NOINDEX_STALE_DAYS — the route page goes noindex. */
  routeIsHistorical(origin: string, destination: string): boolean;
  getRouteSummary(origin: string, destination: string): RouteSummary;
  /** Equipped departures on the pair in the next 48h, under their marketed numbers. */
  getRouteDepartures(origin: string, destination: string): RouteDepartureRow[];
  /** Marketing numbers on a pair without getRouteSummary's windowed departure
   * counts — what the flight permalinks' sibling links actually need. */
  getRouteFlightNumbers(origin: string, destination: string): RouteFlightNumbers;
  /** Newest route-cache sighting per marketing number on a pair (unix sec). */
  getRouteFlightLastSeen(origin: string, destination: string): Map<string, number>;
  getFlightHistorySummary(variants: string[]): FlightHistorySummary;
  getFlightRoutePairs(variants: string[]): FlightRoutePair[];
  /** Newest observation for the airline (unix sec), the reference point for
   * staleness copy; 0 on the hub or with no data. */
  getObservationAnchor(): number;

  // Single-tail lookups + best-effort writes. Airline-scoped like everything
  // else: a tenant's FR24 fallback must not resolve another airline's tail.
  getStarlinkPlaneByTail(
    tail: string
  ): { Aircraft: string; OperatedBy: string; fleet: string } | null;
  getFleetEntryByTail(
    tail: string
  ): { starlink_status: string; verified_wifi: string | null; verified_at: number | null } | null;
  computeWifiConsensus(
    tail: string,
    opts?: { sources?: readonly VerificationSource[] }
  ): WifiConsensus;
  bumpDiscoveryPriority(tail: string): void;

  // Qatar uses a separate schedule cache (per-flight equipment, no per-tail).
  // These are airline-agnostic on the reader because qatar_schedule has no
  // airline column — it's QR-only by definition. Handlers gate on cfg.code.
  getQatarScheduleByFlight(
    variants: string[],
    startOfDay: number,
    endOfDay: number
  ): QatarScheduleRow[];
  getQatarScheduleByRoute(
    origin: string,
    destination: string,
    startOfDay: number,
    endOfDay: number
  ): QatarScheduleRow[];
  /** Every tail the updater has seen on the flight's local date (Starlink Watch). */
  getAssignmentHistory(variants: readonly string[], depDate: string): AssignmentLogRow[];
  getSameDayStarlinkAlternatives(q: SameDayAlternativesQuery): SameDayAlternative[];
  logResolvedAssignments(flightNumber: string, legs: readonly ResolvedLeg[], now: number): void;

  getQatarScheduleStats(): {
    total: number;
    starlink: number;
    rolling: number;
    none: number;
    lastUpdated: number | null;
  };

  /** /fleet/{slug} page data; null on the hub and for types without a page. */
  getAircraftTypePage(slug: string): AircraftTypePageData | null;
  /** Existence + Starlink count for the served gate, without the full page pass. */
  getAircraftTypeGate(slug: string): { total: number; starlink: number } | null;

  // QR equipment history + fetch coverage; airline-agnostic like qatar_schedule.
  getQatarEquipmentHistory(
    variants: readonly string[],
    sinceDate: string,
    untilDate: string
  ): QatarHistoryRow[];
  getQatarEquipmentHistoryByWindow(
    variants: readonly string[],
    startSec: number,
    endSec: number
  ): QatarHistoryRow[];
  getQatarHistoryRoutes(
    variants: readonly string[],
    sinceDate: string
  ): Array<{ origin: string; destination: string }>;
  getQatarFetchCoverage(
    pairs: ReadonlyArray<{ origin: string; destination: string }>,
    fetchDates: readonly string[]
  ): Map<string, number>;
}

const publicCodes = (): readonly AirlineCode[] => publicAirlines().map((a) => a.code);

/** Cross-airline Starlink penetration. `rate` is null when nothing is tracked
 * — the single zero-total rule; callers map null to their own fallback. */
export function aggregatePenetration(
  per: ReadonlyArray<Pick<PerAirlineStat, "starlink" | "total">>
): {
  starlink: number;
  total: number;
  rate: number | null;
} {
  const starlink = per.reduce((s, a) => s + a.starlink, 0);
  const total = per.reduce((s, a) => s + a.total, 0);
  return { starlink, total, rate: total > 0 ? starlink / total : null };
}

function buildPerAirlineStats(db: Database, codes: readonly AirlineCode[]): PerAirlineStat[] {
  const hub = getHubStats(db, codes);
  const byCode = Object.fromEntries(hub.map((h) => [h.code, h]));
  const out: PerAirlineStat[] = [];
  for (const code of codes) {
    const cfg = AIRLINES[code];
    if (!cfg) continue;
    const h: HubAirlineStat | undefined = byCode[code];
    out.push({
      code,
      name: cfg.name,
      starlink: h?.starlink ?? countStarlinkPlanes(db, code),
      total: h?.total ?? getTotalCount(db, code),
      fleetTotal: h?.fleetTotal,
      installs30d: h?.installs30d,
      status: cfg.rollout.status,
      statusLabel: cfg.rollout.statusLabel,
      phaseNote: cfg.rollout.phaseNote,
      accentColor: cfg.brand.accentColor,
      accentText: uiAccent(cfg.brand),
      href: airlineHomeUrl(code),
    });
  }
  return out;
}

function buildReader(db: Database, scope: Scope): ScopedReader {
  // Hub ('ALL') is the union of *enabled* airlines, not every row in the DB —
  // disabled-airline canaries/test data stay invisible until that airline ships.
  const airlines = scope === "ALL" ? publicCodes() : ([scope] as const);
  // Route-compare methods are only meaningful per-airline; assert it.
  const soleAirline = () => {
    if (airlines.length !== 1)
      throw new Error(`ScopedReader method requires a single-airline scope, got ${scope}`);
    return airlines[0];
  };
  const airportsMemo = memo<AirportDepartures>(DEPARTURE_AGGREGATE_MEMO);
  const scheduleMemo = memo<RouteSchedule>(DEPARTURE_AGGREGATE_MEMO);
  const rankedMemo = memo<Array<{ origin: string; destination: string }>>(DEPARTURE_AGGREGATE_MEMO);
  const r: ScopedReader = {
    scope,
    airlines,
    getStarlinkPlanes: () => getStarlinkPlanes(db, airlines),
    countStarlinkPlanes: () => countStarlinkPlanes(db, airlines),
    getAirlineByTail: () => getAirlineByTail(db, airlines),
    getRecentInstalls: (limit, perAirlineCap) =>
      getRecentInstalls(db, airlines, limit, perAirlineCap),
    getFirstFlights: (tails) => getFirstFlights(db, tails, airlines),
    getDailyInstalls: () => getDailyInstalls(db, airlines),
    getPerAirlineStats: () => buildPerAirlineStats(db, airlines),
    getUpcomingFlights: (t) => getUpcomingFlights(db, t, airlines),
    // FleetStats shape is subfleet-specific (express/mainline); there is no
    // hub aggregate — null forces callers to handle the hub case explicitly
    // instead of receiving one airline's stats as the hub's.
    getFleetStats: () => (scope === "ALL" ? null : getFleetStats(db, scope)),
    getFleetRoster: () => (scope === "ALL" ? [] : getFleetRoster(db, scope)),
    getTotalCount: () =>
      scope === "ALL"
        ? airlines.reduce((s, c) => s + getTotalCount(db, c), 0)
        : getTotalCount(db, scope),
    getLastUpdated: () =>
      scope === "ALL"
        ? (airlines
            .map((c) => getLastUpdated(db, c))
            .filter(Boolean)
            .sort()
            .at(-1) ?? "")
        : getLastUpdated(db, scope),
    getLastUpdatedRaw: () =>
      airlines
        .map((c) => getMeta(db, "lastUpdated", c))
        .filter((v): v is string => v !== null)
        .sort()
        .at(-1) ?? null,
    getSitemapFlights: () => (scope === "ALL" ? [] : getSitemapFlights(db, scope)),
    getSitemapRoutes: () => (scope === "ALL" ? [] : getSitemapRoutes(db, scope)),
    getPopularFlights: (limit) => (scope === "ALL" ? [] : getPopularFlights(db, scope, limit)),
    getFleetAnchors: () => getFleetAnchors(db, airlines),
    getMeta: (key) => (scope === "ALL" ? null : getMeta(db, key, scope)),
    getFlightAssignments: (v, s, e) =>
      getFlightAssignments(db, v, s, e, withOperatingPartners(airlines)),
    getUnequippedAssignments: (v, s, e) => getUnequippedAssignments(db, v, s, e, airlines),
    getTypeProgress: () => getTypeProgress(db, soleAirline()),
    getFleetGuideTails: () => getFleetGuideTails(db, soleAirline()),
    getFleetPageData: () => getFleetPageData(db, airlines),
    getDepartureSlots: (q) => getDepartureSlots(db, airlines, q),
    getAirportDepartures: () => airportsMemo("", () => getAirportDepartures(db, airlines)),
    getRouteStarlinkSchedule: () => scheduleMemo("", () => getRouteStarlinkSchedule(db, airlines)),
    getRankedStarlinkRoutePairs: (offset, limit) =>
      rankedMemo(`${offset}:${limit}`, () =>
        getRankedStarlinkRoutePairs(db, airlines, offset, limit)
      ),
    getFleetDiscoveryStats: () => getFleetDiscoveryStats(db, airlines),
    getConfirmedFleetTails: () => getConfirmedFleetTails(db, airlines),
    getPendingFleetTails: () => getPendingFleetTails(db, airlines),
    getVerificationSummary: () => getVerificationSummary(db, airlines),
    getWifiMismatches: () => getWifiMismatches(db, airlines),

    getVerificationObservations: () => getVerificationObservations(db, airlines),
    getAdsbFlightDraws: (since) => (scope === "UA" ? getAdsbFlightDraws(db, since) : []),
    getAdsbFlightDrawsFor: (fn, since) =>
      scope === "UA" ? getAdsbFlightDrawsFor(db, fn, since) : [],
    getRouteFlights: (o, d) => getRouteFlights(db, o, d, airlines),
    getRouteGraphEdges: () => getRouteGraphEdges(db, airlines),
    getServedRoutePairs: () => getServedRoutePairs(db, airlines),
    getConfirmedStarlinkEdges: (s, e) => getConfirmedStarlinkEdges(db, s, e, airlines),
    airlineServesAirports: (px, ...aps) => airlineServesAirports(db, soleAirline(), px, ...aps),
    getSubfleetPenetration: () => getSubfleetPenetration(db, soleAirline()),
    getObservedDirectFlightNumbers: (px, o, d) =>
      getObservedDirectFlightNumbers(db, soleAirline(), px, o, d),
    getDirectRouteEdge: (o, d) => getDirectRouteEdge(db, o, d, airlines),

    getCachedFlightRoutes: (fn, after) => getCachedFlightRoutes(db, fn, after),
    cacheFlightRoute: (fn, o, d, dur) => cacheFlightRoute(db, fn, o, d, dur),
    getRoutesForFlightVariants: (v) => getRoutesForFlightVariants(db, v, airlines),

    flightNumberHasData: (v) => flightNumberHasData(db, v, airlines),
    routeHasData: (o, d) => routeHasData(db, o, d, soleAirline()),
    routeIsHistorical: (o, d) => routeIsHistorical(db, o, d, soleAirline()),
    getRouteSummary: (o, d) => getRouteSummary(db, o, d, soleAirline()),
    getRouteDepartures: (o, d) => getRouteDepartures(db, soleAirline(), o, d),
    getRouteFlightNumbers: (o, d) => getRouteFlightNumbers(db, o, d, soleAirline()),
    getRouteFlightLastSeen: (o, d) => getRouteFlightLastSeen(db, o, d, soleAirline()),
    getFlightHistorySummary: (v) => getFlightHistorySummary(db, v, airlines),
    getFlightRoutePairs: (v) => getFlightRoutePairs(db, v, airlines),
    getObservationAnchor: () => (scope === "ALL" ? 0 : getObservationAnchor(db, scope)),

    getStarlinkPlaneByTail: (tail) => getStarlinkPlaneByTail(db, tail, airlines),
    getFleetEntryByTail: (tail) => getFleetEntryByTail(db, tail, airlines),
    computeWifiConsensus: (tail, opts) =>
      computeWifiConsensus(db, tail, { ...opts, airline: airlines }),
    bumpDiscoveryPriority: (tail) => bumpDiscoveryPriority(db, tail, airlines),

    getQatarScheduleByFlight: (v, s, e) => getQatarScheduleByFlight(db, v, s, e),
    getQatarScheduleByRoute: (o, d, s, e) => getQatarScheduleByRoute(db, o, d, s, e),
    getQatarScheduleStats: () => getQatarScheduleStats(db),
    getQatarEquipmentHistory: (v, s, u) => getQatarEquipmentHistory(db, v, s, u),
    getQatarEquipmentHistoryByWindow: (v, s, e) => getQatarEquipmentHistoryByWindow(db, v, s, e),
    getQatarHistoryRoutes: (v, s) => getQatarHistoryRoutes(db, v, s),
    getQatarFetchCoverage: (p, d) => getQatarFetchCoverage(db, p, d),

    getAssignmentHistory: (v, d) => getAssignmentHistory(db, airlines, v, d),
    getSameDayStarlinkAlternatives: (q) => getSameDayStarlinkAlternatives(db, airlines, q),
    logResolvedAssignments: (fn, legs, now) => logResolvedAssignments(db, airlines, fn, legs, now),

    getAircraftTypePage: (slug) =>
      scope === "ALL" ? null : getAircraftTypePageData(db, scope, slug),
    getAircraftTypeGate: (slug) => (scope === "ALL" ? null : getAircraftTypeGate(db, scope, slug)),
  };
  return Object.freeze(r);
}

export function createReaderFactory(db: Database): (scope: Scope) => ScopedReader {
  const cache = new Map<Scope, ScopedReader>();
  return (scope) => {
    let r = cache.get(scope);
    if (!r) {
      r = buildReader(db, scope);
      cache.set(scope, r);
    }
    return r;
  };
}
