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
import type { AirlineChartCount, AirlineChartGaps, ProgrammeHeadline } from "../database/roster";
import { aircraftName } from "./aircraft-families";
import { AIRLINES, type AirlineConfig, heldBackCount, wifiPhaseFamilies } from "./registry";
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

/** How a by-type sum was reached, for any sentence that prints one. */
export const BY_TYPE_METHOD = "counted by aircraft type, not checked plane by plane";

/** The sum in one sentence, for places with room for it: "149 Qatar Airways
 * aircraft on our fleet list are of types the airline reports finished,
 * leaving out 11 that aren't confirmed, counted by aircraft type, not checked
 * plane by plane". */
export function byTypeSumSentence(cfg: AirlineConfig, sum: number): string {
  return `${fmt(sum)} ${cfg.name} aircraft on our fleet list are of ${byTypeSumBasis(cfg.code)}, ${BY_TYPE_METHOD}`;
}

/** The heading over a by-type sum, or over the aircraft it adds up. */
export const BY_TYPE_SUM_LABEL = "On our fleet list, by aircraft type";

/** The badge's value for a by-type airline. Exactly as long as the
 * "N aircraft equipped" it replaces, so a badge already on someone's page
 * keeps its width. */
export function byTypeBadgeValue(sum: number): string {
  return `${fmt(sum)}, by aircraft type`;
}

/**
 * An all-airline figure, split by how each airline is known. Only airlines
 * counted on this site add up to a total of aircraft that have Starlink; an
 * airline known by aircraft type stays beside the total as its own fleet-list
 * sum, never inside it.
 */
export interface SplitTotal {
  counted: {
    /** Short names, in registry order. */
    names: string[];
    starlink: number;
    total: number;
    /** Every counted airline's roster is its programme's own denominator. */
    rosterIsProgramScope: boolean;
  };
  byType: Array<{ cfg: AirlineConfig; sum: number }>;
}

export function splitByMethod(
  per: ReadonlyArray<{ code: string; starlink: number; total: number }>
): SplitTotal {
  // Registry order, so every place names the airlines the same way round.
  const order = Object.keys(AIRLINES);
  const rows = per
    .flatMap((r) => (AIRLINES[r.code] ? [{ ...r, cfg: AIRLINES[r.code] }] : []))
    .sort((a, b) => order.indexOf(a.cfg.code) - order.indexOf(b.cfg.code));
  const counted = rows.filter((r) => trackingMethod(r.cfg) !== "type");
  return {
    counted: {
      names: counted.map((r) => r.cfg.shortName),
      starlink: counted.reduce((s, r) => s + r.starlink, 0),
      total: counted.reduce((s, r) => s + r.total, 0),
      rosterIsProgramScope: counted.every((r) => r.cfg.rollout.rosterIsProgramScope),
    },
    byType: rows
      .filter((r) => trackingMethod(r.cfg) === "type" && r.starlink > 0)
      .map((r) => ({ cfg: r.cfg, sum: r.starlink })),
  };
}

/** "United and Alaska": whose aircraft a split total counts. */
export function countedNames(split: SplitTotal): string {
  return listed(split.counted.names);
}

/** "Hawaiian's 42 on our fleet list are counted by aircraft type, not checked
 * plane by plane": what a split total leaves out, or null when nothing is. */
export function leftOutByType(split: SplitTotal): string | null {
  if (split.byType.length === 0) return null;
  const one = split.byType.length === 1 && split.byType[0].sum === 1;
  return `${listed(split.byType.map((b) => `${b.cfg.shortName}'s ${fmt(b.sum)}`))} on our fleet list ${one ? "is" : "are"} ${BY_TYPE_METHOD}`;
}

/** A programme headline that spans a by-type partner, as its two kinds. */
export interface ProgrammeParts {
  /** The airline's own aircraft, the only part counted on this site. */
  own: { equipped: number; total: number };
  /** "6 Alaska-operated aircraft counted on this site and 42 Hawaiian A321neo
   * & A330 counted by aircraft type, not checked plane by plane" */
  text: string;
}

type ProgrammeCount = Pick<ProgrammeHeadline, "equipped" | "total"> & {
  partners: ReadonlyArray<{ label: string; equipped: number; total: number }>;
};

/**
 * The combined figure is the scope the airline stated its target over, but
 * only the airline's own part was counted, so every sentence that prints the
 * figure names both parts and gives no share of the whole. Null when no
 * by-type partner adds to the figure.
 */
