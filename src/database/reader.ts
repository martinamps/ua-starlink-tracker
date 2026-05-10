/**
 * Airline-scoped data access. Minted per-scope; consumers receive ONLY this
 * reader, never the raw Database. Every method has the airline filter baked
 * in, so a UA-host request cannot see HA/QR rows even if a caller forgets to
 * filter. Lives in database/ so api/, scripts/, and server/ can all depend on
 * it without crossing into the HTTP layer.
 */

import type { Database } from "bun:sqlite";
import { AIRLINES, type AirlineCode, airlineHomeUrl, publicAirlines } from "../airlines/registry";
import type {
  Aircraft,
  AirportDepartures,
  FleetDiscoveryStats,
  FleetPageData,
  FleetStats,
  Flight,
  PerAirlineStat,
  RecentInstall,
} from "../types";
import {
  type CheckFlightRow,
  type ConfirmedEdge,
  type DirectRouteEdge,
  type FlightAssignmentRow,
  type HubAirlineStat,
  type QatarScheduleRow,
  type RouteEntryRow,
  type RouteFlightRow,
  type RouteGraphEdge,
  type SubfleetPenetration,
  type VerificationObservation,
  type WifiConsensus,
  type WifiMismatch,
  airlineServesAirports,
  bumpDiscoveryPriority,
  cacheFlightRoute,
  computeWifiConsensus,
  getAirlineByTail,
  getAirportDepartures,
  getCachedFlightRoutes,
  getConfirmedFleetTails,
  getConfirmedStarlinkEdges,
  getDirectRouteEdge,
  getFleetDiscoveryStats,
  getFleetEntryByTail,
  getFleetPageData,
  getFleetStats,
  getFlightAssignments,
  getFlightsByNumberAndDate,
  getHubStats,
  getLastUpdated,
  getMeta,
  getObservedDirectFlightNumbers,
  getPendingFleetTails,
  getQatarScheduleByFlight,
  getQatarScheduleByRoute,
  getQatarScheduleStats,
  getRecentInstalls,
  getRouteFlights,
  getRouteGraphEdges,
  getRoutesForFlightVariants,
  getStarlinkPlaneByTail,
  getStarlinkPlanes,
  getSubfleetPenetration,
  getTotalCount,
  getUpcomingFlights,
  getVerificationObservations,
  getVerificationSummary,
  getWifiMismatches,
} from "./database";

export type { Database };

export type Scope = AirlineCode | "ALL";

export interface ScopedReader {
  readonly scope: Scope;
  /** Airline codes covered by this reader (single-element for per-airline hosts, enabled set for hub). */
  readonly airlines: readonly AirlineCode[];
  getStarlinkPlanes(): Aircraft[];
  getAirlineByTail(): Record<string, string>;
  getRecentInstalls(limit?: number, perAirlineCap?: number): RecentInstall[];
  getPerAirlineStats(): PerAirlineStat[];
  getUpcomingFlights(tailNumber?: string): Flight[];
  getFleetStats(): FleetStats;
  getTotalCount(): number;
  getLastUpdated(): string;
  getMeta(key: string): string | null;
  getFlightsByNumberAndDate(
    variants: string[],
    startOfDay: number,
    endOfDay: number
  ): CheckFlightRow[];
  /** Hub-only: query a *specific* airline regardless of reader scope (caller-detected from flight prefix). */
  getFlightsByNumberAndDateForAirline(
    variants: string[],
    startOfDay: number,
    endOfDay: number,
    code: AirlineCode
  ): CheckFlightRow[];
  /** MCP check_flight: assignments without the verified_wifi filter (renders three confidence tiers). */
  getFlightAssignments(
    variants: string[],
    startOfDay: number,
    endOfDay: number
  ): FlightAssignmentRow[];
  getFleetPageData(): FleetPageData;
  getAirportDepartures(): AirportDepartures;
  getFleetDiscoveryStats(): FleetDiscoveryStats;
  getConfirmedFleetTails(): ReturnType<typeof getConfirmedFleetTails>;
  getPendingFleetTails(): ReturnType<typeof getPendingFleetTails>;
  getVerificationSummary(): ReturnType<typeof getVerificationSummary>;
  getWifiMismatches(): WifiMismatch[];

  // Predictor / route-graph
  getVerificationObservations(): VerificationObservation[];
  getRouteFlights(origin: string | null, destination: string | null): RouteFlightRow[];
  getRouteGraphEdges(): RouteGraphEdge[];
  getConfirmedStarlinkEdges(startOfDay: number, endOfDay: number): ConfirmedEdge[];
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

  // Single-tail lookups + best-effort writes (tail_number UNIQUE → scope-safe)
  getStarlinkPlaneByTail(
    tail: string
  ): { Aircraft: string; OperatedBy: string; fleet: string } | null;
  getFleetEntryByTail(
    tail: string
  ): { starlink_status: string; verified_wifi: string | null; verified_at: number | null } | null;
  computeWifiConsensus(tail: string): WifiConsensus;
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
  getQatarScheduleStats(): {
    total: number;
    starlink: number;
    rolling: number;
    none: number;
    lastUpdated: number | null;
  };
}

