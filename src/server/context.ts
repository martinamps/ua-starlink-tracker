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
import type { WifiMismatch } from "../database/database";
import type {
  Aircraft,
  AirportDepartures,
  FleetDiscoveryStats,
  FleetPageData,
  FleetStats,
  Flight,
  PerAirlineStat,
} from "../types";

export type { Database };

export type Scope = AirlineCode | "ALL";

export interface ScopedReader {
  readonly scope: Scope;
  getStarlinkPlanes(): Aircraft[];
  getPerAirlineStats(): PerAirlineStat[];
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

const enabledCodes = (): readonly AirlineCode[] => enabledAirlines().map((a) => a.code);

function perAirlineStat(db: Database, cfg: AirlineConfig): PerAirlineStat {
  return {
    code: cfg.code,
    name: cfg.name,
    starlink: getStarlinkPlanes(db, cfg.code).length,
    total: getTotalCount(db, cfg.code),
  };
}

function buildReader(db: Database, scope: Scope): ScopedReader {
  // Hub ('ALL') is the union of *enabled* airlines, not every row in the DB —
  // disabled-airline canaries/test data stay invisible until that airline ships.
  const a = scope === "ALL" ? enabledCodes() : scope;
  const r: ScopedReader = {
    scope,
    getStarlinkPlanes: () => getStarlinkPlanes(db, a),
    getPerAirlineStats: () =>
      scope === "ALL"
        ? enabledAirlines().map((cfg) => perAirlineStat(db, cfg))
        : enabledAirlines()
            .filter((cfg) => cfg.code === scope)
            .map((cfg) => perAirlineStat(db, cfg)),
    getUpcomingFlights: (t) => getUpcomingFlights(db, t, a),
    // FleetStats shape is UA-subfleet-specific (express/mainline); hub aggregation deferred until
    // getSubfleetStats lands. Hub callers should not rely on this.
    getFleetStats: () => getFleetStats(db, scope === "ALL" ? "UA" : scope),
    getTotalCount: () =>
      scope === "ALL"
        ? enabledCodes().reduce((s, c) => s + getTotalCount(db, c), 0)
        : getTotalCount(db, scope),
    getLastUpdated: () =>
      scope === "ALL"
        ? (enabledCodes()
            .map((c) => getLastUpdated(db, c))
            .filter(Boolean)
            .sort()
            .at(-1) ?? "")
        : getLastUpdated(db, scope),
    getFlightsByNumberAndDate: (v, s, e) => getFlightsByNumberAndDate(db, v, s, e, a),
    getFleetPageData: () => getFleetPageData(db, a),
    getAirportDepartures: () => getAirportDepartures(db, a),
    getFleetDiscoveryStats: () => getFleetDiscoveryStats(db, a),
    getConfirmedFleetTails: () => getConfirmedFleetTails(db, a),
    getPendingFleetTails: () => getPendingFleetTails(db, a),
    getVerificationSummary: () => getVerificationSummary(db, a),
    getWifiMismatches: () => getWifiMismatches(db, a),
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
