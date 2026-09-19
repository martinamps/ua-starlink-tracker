/**
 * The /fleet/{slug} aircraft-type pages: which types get a page on which
 * tenant, how a URL segment resolves to one, and the verdict copy each page
 * leads with. Travelers search by type ("does the United 737-800 have
 * Starlink") because booking sites show a type, never a tail.
 *
 * Pure: page data arrives from getAircraftTypePageData, so every wording rule
 * here is unit-testable without a database.
 */

import type {
  AircraftTypePageData,
  AircraftTypePipeline,
  AircraftVerdictKind,
  WifiProvider,
} from "../types";
import { article } from "../utils/grammar";
import { type RolloutFact, factsForCode, formatFactDate } from "./rollout-facts";

export type AircraftPageTenant = "UA" | "AS";

export interface AircraftPageDef {
  slug: string;
  /** normalizeAircraftType family key. */
  family: string;
  name: string;
  /** H1/title form — keeps "/900ER"-style suffixes out of the title budget. */
  short: string;
  aliases: readonly string[];
  /** Raw-type splits shown as a table; dropped unless they cover every tail. */
  variants?: ReadonlyArray<{ label: string; match: RegExp }>;
  /** Serve only with a tagged dated fact or a confirmed tail: where the airline
   * publishes no per-tail status, an unconfirmed type has nothing true to say. */
  requiresSourcedFact?: boolean;
}

export const MIN_TYPE_TAILS = 5;

// Aliases never include "737-8" / "737-9" (Boeing's own names for the MAX 8/9,
// which travelers also type for the 737-800/900), bare "737", or "max": each
// would silently send someone to the wrong type.
const MAX8_ALIASES = ["737-max8", "737max8", "b38m", "38m", "max-8", "max8", "737-8-max"];
const MAX9_ALIASES = ["737-max9", "737max9", "b39m", "39m", "max-9", "max9", "737-9-max"];
const E175_ALIASES = ["erj-175", "erj175", "embraer-175", "embraer-e175", "e-175"];

