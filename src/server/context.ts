/**
 * Request-scoped data access. Minted once per request from the resolved
 * tenant; route handlers receive ONLY this reader, never the raw Database.
 * Every method has the airline filter baked in, so a UA-host request cannot
 * see HA/QR rows even if the handler forgets to filter.
 */

import type { Database } from "bun:sqlite";
import type { AirlineCode, AirlineConfig, Tenant } from "../airlines/registry";
import {
  type CheckFlightRow,
  getAirportDepartures,
  getConfirmedFleetTails,
  getFleetDiscoveryStats,
  getFleetPageData,
  getFleetStats,
  getFlightsByNumberAndDate,
  getLastUpdated,
  getPendingFleetTails,
  getStarlinkPlanes,
  getTotalCount,
  getUpcomingFlights,
  getVerificationSummary,
  getWifiMismatches,
} from "../database/database";
import type {
  Aircraft,
  AirportDepartures,
  FleetDiscoveryStats,
  FleetPageData,
  FleetStats,
  Flight,
  WifiMismatch,
} from "../types";

export type Scope = AirlineCode | "ALL";

export interface ScopedReader {
  readonly scope: Scope;
  getStarlinkPlanes(): Aircraft[];
  getUpcomingFlights(tailNumber?: string): Flight[];
  getFleetStats(): FleetStats;
  getTotalCount(): number;
  getLastUpdated(): string;
  getFlightsByNumberAndDate(
    variants: string[],
    startOfDay: number,
    endOfDay: number
  ): CheckFlightRow[];
  getFleetPageData(): FleetPageData;
  getAirportDepartures(): AirportDepartures;
  getFleetDiscoveryStats(): FleetDiscoveryStats;
  getConfirmedFleetTails(): ReturnType<typeof getConfirmedFleetTails>;
  getPendingFleetTails(): ReturnType<typeof getPendingFleetTails>;
  getVerificationSummary(): ReturnType<typeof getVerificationSummary>;
  getWifiMismatches(): WifiMismatch[];
}

export interface RequestContext {
  req: Request;
  url: URL;
  tenant: Tenant;
  reader: ScopedReader;
  /** Raw handle. Transitional — handlers should NOT use this; it will be removed once predictor/mcp are reader-based. */
  db: Database;
}

function buildReader(db: Database, scope: Scope): ScopedReader {
  const a = scope === "ALL" ? undefined : scope;
  return Object.freeze({
    scope,
    getStarlinkPlanes: () => getStarlinkPlanes(db, a),
    getUpcomingFlights: (t?: string) => getUpcomingFlights(db, t, a),
    getFleetStats: () => getFleetStats(db, a ?? "UA"),
    getTotalCount: () => getTotalCount(db, a ?? "UA"),
    getLastUpdated: () => getLastUpdated(db, a ?? "UA"),
    getFlightsByNumberAndDate: (v, s, e) => getFlightsByNumberAndDate(db, v, s, e, a),
    getFleetPageData: () => getFleetPageData(db, a),
    getAirportDepartures: () => getAirportDepartures(db, a),
    getFleetDiscoveryStats: () => getFleetDiscoveryStats(db, a),
    getConfirmedFleetTails: () => getConfirmedFleetTails(db, a),
    getPendingFleetTails: () => getPendingFleetTails(db, a),
    getVerificationSummary: () => getVerificationSummary(db, a),
    getWifiMismatches: () => getWifiMismatches(db, a),
  });
}

const readerCache = new Map<Scope, ScopedReader>();

export function getScopedReader(db: Database, scope: Scope): ScopedReader {
  let r = readerCache.get(scope);
  if (!r) {
    r = buildReader(db, scope);
    readerCache.set(scope, r);
  }
  return r;
}

export function tenantScope(tenant: Tenant): Scope {
  return tenant === "ALL" ? "ALL" : tenant.code;
}

export function tenantConfig(tenant: Tenant): AirlineConfig | null {
  return tenant === "ALL" ? null : tenant;
}
