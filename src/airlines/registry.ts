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
  fr24Slug?: string;
  /** Reject fleet-sync results below this size as obviously wrong. */
  minFleetSanity: number;
  /** Per-flight wifi verification source; null = none (type-map only). */
  verifierBackend?: "united" | "alaska-json" | null;
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
    fr24Slug: "united-airlines-ual",
    minFleetSanity: 800,
    verifierBackend: "united",
    brand: {
      title: "United Airlines Starlink Tracker",
      tagline: "Tracking United Airlines aircraft with Starlink WiFi",
      siteTitle: "United Starlink Tracker — Which Flights Have Free Starlink WiFi?",
      description:
        "Track which United Airlines flights have free Starlink WiFi. Live status for every Starlink-equipped aircraft, installation progress, and upcoming flight schedules.",
      ogTitle: "United Airlines Starlink Tracker",
      ogDescription:
        "Live statistics showing United Airlines Starlink WiFi installation progress across mainline and express fleets.",
      keywords:
        "which united planes have starlink, united starlink status, United Airlines Starlink WiFi, united starlink tracker, united starlink rollout, E175 starlink, CRJ-550 starlink, united mainline starlink, united express starlink, check united flight starlink",
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
    enabled: false,
    hosts: ["hawaiianstarlinktracker.com", "www.hawaiianstarlinktracker.com"],
    canonicalHost: "hawaiianstarlinktracker.com",
    iata: "HA",
    icao: "HAL",
    carrierPrefixes: ["HAL", "HA"],
    subfleets: [{ key: "mainline", label: "Hawaiian Fleet", match: () => true }],
    fr24Slug: "ha-hal",
    minFleetSanity: 30,
    verifierBackend: "alaska-json",
    brand: {
      title: "Hawaiian Airlines Starlink Tracker",
      tagline: "Tracking Hawaiian Airlines aircraft with Starlink WiFi",
      siteTitle: "Hawaiian Starlink Tracker — Which Flights Have Free Starlink WiFi?",
      description:
        "Track which Hawaiian Airlines flights have free Starlink WiFi. Live status for every Starlink-equipped aircraft and upcoming flight schedules.",
      ogTitle: "Hawaiian Airlines Starlink Tracker",
      ogDescription:
        "Live statistics showing Hawaiian Airlines Starlink WiFi installation progress across the fleet.",
      keywords:
        "hawaiian airlines starlink, hawaiian starlink tracker, hawaiian wifi, A330 starlink, hawaiian flight wifi, check hawaiian flight starlink",
      accentColor: "#413691",
      accentColorDim: "#6b5fb3",
      faviconPath: "/static/ha/favicon.ico",
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
    carrierPrefixes: ["ASA", "QXE", "SKW", "AS", "QX", "OO"],
    subfleets: [{ key: "mainline", label: "Alaska Fleet", match: () => true }],
    fr24Slug: "as-asa",
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
      faviconPath: "/static/as/favicon.ico",
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
      faviconPath: "/static/qr/favicon.ico",
      analyticsDomain: "qatarstarlinktracker.com",
      pressReleaseUrl:
        "https://www.qatarairways.com/en/press-releases/2024/october/starlink-b777.html",
    },
  },
};

export function enabledAirlines(): AirlineConfig[] {
  return Object.values(AIRLINES).filter((a) => a.enabled);
}

const HUB_HOSTS = ["airlinestatustracker.com", "www.airlinestatustracker.com"];

const HUB_BRAND: PageBrand = {
  title: "Airline Starlink Tracker",
  tagline: "Tracking major airlines' rollout of Starlink WiFi",
  siteTitle: "Airline Starlink Tracker | United, Delta & All Airlines WiFi Rollout",
  description:
    "Track the rollout of SpaceX's Starlink WiFi on major airlines. See live statistics on United Airlines, Delta and more as they equip their fleets with high-speed satellite internet.",
  ogTitle: "Airline Starlink Tracker - United, Delta & More",
  ogDescription:
    "Live statistics tracking SpaceX's Starlink WiFi rollout across major airlines like United and Delta.",
  keywords:
    "Airlines, Starlink, WiFi, Internet, SpaceX, Aircraft, United, Delta, In-flight WiFi, Satellite Internet",
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