export const AIRCRAFT_PAGES: Record<AircraftPageTenant, readonly AircraftPageDef[]> = {
  UA: [
    {
      slug: "e175",
      family: "E175",
      name: "Embraer E175",
      short: "E175",
      aliases: [...E175_ALIASES, "e175sc"],
    },
    {
      slug: "crj-550",
      family: "CRJ-550",
      name: "Bombardier CRJ550",
      short: "CRJ550",
      aliases: ["crj550", "crj-550er"],
    },
    {
      slug: "a321neo",
      family: "A321",
      name: "Airbus A321neo",
      short: "A321neo",
      aliases: ["a321", "a321-neo", "airbus-a321neo", "a321xlr", "a21n"],
      variants: [
        { label: "A321XLR", match: /XLR/i },
        { label: "A321neo", match: /A321/i },
      ],
    },
    {
      slug: "737-800",
      family: "B737-800",
      name: "Boeing 737-800",
      short: "737-800",
      aliases: ["738", "b738", "737800", "boeing-737-800"],
    },
    {
      slug: "737-900",
      family: "B737-900",
      name: "Boeing 737-900/900ER",
      short: "737-900",
      // No variant split: FR24 labels some -900ERs plain "737-900", so an
      // ER/non-ER table would misfile tails.
      aliases: ["739", "b739", "737900", "737-900er", "boeing-737-900"],
    },
    {
      slug: "737-max-9",
      family: "B737-MAX9",
      name: "Boeing 737 MAX 9",
      short: "737 MAX 9",
      aliases: MAX9_ALIASES,
    },
    {
      slug: "777",
      family: "B777",
      name: "Boeing 777",
      short: "777",
      aliases: ["b777", "boeing-777", "777-200", "777-200er", "777-300er", "77w"],
      variants: [
        { label: "777-300ER", match: /777-3/ },
        { label: "777-200/200ER", match: /777-2/ },
      ],
    },
    {
      slug: "737-max-8",
      family: "B737-MAX8",
      name: "Boeing 737 MAX 8",
      short: "737 MAX 8",
      aliases: MAX8_ALIASES,
    },
    {
      slug: "787",
      family: "B787",
      name: "Boeing 787 Dreamliner",
      short: "787",
      aliases: ["b787", "boeing-787", "dreamliner", "787-8", "787-9", "787-10"],
      variants: [
        { label: "787-10", match: /787-10/ },
        { label: "787-9", match: /787-9/ },
        { label: "787-8", match: /787-8/ },
      ],
    },
    {
      slug: "737-700",
      family: "B737-700",
      name: "Boeing 737-700",
      short: "737-700",
      aliases: ["73g", "b737-700", "737700", "boeing-737-700"],
    },
    {
      slug: "757",
      family: "B757",
      name: "Boeing 757",
      short: "757",
      aliases: ["b757", "boeing-757", "757-200", "757-300"],
      variants: [
        { label: "757-300", match: /757-3/ },
        { label: "757-200", match: /757-2/ },
      ],
    },
    {
      slug: "767",
      family: "B767",
      name: "Boeing 767",
      short: "767",
      aliases: ["b767", "boeing-767", "767-300", "767-300er", "767-400", "767-400er"],
      variants: [
        { label: "767-400ER", match: /767-4/ },
        { label: "767-300ER", match: /767-3/ },
      ],
    },
    { slug: "a319", family: "A319", name: "Airbus A319", short: "A319", aliases: ["airbus-a319"] },
    { slug: "a320", family: "A320", name: "Airbus A320", short: "A320", aliases: ["airbus-a320"] },
    {
      slug: "crj-200",
      family: "CRJ-200",
      name: "Bombardier CRJ200",
      short: "CRJ200",
      aliases: ["crj200", "crj2"],
    },
    {
      slug: "erj-145",
      family: "ERJ-145",
      name: "Embraer ERJ-145",
      short: "ERJ-145",
      aliases: ["erj145", "e145", "embraer-145"],
    },
  ],
  // Every Alaska def needs a sourced fact: alaskaair.com confirms Starlink per
  // flight but publishes nothing per aircraft for the rest, so without Alaska's
  // own dated figure a page could only say "we don't know".
  AS: [
    {
      slug: "e175",
      family: "E175",
      name: "Embraer E175",
      short: "E175",
      aliases: [...E175_ALIASES, "e175lr"],
      requiresSourcedFact: true,
    },
    {
      slug: "737-max-8",
      family: "B737-MAX8",
      name: "Boeing 737 MAX 8",
      short: "737 MAX 8",
      aliases: MAX8_ALIASES,
      requiresSourcedFact: true,
    },
    {
      slug: "737-max-9",
      family: "B737-MAX9",
      name: "Boeing 737 MAX 9",
      short: "737 MAX 9",
      aliases: MAX9_ALIASES,
      requiresSourcedFact: true,
    },
    {
      slug: "737-800",
      family: "B737-800",
      name: "Boeing 737-800",
      short: "737-800",
      aliases: ["738", "b738", "737800", "boeing-737-800"],
      requiresSourcedFact: true,
    },
    {
      slug: "737-900",
      family: "B737-900",
      name: "Boeing 737-900ER",
      short: "737-900",
      aliases: ["739", "b739", "737900", "737-900er", "boeing-737-900"],
      requiresSourcedFact: true,
    },
    {
      slug: "787",
      family: "B787",
      name: "Boeing 787-9 Dreamliner",
      short: "787",
      aliases: ["b787", "boeing-787", "dreamliner", "787-9"],
      requiresSourcedFact: true,
    },
  ],
};

export function aircraftPagesFor(code: string): readonly AircraftPageDef[] {
  return AIRCRAFT_PAGES[code as AircraftPageTenant] ?? [];
}

const SEGMENT_RE = /^[a-z0-9-]{1,40}$/;

/** A URL segment → its type page. `redirect` when the segment is not the
 * canonical slug (an alias, or different case), so the caller 301s. */
export function resolveAircraftSlug(
  code: string,
  segment: string
): { def: AircraftPageDef; redirect: boolean } | null {
  const lower = segment.toLowerCase();
  if (!SEGMENT_RE.test(lower)) return null;
  const pages = aircraftPagesFor(code);
  const exact = pages.find((d) => d.slug === lower);
  if (exact) return { def: exact, redirect: segment !== exact.slug };
  const aliased = pages.find((d) => d.aliases.includes(lower));
  return aliased ? { def: aliased, redirect: true } : null;
}

