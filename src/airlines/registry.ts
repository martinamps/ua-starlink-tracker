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
  title: string;
  tagline: string;
  description: string;
  accentColor: string;
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
      description:
        "Track which United Airlines flights have free Starlink WiFi. Live status for every Starlink-equipped aircraft, installation progress, and upcoming flight schedules.",
      accentColor: "#0ea5e9",
      faviconPath: "/favicon.ico",
      analyticsDomain: "unitedstarlinktracker.com",
      pressReleaseUrl: "https://www.united.com/en/us/newsroom/announcements/cision-125370",
    },
  },
};

export const HUB_HOSTS = ["airlinestatustracker.com", "www.airlinestatustracker.com"];

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
