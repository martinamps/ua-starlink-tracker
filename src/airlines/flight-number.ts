/**
 * Airline-agnostic flight-number normalization. Behavior is driven entirely by
 * the AirlineConfig — adding a carrier means adding a config, not editing here.
 */

import type { AirlineConfig } from "./registry";

function iataExact(cfg: AirlineConfig): RegExp {
  return new RegExp(`^${cfg.iata}\\d+$`);
}

/**
 * Normalize an operating-carrier flight number to the marketing-carrier code.
 * e.g. for UA: SKW5882 → UA5882, UAL544 → UA544, UA1234 → UA1234.
 */
export function normalizeAirlineFlightNumber(cfg: AirlineConfig, flightNumber: string): string {
  if (!flightNumber) return flightNumber;
  if (iataExact(cfg).test(flightNumber)) return flightNumber;
  for (const prefix of cfg.carrierPrefixes) {
    if (flightNumber.startsWith(prefix) && /^\d+$/.test(flightNumber.slice(prefix.length))) {
      return `${cfg.iata}${flightNumber.slice(prefix.length)}`;
    }
  }
  return flightNumber;
}

/**
 * Force a flight number into exact `{IATA}####` format. Composes
 * normalizeAirlineFlightNumber + bare-digit handling.
 */
export function ensureAirlinePrefix(cfg: AirlineConfig, flightNumber: string): string {
  const normalized = normalizeAirlineFlightNumber(cfg, flightNumber.trim().toUpperCase());
  if (iataExact(cfg).test(normalized)) return normalized;
  if (/^\d+$/.test(normalized)) return `${cfg.iata}${normalized}`;
  return normalized;
}

/**
 * Build all carrier-prefix variants of a marketing-code flight number for DB
 * lookup. The DB stores operating-carrier codes (SKW5212, OO5212, …) but users
 * enter the marketing code.
 */
export function buildAirlineFlightNumberVariants(
  cfg: AirlineConfig,
  flightNumber: string
): string[] {
  if (!iataExact(cfg).test(flightNumber)) return [flightNumber];
  const num = flightNumber.slice(cfg.iata.length);
  return [flightNumber, ...cfg.carrierPrefixes.map((p) => `${p}${num}`)];
}

/**
 * Infer subfleet from flight number using the airline's subfleet match rules.
 * First matching subfleet wins; "unknown" if none match.
 */
export function inferSubfleet(cfg: AirlineConfig, flightNumber: string): string {
  for (const sf of cfg.subfleets) {
    if (sf.match(flightNumber)) return sf.key;
  }
  return "unknown";
}
