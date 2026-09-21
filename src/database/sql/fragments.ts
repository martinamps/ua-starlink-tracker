/**
 * SQL building blocks shared by every reader, so a scope rule, a flight-number
 * shape or a wifi spelling is written once. Fragments are strings plus their
 * params; values always travel as params, never interpolated.
 */

import { ensureAirlinePrefix, stripFlightNumberZeros } from "../../airlines/flight-number";
import { type AirlineConfig, enabledAirlines } from "../../airlines/registry";

/** One airline, several, or undefined for every enabled airline. */
export type AirlineFilter = string | readonly string[] | undefined;

export type SqlParam = string | number;

/** `?,?,?` for an IN list. Callers guard empty lists: `IN ()` is a syntax error. */
export function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

/** Cache key for an AirlineFilter. */
export function filterKey(f: AirlineFilter): string {
  if (f === undefined) return "ALL";
  return Array.isArray(f) ? f.join(",") : (f as string);
}

/** Append `AND <alias.>airline = ?` (or `IN (…)`) and its params when scope is set. */
export function withAirline(
  sql: string,
  airline: AirlineFilter,
  alias = "",
  params: SqlParam[] = []
): { sql: string; params: SqlParam[] } {
  if (airline === undefined) return { sql, params };
  const col = alias ? `${alias}.airline` : "airline";
  if (typeof airline === "string") {
    return { sql: `${sql} AND ${col} = ?`, params: [...params, airline] };
  }
  if (airline.length === 0) return { sql: `${sql} AND 1=0`, params };
  return {
    sql: `${sql} AND ${col} IN (${placeholders(airline)})`,
    params: [...params, ...airline],
  };
}

/** `<column> IN (…)` over explicit codes; an empty list matches nothing. */
export function airlineIn(
  airlines: readonly string[],
  column = "airline"
): { sql: string; params: string[] } {
  if (airlines.length === 0) return { sql: "1=0", params: [] };
  return { sql: `${column} IN (${placeholders(airlines)})`, params: [...airlines] };
}

/** Resolve an AirlineFilter to concrete airline codes (undefined = all enabled). */
export function airlineCodes(airline: AirlineFilter): readonly string[] {
  if (airline === undefined) return enabledAirlines().map((a) => a.code);
  return typeof airline === "string" ? [airline] : airline;
}

/** GLOB pattern for flight numbers under one carrier prefix: `UA[0-9]*`. */
export function prefixGlob(prefix: string): string {
  return `${prefix}[0-9]*`;
}

/** `<column> GLOB ?` ORed over carrier prefixes. */
export function flightNumberGlob(
  prefixes: readonly string[],
  column = "flight_number"
): { clause: string; params: string[] } {
  return {
    clause: prefixes.map(() => `${column} GLOB ?`).join(" OR "),
    params: prefixes.map(prefixGlob),
  };
}

/**
 * The permalink spelling of a stored flight number: marketing prefix, no zero
 * padding (HA0011 → HA11, 1234 → UA1234). The padded URL 301s here, so every
 * surface that links or counts flight numbers keys on this form.
 */
export function marketingFlightNumber(cfg: AirlineConfig, raw: string): string {
  return stripFlightNumberZeros(ensureAirlinePrefix(cfg, raw));
}

/**
 * Airport codes eligible for a route URL: IATA only, so one airport is exactly
 * one URL. Rows carrying 4-letter ICAO codes are skipped by both the sitemap
 * and the page gate, which keeps the two in agreement.
 */
export const ROUTE_AIRPORT_RE = /^[A-Z]{3}$/;

/** Two IATA codes that differ. A→A rows are returns and diversions, never a route. */
export function isCleanAirportPair(origin: string, destination: string): boolean {
  return (
    ROUTE_AIRPORT_RE.test(origin) && ROUTE_AIRPORT_RE.test(destination) && origin !== destination
  );
}

/** SQL twin of isCleanAirportPair. */
export function cleanAirportPairSql(origin: string, destination: string): string {
  return `${origin} GLOB '[A-Z][A-Z][A-Z]' AND ${destination} GLOB '[A-Z][A-Z][A-Z]'
    AND ${origin} <> ${destination}`;
}

/** The sheet's two spellings of Starlink: express tabs say StrLnk, mainline Starlink. */
export const SHEET_STARLINK_WIFI = ["StrLnk", "Starlink"] as const;

/** `<column> IN ('StrLnk', 'Starlink')` — literals, the vocabulary is fixed. */
export function sheetSaysStarlink(column = "wifi"): string {
  return `${column} IN (${SHEET_STARLINK_WIFI.map((w) => `'${w}'`).join(", ")})`;
}

/** Deterministic 32-bit hash of a tail, for per-tail jitter that is stable across runs. */
export function tailHash(tailNumber: string): number {
  let hash = 0;
  for (let i = 0; i < tailNumber.length; i++) {
    hash = (hash * 31 + tailNumber.charCodeAt(i)) >>> 0;
  }
  return hash;
}
