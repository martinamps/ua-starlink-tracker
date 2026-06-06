/**
 * Airline registry — the single source of per-airline configuration.
 * Adding an airline = adding a config object here, not editing scattered code.
 */

import type { VerificationSource } from "../database/database";
import type { RolloutStatus, StarlinkStatus } from "../types";
import { normalizeAircraftType } from "./aircraft-families";

// Registration patterns are stored as unanchored bodies; the anchored
// validation pattern and the global scan pattern (for pulling registrations
// out of prose) both derive from the same body, so they can never disagree.
function tailPatterns(body: string): { tailPattern: RegExp; tailScanPattern: RegExp } {
  return {
    tailPattern: new RegExp(`^${body}$`),
    tailScanPattern: new RegExp(`\\b(?:${body})\\b`, "g"),
  };
}

// FAA N-numbers: N + 1-5 alphanumeric, first 1-9, no I/O in suffix.
const FAA_TAIL = tailPatterns("N[1-9][0-9A-HJ-NP-Z]{0,4}");
const QATAR_TAIL = tailPatterns("A7-[A-Z]{3}");

export type AirlineCode = string;

export interface SubfleetDef {
  key: string;
  label: string;
  match: (flightNumber: string) => boolean;
  /** Display-only flight-number-range hint for the route-compare "mixed equipment" row. */
  flightNumberHint?: string;
  /** Fixed Starlink rate when this subfleet flies on another carrier's metal
   * (e.g. AS800-899 on Hawaiian A330/A321neo). */
  penetrationOverride?: number;
}

export interface PageBrand {
  /** Display title (rendered in-page) */
  title: string;
  tagline: string;
  /** SEO `<title>` tag */
  siteTitle: string;
  /** Meta description / og:description fallback */
  description: string;
  ogTitle: string;
  ogDescription: string;
  keywords: string;
  accentColor: string;
  accentColorDim: string;
  /** Brand color tuned for the favicon's glowing arc on a dark tile —
   * defaults to accentColor when omitted. */
  faviconAccent?: string;
  /** og:image / twitter:image path. Filenames are derived from this everywhere
   * (static routes, generate-og-images output). The server falls back to the
   * hub card if the asset hasn't been generated yet (see resolveSocialImage). */
  socialImagePath: string;
  analyticsDomain: string;
  pressReleaseUrl?: string;
}

export interface AnalyticsConfig {
  scriptSrc: string;
  dataDomain: string;
  eventApiUrl?: string;
}

export interface SiteFeatures {
  homeNav: boolean;
  checkFlightPage: boolean;
  routePlannerPage: boolean;
  fleetPage: boolean;
  mcpPage: boolean;
  chromeExtension: boolean;
}

export interface SiteConfig {
  key: string;
  scope: AirlineCode | "ALL";
  live: boolean;
  hosts: string[];
  canonicalHost: string;
  brand: PageBrand;
  analytics: AnalyticsConfig | null;
  features: SiteFeatures;
  headSnippet?: string;
}

export type LastUpdatedOwner = "fleet-meta" | "sheet-scrape" | "schedule-ingester";

export interface AirlineConfig {
  code: AirlineCode;
  name: string;
  /** Brand-only short form ("United", "Alaska") for titles where the full
   * legal name pushes the keyword past mobile SERP truncation (~50–55 chars). */
  shortName: string;
  /** Background jobs (scrape/verify/discover/sync) skip airlines with enabled=false. resolveTenant still resolves them. */
  enabled: boolean;
  /** Included on public hub surfaces and hub-only APIs. */
  publicInHub: boolean;
  iata: string;
  icao: string;
  /** All operating-carrier prefixes (ICAO + IATA) that map to this marketing carrier. Longest-first. */
  carrierPrefixes: string[];
  subfleets: SubfleetDef[];
  /** Map FR24/ICAO aircraft-type strings to a subfleet key for fleet-sync. Defaults to 'mainline'. */
  classifyFleet?: (aircraftType: string) => string;
  fr24Slug?: string;
  /** Wholly-owned regional carriers with their own FR24 roster (Horizon for AS, etc.). fleet-sync + seed scripts iterate these in addition to fr24Slug. */
  regionalCarriers?: { fr24Slug: string; name: string; subfleet: string }[];
  /** Reject fleet-sync results below this size as obviously wrong. */
  minFleetSanity: number;
  /** Per-flight wifi verification source; null = none (type-map only). */
  verifierBackend?: "united" | "alaska-json" | "qatar-fltstatus" | null;
  /** Sole writer of this airline's `lastUpdated` meta. Every writer stamps
   * via stampLastUpdated, which no-ops unless the caller IS the owner — so a
   * daily fleet sync can't mask a dead primary pipeline. Default "fleet-meta"
   * (refreshFleetMeta); UA = "sheet-scrape", QR = "schedule-ingester". */
  lastUpdatedOwner?: LastUpdatedOwner;
  /** A per-flight Starlink probability model exists, trained on THIS airline's
   * observation log. False → prediction surfaces answer from type rules and
   * subfleet penetration instead; another carrier's priors never apply. */
  flightHistoryModel: boolean;
  /** Site users should double-check answers on (flight status / WiFi pages). */
  verifySite: string;
  /** For airlines whose Starlink status is fully determined by aircraft type
   * (no per-tail observation needed). null = leave as unknown (in progress). */
  typeDeterministicWifi?: (aircraftType: string) => StarlinkStatus | null;
  /** Type-deterministic route rule for airlines whose Starlink status depends only on aircraft type / route class, not per-tail observation. */
  routeTypeRule?: (
    origin: string,
    destination: string
  ) => { probability: number; reason: string } | null;
  /** Canonical lowercase tag for Datadog `airline:` — preserves history (`united`, not `UA`). */
  metricTag: string;
  /** Anchored registration format for tails operated by this airline. Used to
   * reject sheet typos at ingest and gate cleanup scripts. Built by
   * tailPatterns() from the same body as tailScanPattern. */
  tailPattern: RegExp;
  /** Global word-boundary scan variant of tailPattern, for pulling
   * registrations out of prose (FlyerTalk posts, wikiposts). Safe to share:
   * String.match(/g/) and matchAll don't depend on lastIndex. */
  tailScanPattern: RegExp;
  /** Rollout story — hub status card + llms.txt copy. Required so a new
   * airline without a rollout story is a compile error, not missing prose. */
  rollout: {
    status: RolloutStatus;
    statusLabel: string;
    phaseNote: string;
  };
  brand: PageBrand;
}

