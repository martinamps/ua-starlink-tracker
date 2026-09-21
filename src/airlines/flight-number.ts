/**
 * Airline-agnostic flight-number normalization. Behavior is driven entirely by
 * the AirlineConfig — adding a carrier means adding a config, not editing here.
 */

import {
  type FlightInputRules,
  canonicalFlightFor,
  canonicalFlightInput,
  stripFlightNumberZeros,
} from "./flight-input";
import { AIRLINES, type AirlineConfig, enabledAirlines } from "./registry";

export { canonicalFlightFor, canonicalFlightInput, stripFlightNumberZeros };

function detectByPrefixes(
  flightNumber: string,
  airlines: readonly AirlineConfig[],
  prefixesOf: (cfg: AirlineConfig) => string[]
): AirlineConfig | null {
  const fn = canonicalFlightInput(flightNumber);
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
  const fn = canonicalFlightInput(flightNumber);
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
  const normalized = normalizeAirlineFlightNumber(cfg, canonicalFlightInput(flightNumber));
  // Zero-padding is stripped here, not just at the permalink layer: boarding
  // passes and GDS itineraries print UA0100, the verification log stores UA100
  // (the DB writer strips too), so a padded query silently missed every row and
  // fell through to the fleet prior. buildFlightLookupVariants re-adds every
  // padding width for the DB lookup, so canonicalizing first is lossless.
  if (iataExact(cfg).test(normalized)) return stripFlightNumberZeros(normalized);
  if (/^\d+$/.test(normalized)) return `${cfg.iata}${normalized.replace(/^0+(?=\d)/, "")}`;
  return normalized;
}

/** UAL675 → UA675: people paste the callsign from FR24/FlightAware. Only a
 * carrier's own ICAO code maps — operating prefixes (SKW, OO) fly for several. */
export function icaoCallsignToIata(fn: string): string {
  for (const cfg of enabledAirlines()) {
    if (fn.startsWith(cfg.icao) && /^\d{1,4}$/.test(fn.slice(cfg.icao.length))) {
      return `${cfg.iata}${fn.slice(cfg.icao.length)}`;
    }
  }
  return fn;
}

/**
 * The airline a /check-flight permalink answers for. Deliberately looser than
 * check-flight-core's decideCarrier: a pinned host owns only its own IATA
 * spelling, and the hub resolves by any tracked prefix.
 */
export function permalinkCarrier(
  pinned: AirlineConfig | null,
  flightNumber: string
): AirlineConfig | null {
  if (pinned) return flightNumber.startsWith(pinned.iata) ? pinned : null;
  return detectAirline(flightNumber);
}

/**
 * The permalink spelling of a stored flight number under its own carrier:
 * marketing prefix, no zero padding (HA0011 → HA11, 1234 → UA1234). The padded
 * URL 301s here, so every surface that links or counts flight numbers keys on
 * this form. Unlike marketingFlightNumber it never re-homes a foreign prefix.
 */
export function permalinkFlightNumber(cfg: AirlineConfig, raw: string): string {
  return stripFlightNumberZeros(ensureAirlinePrefix(cfg, raw));
}

/**
 * A stored row's number as the marketing number it's sold under: the row's own
 * carrier when its prefix maps there, else whichever tracked marketing carrier
 * owns the prefix, else the row carrier's IATA over the digits.
 */
export function marketingFlightNumber(rowCfg: AirlineConfig, raw: string): string {
  const fn = normalizeAirlineFlightNumber(rowCfg, raw);
  if (iataExact(rowCfg).test(fn)) return fn;
  const marketing = detectMarketingCarrier(raw);
  if (marketing) return normalizeAirlineFlightNumber(marketing, raw);
  const digits = raw.match(/^[A-Z]{2,3}(\d{1,4})$/)?.[1];
  return digits ? `${rowCfg.iata}${digits}` : raw;
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
  // carrierPrefixes carries the IATA code too, which would repeat flightNumber.
  return [...new Set([flightNumber, ...cfg.carrierPrefixes.map((p) => `${p}${num}`)])];
}

export interface SlotFlightPrefix {
  prefix: string;
  /** The marketing IATA a carrier's own code collapses to; null for an operator code. */
  marketing: string | null;
  /** An operator code's IATA when the row's airline is unknown: its first registry owner. */
  fallback: string;
}

let slotPrefixCache: readonly SlotFlightPrefix[] | null = null;

/**
 * Every code a tracked carrier's rows are stored under, longest first. A
 * carrier's own IATA/ICAO collapses to that carrier. A regional operator code
 * (SKW, OO) flies for several marketing carriers, so it collapses to the
 * row's airline: SkyWest's OO3448 on an Alaska row is sold as AS3448, the
 * same code on a United row as UA3448. The operator's own number is unique to
 * it, so either way two different departures never merge.
 */
