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
  /** Website-scraping verifier for this airline; null = FR24-consensus only. */
  verifierBackend?: "united" | null;
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
};

export const HUB_HOSTS = ["airlinestatustracker.com", "www.airlinestatustracker.com"];

export const HUB_BRAND: PageBrand = {
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