const publicCodes = (): readonly AirlineCode[] => publicAirlines().map((a) => a.code);

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
      starlink: h?.starlink ?? getStarlinkPlanes(db, code).length,
      total: h?.total ?? getTotalCount(db, code),
      fleetTotal: h?.fleetTotal,
      installs30d: h?.installs30d,
      status: cfg.rollout?.status,
      statusLabel: cfg.rollout?.statusLabel,
      phaseNote: cfg.rollout?.phaseNote,
      accentColor: cfg.brand.accentColor,
      href: airlineHomeUrl(code),
    });
  }
  return out;
}

function buildReader(db: Database, scope: Scope): ScopedReader {
  // Hub ('ALL') is the union of *enabled* airlines, not every row in the DB —
  // disabled-airline canaries/test data stay invisible until that airline ships.
  const airlines = scope === "ALL" ? publicCodes() : ([scope] as const);
  // Meta keys are namespaced per-airline; ALL has no single namespace.
  const metaCode = scope === "ALL" ? "UA" : scope;
  // Route-compare methods are only meaningful per-airline; assert it.
  const soleAirline = () => {
    if (airlines.length !== 1)
      throw new Error(`ScopedReader method requires a single-airline scope, got ${scope}`);
    return airlines[0];
  };
  const r: ScopedReader = {
    scope,
    airlines,
    getStarlinkPlanes: () => getStarlinkPlanes(db, airlines),
    getAirlineByTail: () => getAirlineByTail(db, airlines),
    getRecentInstalls: (limit, perAirlineCap) =>
      getRecentInstalls(db, airlines, limit, perAirlineCap),
    getPerAirlineStats: () => buildPerAirlineStats(db, airlines),
    getUpcomingFlights: (t) => getUpcomingFlights(db, t, airlines),
    // FleetStats shape is UA-subfleet-specific (express/mainline); hub aggregation deferred until
    // getSubfleetStats lands. Hub callers should not rely on this.
    getFleetStats: () => getFleetStats(db, metaCode),
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
    getMeta: (key) => getMeta(db, key, metaCode),
    getFlightsByNumberAndDate: (v, s, e) => getFlightsByNumberAndDate(db, v, s, e, airlines),
    getFlightsByNumberAndDateForAirline: (v, s, e, code) =>
      getFlightsByNumberAndDate(db, v, s, e, code),
    getFlightAssignments: (v, s, e) => getFlightAssignments(db, v, s, e, airlines),
    getFleetPageData: () => getFleetPageData(db, airlines),
    getAirportDepartures: () => getAirportDepartures(db, airlines),
    getFleetDiscoveryStats: () => getFleetDiscoveryStats(db, airlines),
    getConfirmedFleetTails: () => getConfirmedFleetTails(db, airlines),
    getPendingFleetTails: () => getPendingFleetTails(db, airlines),
    getVerificationSummary: () => getVerificationSummary(db, airlines),
    getWifiMismatches: () => getWifiMismatches(db, airlines),

    getVerificationObservations: () => getVerificationObservations(db, airlines),
    getRouteFlights: (o, d) => getRouteFlights(db, o, d, airlines),
    getRouteGraphEdges: () => getRouteGraphEdges(db, airlines),
    getConfirmedStarlinkEdges: (s, e) => getConfirmedStarlinkEdges(db, s, e, airlines),
    airlineServesAirports: (px, ...aps) => airlineServesAirports(db, soleAirline(), px, ...aps),
    getSubfleetPenetration: () => getSubfleetPenetration(db, soleAirline()),
    getObservedDirectFlightNumbers: (px, o, d) =>
      getObservedDirectFlightNumbers(db, soleAirline(), px, o, d),
    getDirectRouteEdge: (o, d) => getDirectRouteEdge(db, o, d, airlines),

    getCachedFlightRoutes: (fn, after) => getCachedFlightRoutes(db, fn, after),
    cacheFlightRoute: (fn, o, d, dur) => cacheFlightRoute(db, fn, o, d, dur),
    getRoutesForFlightVariants: (v) => getRoutesForFlightVariants(db, v, airlines),

    getStarlinkPlaneByTail: (tail) => getStarlinkPlaneByTail(db, tail),
    getFleetEntryByTail: (tail) => getFleetEntryByTail(db, tail),
    computeWifiConsensus: (tail) => computeWifiConsensus(db, tail),
    bumpDiscoveryPriority: (tail) => bumpDiscoveryPriority(db, tail),

    getQatarScheduleByFlight: (v, s, e) => getQatarScheduleByFlight(db, v, s, e),
    getQatarScheduleByRoute: (o, d, s, e) => getQatarScheduleByRoute(db, o, d, s, e),
    getQatarScheduleStats: () => getQatarScheduleStats(db),
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
