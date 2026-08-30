/**
 * Airline-agnostic flight-number normalization. Behavior is driven entirely by
 * the AirlineConfig — adding a carrier means adding a config, not editing here.
 */

import { type AirlineConfig, enabledAirlines } from "./registry";

function detectByPrefixes(
  flightNumber: string,
  airlines: readonly AirlineConfig[],
  prefixesOf: (cfg: AirlineConfig) => string[]
): AirlineConfig | null {
  const fn = flightNumber.trim().toUpperCase();
  let best: { cfg: AirlineConfig; len: number } | null = null;
  for (const cfg of airlines) {
    for (const prefix of prefixesOf(cfg)) {
      if (
        fn.startsWith(prefix) &&
        /^\d+$/.test(fn.slice(prefix.length)) &&
        prefix.length > (best?.len ?? 0)
      ) {
        best = { cfg, len: prefix.length };
      }
    }
  }
  return best?.cfg ?? null;
}

/**
 * Detect which airline a flight number belongs to via longest-prefix match
 * across all enabled airlines' carrierPrefixes. Returns null if none match.
 */
export function detectAirline(
  flightNumber: string,
  airlines: readonly AirlineConfig[] = enabledAirlines()
): AirlineConfig | null {
  return detectByPrefixes(flightNumber, airlines, (cfg) => [cfg.iata, ...cfg.carrierPrefixes]);
}

/**
 * Host-less detection (hub APIs): only the airline's own marketing IATA/ICAO
 * codes count. Operating-carrier prefixes (OO/SKW/YX…) fly for multiple
 * marketing carriers, so matching them would silently attribute a shared
 * regional flight to one airline — fail closed instead.
 */
export function detectMarketingCarrier(
  flightNumber: string,
  airlines: readonly AirlineConfig[] = enabledAirlines()
): AirlineConfig | null {
  return detectByPrefixes(flightNumber, airlines, (cfg) => [cfg.iata, cfg.icao]);
}

function iataExact(cfg: AirlineConfig): RegExp {
  return new RegExp(`^${cfg.iata}\\d+$`);
}

/**
 * Does this flight number's carrier prefix belong to `cfg`?
 *
 * detectMarketingCarrier only recognises airlines we track, so an untracked
 * carrier's number (DL100, B6100) looked prefix-less and got answered from the
 * pinned carrier's model — B6100 was reported as 70% Starlink because
 * inferSubfleet read "6100" as a United Express number. Bare digits stay true:
 * they carry no carrier claim, so the pinned carrier owns them.
 */
export function prefixBelongsTo(cfg: AirlineConfig, flightNumber: string): boolean {
  const fn = flightNumber.trim().toUpperCase();
  const m = fn.match(/^([A-Z]+)\d+$/);
  if (!m) return true;
  const prefix = m[1];
  return prefix === cfg.iata || prefix === cfg.icao || cfg.carrierPrefixes.includes(prefix);
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
  // Zero-padding is stripped here, not just at the permalink layer: boarding
  // passes and GDS itineraries print UA0100, the verification log stores UA100
  // (the DB writer strips too), so a padded query silently missed every row and
  // fell through to the fleet prior. buildFlightLookupVariants re-adds every
  // padding width for the DB lookup, so canonicalizing first is lossless.
  if (iataExact(cfg).test(normalized)) return stripFlightNumberZeros(normalized);
  if (/^\d+$/.test(normalized)) return `${cfg.iata}${normalized.replace(/^0+(?=\d)/, "")}`;
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

/** Strip zero-padding so each flight has exactly one spelling (HA0011 → HA11).
 * Permalinks 301 to this form and the sitemap advertises it. */
export function stripFlightNumberZeros(flightNumber: string): string {
  return flightNumber.replace(/^([A-Z]+)0+(?=\d)/, "$1");
}

/**
 * The one spelling a /check-flight permalink may take: two-letter marketing
 * IATA plus 1-4 digits, zero-padding already stripped. Every producer of a
 * permalink (sitemap, route pages) and the router that resolves one must agree
 * on this shape — when they drifted, the sitemap advertised /check-flight/UA63986
 * (5 digits, minted by an FR24 cache write) and the router 404'd it.
 */
export const CANONICAL_FLIGHT_PERMALINK = /^[A-Z]{2}\d{1,4}$/;

/**
 * What may be persisted into the flight_routes cache. Looser than the permalink
 * shape because the cache legitimately holds operating-carrier numbers (SKW4726
 * for a United Express leg) that have no permalink of their own, but still
 * bounded to 4 digits — the cache is written from caller-supplied lookup input,
 * and the sitemap enumerates it.
 */
export const CACHEABLE_FLIGHT_NUMBER = /^[A-Z]{2,3}\d{1,4}$/;

/** Marketing-number matcher for one airline, bounded to the permalink shape. */
export function canonicalPermalinkFor(cfg: AirlineConfig): RegExp {
  return new RegExp(`^${cfg.iata}\\d{1,4}$`);
}

/**
 * Carrier-prefix variants plus zero-padded spellings for DB lookup. Schedule
 * feeds store some carriers' numbers zero-padded (HA11 arrives as HA0011) at
 * inconsistent widths, so every width from the natural spelling up to 5 digits
 * is generated — the sitemap strips ANY padding when it advertises a
 * permalink, and the existence gate must match whatever padded row produced
 * that entry or an advertised URL would 404.
 */
export function buildFlightLookupVariants(cfg: AirlineConfig, flightNumber: string): string[] {
  const variants = new Set(buildAirlineFlightNumberVariants(cfg, flightNumber));
  for (const v of [...variants]) {
    const m = v.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const digits = m[2].replace(/^0+(?=\d)/, "");
    for (let width = digits.length; width <= 5; width++) {
      variants.add(`${m[1]}${digits.padStart(width, "0")}`);
    }
  }
  return [...variants];
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
