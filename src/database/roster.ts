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
import { AIRLINES, isOutsideProgramme } from "../airlines/registry";
import { normalizeAircraftType } from "../observability/metrics";
import { listedVerifiedSql, tailEquippedSql } from "./sql/equipped";
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
  /** A listing names Starlink, so the tail is evidence tier "verified" rather
   * than "listed". Equipped either way; only the display differs. */
  listedVerified: boolean;
}

/** Every roster row in scope, in-programme or not, tail order. */
export function fleetRoster(db: Database, airline: AirlineFilter): RosterTail[] {
  const q = withAirline(
    `SELECT uf.airline, uf.tail_number, uf.aircraft_type, uf.fleet, uf.operated_by,
            uf.starlink_status, uf.verified_wifi, uf.verified_at,
            ${tailEquippedSql("uf.tail_number", "uf.airline")} AS equipped,
            ${listedVerifiedSql("uf.tail_number", "uf.airline")} AS listed_verified
     FROM united_fleet uf WHERE 1=1`,
    airline,
    "uf"
  );
  const rows = db.query(`${q.sql} ORDER BY uf.tail_number`).all(...q.params) as Array<
    Omit<RosterTail, "family" | "equipped" | "listedVerified"> & {
      equipped: number;
      listed_verified: number;
    }
  >;
  return rows.map((r) => ({
    ...r,
    family: normalizeAircraftType(r.aircraft_type),
    equipped: r.equipped === 1,
    listedVerified: r.listed_verified === 1,
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

/**
 * A tenant's programme as the airline itself counts it: its own programme
 * roster plus the partner-operated families its programme names
 * (programmePartners). Only the tenant's headline and /fleet read this; every
 * per-airline count stays on programmeRoster so cross-airline sums never see a
 * partner tail twice.
 */
export function tenantProgrammeRoster(db: Database, code: string): RosterTail[] {
  const partners = AIRLINES[code]?.programmePartners?.partners ?? [];
  return [
    ...programmeRoster(db, code),
    ...partners.flatMap((p) =>
      programmeRoster(db, p.airline).filter((t) => p.families.includes(t.family))
    ),
  ];
}

/**
 * The airline's own by-type chart, as stored with the chart's own date, for
 * the case where it counts more aircraft than this site can name by tail.
 */
export interface AirlineChartCount {
  connected: number;
  total: number;
  /** The chart's own "last updated" date, YYYY-MM-DD. Printed beside the count. */
  asOf: string;
  sourceLabel: string;
  url: string;
  /** The chart is at least as new as the newest named tail, so it leads the
   * headline; false = the named count leads and the chart sits beside it. */
  leads: boolean;
  /** Per family, the aircraft the chart counts beyond the tails named here. */
  unnamed: Array<{ family: string; count: number }>;
  /** Families where the fleet list and the chart differ in size; `chart` is
   * null for a family the chart leaves out. */
  rosterDiff: Array<{ family: string; ours: number; chart: number | null }>;
}

export interface ProgrammeHeadline extends RosterCount {
  noun: string;
  /** One row per partner slice, for the hero's segment list. */
  partners: Array<RosterCount & { label: string }>;
  /** Set by programmeHeadlineWithChart (airline-count.ts); null or absent
   * when the airline's chart counts no more than the named tails. */
  airlineCount?: AirlineChartCount | null;
}

/** The tenant headline over tenantProgrammeRoster; null for an airline with no
 * programme partners, whose headline stays on its per-airline figures. */
export function programmeHeadline(db: Database, code: string): ProgrammeHeadline | null {
  const cfg = AIRLINES[code]?.programmePartners;
  if (!cfg) return null;
  const tally = (tails: readonly RosterTail[]): RosterCount => ({
    total: tails.length,
    equipped: tails.filter((t) => t.equipped).length,
  });
  const all = tenantProgrammeRoster(db, code);
  return {
    ...tally(all),
    noun: cfg.noun,
    partners: cfg.partners.map((p) => ({
      label: p.label,
      ...tally(all.filter((t) => t.airline === p.airline && p.families.includes(t.family))),
    })),
  };
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