function flightNum(fn: string): number {
  const m = fn.match(/(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : Number.NaN;
}

const AIRLINE_DEFS = {
  UA: {
    code: "UA",
    name: "United Airlines",
    shortName: "United",
    enabled: true,
    publicInHub: true,
    iata: "UA",
    icao: "UAL",
    // ACA (Air Canada), PDT (Piedmont), and ENY (Envoy) are deliberately
    // absent — they don't operate United Express, so e.g. ACA123 must never
    // resolve to UA123.
    carrierPrefixes: [
      "UAL",
      "SKW",
      "ASH",
      "RPA",
      "GJS",
      "UCA",
      "AWI",
      "OO",
      "YX",
      "YV",
      "G7",
      "C5",
      "ZW",
    ],
    subfleets: [
      {
        key: "express",
        label: "United Express Fleet",
        flightNumberHint: "UA3000-6999",
        match: (fn) => {
          const n = flightNum(fn);
          return n >= 3000 && n <= 6999;
        },
      },
      {
        key: "mainline",
        label: "United Mainline Fleet",
        flightNumberHint: "UA1-2999",
        match: (fn) => {
          const n = flightNum(fn);
          return Number.isFinite(n) && !(n >= 3000 && n <= 6999);
        },
      },
    ],
    classifyFleet: (t) => {
      if (/E175|ERJ.?175|CRJ|CR[27]|EMB/i.test(t)) return "express";
      if (/737|757|767|777|787|A3[12]\d|A350/i.test(t)) return "mainline";
      return "unknown";
    },
    fr24Slug: "ua-ual",
    metricTag: "united",
    ...FAA_TAIL,
    minFleetSanity: 800,
    verifierBackend: "united",
    // UA meta (totals + lastUpdated) comes from the community sheet, not FR24.
    lastUpdatedOwner: "sheet-scrape",
    flightHistoryModel: true,
    verifySite: "united.com",
    // Whole fleet eligible — Express + mainline both in the program.
    rollout: {
      status: "in_progress",
      statusLabel: "In progress",
      phaseNote:
        "Started with regional jets in early 2025; rolling out across United Express and mainline.",
    },
    brand: {
      title: "United Airlines Starlink Tracker",
      tagline: "Tracking United Airlines aircraft with Starlink WiFi",
      // {{starlinkCount}}/{{totalAircraftCount}} resolve in buildBaseTemplateVars();
      // og:title intentionally has no count — social platforms cache OG metadata.
      siteTitle: "United Starlink Tracker — {{starlinkCount}} Aircraft Have Starlink Today",
      description:
        "{{starlinkCount}} of {{totalAircraftCount}} United aircraft have Starlink today, verified against united.com. Check any flight by number, browse the fleet, and watch the install rate.",
      ogTitle: "United Starlink Tracker — Live Fleet Rollout",
      ogDescription:
        "Check any United flight for free Starlink WiFi. Per-tail status verified against united.com, live rollout progress, and the best routes for fast internet.",
      keywords: "united starlink tracker, united starlink wifi",
      accentColor: "#0ea5e9",
      accentColorDim: "#0284c7",
      faviconAccent: "#1d70c9", // United "Pacific Blue" — closer to brand than the site's sky-500
      socialImagePath: "/static/social-image.webp",
      analyticsDomain: "unitedstarlinktracker.com",
      pressReleaseUrl: "https://www.united.com/en/us/newsroom/announcements/cision-125370",
    },
  },
  HA: {
    code: "HA",
    name: "Hawaiian Airlines",
    shortName: "Hawaiian",
    enabled: true,
    publicInHub: true,
    iata: "HA",
    icao: "HAL",
    carrierPrefixes: ["HAL", "HA"],
    subfleets: [{ key: "mainline", label: "Hawaiian Fleet", match: () => true }],
    fr24Slug: "ha-hal",
    metricTag: "hawaiian",
    ...FAA_TAIL,
    minFleetSanity: 30,
    verifierBackend: "alaska-json",
    flightHistoryModel: false,
    verifySite: "hawaiianairlines.com",
    typeDeterministicWifi: hawaiianTypeToWifi,
    // 717 interisland fleet was never in scope (no WiFi provider) and is being retired —
    // see HA's own press release. Denominator is the Airbus fleet only.
    rollout: {
      status: "complete",
      statusLabel: "Complete",
      phaseNote: "Every A330 and A321neo has Starlink. The 717 interisland jets won't get it.",
    },
    routeTypeRule: (o, d) => {
      // Hawaiian's network is hub-and-spoke from Hawai'i — every route touches
      // an island airport. Routes between two mainland cities aren't HA routes.
      const HI = new Set(["HNL", "OGG", "KOA", "LIH", "ITO", "MKK", "LNY"]);
      if (!HI.has(o) && !HI.has(d)) return null;
      return HI.has(o) && HI.has(d)
        ? { probability: 0, reason: "Interisland — Boeing 717, no WiFi" }
        : { probability: 1, reason: "All Hawaiian A330/A321neo have Starlink" };
    },
    brand: {
      title: "Hawaiian Airlines Starlink Tracker",
      tagline: "Tracking Hawaiian Airlines aircraft with Starlink WiFi",
      siteTitle: "Hawaiian Airlines Starlink — Every A330 and A321neo Has Free WiFi",
      description:
        "Hawaiian Airlines completed its Starlink rollout in September 2024. Every Airbus A330 and A321neo has free, gate-to-gate Starlink WiFi; the 717 interisland fleet does not have WiFi. See which aircraft is on your flight.",
      ogTitle: "Hawaiian Airlines Starlink — Rollout Complete",
      ogDescription:
        "Every Hawaiian A330 and A321neo has free gate-to-gate Starlink — the first U.S. carrier with a full fleet install. 717 interisland flights have no WiFi.",
      keywords:
        "hawaiian airlines starlink, hawaiian airlines wifi, does hawaiian have wifi, hawaiian a330 starlink, hawaiian a321neo wifi, hawaiian 717 wifi, hawaiian interisland wifi, free wifi hawaiian airlines",
      accentColor: "#413691",
      accentColorDim: "#6b5fb3",
      faviconAccent: "#9d4edd", // Pualani purple, lifted to glow on dark
      socialImagePath: "/static/social-image-ha.webp",
      analyticsDomain: "hawaiianstarlinktracker.com",
      pressReleaseUrl:
        "https://newsroom.hawaiianairlines.com/releases/hawaiian-airlines-launches-fast-and-free-starlink-internet",
    },
  },
  AS: {
    code: "AS",
    name: "Alaska Airlines",
    shortName: "Alaska",
    enabled: true,
    publicInHub: true,
    iata: "AS",
    icao: "ASA",
    // SkyWest-for-Alaska tails are tracked (CPA-dedicated, disjoint from UA's),
    // but SKW/OO stay out of carrierPrefixes — we don't resolve SkyWest-operated
    // AS flight numbers to tails yet.
    carrierPrefixes: ["ASA", "QXE", "AS", "QX"],
    subfleets: [
      // AS800-899 are AS-marketed flights on Hawaiian A330/A321neo metal
      // post-merger — every one of those aircraft has Starlink. Listed first
      // so it wins the find() over mainline.
      {
        key: "hawaiian_metal",
        label: "Hawaiian-operated (A330/A321neo)",
        flightNumberHint: "AS800-899",
        penetrationOverride: 1,
        match: (fn) => {
          const n = flightNum(fn);
          return Number.isFinite(n) && n >= 800 && n <= 899;
        },
      },
      {
        key: "mainline",
        label: "Mainline (737/787)",
        flightNumberHint: "AS1-1999",
        match: (fn) => {
          const n = flightNum(fn);
          return Number.isFinite(n) && n < 2000 && !(n >= 800 && n <= 899);
        },
      },
      {
        key: "horizon",
        // Horizon- and SkyWest-operated E175s both fly AS2000+ — don't credit
        // one operator in user-facing copy.
        label: "Regional E175",
        flightNumberHint: "AS2000+",
        // Phase complete (rollout.phaseNote): every E175 has Starlink. The
        // override keeps predictions right even before the type reconcile
        // settles a fresh roster's statuses.
        penetrationOverride: 1,
        match: (fn) => {
          const n = flightNum(fn);
          return Number.isFinite(n) && n >= 2000;
        },
      },
    ],
    // Same matcher as alaskaTypeToWifi so verdict and subfleet can't disagree.
    classifyFleet: (t) => (normalizeAircraftType(t) === "E175" ? "horizon" : "mainline"),
    fr24Slug: "as-asa",
    regionalCarriers: [{ fr24Slug: "qx-qxe", name: "Horizon Air", subfleet: "horizon" }],
    metricTag: "alaska",
    ...FAA_TAIL,
    minFleetSanity: 200,
    verifierBackend: "alaska-json",
    flightHistoryModel: false,
    verifySite: "alaskaair.com",
    typeDeterministicWifi: alaskaTypeToWifi,
    // Phase 1 (E175 regional) complete. Update status/phaseNote when 737/787 mainline starts.
    rollout: {
      status: "phase_done",
      statusLabel: "Regional fleet done",
      phaseNote: "All 90 regional E175s have Starlink. Mainline 737s and 787s start later in 2026.",
    },
    brand: {
      title: "Alaska Airlines Starlink Tracker",
      tagline: "Tracking Alaska Airlines aircraft with Starlink WiFi",
      siteTitle: "Alaska Starlink Tracker — Which Flights Have Free Starlink WiFi?",
      description:
        "Track which Alaska Airlines flights have free Starlink WiFi. Live status for every Starlink-equipped aircraft, installation progress, and upcoming flight schedules.",
      ogTitle: "Alaska Airlines Starlink Tracker",
      ogDescription:
        "Live statistics showing Alaska Airlines Starlink WiFi installation progress across the fleet.",
      keywords:
        "alaska airlines starlink, alaska starlink tracker, alaska wifi, 737 MAX starlink, E175 starlink, check alaska flight starlink",
      accentColor: "#01426a",
      accentColorDim: "#2b6a8f",
      faviconAccent: "#00b2e3", // Alaska secondary brand blue — primary #01426a is too dark to glow
      socialImagePath: "/static/social-image-as.webp",
      analyticsDomain: "alaskastarlinktracker.com",
      pressReleaseUrl:
        "https://news.alaskaair.com/company/alaska-airlines-and-hawaiian-airlines-to-offer-free-starlink-wi-fi/",
    },
  },
  QR: {
    code: "QR",
    name: "Qatar Airways",
    shortName: "Qatar",
    enabled: true,
    publicInHub: false,
    iata: "QR",
    icao: "QTR",
    carrierPrefixes: ["QTR", "QR"],
    // QR runs the same flight number across very different equipment day-to-day
    // (DOH-CAI may be 359 on QR1303 and 788 on QR1301 same date), so flight-
    // number partition is meaningless. One bucket; UI can break out by type.
    subfleets: [{ key: "mainline", label: "Qatar Fleet", match: () => true }],
    classifyFleet: () => "mainline",
    fr24Slug: "qr-qtr",
    metricTag: "qatar",
    ...QATAR_TAIL,
    // 274 aircraft on FR24 (Apr 2026); minus ~37 freighters leaves ~237. Set
    // floor at 200 so a partial scrape still passes sanity but a near-empty
    // one doesn't blow away the roster.
    minFleetSanity: 200,
    verifierBackend: "qatar-fltstatus",
    // QR freshness = "the schedule cache is current", not "the roster row
    // count changed" — the hourly ingester owns the stamp (gated on outcome).
    lastUpdatedOwner: "schedule-ingester",
    flightHistoryModel: false,
    verifySite: "qatarairways.com",
    typeDeterministicWifi: qatarTypeToStarlink,
    rollout: {
      status: "phase_done",
      statusLabel: "Widebodies done",
      phaseNote:
        "Every Boeing 777 and Airbus A350 has Starlink (rollout completed December 2025); the 787 fleet is mid-installation. Narrowbodies and freighters are not in the program.",
    },
    brand: {
      title: "Qatar Airways Starlink Tracker",
      tagline: "Tracking Qatar Airways aircraft with Starlink WiFi",
      siteTitle: "Qatar Starlink Tracker — Which Flights Have Free Starlink WiFi?",
      description:
        "Track which Qatar Airways flights have free Starlink WiFi. Every Boeing 777 and Airbus A350 has Starlink (rollout complete December 2025); the Boeing 787 fleet is mid-installation. Check your flight by number and date.",
      ogTitle: "Qatar Airways Starlink Tracker",
      ogDescription:
        "Boeing 777 + A350 fleets are 100% Starlink-equipped; B787 rollout in progress. Check your QR flight to see which aircraft is scheduled.",
      keywords:
        "qatar airways starlink, qatar starlink tracker, qatar wifi, B777 starlink, A350 starlink, B787 starlink, check qatar flight starlink, qr wifi",
      accentColor: "#5c0632",
      accentColorDim: "#8a2851",
      faviconAccent: "#a3204e", // Qatar oryx burgundy, lifted
      socialImagePath: "/static/social-image-qr.webp",
      analyticsDomain: "qatarstarlinktracker.com",
      pressReleaseUrl:
        "https://www.qatarairways.com/press-releases/en-WW/259315-qatar-airways-launches-world-s-first-starlink-equipped-boeing-787-and-completes-airbus-a350-starlink-rollout-connecting-over-11-millio/",
    },
  },
} satisfies Record<string, AirlineConfig>;

/** Literal union of registered airline codes. Type per-airline maps as
 * Record<KnownAirlineCode, T> so a missing airline is a compile error, not a
 * silent fallback to another tenant's data (the og:image bug class). */
export type KnownAirlineCode = keyof typeof AIRLINE_DEFS;

export const AIRLINES: Record<AirlineCode, AirlineConfig> = AIRLINE_DEFS;

/** Every subfleet key any airline registers — the vocabulary normalizeFleet
 * and the fleet pages accept. Derived, never hand-enumerated. */
export const SUBFLEET_KEYS: ReadonlySet<string> = new Set(
  Object.values(AIRLINE_DEFS).flatMap((a) => a.subfleets.map((s) => s.key))
);

/** Literal list backing the SubfleetKey type (src/types.ts derives from it).
 * tests/vocabulary.test.ts pins it equal to the runtime-derived SUBFLEET_KEYS. */
export const SUBFLEET_KEY_LIST = ["mainline", "express", "horizon", "hawaiian_metal"] as const;

// ── Canonical type→Starlink program state ────────────────────────────────────
// One phase table per type-deterministic airline, keyed by the families that
// normalizeAircraftType (the single free-text matcher) produces. Keyspace
// adapters: free text resolves via normalizeAircraftType, IATA equipment
// codes via QATAR_EQUIPMENT. A program change is one edit here, never a
// per-module sweep.

export type WifiPhase = "confirmed" | "rolling" | "negative";

// QR program truth. 787 completion (target end-2026): flip B787 to
// "confirmed" — both the FR24-name path (typeDeterministicWifi) and the
// IATA-code path (qatarEquipmentToWifi) read this table.
const QATAR_PHASE_BY_FAMILY: Record<string, WifiPhase> = {
  B777: "confirmed", // rollout complete Q2 2025
  A350: "confirmed", // rollout complete Dec 2025
  B787: "rolling", // mid-install — per-flight equipment alone can't decide
  B777F: "negative", // Qatar Cargo — no passenger service
  B747F: "negative",
  A380: "negative", // no installation plan announced
  A330: "negative",
  A320: "negative",
  B737: "negative",
};

// Collapse normalizeAircraftType's granular families to QR program families:
// the program treats the whole 737/A320 lineups uniformly.
function qatarProgramFamily(family: string): string {
  if (family.startsWith("B737")) return "B737";
  if (family === "A319" || family === "A321") return "A320";
  return family;
}

// Every IATA equipment code QR's API returns (qoreservices keyspace), mapped
// once to canonical family (phase-table key) + display name. Adding a QR
// equipment code is one row here. 351/359 are both A350-900 — QR's API
// returns either; 77F/77X/74Y/74F are Qatar Cargo freighters.
const QATAR_EQUIPMENT: Record<string, { family: string; name: string }> = {
  "77W": { family: "B777", name: "Boeing 777-300ER" },
  "77L": { family: "B777", name: "Boeing 777-200LR" },
  "77F": { family: "B777F", name: "Boeing 777 Freighter" },
  "77X": { family: "B777F", name: "Boeing 777 Freighter" },
  "74Y": { family: "B747F", name: "Boeing 747 Freighter" },
  "74F": { family: "B747F", name: "Boeing 747 Freighter" },
  "351": { family: "A350", name: "Airbus A350-900" },
  "359": { family: "A350", name: "Airbus A350-900" },
  "35K": { family: "A350", name: "Airbus A350-1000" },
  "788": { family: "B787", name: "Boeing 787-8" },
  "789": { family: "B787", name: "Boeing 787-9" },
  "388": { family: "A380", name: "Airbus A380-800" },
  "332": { family: "A330", name: "Airbus A330-200" },
  "333": { family: "A330", name: "Airbus A330-300" },
  "320": { family: "A320", name: "Airbus A320" },
  "321": { family: "A320", name: "Airbus A321" },
  "21N": { family: "A320", name: "Airbus A321neo" },
  "38M": { family: "B737", name: "Boeing 737 MAX 8" },
  "73H": { family: "B737", name: "Boeing 737 MAX 8" },
};

export function qatarEquipment(
  code: string | null | undefined
): { family: string; name: string } | null {
  if (!code) return null;
  return QATAR_EQUIPMENT[code.toUpperCase()] ?? null;
}

export function qatarStarlinkPhase(family: string | null): WifiPhase | null {
  return family ? (QATAR_PHASE_BY_FAMILY[family] ?? null) : null;
}

/**
 * Family→phase table for type-deterministic airlines; null for carriers whose
 * program isn't a per-type table (UA per-tail, AS per-subfleet). When the
 * phases span confirmed AND negative/rolling, no single per-flight probability
 * is honest — prediction surfaces must render the split instead of a blend.
 */
export function wifiPhaseFamilies(code: AirlineCode): Record<string, WifiPhase> | null {
  if (code === "QR") return QATAR_PHASE_BY_FAMILY;
  if (code === "HA") return HAWAIIAN_PHASE_BY_FAMILY;
  return null;
}

/** Narrow a program phase to a settleable status. "rolling" (and unrecognized
 * input → null) stays null: mid-rollout is per-tail, not type-decidable, and
 * a format drift must never settle a tail. */
export function phaseToStatus(phase: WifiPhase | null): StarlinkStatus | null {
  return phase === "confirmed" || phase === "negative" ? phase : null;
}

/** Wifi-provider keyspace label for a settled status; null when unsettled. */
export function providerLabel(status: StarlinkStatus | null): "Starlink" | "None" | null {
  return status === "confirmed" ? "Starlink" : status === "negative" ? "None" : null;
}

// Catch-all is null so an FR24 type-string format drift produces no
// observation instead of mass-flipping confirmed tails on reconcile
// (unrecognized strings normalize to "other"/"unknown" — no phase).
export function qatarTypeToStarlink(aircraftType: string): StarlinkStatus | null {
  return phaseToStatus(qatarStarlinkPhase(qatarProgramFamily(normalizeAircraftType(aircraftType))));
}

// HA program truth: Airbus fleet complete (Sep 2024), 787s pending install,
// 717 interisland jets never in scope. HA operates only A321neos, so the
// whole A321 family is confirmed.
const HAWAIIAN_PHASE_BY_FAMILY: Record<string, WifiPhase> = {
  A330: "confirmed",
  A321: "confirmed",
  B787: "rolling",
  B717: "negative",
};

export function hawaiianStarlinkPhase(equipmentType: string | null | undefined): WifiPhase | null {
  if (!equipmentType) return null;
  return HAWAIIAN_PHASE_BY_FAMILY[normalizeAircraftType(equipmentType)] ?? null;
}

function hawaiianTypeToWifi(aircraftType: string): StarlinkStatus | null {
  return phaseToStatus(hawaiianStarlinkPhase(aircraftType));
}

// AS: regional E175s 100% equipped (Q1 2026 earnings call). Mainline 737/787
// is per-tail mid-rollout — null, settled by FlyerTalk/verifier evidence.
function alaskaTypeToWifi(aircraftType: string): StarlinkStatus | null {
  return normalizeAircraftType(aircraftType) === "E175" ? "confirmed" : null;
}

// What each verifier backend writes to starlink_verification_log.source.
// 'qatar-fltstatus' has no verification-log writer yet: QR evidence flows
// through qatar_schedule (schedule ingester) instead, so the 'qatar' tag is
// read-side only — it matches zero log rows until a QR verifier loop exists.
const VERIFIER_SOURCE_TAG: Record<
  NonNullable<AirlineConfig["verifierBackend"]>,
  VerificationSource
> = {
  united: "united",
  "alaska-json": "alaska",
  "qatar-fltstatus": "qatar",
};

/** The source tag this airline's verifier writes to starlink_verification_log.
 * Throws for airlines without a verifier backend — calling this at a write
 * site for such an airline is a programming error. */
export function verifierSourceTag(cfg: AirlineConfig): VerificationSource {
  if (!cfg.verifierBackend) {
    throw new Error(`${cfg.code} has no verifier backend — no verification source tag`);
  }
  return VERIFIER_SOURCE_TAG[cfg.verifierBackend];
}

/** Verification-log source tags whose evidence consensus may weigh — derived
 * from the enabled airlines' verifier backends. */
export const VERIFICATION_SOURCES: readonly VerificationSource[] = [
  ...new Set(
    enabledAirlines()
      .filter((a) => a.verifierBackend)
      .map((a) => verifierSourceTag(a))
  ),
].sort();

// What kind of evidence each backend's wifi field carries. united scrapes the
// actual wifi banner off united.com; alaska-json and qatar-fltstatus only see
// equipment type, so their wifi field is derived from the type rule.
const VERIFIER_EVIDENCE: Record<
  NonNullable<AirlineConfig["verifierBackend"]>,
  "observed_wifi" | "type_derived"
> = {
  united: "observed_wifi",
  "alaska-json": "type_derived",
  "qatar-fltstatus": "type_derived",
};

/** Sources whose wifi field is an actually-observed signal — the only
 * evidence allowed to WRITE verified_wifi via consensus. Type-derived truth
 * flows through reconcileTypeDeterministicFleets instead, so a type inference
 * can never masquerade as a per-tail observation (the wrong-yes bug class). */
export const OBSERVED_WIFI_SOURCES: readonly VerificationSource[] = [
  ...new Set(
    enabledAirlines()
      .filter((a) => a.verifierBackend && VERIFIER_EVIDENCE[a.verifierBackend] === "observed_wifi")
      .map((a) => verifierSourceTag(a))
  ),
].sort();

export function lastUpdatedOwner(code: string): LastUpdatedOwner {
  return AIRLINES[code]?.lastUpdatedOwner ?? "fleet-meta";
}

export function enabledAirlines(): AirlineConfig[] {
  return Object.values(AIRLINES).filter((a) => a.enabled);
}

export function publicAirlines(): AirlineConfig[] {
  return enabledAirlines().filter((a) => a.publicInHub);
}

export function looksLikeValidTailNumber(tail: string): boolean {
  return Object.values(AIRLINES).some((a) => a.tailPattern.test(tail));
}

export const HUB_BRAND: PageBrand = {
  title: "Airline Starlink Tracker",
  tagline: "Which airlines and flights have Starlink WiFi — by tail number",
  siteTitle: "Airline Starlink Tracker — Which Flights Have Starlink WiFi?",
  description:
    "Per-aircraft Starlink WiFi status across United, Hawaiian, and Alaska Airlines. Check whether your flight has fast, free in-flight internet, see each airline's rollout progress, and find which routes to book to stay connected.",
  ogTitle: "Which flights have Starlink? — Airline Starlink Tracker",
  ogDescription:
    "Per-aircraft Starlink status across United, Hawaiian, and Alaska. Check your flight, compare airline rollouts, and find routes with fast free in-flight WiFi.",
  keywords:
    "which airlines have starlink, starlink wifi airlines, does my flight have starlink, in-flight starlink wifi, united starlink, hawaiian starlink, alaska airlines starlink, starlink airline tracker, free airplane wifi",
  accentColor: "#0ea5e9",
  accentColorDim: "#0284c7",
  analyticsDomain: "airlinestarlinktracker.com",
  socialImagePath: "/static/social-image-hub.webp",
};

const DEFAULT_ANALYTICS_SCRIPT = "https://analytics.martinamps.com/js/script.js";
const DEFAULT_ANALYTICS_EVENT_API = "https://analytics.martinamps.com/api/event";

const AIRLINE_SITE_FEATURES: SiteFeatures = {
  homeNav: true,
  checkFlightPage: true,
  routePlannerPage: true,
  fleetPage: true,
  mcpPage: false,
  chromeExtension: false,
};

export const SITES: Record<string, SiteConfig> = {
  united: {
    key: "united",
    scope: "UA",
    live: true,
    hosts: ["unitedstarlinktracker.com", "www.unitedstarlinktracker.com"],
    canonicalHost: "unitedstarlinktracker.com",
    brand: AIRLINES.UA.brand,
    analytics: {
      scriptSrc: DEFAULT_ANALYTICS_SCRIPT,
      dataDomain: AIRLINES.UA.brand.analyticsDomain,
      eventApiUrl: DEFAULT_ANALYTICS_EVENT_API,
    },
    features: {
      ...AIRLINE_SITE_FEATURES,
      mcpPage: true,
      chromeExtension: true,
    },
  },
  airline: {
    key: "airline",
    scope: "ALL",
    live: true,
    hosts: ["airlinestarlinktracker.com", "www.airlinestarlinktracker.com"],
    canonicalHost: "airlinestarlinktracker.com",
    brand: HUB_BRAND,
    analytics: {
      scriptSrc: DEFAULT_ANALYTICS_SCRIPT,
      dataDomain: HUB_BRAND.analyticsDomain,
      eventApiUrl: DEFAULT_ANALYTICS_EVENT_API,
    },
    features: {
      homeNav: false,
      checkFlightPage: false,
      routePlannerPage: false,
      fleetPage: true,
      mcpPage: false,
      chromeExtension: false,
    },
  },
  hawaiian: {
    key: "hawaiian",
    scope: "HA",
    live: false,
    hosts: ["hawaiianstarlinktracker.com", "www.hawaiianstarlinktracker.com"],
    canonicalHost: "hawaiianstarlinktracker.com",
    brand: AIRLINES.HA.brand,
    analytics: {
      scriptSrc: DEFAULT_ANALYTICS_SCRIPT,
      dataDomain: AIRLINES.HA.brand.analyticsDomain,
      eventApiUrl: DEFAULT_ANALYTICS_EVENT_API,
    },
    features: AIRLINE_SITE_FEATURES,
  },
  alaska: {
    key: "alaska",
    scope: "AS",
    live: false,
    hosts: ["alaskastarlinktracker.com", "www.alaskastarlinktracker.com"],
    canonicalHost: "alaskastarlinktracker.com",
    brand: AIRLINES.AS.brand,
    analytics: {
      scriptSrc: DEFAULT_ANALYTICS_SCRIPT,
      dataDomain: AIRLINES.AS.brand.analyticsDomain,
      eventApiUrl: DEFAULT_ANALYTICS_EVENT_API,
    },
    features: AIRLINE_SITE_FEATURES,
  },
  qatar: {
    key: "qatar",
    scope: "QR",
    live: false,
    hosts: ["qatarstarlinktracker.com", "www.qatarstarlinktracker.com"],
    canonicalHost: "qatarstarlinktracker.com",
    brand: AIRLINES.QR.brand,
    analytics: {
      scriptSrc: DEFAULT_ANALYTICS_SCRIPT,
      dataDomain: AIRLINES.QR.brand.analyticsDomain,
      eventApiUrl: DEFAULT_ANALYTICS_EVENT_API,
    },
    // Route planner reads flight_routes/departure_log, both empty for QR until
    // we ingest historical assignments. Hide the page rather than ship a
    // permanently-empty UX.
    features: { ...AIRLINE_SITE_FEATURES, routePlannerPage: false },
  },
};

function allSites(): SiteConfig[] {
  return Object.values(SITES);
}

function siteForScope(scope: AirlineCode | "ALL", liveOnly = false): SiteConfig | null {
  if (liveOnly) {
    return allSites().find((site) => site.scope === scope && site.live) ?? null;
  }
  return allSites().find((site) => site.scope === scope) ?? null;
}

export function tenantBrand(tenant: Tenant): PageBrand {
  return tenant === "ALL" ? HUB_BRAND : tenant.brand;
}

/** Produce the template-variable map that index.html `{{...}}` placeholders expect. */
export function brandMetadata(brand: PageBrand) {
  return {
    siteTitle: brand.siteTitle,
    siteDescription: brand.description,
    ogTitle: brand.ogTitle,
    ogDescription: brand.ogDescription,
    // Stable alt text; social platforms cache OG metadata, so keep counts out.
    ogImageAlt: brand.title,
    keywords: brand.keywords,
    siteName: brand.title,
    accentColor: brand.accentColor,
    accentColorDim: brand.accentColorDim,
    // socialImagePath is intentionally absent: resolveSocialImage (app.ts) is
    // the single resolver, with the missing-asset fallback.
  };
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"];

export type Tenant = AirlineConfig | "ALL";

export function siteTenant(site: SiteConfig): Tenant {
  return site.scope === "ALL" ? "ALL" : AIRLINES[site.scope];
}

/** The single airline a site is bound to. Throws on the hub — airline-scoped
 * pages must never render under a site with no airline binding. */
export function siteAirline(site: SiteConfig): AirlineConfig {
  const tenant = siteTenant(site);
  if (tenant === "ALL") {
    throw new Error(`site "${site.key}" has no airline binding — this page is airline-scoped`);
  }
  return tenant;
}

// Hosts that resolve here but aren't tenants yet — 301 to the hub until the
// airline has data. Promote to a tenant config and remove the entry when ready.
export const HOST_REDIRECTS: Record<string, string> = {
  "deltastarlinktracker.com": "https://airlinestarlinktracker.com",
};

export function resolveSite(host: string | null): SiteConfig | null {
  if (!host) return null;
  const h = host.split(":")[0].toLowerCase();

  for (const site of allSites()) {
    if (site.hosts.includes(h)) return site;
  }

  if (LOCAL_HOSTS.includes(h)) {
    const devSite = process.env.DEV_SITE;
    if (devSite && SITES[devSite]) return SITES[devSite];

    const dev = process.env.DEV_TENANT;
    if (dev === "ALL") return siteForScope("ALL", true) ?? SITES.airline;

    if (dev && AIRLINES[dev]) {
      return siteForScope(dev, true) ?? siteForScope(dev) ?? SITES.united;
    }

    return SITES.united;
  }

  return null;
}

export function siteForAirline(code: AirlineCode, liveOnly = false): SiteConfig | null {
  return siteForScope(code, liveOnly);
}

export function airlineHomeUrl(
  code: AirlineCode,
  query?: Record<string, string | number | undefined>
): string {
  const liveSite = siteForAirline(code, true);
  const targetHost = liveSite?.canonicalHost ?? SITES.airline.canonicalHost;
  const url = new URL(`https://${targetHost}/`);

  if (!liveSite) {
    url.searchParams.set("filter", code);
  }

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export function analyticsOrigins() {
  const scriptOrigins = new Set<string>();
  const connectOrigins = new Set<string>();

  for (const site of allSites()) {
    if (!site.analytics) continue;
    scriptOrigins.add(new URL(site.analytics.scriptSrc).origin);
    if (site.analytics.eventApiUrl) {
      connectOrigins.add(new URL(site.analytics.eventApiUrl).origin);
    }
  }

  return {
    scriptOrigins: [...scriptOrigins].sort(),
    connectOrigins: [...connectOrigins].sort(),
  };
}

/**
 * Resolve the tenant from an incoming Host header.
 * - Matches an airline's hosts → that AirlineConfig
 * - Matches the hub site's hosts → 'ALL'
 * - localhost → AIRLINES[DEV_TENANT ?? 'UA']
 * - Anything else → null (caller responds 421)
 */
export function resolveTenant(host: string | null): Tenant | null {
  const site = resolveSite(host);
  return site ? siteTenant(site) : null;
}
