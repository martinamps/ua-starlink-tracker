// Check if the current domain is for United Airlines specific tracking.
// Treats localhost as United for local dev (the site only serves United content
// in practice, and the generic "airline" variant is vestigial).
export function isUnitedDomain(hostname: string): boolean {
  return (
    hostname.includes("unitedstarlinktracker") ||
    hostname.startsWith("localhost") ||
    hostname.startsWith("127.0.0.1")
  );
}

// Database path
export const DB_PATH =
  process.env.DB_PATH ??
  (process.env.NODE_ENV === "production"
    ? "/srv/ua-starlink-tracker/plane-data.sqlite"
    : "./plane-data.sqlite");

// Flight data source configuration
// Options: "flightradar24" (free) or "flightaware" (requires API key)
export type FlightDataSource = "flightradar24" | "flightaware";
export const FLIGHT_DATA_SOURCE: FlightDataSource =
  (process.env.FLIGHT_DATA_SOURCE as FlightDataSource) || "flightradar24";

// United Express operating carrier prefixes that should be normalized to UA
// ICAO 3-letter codes (from FR24 callsigns) and IATA 2-letter codes (from FR24 number.alternative)
// Ordered longest-first so prefix matching works (UAL before UA, etc.)
const UNITED_CARRIER_PREFIXES = [
  // ICAO 3-letter (callsign format)
  "UAL", // United Airlines mainline
  "SKW", // SkyWest
  "ASH", // Mesa
  "RPA", // Republic
  "GJS", // GoJet
  "PDT", // Piedmont
  "ACA", // Air Canada (codeshare)
  "ENY", // Envoy
  // IATA 2-letter
  "OO", // SkyWest
  "YX", // Republic
  "YV", // Mesa
  "G7", // GoJet
];

/**
 * Normalize flight numbers to UA marketing code
 * Converts operating carrier codes (SKW5882, ASH4054, UAL544, OO4680) to UA prefix
 * This matches what customers see on their tickets
 */
export function normalizeFlightNumber(flightNumber: string): string {
  if (!flightNumber) return flightNumber;

  // Already exact UA#### format (not UAL####), return as-is
  if (/^UA\d+$/.test(flightNumber)) return flightNumber;

  // Check if it starts with a known carrier prefix followed by digits
  for (const carrier of UNITED_CARRIER_PREFIXES) {
    if (flightNumber.startsWith(carrier) && /^\d+$/.test(flightNumber.slice(carrier.length))) {
      return `UA${flightNumber.slice(carrier.length)}`;
    }
  }

  // Unknown prefix, return as-is
  return flightNumber;
}

/**
 * Force a flight number into exact UA#### format for predictor lookup.
 * Composes normalizeFlightNumber + bare-digit handling.
 * "SKW5882" → "UA5882", "5882" → "UA5882", "UA5882" → "UA5882"
 */
export function ensureUAPrefix(flightNumber: string): string {
  const normalized = normalizeFlightNumber(flightNumber.trim().toUpperCase());
  if (/^UA\d+$/.test(normalized)) return normalized;
  if (/^\d+$/.test(normalized)) return `UA${normalized}`;
  return normalized;
}

/**
 * Build all carrier-prefix variants of a UA flight number for DB lookup.
 * The DB stores operating-carrier codes (SKW5212, OO5212, UAL544) but users
 * enter UA numbers. Returns [input, UAL###, SKW###, ..., OO###, ...].
 */
export function buildFlightNumberVariants(uaFlightNumber: string): string[] {
  if (!/^UA\d+$/.test(uaFlightNumber)) return [uaFlightNumber];
  const num = uaFlightNumber.slice(2);
  return [uaFlightNumber, ...UNITED_CARRIER_PREFIXES.map((p) => `${p}${num}`)];
}

/**
 * Infer fleet type from flight number range.
 * United Express (regional) flights are typically UA3000-6999.
 */
