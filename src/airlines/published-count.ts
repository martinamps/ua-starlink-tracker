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
import { type AirlineOwnCount, airlineOwnCount, formatFactDate } from "./rollout-facts";

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
