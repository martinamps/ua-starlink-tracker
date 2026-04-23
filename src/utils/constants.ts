import {
  buildAirlineFlightNumberVariants,
  ensureAirlinePrefix,
  inferSubfleet,
  normalizeAirlineFlightNumber,
} from "../airlines/flight-number";
import { AIRLINES, analyticsOrigins } from "../airlines/registry";

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

// ─────────────────────────────────────────────────────────────────────────────
// UA-bound shims over the airline-agnostic helpers in src/airlines/flight-number.
// Kept so existing UA-only callers (scripts, predictor, mcp-server) don't change
// in this slice. New code in app.ts uses the cfg-taking versions directly.
// ─────────────────────────────────────────────────────────────────────────────

export const normalizeFlightNumber = (fn: string): string =>
  normalizeAirlineFlightNumber(AIRLINES.UA, fn);

export const ensureUAPrefix = (fn: string): string => ensureAirlinePrefix(AIRLINES.UA, fn);

export const buildFlightNumberVariants = (fn: string): string[] =>
  buildAirlineFlightNumberVariants(AIRLINES.UA, fn);

export const inferFleet = (fn: string): "express" | "mainline" | "unknown" =>
  inferSubfleet(AIRLINES.UA, fn) as "express" | "mainline" | "unknown";

// Security headers
const { scriptOrigins: ANALYTICS_SCRIPT_ORIGINS, connectOrigins: ANALYTICS_CONNECT_ORIGINS } =
  analyticsOrigins();
const CONNECT_SRC = ["'self'", ...ANALYTICS_CONNECT_ORIGINS].join(" ");
const SCRIPT_SRC = ["'self'", "'unsafe-inline'", "https://unpkg.com", ...ANALYTICS_SCRIPT_ORIGINS]
  .filter(Boolean)
  .join(" ");

export const SECURITY_HEADERS = {
  api: {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'self' https://unpkg.com; connect-src ${CONNECT_SRC}; script-src ${SCRIPT_SRC}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*;`,
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
    "Content-Security-Policy": `default-src 'self' https://unpkg.com; connect-src ${CONNECT_SRC}; script-src ${SCRIPT_SRC}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;`,
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