export function aircraftPageForFamily(code: string, family: string): AircraftPageDef | null {
  return aircraftPagesFor(code).find((d) => d.family === family) ?? null;
}

/** United fleet progress sheet column codes → family. Every code the sheet has
 * carried is listed, typed or not, so an unmapped code is a new column. */
export const SHEET_CODE_TO_FAMILY: Readonly<Record<string, string>> = {
  "73G": "B737-700",
  "738": "B737-800",
  "739": "B737-900",
  "38M": "B737-MAX8",
  "39M": "B737-MAX9",
  "319": "A319",
  "320": "A320",
  "321": "A321",
  "321XLR": "A321",
  "752": "B757",
  "753": "B757",
  "763": "B767",
  "764": "B767",
  "763A/Q": "B767",
  "763L": "B767",
  "764S/U": "B767",
  "772A/E": "B777",
  GE: "B777",
  PW: "B777",
  "77W": "B777",
  "788": "B787",
  "789": "B787",
  "789L": "B787",
  "78X": "B787",
  E175: "E175",
  E175SC: "E175",
  E170: "E170",
  CRJ7: "CRJ-700",
  CRJ550: "CRJ-550",
  CRJ2: "CRJ-200",
  E145X: "ERJ-145",
};

/** The progress sheets' column shorthand, spelled out for display. */
export const TYPE_DISPLAY: Record<string, string> = {
  "73G": "737-700",
  "738": "737-800",
  "739": "737-900",
  "38M": "737 MAX 8",
  "39M": "737 MAX 9",
  "319": "A319",
  "320": "A320",
  "321": "A321",
  "321XLR": "A321XLR",
  "752": "757-200",
  "753": "757-300",
  "763": "767-300",
  "764": "767-400",
  GE: "777-200",
  PW: "777-200",
  "77W": "777-300ER",
  "788": "787-8",
  "789": "787-9",
  "78X": "787-10",
  "763A/Q": "767-300ER",
  "763L": "767-300ER",
  "764S/U": "767-400ER",
  "772A/E": "777-200ER",
  "789L": "787-9",
  CRJ2: "CRJ200",
  E145X: "ERJ-145XR",
};

export function sheetCodesFor(family: string): string[] {
  return Object.keys(SHEET_CODE_TO_FAMILY).filter((c) => SHEET_CODE_TO_FAMILY[c] === family);
}

function factDate(f: RolloutFact): string {
  return f.asOf ?? f.accessed ?? "";
}

/** Dated facts tagged for this type page (or every page of the airline), newest first. */
export function typeFactsFor(code: string, slug: string): RolloutFact[] {
  const facts = factsForCode(code)?.facts ?? [];
  return facts
    .filter((f) => f.aircraftPages?.includes(slug) || f.aircraftPages?.includes("*"))
    .sort((a, b) => factDate(b).localeCompare(factDate(a)));
}

export interface OfficialCount {
  count: number;
  asOf: string;
  sourceLabel: string;
  url: string;
}

/** The airline's own newest per-type figure, from the facts that state one. */
export function officialCountFor(code: string, slug: string): OfficialCount | null {
  const fact = typeFactsFor(code, slug).find((f) => f.officialCounts?.[slug] !== undefined);
  if (!fact?.officialCounts) return null;
  return {
    count: fact.officialCounts[slug],
    asOf: factDate(fact),
    sourceLabel: fact.source.label,
    url: fact.source.url,
  };
}

/** A sourced-fact def the airline itself counts only needs one roster row:
 * Alaska names its 787s, so losing a tail row must not 404 an indexed URL. */
export function minTypeTails(code: string, def: AircraftPageDef): number {
  return def.requiresSourcedFact && officialCountFor(code, def.slug) ? 1 : MIN_TYPE_TAILS;
}

interface TenantCopy {
  airline: string;
  possessive: string;
  evidence: string;
  /** The verifier records non-Starlink tails too, so "unchecked" means something. */
  checksEveryTail: boolean;
}

