/**
 * The dependency-free core of flight-number input handling, shared by the
 * server (via flight-number.ts) and the browser bundle (src/client), so the
 * search form and the permalink router can't disagree on a spelling.
 */

/**
 * How people actually type flight numbers: "UA 544", "ua-544", "UA.544".
 * Stripping separators before any prefix logic keeps every surface agreeing;
 * digits stay digits, so "UA 544 2026" still fails the 1-4 digit bound.
 */
export const FLIGHT_INPUT_SEPARATORS = /[\s\-.]/g;

export function canonicalFlightInput(s: string): string {
  return s.trim().toUpperCase().replace(FLIGHT_INPUT_SEPARATORS, "");
}

/** Strip zero-padding so each flight has exactly one spelling (HA0011 → HA11).
 * Permalinks 301 to this form and the sitemap advertises it. */
export function stripFlightNumberZeros(flightNumber: string): string {
  return flightNumber.replace(/^([A-Z]+)0+(?=\d)/, "$1");
}

/** One carrier's permalink rules as plain data (flightInputRules builds it). */
export interface FlightInputRules {
  iata: string;
  icao: string;
  permalink: string;
}

/**
 * parseCheckFlightPath for one known carrier: separators out, bare
 * digits get the carrier code, its own ICAO callsign maps to IATA, padding
 * goes. Null when the result is not this carrier's permalink shape.
 */
export function canonicalFlightFor(rules: FlightInputRules, input: string): string | null {
  let fn = canonicalFlightInput(input);
  if (/^\d+$/.test(fn)) fn = rules.iata + fn;
  if (fn.startsWith(rules.icao) && /^\d+$/.test(fn.slice(rules.icao.length))) {
    fn = rules.iata + fn.slice(rules.icao.length);
  }
  fn = stripFlightNumberZeros(fn);
  return new RegExp(rules.permalink).test(fn) ? fn : null;
}
