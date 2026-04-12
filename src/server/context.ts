/**
 * Request-scoped data access. Minted once per request from the resolved
 * tenant; route handlers receive ONLY this reader, never the raw Database.
 * Every method has the airline filter baked in, so a UA-host request cannot
 * see HA/QR rows even if the handler forgets to filter.
 */

import type { Database } from "bun:sqlite";
import {
  type AirlineCode,
  type AirlineConfig,
  type Tenant,
  enabledAirlines,
} from "../airlines/registry";
import {
  type CheckFlightRow,
  type ConfirmedEdge,
  type DirectRouteEdge,
  type FlightAssignmentRow,
  type HubAirlineStat,
  type RouteEntryRow,
  type RouteFlightRow,
  type RouteGraphEdge,
  type VerificationObservation,
  type WifiConsensus,
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
  getPendingFleetTails,
  getRecentInstalls,
  getRouteAirlineCoverage,
  getRouteFlights,
  getRouteGraphEdges,
  getRoutesForFlightVariants,
  getStarlinkPlaneByTail,
  getStarlinkPlanes,
  getTotalCount,
  getUpcomingFlights,
  getVerificationObservations,
  getVerificationSummary,
  getWifiMismatches,
} from "../database/database";
import type { WifiMismatch } from "../database/database";
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

export type { Database };

export type Scope = AirlineCode | "ALL";

export interface ScopedReader {
  readonly scope: Scope;
  /** Airline codes covered by this reader (single-element for per-airline hosts, enabled set for hub). */
  readonly airlines: readonly AirlineCode[];
  getStarlinkPlanes(): Aircraft[];
  getAirlineByTail(): Record<string, string>;
  getRecentInstalls(limit?: number): RecentInstall[];
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
  getVerificationObservations(beforeSec?: number, afterSec?: number): VerificationObservation[];
  getRouteFlights(origin: string | null, destination: string | null): RouteFlightRow[];
  getRouteGraphEdges(): RouteGraphEdge[];
  getConfirmedStarlinkEdges(startOfDay: number, endOfDay: number): ConfirmedEdge[];
  getRouteAirlineCoverage(
    origin: string,
    destination: string,
    code: AirlineCode
  ): { tail_number: string; sl: number }[];
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
}

export interface RequestContext {
  req: Request;
  url: URL;
  tenant: Tenant;
  reader: ScopedReader;
  /** Mint a reader for a specific airline (hub endpoints that detect airline from flight-number prefix). */
  getReader: (scope: Scope) => ScopedReader;
}

const enabledCodes = (): readonly AirlineCode[] => enabledAirlines().map((a) => a.code);

function buildPerAirlineStats(db: Database, codes: readonly AirlineCode[]): PerAirlineStat[] {
  const hub = getHubStats(db, codes);
  const byCode = Object.fromEntries(hub.map((h) => [h.code, h]));
  const out: PerAirlineStat[] = [];
  for (const code of codes) {
    const cfg = enabledAirlines().find((c) => c.code === code);
    if (!cfg) continue;
    const h: HubAirlineStat | undefined = byCode[code];
    out.push({
      code,
      name: cfg.name,
      starlink: h?.starlink ?? getStarlinkPlanes(db, code).length,
      total: h?.total ?? getTotalCount(db, code),
      fleetTotal: h?.fleetTotal,
      installs30d: h?.installs30d,
      accentColor: cfg.brand.accentColor,
      canonicalHost: cfg.canonicalHost,
    });
  }
  return out;
}

function buildReader(db: Database, scope: Scope): ScopedReader {
  // Hub ('ALL') is the union of *enabled* airlines, not every row in the DB —
  // disabled-airline canaries/test data stay invisible until that airline ships.
  const airlines = scope === "ALL" ? enabledCodes() : ([scope] as const);
  const a = scope === "ALL" ? airlines : scope;
  // Meta keys are namespaced per-airline; ALL has no single namespace.
  const metaCode = scope === "ALL" ? "UA" : scope;
  const r: ScopedReader = {
    scope,
    airlines,
    getStarlinkPlanes: () => getStarlinkPlanes(db, a),
    getAirlineByTail: () => getAirlineByTail(db, a),
    getRecentInstalls: (limit) => getRecentInstalls(db, a, limit),
    getPerAirlineStats: () => buildPerAirlineStats(db, airlines),
    getUpcomingFlights: (t) => getUpcomingFlights(db, t, a),
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
    getFlightsByNumberAndDate: (v, s, e) => getFlightsByNumberAndDate(db, v, s, e, a),
    getFlightsByNumberAndDateForAirline: (v, s, e, code) =>
      getFlightsByNumberAndDate(db, v, s, e, code),
    getFlightAssignments: (v, s, e) => getFlightAssignments(db, v, s, e, a),
    getFleetPageData: () => getFleetPageData(db, a),
    getAirportDepartures: () => getAirportDepartures(db, a),
    getFleetDiscoveryStats: () => getFleetDiscoveryStats(db, a),
    getConfirmedFleetTails: () => getConfirmedFleetTails(db, a),
    getPendingFleetTails: () => getPendingFleetTails(db, a),
    getVerificationSummary: () => getVerificationSummary(db, a),
    getWifiMismatches: () => getWifiMismatches(db, a),

    getVerificationObservations: (before, after) =>
      getVerificationObservations(db, a, before, after),
    getRouteFlights: (o, d) => getRouteFlights(db, o, d, a),
    getRouteGraphEdges: () => getRouteGraphEdges(db, a),
    getConfirmedStarlinkEdges: (s, e) => getConfirmedStarlinkEdges(db, s, e, a),
    getRouteAirlineCoverage: (o, d, code) => getRouteAirlineCoverage(db, o, d, code),
    getDirectRouteEdge: (o, d) => getDirectRouteEdge(db, o, d, a),

    getCachedFlightRoutes: (fn, after) => getCachedFlightRoutes(db, fn, after),
    cacheFlightRoute: (fn, o, d, dur) => cacheFlightRoute(db, fn, o, d, dur),
    getRoutesForFlightVariants: (v) => getRoutesForFlightVariants(db, v, a),

    getStarlinkPlaneByTail: (tail) => getStarlinkPlaneByTail(db, tail),
    getFleetEntryByTail: (tail) => getFleetEntryByTail(db, tail),
    computeWifiConsensus: (tail) => computeWifiConsensus(db, tail),
    bumpDiscoveryPriority: (tail) => bumpDiscoveryPriority(db, tail),
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

export function tenantScope(tenant: Tenant): Scope {
  return tenant === "ALL" ? "ALL" : tenant.code;
}

export function tenantConfig(tenant: Tenant): AirlineConfig | null {
  return tenant === "ALL" ? null : tenant;
}