export function programmeParts(
  cfg: AirlineConfig,
  programme: ProgrammeCount
): ProgrammeParts | null {
  const partners = cfg.programmePartners?.partners ?? [];
  const slices = programme.partners.map((slice, i) => ({
    ...slice,
    byType:
      Boolean(AIRLINES[partners[i]?.airline]) &&
      trackingMethod(AIRLINES[partners[i].airline]) === "type",
  }));
  if (!slices.some((s) => s.byType && s.equipped > 0)) return null;
  const own = {
    equipped: programme.equipped - slices.reduce((sum, s) => sum + s.equipped, 0),
    total: programme.total - slices.reduce((sum, s) => sum + s.total, 0),
  };
  return {
    own,
    text: listed([
      `${fmt(own.equipped)} ${cfg.shortName}-operated aircraft counted on this site`,
      ...slices
        .filter((s) => s.equipped > 0)
        .map(
          (s) =>
            `${fmt(s.equipped)} ${s.label} ${s.byType ? BY_TYPE_METHOD : "counted on this site"}`
        ),
    ]),
  };
}

export function programmePartsText(cfg: AirlineConfig, programme: ProgrammeCount): string | null {
  return programmeParts(cfg, programme)?.text ?? null;
}

/** programmeParts from the homepage's ContentStats, which carries the same
 * headline under its own field names. */
export function statsParts(
  cfg: AirlineConfig,
  stats: {
    starlinkCount: number;
    totalCount: number;
    partners?: ReadonlyArray<{ label: string; starlink: number; total: number }>;
  }
): ProgrammeParts | null {
  return programmeParts(cfg, {
    equipped: stats.starlinkCount,
    total: stats.totalCount,
    partners: (stats.partners ?? []).map((p) => ({
      label: p.label,
      equipped: p.starlink,
      total: p.total,
    })),
  });
}

/** Whether a partner slice of this airline's programme is known by aircraft
 * type, by the slice's label ("Hawaiian A321neo & A330"). */
export function partnerIsByType(cfg: AirlineConfig, label: string): boolean {
  const partner = cfg.programmePartners?.partners.find((p) => p.label === label);
  return Boolean(
    partner && AIRLINES[partner.airline] && trackingMethod(AIRLINES[partner.airline]) === "type"
  );
}

/** Beside a by-type airline's row count where a list holds both kinds of
 * aircraft: "HAWAIIAN AIRLINES (42 by type)". */
export const BY_TYPE_TAB_NOTE = "by type";

/** The caption under a by-type sum on the share pictures (set in capitals,
 * no longer than the longest caption the card already carries). */
export const BY_TYPE_CARD_CAPTION = "ON OUR LIST, COUNTED BY TYPE";

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

export const listed = (parts: string[]) =>
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

/**
 * A type the airline's chart counts more of than this site names, said both
 * ways with the chart's owner and date: "Alaska counts 4 of its 80 737 MAX 9s
 * with Starlink (its chart of Oct 26, 2026). It doesn't say which aircraft,
 * so we list none by tail yet." Null once every type's figures meet.
 */
export function typeGapSentences(cfg: AirlineConfig, gaps: AirlineChartGaps): string | null {
  const { types } = gaps;
  if (types.length === 0) return null;
  const counts = listed(
    types.map((t) => `${fmt(t.connected)} of its ${typeCount(t.total, t.family)}`)
  );
  const ours = types.every((t) => t.named === 0)
    ? "so we list none by tail yet"
    : types.length === 1
      ? `and we list ${fmt(types[0].named)} by tail`
      : `and by tail we list ${listed(types.map((t) => `${t.named === 0 ? "none" : fmt(t.named)} of the ${aircraftName(t.family)}s`))}`;
  return `${cfg.shortName} counts ${counts} with Starlink (its chart of ${formatFactDate(gaps.asOf)}). It doesn't say which aircraft, ${ours}.`;
}

/** After our own mainline figure: "named by tail; Alaska counts 16 as of Oct
 * 26, 2026". Null unless the chart counts more mainline jets than are named. */
export function mainlineChartNote(cfg: AirlineConfig, gaps: AirlineChartGaps): string | null {
  return gaps.mainline
    ? `named by tail; ${cfg.shortName} counts ${fmt(gaps.mainline.connected)} ${ownCountAsOf(gaps)}`
    : null;
}