export function inferFleet(flightNumber: string): "express" | "mainline" | "unknown" {
  const numMatch = flightNumber.match(/(\d+)$/);
  if (!numMatch) return "unknown";
  const num = Number.parseInt(numMatch[1], 10);
  if (num >= 3000 && num <= 6999) return "express";
  return "mainline";
}

// Page-specific content that changes based on the domain
export const PAGE_CONTENT = {
  pageTitle: {
    united: "United Airlines Starlink Tracker",
    generic: "Airline Starlink Tracker",
  },
  pageSubtitle: {
    united: "Tracking United Airlines aircraft with Starlink WiFi",
    generic: "Tracking major airlines' rollout of Starlink WiFi",
  },
  mainDescription: {
    pressReleaseUrl: "https://www.united.com/en/us/newsroom/announcements/cision-125370",
    united:
      "United Airlines began equipping its fleet with SpaceX's Starlink internet on March 7, 2025. The ultra-fast WiFi offers speeds up to 250 Mbps—50 times faster than previous systems—with gaming-grade latency that works seamlessly over oceans on international routes. No app required: just connect like any WiFi. The airline continues installing on 40+ aircraft monthly, with the lightweight 85-pound equipment improving fuel efficiency compared to older 300-pound systems.",
  },
  fleetLabels: {
    mainline: "United Mainline Fleet",
    express: "United Express Fleet",
    combined: "Combined Fleet",
  },
};

// Domain-specific content mapping for HTML metadata
export function getDomainContent(host: string) {
  const unitedDomain = isUnitedDomain(host);

  return {
    siteTitle: unitedDomain
      ? "United Starlink Tracker — Which Flights Have Free Starlink WiFi?"
      : "Airline Starlink Tracker | United, Delta & All Airlines WiFi Rollout",

    siteDescription: unitedDomain
      ? "Track which United Airlines flights have free Starlink WiFi. Live status for every Starlink-equipped aircraft, installation progress, and upcoming flight schedules."
      : "Track the rollout of SpaceX's Starlink WiFi on major airlines. See live statistics on United Airlines, Delta and more as they equip their fleets with high-speed satellite internet.",

    ogTitle: unitedDomain
      ? PAGE_CONTENT.pageTitle.united
      : "Airline Starlink Tracker - United, Delta & More",

    ogDescription: unitedDomain
      ? "Live statistics showing United Airlines Starlink WiFi installation progress across mainline and express fleets."
      : "Live statistics tracking SpaceX's Starlink WiFi rollout across major airlines like United and Delta.",

    keywords: unitedDomain
      ? "which united planes have starlink, united starlink status, United Airlines Starlink WiFi, united starlink tracker, united starlink rollout, E175 starlink, CRJ-550 starlink, united mainline starlink, united express starlink, check united flight starlink"
      : "Airlines, Starlink, WiFi, Internet, SpaceX, Aircraft, United, Delta, In-flight WiFi, Satellite Internet",

    analyticsUrl: unitedDomain ? "unitedstarlinktracker.com" : "airlinestarlinktracker.com",

    siteName: unitedDomain ? PAGE_CONTENT.pageTitle.united : PAGE_CONTENT.pageTitle.generic,
  };
}

// Security headers
export const SECURITY_HEADERS = {
  api: {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self' https://unpkg.com; connect-src 'self' https://analytics.martinamps.com; " +
      "script-src 'self' 'unsafe-inline' https://unpkg.com https://analytics.martinamps.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*;",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, max-age=0",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  },
  html: {
    "Content-Type": "text/html",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self' https://unpkg.com; connect-src 'self' https://analytics.martinamps.com; " +
      "script-src 'self' 'unsafe-inline' https://unpkg.com https://analytics.martinamps.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Referrer-Policy": "no-referrer",
  },
  notFound: {
    "Content-Type": "text/html",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "Referrer-Policy": "no-referrer",
  },
};

// File content types
export const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