export function slotFlightPrefixes(): readonly SlotFlightPrefix[] {
  if (slotPrefixCache) return slotPrefixCache;
  const marketing = new Map<string, string>();
  for (const cfg of Object.values(AIRLINES)) {
    for (const p of [cfg.iata, cfg.icao]) if (!marketing.has(p)) marketing.set(p, cfg.iata);
  }
  const owner = new Map<string, string>();
  for (const cfg of Object.values(AIRLINES)) {
    for (const p of [cfg.iata, cfg.icao, ...cfg.carrierPrefixes]) {
      if (!owner.has(p)) owner.set(p, cfg.iata);
    }
  }
  slotPrefixCache = [...owner]
    .map(([prefix, first]) => ({
      prefix,
      marketing: marketing.get(prefix) ?? null,
      fallback: first,
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
  return slotPrefixCache;
}

/**
 * The flight half of a physical departure slot, and the number it is sold
 * under. One departure is stored under several spellings (UAL1377 and UA1377,
 * SKW3440 and OO3440, HA0011): all of them collapse to one key. A spelling no
 * prefix explains, such as an ATC callsign (SKW302M), stays itself. `airline`
 * is the stored row's airline. Mirrored in SQL by slotFlightSql
 * (database.ts); tests pin the two together.
 */
export function slotFlightKey(flightNumber: string | null, airline?: string): string | null {
  if (!flightNumber) return flightNumber;
  for (const p of slotFlightPrefixes()) {
    if (!flightNumber.startsWith(p.prefix)) continue;
    const rest = flightNumber.slice(p.prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    const iata = p.marketing ?? (airline ? AIRLINES[airline]?.iata : undefined) ?? p.fallback;
    return `${iata}${Number.parseInt(rest, 10)}`;
  }
  return flightNumber;
}

/** The router's cap on a permalink's digits. */
const PERMALINK_DIGITS = String.raw`\d{1,4}`;

/**
 * An IATA airline designator: two alphanumeric characters, never two digits.
 * Deliberately wider than the [A-Z]{2} every carrier we track happens to use —
 * B6, 9E and G7 are all real, and a generic permalink shape that rejected them
 * while canonicalPermalinkFor accepted them is exactly the producer/router
 * disagreement this module exists to prevent.
 */
const IATA_CODE = String.raw`(?:[A-Z][A-Z0-9]|\d[A-Z])`;

/**
 * One template, so the generic shape and the per-airline matcher below are the
 * same predicate with the carrier code substituted rather than two spellings
 * that agree by luck.
 */
const permalinkPattern = (code: string) => `^${code}${PERMALINK_DIGITS}$`;

/**
 * The one spelling a /check-flight permalink may take: marketing IATA plus 1-4
 * digits, zero-padding already stripped. Every producer of a permalink
 * (sitemap, route pages, the IndexNow ping) and the router that resolves one
 * must agree on this shape — when they drifted, the sitemap advertised
 * /check-flight/UA63986 (5 digits, minted by an FR24 cache write) and the
 * router 404'd it.
 */
export const CANONICAL_FLIGHT_PERMALINK = new RegExp(permalinkPattern(IATA_CODE));

/**
 * What may be persisted into the flight_routes cache. Looser than the permalink
 * shape because the cache legitimately holds operating-carrier callsigns that
 * have no permalink of their own: the bare ICAO form (SKW4726 for a United
 * Express leg) and the suffixed form schedule feeds use to disambiguate a
 * reused number (QTR16A, SKW302M, UAL353T, ASH611A — 3.5% of production rows,
 * and the only source for most of Qatar's route pairs). Still bounded to 4
 * digits and one suffix letter: this cache is written from caller-supplied
 * lookup input and the sitemap enumerates it, so the bound is what stops an
 * arbitrary string minting a permalink.
 */
export const CACHEABLE_FLIGHT_NUMBER = /^[A-Z]{2,3}\d{1,4}[A-Z]?$/;

/** Marketing-number matcher for one airline, bounded to the permalink shape. */
export function canonicalPermalinkFor(cfg: AirlineConfig): RegExp {
  return new RegExp(permalinkPattern(cfg.iata));
}

/**
 * The permalink rules as plain data for canonicalFlightFor, so the browser
 * form and the no-JS redirect mint exactly the URL parseCheckFlightPath
 * accepts instead of carrying their own copy of the bound.
 */
export function flightInputRules(cfg: AirlineConfig): FlightInputRules {
  return {
    iata: cfg.iata,
    icao: cfg.icao,
    permalink: canonicalPermalinkFor(cfg).source,
  };
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
  return zeroPaddedVariants(buildAirlineFlightNumberVariants(cfg, flightNumber));
}

/** Each spelling plus its zero-padded forms up to 5 digits, deduplicated. */
export function zeroPaddedVariants(spellings: readonly string[]): string[] {
  const variants = new Set(spellings);
  for (const v of spellings) {
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