const TENANT_COPY: Record<AircraftPageTenant, TenantCopy> = {
  UA: {
    airline: "United",
    possessive: "United's",
    evidence: "verified against united.com",
    checksEveryTail: true,
  },
  AS: {
    airline: "Alaska",
    possessive: "Alaska's",
    evidence: "confirmed from per-aircraft reports",
    checksEveryTail: false,
  },
};

export function tenantCopy(code: string): TenantCopy {
  return TENANT_COPY[code as AircraftPageTenant] ?? TENANT_COPY.UA;
}

export const PROVIDER_NAMES: Record<WifiProvider, string> = {
  starlink: "Starlink",
  viasat: "Viasat",
  panasonic: "Panasonic",
  thales: "Thales",
  none: "no WiFi",
  unknown: "not checked yet",
};

/** Floor, never round up: "100%" only when every tail has it. */
export function sharePct(n: number, total: number): string {
  if (total <= 0) return "0%";
  if (n >= total) return "100%";
  const p = (n / total) * 100;
  if (p > 99) return ">99%";
  if (p > 0 && p < 1) return "<1%";
  return `${Math.floor(p)}%`;
}

export function isoDay(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

const OFFICIAL_STALE_DAYS = 45;
const PIPELINE_ACTIVE = (p: AircraftTypePipeline | null) =>
  p ? p.starlink_complete + p.in_mod + p.verification_needed : 0;

export interface AircraftAnswer {
  kind: AircraftVerdictKind;
  headline: string;
  sentence: string;
  /** Fleet share for someone booked on the type; null when there is none. */
  shareLine: string | null;
  indexable: boolean;
  /** The count the verdict is built on: ours, or the airline's own when higher. */
  effective: number;
  official: OfficialCount | null;
}

type AnswerInput = Pick<
  AircraftTypePageData,
  | "airline"
  | "total"
  | "starlink"
  | "knownOther"
  | "unchecked"
  | "listedAwaitingVerification"
  | "pipeline"
  | "dataClock"
>;

const INDEXABLE_KINDS: ReadonlySet<AircraftVerdictKind> = new Set([
  "all",
  "all_checked",
  "most",
  "some",
  "verifying",
]);

export const SHARE_KINDS: ReadonlySet<AircraftVerdictKind> = new Set([
  "all",
  "all_checked",
  "most",
  "some",
]);

const SWAP_NOTE =
  "Aircraft swaps happen; the real answer comes when the tail is assigned, about 1–2 days out.";

/**
 * The verdict a type page leads with. Decided on the tails actually checked:
 * a newly delivered tail the verifier hasn't reached yet must not flip "every
 * one" to "most", and a listing still awaiting its first check is "not
 * verified yet", never "no". On Alaska, whose per-aircraft status is not
 * public, the airline's own dated figure drives the count whenever it is
 * higher than what we can confirm tail by tail.
 */
export function answerFor(
  data: AnswerInput,
  def: AircraftPageDef,
  official: OfficialCount | null
): AircraftAnswer {
  const copy = tenantCopy(data.airline);
  const { total: T, starlink: s, knownOther: K, unchecked: U } = data;
  const L = data.listedAwaitingVerification.length;
  const O = official;
  const E = O ? Math.max(s, Math.min(O.count, T)) : s;
  const attributed = O !== null && O.count > s;
  const pct = sharePct(E, T);
  const short = def.short;
  const shorts = `${short}s`;
  const oDate = O ? formatFactDate(O.asOf) : "";
  const listedTail =
    L > 0 && copy.checksEveryTail ? ` +${L} more listed, awaiting a united.com check.` : "";
  const staleOfficial =
    O &&
    data.dataClock &&
    Date.parse(O.asOf) < (data.dataClock - OFFICIAL_STALE_DAYS * 86400) * 1000
      ? ` ${copy.possessive} tracker hasn't been updated since ${oDate}.`
      : "";

  const build = (
    kind: AircraftVerdictKind,
    headline: string,
    sentence: string,
    shareLine: string | null = null
  ): AircraftAnswer => ({
    kind,
    headline,
    sentence: `${sentence}${staleOfficial}`,
    shareLine,
    indexable: INDEXABLE_KINDS.has(kind),
    effective: E,
    official: O,
  });

  const attributedShare = () =>
    `${copy.airline} reports ${O?.count} of its ${T} ${shorts} connected (${oDate}), about ${pct}. We have tail-level confirmation for ${s}. ${SWAP_NOTE}`;

  if (E > 0 && E === T && (!copy.checksEveryTail || (K === 0 && U === 0))) {
    if (O && O.count >= T && attributed) {
      const ours =
        s === T
          ? `every one of the ${T} in our roster is ${copy.evidence}`
          : `${s} of the ${T} in our roster are ${copy.evidence}`;
      return build(
        "all",
        "Yes, every one.",
        `${copy.airline} reports all ${O.count} of its ${shorts} connected (tracker updated ${oDate}), and ${ours}.`,
        `Every ${copy.airline} ${short} has Starlink per ${copy.possessive} own count, so it's near-certain unless the aircraft is swapped for another type.`
      );
    }
    const officialNote =
      O && O.count >= T
        ? ` ${copy.airline} reports all ${O.count} of its ${shorts} connected (tracker updated ${oDate}).`
        : "";
    return build(
      "all",
      "Yes, every one.",
      `All ${T} ${copy.airline} ${shorts} have Starlink, each ${copy.evidence}.${officialNote}`,
      `Every ${copy.airline} ${short} has Starlink, so it's near-certain unless the aircraft is swapped for another type.`
    );
  }

  if (copy.checksEveryTail && s > 0 && K === 0 && U > 0) {
    return build(
      "all_checked",
      "Every one we've checked.",
      `${s} of ${T} ${copy.airline} ${shorts} have Starlink, ${copy.evidence}; ${U} ${plural(U, "tail")} not checked yet.`,
      `Every ${short} we've checked has Starlink, so it's near-certain unless the aircraft is swapped for another type or you draw ${U === 1 ? "the one unchecked tail" : `one of the ${U} unchecked`}.`
    );
  }

  if (E > 0) {
    const most = E / T >= 0.5;
    const kind = most ? "most" : "some";
    const lead = most ? "Most do" : "Some do";
    if (attributed) {
      return build(
        kind,
        `${lead}, per ${copy.airline}: ${E} of ${T} (${pct}).`,
        `${copy.airline} reports ${O?.count} of its ${T} ${shorts} connected (tracker updated ${oDate}). We can confirm ${s} of them ourselves, from per-aircraft reports.`,
        attributedShare()
      );
    }
    return build(
      kind,
      `${lead}: ${E} of ${T} (${pct}).`,
      `Every Starlink ${short} counted here is ${copy.evidence}.${listedTail}`,
      `${pct} of ${copy.possessive} ${shorts} have Starlink (${E} of ${T}). ${SWAP_NOTE}`
    );
  }

  const active = PIPELINE_ACTIVE(data.pipeline);
  if (L > 0 || active > 0) {
    const listed = `${L} ${plural(L, "tail is", "tails are")} listed with Starlink, awaiting a united.com check.`;
    const sentence =
      active > 0 && data.pipeline
        ? `${active} ${plural(active, "install")} finished or under way per the United fleet progress sheet (fetched ${formatFactDate(isoDay(data.pipeline.fetched_at))}), none confirmed on united.com yet for the ${short}.${L > 0 ? ` ${listed}` : ""}`
        : `${copy.airline} ${short}: ${listed} None is confirmed there yet.`;
    return build("verifying", "Not verified yet.", sentence);
  }

  if (O && O.count === 0) {
    return build(
      "official_none",
      `Not yet, per ${copy.possessive} own tracker.`,
      `${copy.possessive} Starlink tracker (updated ${oDate}) shows no ${short} connected yet; our roster has ${T}.`
    );
  }

  if (def.requiresSourcedFact && !O) {
    return build(
      "unknown",
      "Unconfirmed.",
      `${copy.airline} hasn't published a count for the ${short}; we have no confirmed tails among its ${T} yet.`
    );
  }

  return build(
    "none",
    `Not yet: 0 of ${T}.`,
    U > 0
      ? `None of ${copy.possessive} ${T} ${shorts} has Starlink yet: ${T - U} checked on united.com, ${U} not checked yet.`
      : `None of ${copy.possessive} ${T} ${shorts} has Starlink yet, each checked on united.com.`
  );
}

export const TITLE_MAX = 60;

/**
 * <title> by ladder: the count-bearing question when it fits, then a short
 * count form, then a count-less one. withClampedMeta clamps descriptions only,
 * so a title has to be built inside the budget — and never says "Not Yet"
 * for a type that is merely unverified.
 */
export function aircraftTypeTitle(
  data: Pick<AircraftTypePageData, "airline" | "total" | "starlink">,
  def: AircraftPageDef,
  answer: Pick<AircraftAnswer, "kind" | "effective" | "official">
): string {
  const { airline, possessive } = tenantCopy(data.airline);
  const s = def.short;
  const T = data.total;
  const E = answer.effective;
  const perAirline = answer.official !== null && answer.official.count > data.starlink;
  const ladder: string[] = [];
  switch (answer.kind) {
    case "all":
      ladder.push(`${airline} ${s} Starlink: Yes, All ${T}`);
      break;
    case "all_checked":
      ladder.push(`${airline} ${s} Starlink: Every One Checked (${data.starlink})`);
      break;
    case "most":
    case "some":
      if (perAirline) ladder.push(`${airline} ${s} Starlink: ${E} of ${T}, per ${airline}`);
      // "1 of 96 Do" doesn't parse; a lone tail takes the plain count form.
      else if (E > 1) ladder.push(`Does the ${airline} ${s} Have Starlink? ${E} of ${T} Do`);
      ladder.push(`${airline} ${s} Starlink: ${E} of ${T}`);
      break;
    case "verifying":
      ladder.push(`Does ${possessive} ${s} Have Starlink? Not Verified Yet`);
      ladder.push(`${airline} ${s} Starlink: Not Verified Yet`);
      break;
    case "official_none":
      ladder.push(`${airline} ${s} Starlink: Not Yet, per ${airline}`);
      break;
    case "none":
      ladder.push(`Does the ${airline} ${s} Have Starlink? Not Yet`);
      ladder.push(`${airline} ${s} Starlink: Not Yet`);
      break;
    case "unknown":
      break;
  }
  ladder.push(`${airline} ${s} Starlink Status`);
  return ladder.find((t) => t.length <= TITLE_MAX) ?? `${airline} ${s} Starlink`;
}

/** The United progress sheet next to our own count, attributed both ways and
 * neutral about which runs ahead (ours is above the sheet as often as below). */
export function sheetComparison(pipeline: AircraftTypePipeline, starlink: number): string[] {
  const fetched = formatFactDate(isoDay(pipeline.fetched_at));
  const lines = [
    `Per the United fleet progress sheet (fetched ${fetched}): ${pipeline.starlink_complete} complete, ${pipeline.in_mod} in mod, ${pipeline.verification_needed} awaiting verification. Verified by us on united.com: ${starlink}.`,
  ];
  if (pipeline.starlink_complete !== starlink) {
    lines.push(
      "The sheet and united.com update independently, so the two counts don't always match."
    );
  }
  return lines;
}

const TARGET_RE = /\bby (the )?(end|fall|summer|spring|following|early|mid)/i;

export function factText(f: RolloutFact): string {
  return f.pageText ?? f.fact;
}

/** The newest dated fact that states a completion target, preferring one
 * about this type over a whole-fleet one. */
export function targetFact(facts: RolloutFact[], slug: string): RolloutFact | null {
  const targets = facts.filter((f) => f.asOf && TARGET_RE.test(factText(f)));
  return targets.find((f) => f.aircraftPages?.includes(slug)) ?? targets[0] ?? null;
}

export interface TypeFaqItem {
  q: string;
  a: string;
  /** Same answer with an inline link; `a` is what FAQPage JSON-LD carries. */
  aHtml?: { before: string; linkText: string; href: string; after: string };
}

export interface TypeFaqOptions {
  /** One-sentence "is it free" answer for the airline. */
  freeAccess?: string | null;
  /** /is-starlink-free where that page serves. */
  freeHref?: string | null;
}

/**
 * The visible FAQ, which the FAQPage JSON-LD is built from verbatim. Every
 * answer carries this type's own numbers — a generic "how do I check" answer
 * repeated on sixteen URLs is the duplicate cluster these pages must not be.
 */
export function aircraftTypeFaq(
  data: AircraftTypePageData,
  def: AircraftPageDef,
  facts: RolloutFact[],
  official: OfficialCount | null,
  opts: TypeFaqOptions = {}
): TypeFaqItem[] {
  const copy = tenantCopy(data.airline);
  const answer = answerFor(data, def, official);
  const short = def.short;
  const shorts = `${short}s`;
  const items: TypeFaqItem[] = [
    {
      q: `Does the ${copy.airline} ${short} have Starlink?`,
      a: `${answer.headline} ${answer.sentence}`,
    },
  ];

  if (copy.checksEveryTail && data.knownOther > 0) {
    const parts = (["viasat", "panasonic", "thales", "none"] as const)
      .filter((p) => data.providers[p] > 0)
      .map(
        (p) =>
          `${data.providers[p]} ${data.providers[p] === 1 ? "has" : "have"} ${p === "none" ? "no WiFi" : PROVIDER_NAMES[p]}`
      );
    const unchecked = data.unchecked > 0 ? ` ${data.unchecked} not checked yet.` : "";
    items.push({
      q: `What WiFi do ${copy.possessive} ${data.starlink > 0 ? "other " : ""}${shorts} have?`,
      a:
        data.starlink > 0
          ? `Of the ${data.checked} ${copy.airline} ${shorts} last checked on united.com, ${data.starlink} have Starlink; of the rest, ${parts.join(", ")}.${unchecked}`
          : `Of the ${data.checked} ${copy.airline} ${shorts} last checked on united.com, ${parts.join(", ")}.${unchecked}`,
    });
  }

  const target = answer.kind === "all" ? null : targetFact(facts, def.slug);
  if (target?.asOf) {
    items.push({
      q: `When will every ${copy.airline} ${short} have Starlink?`,
      a: `No date is published for the ${short} alone. The closest dated target (${formatFactDate(target.asOf)}, ${target.source.label}): ${factText(target)}`,
    });
  }

  if (SHARE_KINDS.has(answer.kind) && opts.freeAccess) {
    const terms = opts.freeAccess.replace(/^Yes\b[\s—–,.:-]*/i, "");
    const lead = `Yes, on the ${answer.effective} equipped ${copy.airline} ${shorts}: ${terms.charAt(0).toUpperCase()}${terms.slice(1)}`;
    items.push({
      q: `Is Starlink free on ${copy.possessive} ${short}?`,
      a: lead,
      ...(opts.freeHref
        ? {
            aHtml: {
              before: `${lead} `,
              linkText: "The fine print",
              href: opts.freeHref,
              after: ".",
            },
          }
        : {}),
    });
  }

  const linked = data.flightNumbers.slice(0, 5).map((f) => f.flightNumber);
  if (linked.length >= 3) {
    items.push(
      data.flightNumbersScope === "starlink_only"
        ? {
            q: `Which ${copy.airline} flights recently had a Starlink ${short}?`,
            a: `In the last 30 days, a Starlink-equipped ${short} flew ${linked.join(", ")} most often. Check your own flight by number for the tail actually assigned.`,
          }
        : {
            q: `Which ${copy.airline} flights usually use ${article(short)} ${short}?`,
            a: `Over the last 30 days of observed assignments, ${linked.join(", ")} most often got ${article(short)} ${short}. Check your own flight by number for the tail actually assigned.`,
          }
    );
  }

  if (
    !copy.checksEveryTail &&
    official &&
    (official.count > data.starlink || answer.kind === "official_none")
  ) {
    items.push({
      q: "Why does this page cite Alaska instead of tail data?",
      a: `Alaska doesn't publish WiFi status per aircraft, so for the ${short} this page quotes ${copy.possessive} own Starlink tracker (updated ${formatFactDate(official.asOf)}) and counts only tails we can confirm ourselves: ${data.starlink} so far.`,
    });
  }

  return items.slice(0, 5);
}
