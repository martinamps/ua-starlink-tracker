/**
 * The fleet denominator. Every "N of M aircraft" reads M from
 * programmeRoster: the airline's united_fleet rows minus freighters and the
 * programme's declared exclusions (isOutsideProgramme). Each row carries the
 * one equipped flag (sql/equipped.ts), so numerators come from the same pass.
 *
 * One deliberate exception: the headline total (getTotalCount, meta
 * totalAircraftCount) behind the homepage, badge, fleet-summary API and MCP
 * get_fleet_stats. For AS/HA/QR/AF refreshFleetMeta writes it from this
 * roster, so the two agree. For UA the hourly sheet scrape writes the sheet's
 * own fleet total, the figure the community tracker publishes; it matched
 * programmeRoster on the 2026-09-21 snapshot (1,659) but can lead it between
 * fleet syncs. Moving the headline onto the roster is a contract change for
 * those surfaces (tests/golden pins them), not a refactor.
 */

import type { Database } from "bun:sqlite";
import { isOutsideProgramme } from "../airlines/registry";
import { normalizeAircraftType } from "../observability/metrics";
import { tailEquippedSql } from "./sql/equipped";
import { type AirlineFilter, withAirline } from "./sql/fragments";

export interface RosterTail {
  airline: string;
  tail_number: string;
  aircraft_type: string | null;
  /** normalizeAircraftType(aircraft_type). */
  family: string;
  fleet: string;
  operated_by: string | null;
  starlink_status: string;
  verified_wifi: string | null;
  verified_at: number | null;
  equipped: boolean;
}

/** Every roster row in scope, in-programme or not, tail order. */
export function fleetRoster(db: Database, airline: AirlineFilter): RosterTail[] {
  const q = withAirline(
    `SELECT uf.airline, uf.tail_number, uf.aircraft_type, uf.fleet, uf.operated_by,
            uf.starlink_status, uf.verified_wifi, uf.verified_at,
            ${tailEquippedSql("uf.tail_number", "uf.airline")} AS equipped
     FROM united_fleet uf WHERE 1=1`,
    airline,
    "uf"
  );
  const rows = db.query(`${q.sql} ORDER BY uf.tail_number`).all(...q.params) as Array<
    Omit<RosterTail, "family" | "equipped"> & { equipped: number }
  >;
  return rows.map((r) => ({
    ...r,
    family: normalizeAircraftType(r.aircraft_type),
    equipped: r.equipped === 1,
  }));
}

/** The denominator: roster tails inside the airline's Starlink programme. */
export function programmeRoster(db: Database, airline: AirlineFilter): RosterTail[] {
  return fleetRoster(db, airline).filter((t) => !isOutsideProgramme(t.airline, t.family));
}

export interface RosterCount {
  total: number;
  equipped: number;
}

/** Totals keyed by `keyOf`, in first-seen order. */
export function countRoster(
  tails: readonly RosterTail[],
  keyOf: (t: RosterTail) => string
): Map<string, RosterCount> {
  const out = new Map<string, RosterCount>();
  for (const t of tails) {
    const key = keyOf(t);
    const acc = out.get(key) ?? { total: 0, equipped: 0 };
    acc.total++;
    if (t.equipped) acc.equipped++;
    out.set(key, acc);
  }
  return out;
}
