/**
 * Airline registry — the single source of per-airline configuration.
 * Adding an airline = adding a config object here, not editing scattered code.
 */

export type AirlineCode = string;

export interface SubfleetDef {
  key: string;
  label: string;
  match: (flightNumber: string) => boolean;
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
  faviconPath: string;
  /** og:image / twitter:image path. Defaults to shared /static/social-image.webp until per-airline assets exist. */
  socialImagePath?: string;
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
  hosts: string[];
  canonicalHost: string;
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
  /** Type-deterministic route rule for airlines whose Starlink status depends only on aircraft type / route class, not per-tail observation. */
  routeTypeRule?: (origin: string, destination: string) => { probability: number; reason: string };
  /** Canonical lowercase tag for Datadog `airline:` — preserves history (`united`, not `UA`). */
  metricTag: string;
  brand: PageBrand;
}

function flightNum(fn: string): number {
  const m = fn.match(/(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : Number.NaN;
}

export const AIRLINES: Record<AirlineCode, AirlineConfig> = {
  UA: {
    code: "UA",
    name: "United Airlines",
    shortName: "United",
    enabled: true,
    publicInHub: true,
    hosts: ["unitedstarlinktracker.com", "www.unitedstarlinktracker.com"],
    canonicalHost: "unitedstarlinktracker.com",
    iata: "UA",
    icao: "UAL",
    carrierPrefixes: [
      "UAL",
      "SKW",
      "ASH",
      "RPA",
      "GJS",
      "PDT",
      "ACA",
      "ENY",
      "OO",
      "YX",
      "YV",
      "G7",
    ],
    subfleets: [
      {
        key: "express",
        label: "United Express Fleet",
        match: (fn) => {
          const n = flightNum(fn);
          return n >= 3000 && n <= 6999;
        },
      },
      {
        key: "mainline",
        label: "United Mainline Fleet",
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
    minFleetSanity: 800,
    verifierBackend: "united",
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
        "Check any United flight for free Starlink WiFi. Per-tail status verified against united.com, live rollout progress, and which routes to book for fast in-flight internet.",
      keywords: "united starlink tracker, united starlink wifi",
      accentColor: "#0ea5e9",
      accentColorDim: "#0284c7",
      faviconPath: "/favicon.ico",
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
    hosts: ["hawaiianstarlinktracker.com", "www.hawaiianstarlinktracker.com"],
    canonicalHost: "hawaiianstarlinktracker.com",
    iata: "HA",
    icao: "HAL",
    carrierPrefixes: ["HAL", "HA"],
    subfleets: [{ key: "mainline", label: "Hawaiian Fleet", match: () => true }],
    fr24Slug: "ha-hal",
    metricTag: "hawaiian",
    minFleetSanity: 30,
    verifierBackend: "alaska-json",
    routeTypeRule: (o, d) => {
      const HI = new Set(["HNL", "OGG", "KOA", "LIH", "ITO", "MKK", "LNY"]);
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
        "Every Hawaiian Airlines A330 and A321neo has free gate-to-gate Starlink WiFi — the first major U.S. carrier to finish a fleet-wide install. 717 interisland flights do not have WiFi.",
      keywords:
        "hawaiian airlines starlink, hawaiian airlines wifi, does hawaiian have wifi, hawaiian a330 starlink, hawaiian a321neo wifi, hawaiian 717 wifi, hawaiian interisland wifi, free wifi hawaiian airlines",
      accentColor: "#413691",
      accentColorDim: "#6b5fb3",
      faviconPath: "/favicon.ico",
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
    hosts: ["alaskastarlinktracker.com", "www.alaskastarlinktracker.com"],
    canonicalHost: "alaskastarlinktracker.com",
    iata: "AS",
    icao: "ASA",
    // SkyWest (OO/SKW) intentionally excluded — shared with UA, tail_number is
    // UNIQUE on united_fleet. AS regionals via SkyWest are out of scope until
    // the Phase-3 composite-PK migration.
    carrierPrefixes: ["ASA", "QXE", "AS", "QX"],
    subfleets: [
      {
        key: "mainline",
        label: "Mainline (737/787)",
        match: (fn) => {
          const n = flightNum(fn);
          return Number.isFinite(n) && n < 2000;
        },
      },
      {
        key: "horizon",
        label: "Horizon (E175)",
        match: (fn) => {
          const n = flightNum(fn);
          return Number.isFinite(n) && n >= 2000;
        },
      },
    ],
    classifyFleet: (t) => (/E175|ERJ.?175|EMB/i.test(t) ? "horizon" : "mainline"),
    fr24Slug: "as-asa",
    regionalCarriers: [{ fr24Slug: "qx-qxe", name: "Horizon Air", subfleet: "horizon" }],
    metricTag: "alaska",
    minFleetSanity: 200,
    verifierBackend: "alaska-json",
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
      faviconPath: "/favicon.ico",
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
    hosts: ["qatarstarlinktracker.com", "www.qatarstarlinktracker.com"],
    canonicalHost: "qatarstarlinktracker.com",
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
    // 274 aircraft on FR24 (Apr 2026); minus ~37 freighters leaves ~237. Set
    // floor at 200 so a partial scrape still passes sanity but a near-empty
    // one doesn't blow away the roster.
    minFleetSanity: 200,
    verifierBackend: "qatar-fltstatus",
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
      faviconPath: "/favicon.ico",
      analyticsDomain: "qatarstarlinktracker.com",
      pressReleaseUrl:
        "https://www.qatarairways.com/press-releases/en-WW/259315-qatar-airways-launches-world-s-first-starlink-equipped-boeing-787-and-completes-airbus-a350-starlink-rollout-connecting-over-11-millio/",
    },
  },
};

export function enabledAirlines(): AirlineConfig[] {
  return Object.values(AIRLINES).filter((a) => a.enabled);
}

export function publicAirlines(): AirlineConfig[] {
  return enabledAirlines().filter((a) => a.publicInHub);
}

const HUB_BRAND: PageBrand = {
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
  faviconPath: "/favicon.ico",
  analyticsDomain: "airlinestarlinktracker.com",
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
    faviconPath: brand.faviconPath,
    socialImagePath: brand.socialImagePath ?? "/static/social-image.webp",
  };
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"];

export type Tenant = AirlineConfig | "ALL";

export function siteTenant(site: SiteConfig): Tenant {
  return site.scope === "ALL" ? "ALL" : AIRLINES[site.scope];
}

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
