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
 * Where the airline's source states no total but calls whole types complete
 * with a count each (Hawaiian on Alaska's tracker), those counts may be added
 * up: the sum is printed with its parts, the source and the date, and worded
 * as this site's sum.
 * The by-type table stays what it is: fleet sizes by type.
 */

import { fmt } from "../components/ui/format";
import type { AirlineChartCount } from "../database/roster";
import { aircraftName } from "./aircraft-families";
import { type AirlineConfig, heldBackCount, wifiPhaseFamilies } from "./registry";
import {
  type AirlineOwnCount,
  type AirlineOwnTypeSum,
  type RolloutFact,
  airlineOwnCount,
  airlineOwnTypeSum,
  airlineOwnTypeTotal,
  factsForCode,
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
  /** Known by type; the count is this site's sum of the counts a source gives
   * for the airline's wholly fitted types. */
  | ({ basis: "type-sum" } & AirlineOwnTypeSum)
  /** Known by type, and neither figure is on file: no count. */
  | { basis: "type" };

export function publishedCount(cfg: AirlineConfig, tracked: number): PublishedCount {
  if (trackingMethod(cfg) !== "type") return { basis: "tracked", count: tracked };
  const own = airlineOwnCount(cfg.code);
  if (own) return { basis: "airline", ...own };
  const sum = airlineOwnTypeSum(cfg.code);
  return sum ? { basis: "type-sum", ...sum } : { basis: "type" };
}

/** What a by-type airline's fleet-list sum is a sum of. A sentence that
 * prints the sum says this in place of "have Starlink": the aircraft were
 * never counted one by one, and the airline's own figure differs. */
export function byTypeSumBasis(code: string): string {
  const held = heldBackCount(code);
  return held > 0
    ? `types the airline reports finished, leaving out ${fmt(held)} that aren't confirmed`
    : "fully equipped types";
}

/** Every aircraft is checked on its own: no aircraft-type rule and no
 * community list settles any of them. Alaska is not this: its type rule marks
 * every E175 on the fleet list, most of its count, the way Qatar's does. */
export function checkedPlaneByPlane(cfg: AirlineConfig): boolean {
  return trackingMethod(cfg) === "tail" && !cfg.typeDeterministicWifi;
}

/** Counted on this site, but a rule on aircraft type settles part of the
 * fleet and only the rest is checked aircraft by aircraft (Alaska). */
export function partlyByType(cfg: AirlineConfig): boolean {
  return trackingMethod(cfg) === "tail" && !checkedPlaneByPlane(cfg);
}

const namesAre = (names: string[]) =>
  `${names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ")} ${names.length === 1 ? "is" : "are"}`;

/** "United is counted plane by plane. Alaska is counted partly by aircraft
 * type.": one sentence per method, so no airline with a type rule shares a
 * sentence with "plane by plane". */
export function countingMethodSentences(
  airlines: AirlineConfig[],
  verb: "counted" | "tracked" = "counted"
): string {
  const names = (pick: (cfg: AirlineConfig) => boolean) =>
    airlines.filter(pick).map((a) => a.shortName);
  const perPlane = names(checkedPlaneByPlane);
  const partly = names(partlyByType);
  return [
    perPlane.length > 0 && `${namesAre(perPlane)} ${verb} plane by plane.`,
    partly.length > 0 && `${namesAre(partly)} ${verb} partly by aircraft type.`,
  ]
    .filter(Boolean)
    .join(" ");
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
export function ownCountAsOf(own: Pick<AirlineOwnCount, "asOf">): string {
  return `as of ${formatFactDate(own.asOf)}`;
}

/** What a by-type site prints beside its fleet-list sum: the airline's own
 * dated count where a current fact carries one, else its newest current dated
 * fact quoted whole, so the line can never name a figure a later fact retired. */
export type OwnFigureNote =
  | { kind: "count"; own: AirlineOwnCount }
  | { kind: "fact"; fact: RolloutFact & { asOf: string } };

export function ownFigureNote(code: string): OwnFigureNote | null {
  const own = airlineOwnCount(code);
  if (own) return { kind: "count", own };
  const fact = (factsForCode(code)?.facts ?? [])
    .filter((f): f is RolloutFact & { asOf: string } => !f.superseded && Boolean(f.asOf))
    .sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
  return fact ? { kind: "fact", fact } : null;
}

/** "as of Nov 16, 2026, as reported by The Peninsula": the date, and the
 * publisher too when the figure reached us through one. */
export function ownCountSourced(own: AirlineOwnCount): string {
  return `${ownCountAsOf(own)}${own.reportedBy ? `, as reported by ${own.reportedBy}` : ""}`;
}

/** The words before the source link. From the airline's own page: "per Qatar
 * Airways as of Aug 21, 2026", the link following in brackets. Through
 * another publisher: "the airline's own figure as of Nov 16, 2026, as
 * reported by", and the link is that publisher's name. */
export function ownCountCredit(cfg: AirlineConfig, own: AirlineOwnCount): string {
  return own.reportedBy
    ? `the airline's own figure ${ownCountAsOf(own)}, as reported by`
    : `per ${cfg.name} ${ownCountAsOf(own)}`;
}

const listed = (parts: string[]) =>
  parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join(" and ");

const typeCount = (n: number, family: string) =>
  `${fmt(n)} ${aircraftName(family)}${n === 1 ? "" : "s"}`;

/** "18 A321neos and 24 A330s": the counts as the source gives them. */
export function typeSumParts(sum: AirlineOwnTypeSum): string {
  return listed(sum.parts.map((p) => typeCount(p.count, p.name)));
}

/** "per Alaska's installation tracker as of Oct 26, 2026" */
export function typeSumCredit(sum: AirlineOwnTypeSum): string {
  return `per ${sum.by} ${ownCountAsOf(sum)}`;
}

/** "42, our sum of 18 A321neos and 24 A330s per Alaska's installation tracker
 * as of Oct 26, 2026": the figure for a sentence that ranks it. */
export function typeSumFigure(sum: AirlineOwnTypeSum): string {
  return `${fmt(sum.count)}, our sum of ${typeSumParts(sum)} ${typeSumCredit(sum)}`;
}

/** The headline figure and whose it is: the airline's chart while it counts
 * more than the named tails and is no older than them, else the named count. */
export function leadCount(c: {
  starlinkCount: number;
  totalCount: number;
  airlineCount?: AirlineChartCount | null;
}): { n: number; total: number; own: AirlineChartCount | null } {
  const own = c.airlineCount?.leads ? c.airlineCount : null;
  return own
    ? { n: own.connected, total: own.total, own }
    : { n: c.starlinkCount, total: c.totalCount, own: null };
}

/** "Alaska counts 4 737 MAX 9s that no source names by tail yet." */
export function unnamedSentence(cfg: AirlineConfig, c: AirlineChartCount): string | null {
  if (c.unnamed.length === 0) return null;
  return `${cfg.shortName} counts ${listed(c.unnamed.map((u) => typeCount(u.count, u.family)))} that no source names by tail yet.`;
}

/** Why the two denominators differ, from the two lists themselves: "Alaska's
 * chart leaves out the 11 737-700s on our fleet list and counts 5 787s where
 * we list 6." */
export function rosterDiffSentence(cfg: AirlineConfig, c: AirlineChartCount): string | null {
  const parts = c.rosterDiff.map((d) =>
    d.chart === null
      ? `leaves out the ${typeCount(d.ours, d.family)} on our fleet list`
      : `counts ${typeCount(d.chart, d.family)} where we list ${d.ours === 0 ? "none" : fmt(d.ours)}`
  );
  return parts.length > 0 ? `${cfg.shortName}'s chart ${listed(parts)}.` : null;
}
