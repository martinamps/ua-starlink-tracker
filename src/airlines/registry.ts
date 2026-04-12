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

export interface AirlineConfig {
  code: AirlineCode;
  name: string;
  /** Background jobs (scrape/verify/discover/sync) skip airlines with enabled=false. resolveTenant still resolves them. */
  enabled: boolean;
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
  /** Reject fleet-sync results below this size as obviously wrong. */
  minFleetSanity: number;
  /** Per-flight wifi verification source; null = none (type-map only). */
  verifierBackend?: "united" | "alaska-json" | null;
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
    enabled: true,
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
      siteTitle: "United Starlink Tracker — Does My United Flight Have Starlink WiFi?",
      description:
        "Check whether your United Airlines flight has free Starlink WiFi. Per-aircraft status verified against united.com, live installation progress across mainline and Express fleets, and upcoming flight schedules for every Starlink-equipped tail.",
      ogTitle: "Does my United flight have Starlink? — United Starlink Tracker",
      ogDescription:
        "Check any United flight for free Starlink WiFi. Per-tail status verified against united.com, live rollout progress, and which routes to book for fast in-flight internet.",
      keywords:
        "does my united flight have starlink, united starlink wifi, which united planes have starlink, united starlink tracker, united express starlink, E175 starlink, CRJ-550 starlink, united 737 starlink, check united flight wifi",
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
    enabled: true,
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
    enabled: false,
    hosts: ["alaskastarlinktracker.com", "www.alaskastarlinktracker.com"],
    canonicalHost: "alaskastarlinktracker.com",
    iata: "AS",
    icao: "ASA",
    // SkyWest (OO/SKW) intentionally excluded — shared with UA, tail_number is
    // UNIQUE on united_fleet. AS regionals via SkyWest are out of scope until
    // the Phase-3 composite-PK migration; AS Starlink is mainline-first anyway.
    carrierPrefixes: ["ASA", "QXE", "AS", "QX"],
    subfleets: [{ key: "mainline", label: "Alaska Fleet", match: () => true }],
    fr24Slug: "as-asa",
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
    enabled: false,
    hosts: ["qatarstarlinktracker.com", "www.qatarstarlinktracker.com"],
    canonicalHost: "qatarstarlinktracker.com",
    iata: "QR",
    icao: "QTR",
    carrierPrefixes: ["QTR", "QR"],
    subfleets: [{ key: "mainline", label: "Qatar Fleet", match: () => true }],
    fr24Slug: "qr-qtr",
    metricTag: "qatar",
    minFleetSanity: 200,
    verifierBackend: null,
    brand: {
      title: "Qatar Airways Starlink Tracker",
      tagline: "Tracking Qatar Airways aircraft with Starlink WiFi",
      siteTitle: "Qatar Starlink Tracker — Which Flights Have Free Starlink WiFi?",
      description:
        "Track which Qatar Airways flights have free Starlink WiFi. Live status for every Starlink-equipped aircraft and upcoming flight schedules.",
      ogTitle: "Qatar Airways Starlink Tracker",
      ogDescription:
        "Live statistics showing Qatar Airways Starlink WiFi installation progress across the fleet.",
      keywords:
        "qatar airways starlink, qatar starlink tracker, qatar wifi, B777 starlink, A350 starlink, check qatar flight starlink",
      accentColor: "#5c0632",
      accentColorDim: "#8a2851",
      faviconPath: "/favicon.ico",
      analyticsDomain: "qatarstarlinktracker.com",
      pressReleaseUrl:
        "https://www.qatarairways.com/en/press-releases/2024/october/starlink-b777.html",
    },
  },
};

export function enabledAirlines(): AirlineConfig[] {
  return Object.values(AIRLINES).filter((a) => a.enabled);
}

export const HUB_HOSTS = ["airlinestarlinktracker.com", "www.airlinestarlinktracker.com"];

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
    keywords: brand.keywords,
    analyticsUrl: brand.analyticsDomain,
    siteName: brand.title,
    accentColor: brand.accentColor,
    accentColorDim: brand.accentColorDim,
    faviconPath: brand.faviconPath,
    socialImagePath: brand.socialImagePath ?? "/static/social-image.webp",
  };
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"];

export type Tenant = AirlineConfig | "ALL";

/**
 * Resolve the tenant from an incoming Host header.
 * - Matches an airline's hosts → that AirlineConfig
 * - Matches HUB_HOSTS → 'ALL'
 * - localhost → AIRLINES[DEV_TENANT ?? 'UA']
 * - Anything else → null (caller responds 421)
 */
export function resolveTenant(host: string | null): Tenant | null {
  if (!host) return null;
  const h = host.split(":")[0].toLowerCase();

  for (const cfg of Object.values(AIRLINES)) {
    if (cfg.hosts.includes(h)) return cfg;
  }
  if (HUB_HOSTS.includes(h)) return "ALL";
  if (LOCAL_HOSTS.includes(h)) {
    const dev = process.env.DEV_TENANT;
    if (dev === "ALL") return "ALL";
    return AIRLINES[dev ?? "UA"] ?? AIRLINES.UA;
  }
  return null;
}
