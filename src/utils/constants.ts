import { normalizeAirlineFlightNumber } from "../airlines/flight-number";
import { AIRLINES, analyticsOrigins } from "../airlines/registry";

// Database path
export const DB_PATH =
  process.env.DB_PATH ??
  (process.env.NODE_ENV === "production"
    ? "/srv/ua-starlink-tracker/plane-data.sqlite"
    : "./plane-data.sqlite");

// Shared User-Agent for outbound HTTP and Playwright contexts. Bare
// "Mozilla/5.0" trips bot heuristics on several upstreams; one realistic
// Chrome string keeps the call sites from drifting.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Flight data source configuration
// Options: "flightradar24" (free) or "flightaware" (requires API key)
export type FlightDataSource = "flightradar24" | "flightaware";
export const FLIGHT_DATA_SOURCE: FlightDataSource =
  (process.env.FLIGHT_DATA_SOURCE as FlightDataSource) || "flightradar24";

/** UTC calendar date string used for united.com flight-status lookups. */
export const unitedLookupDate = (epochSec: number): string =>
  new Date(epochSec * 1000).toISOString().slice(0, 10);

// united.com redirects flight-status lookups dated past UTC-today+1 to the search
// page. Compare calendar dates, not seconds: 1.9d away by seconds can be day +2.
function isWithinUnitedLookupWindow(departureTimeSec: number, nowSec: number): boolean {
  return unitedLookupDate(departureTimeSec) <= unitedLookupDate(nowSec + 86400);
}

/** Bare flight digits for united.com URLs. Strip the carrier prefix first: G74460 → 4460, not 74460 (404s). */
export function extractFlightNumber(flightNumber: string): string {
  return normalizeAirlineFlightNumber(AIRLINES.UA, flightNumber).replace(/^UA/, "");
}

/** First flight whose number normalizes to bare digits and whose lookup date united.com can resolve. */
export function pickVerifiableFlight<T extends { flight_number: string; departure_time: number }>(
  flights: T[],
  nowSec = Date.now() / 1000
): T | undefined {
  return flights.find(
    (f) =>
      /^\d+$/.test(extractFlightNumber(f.flight_number)) &&
      isWithinUnitedLookupWindow(f.departure_time, nowSec)
  );
}

// Security headers
const { scriptOrigins: ANALYTICS_SCRIPT_ORIGINS, connectOrigins: ANALYTICS_CONNECT_ORIGINS } =
  analyticsOrigins();
const CONNECT_SRC = ["'self'", ...ANALYTICS_CONNECT_ORIGINS].join(" ");
const SCRIPT_SRC = ["'self'", "'unsafe-inline'", "https://unpkg.com", ...ANALYTICS_SCRIPT_ORIGINS]
  .filter(Boolean)
  .join(" ");

// Baseline filled in by dispatch's finalize wrapper on every response where
// the handler set nothing; the SECURITY_HEADERS variants below build on it so
// the two can never drift. The CSP here is the non-HTML default — variants
// override it with their page CSP.
export const BASE_RESPONSE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'",
};

// The /api/* CORS contract (Chrome extension + Google Flights embedding).
// Spread into SECURITY_HEADERS.api and mirrored verbatim by OPTIONS preflight.
export const API_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const SECURITY_HEADERS = {
  api: {
    ...BASE_RESPONSE_HEADERS,
    ...API_CORS_HEADERS,
    "Content-Type": "application/json",
    "Content-Security-Policy": `default-src 'self' https://unpkg.com; connect-src ${CONNECT_SRC}; script-src ${SCRIPT_SRC}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*;`,
    "Cache-Control": "no-store, max-age=0",
  },
  html: {
    ...BASE_RESPONSE_HEADERS,
    "Content-Type": "text/html",
    "Content-Security-Policy": `default-src 'self' https://unpkg.com; connect-src ${CONNECT_SRC}; script-src ${SCRIPT_SRC}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;`,
  },
  notFound: {
    ...BASE_RESPONSE_HEADERS,
    "Content-Type": "text/html",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;",
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
