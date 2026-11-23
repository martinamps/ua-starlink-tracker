/**
 * The one rule for which Starlink count a ranking, a description or a stated
 * total may print for an airline.
 *
 * United and Alaska are checked plane by plane, so their count is evidence.
 * An airline known only by aircraft type (Qatar, Hawaiian) has no such count:
 * adding up every aircraft of its finished types on a third-party fleet list
 * is arithmetic, and it has run ten ahead of the airline's own figure while
 * also counting none of a type that is mid-install. For those airlines the
 * only count is the airline's own, printed with its date, or none at all.
 * The by-type table stays what it is: fleet sizes by type.
 */

import { type AirlineConfig, wifiPhaseFamilies } from "./registry";
import {
  type AirlineOwnCount,
  airlineOwnCount,
  airlineOwnTypeTotal,
  formatFactDate,
} from "./rollout-facts";

/** How an airline's Starlink status is decided: per aircraft, by aircraft
 * type, or from a community-curated list. Only "tail" earns "plane by plane". */
export function trackingMethod(cfg: AirlineConfig): "tail" | "type" | "community" {
  if (cfg.communitySource) return "community";
  return wifiPhaseFamilies(cfg.code) ? "type" : "tail";
}

export type PublishedCount =
  /** Counted on this site, aircraft by aircraft. */
  | { basis: "tracked"; count: number }
  /** Known by type; the count is the airline's own dated figure. */
  | ({ basis: "airline" } & AirlineOwnCount)
  /** Known by type, and the airline's own figure isn't on file: no count. */
  | { basis: "type" };

export function publishedCount(cfg: AirlineConfig, tracked: number): PublishedCount {
  if (trackingMethod(cfg) !== "type") return { basis: "tracked", count: tracked };
  const own = airlineOwnCount(cfg.code);
  return own ? { basis: "airline", ...own } : { basis: "type" };
}

/** Every aircraft is checked on its own: no aircraft-type rule and no
 * community list settles any of them. Alaska is not this: its type rule marks
 * every E175 on the fleet list, most of its count, the way Qatar's does. */
export function checkedPlaneByPlane(cfg: AirlineConfig): boolean {
  return trackingMethod(cfg) === "tail" && !cfg.typeDeterministicWifi;
}

/**
 * The count a search description may state for an airline, or null to leave
 * the airline unnamed. A snippet has no room for a date, a source or a caveat,
 * so a number stands there only when it needs none: every aircraft was checked
 * on its own, or the count tracked here equals the airline's own dated figure
 * on file (its fleet-wide count, else its per-type counts added up). A sum by
 * aircraft type that the airline's figures don't match, and a community list,
 * never qualify.
 */
export function statedCount(cfg: AirlineConfig, tracked: number): number | null {
  if (tracked <= 0) return null;
  if (checkedPlaneByPlane(cfg)) return tracked;
  const own = airlineOwnCount(cfg.code)?.count ?? airlineOwnTypeTotal(cfg.code)?.total;
  return own === tracked ? tracked : null;
}

/** Rank order: by the published count, airlines without one last. */
export function byPublishedCount<T extends { published: PublishedCount }>(rows: T[]): T[] {
  const n = (p: PublishedCount) => (p.basis === "type" ? -1 : p.count);
  return [...rows].sort((a, b) => n(b.published) - n(a.published));
}

/** "as of Aug 21, 2026": the date never leaves an airline's own figure. */
export function ownCountAsOf(own: AirlineOwnCount): string {
  return `as of ${formatFactDate(own.asOf)}`;
}

export function ownCountCredit(cfg: AirlineConfig, own: AirlineOwnCount): string {
  return `per ${cfg.name} ${ownCountAsOf(own)}`;
}
