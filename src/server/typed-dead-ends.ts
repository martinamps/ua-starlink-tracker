/**
 * What a traveller typed where a flight number goes, when it is not a flight
 * this host answers: an airline's name for its code, a flight of another
 * airline, or a tail number read off the aircraft. Each resolves to a page
 * that already exists, or to nothing. No new address is minted here.
 */

import {
  CANONICAL_FLIGHT_PERMALINK,
  canonicalFlightFor,
  canonicalFlightInput,
  detectMarketingCarrier,
  flightInputRules,
  icaoCallsignToIata,
  spelledOutFlight,
  stripFlightNumberZeros,
} from "../airlines/flight-number";
import {
  type AirlineConfig,
  SITES,
  hubLookupAirlines,
  looksLikeValidTailNumber,
  siteForAirline,
} from "../airlines/registry";
import type { FlightElsewhere } from "../components/check-flight/types";
import { airportTimezone } from "../utils/airport-tz";

interface TypedFlight {
  cfg: AirlineConfig;
  flightNumber: string;
  /** The airline was typed by name, so the address is a misspelling of the coded one. */
  spelled: boolean;
}

/** The coded flight of an airline the lookup surfaces answer, from its code,
 * its own callsign or its name. Null for every other airline's flight. */
export function typedFlight(raw: string): TypedFlight | null {
  const spelled = spelledOutFlight(raw);
  if (spelled) return { ...spelled, spelled: true };
  const fn = stripFlightNumberZeros(icaoCallsignToIata(canonicalFlightInput(raw)));
  if (!CANONICAL_FLIGHT_PERMALINK.test(fn)) return null;
  const cfg = detectMarketingCarrier(fn, hubLookupAirlines());
  return cfg && fn.startsWith(cfg.iata) ? { cfg, flightNumber: fn, spelled: false } : null;
}

/** The flight's page on its airline's own live site, when that site has one. */
export function checkPageFor(flight: TypedFlight, date: string | null): string | null {
  const site = siteForAirline(flight.cfg.code, true);
  if (!site?.features.checkFlightPage) return null;
  return `https://${site.canonicalHost}/check-flight/${flight.flightNumber}${date ? `/${date}` : ""}`;
}

/** Where another airline's flight is answered, seen from a single-airline
 * site: its own live tracker by name, else the hub's check without naming it
 * (a tenant never names an airline whose site is not public). */
export function flightElsewhere(flight: TypedFlight, date: string | null): FlightElsewhere {
  const page = checkPageFor(flight, date);
  return page
    ? {
        kind: "sister",
        href: page,
        label: `Check ${flight.flightNumber} on the ${flight.cfg.shortName} Starlink Tracker`,
      }
    : { kind: "hub", href: `https://${SITES.airline.canonicalHost}/`, label: "all-airlines site" };
}

/** The airlines we track, for a flight of one we don't. */
export function trackedAirlinesLink(): FlightElsewhere {
  return {
    kind: "airlines",
    href: `https://${SITES.airline.canonicalHost}/airlines`,
    label: "See the airlines we track",
  };
}

/** A registration as typed, uppercased. The leading letter is required: bare
 * digits where a flight goes are a flight number. */
export function typedTail(raw: string): string | null {
  const tail = raw.trim().toUpperCase();
  return looksLikeValidTailNumber(tail) ? tail : null;
}

/** A word and a short number: some airline's flight, by callsign or by name. */
export function looksLikeAFlight(raw: string): boolean {
  return /^[A-Z]{3,}\d{1,4}$/.test(canonicalFlightInput(raw));
}

/** Digits alone where a flight goes, completed with the site's own code the
 * way the search form completes them. Null unless that is a real permalink,
 * and for zeros alone: no airline flies flight 0, so "0" is no flight's hop. */
export function bareDigitsFlight(pinned: AirlineConfig, raw: string): string | null {
  return /^0*[1-9]\d*$/.test(canonicalFlightInput(raw))
    ? canonicalFlightFor(flightInputRules(pinned), raw)
    : null;
}

/** Five digits, bare or behind the site's code: too long for a flight number,
 * and the shape of a tail number read without its N (UA39450 for N39450).
 * Returns the digits for the tail lookup, null for any other shape. */
export function longNumberDigits(pinned: AirlineConfig, raw: string): string | null {
  const fn = canonicalFlightInput(raw);
  const digits = fn.startsWith(pinned.iata) ? fn.slice(pinned.iata.length) : fn;
  return /^\d{5}$/.test(digits) ? digits : null;
}

/** Codes travellers type for an airline's own: United read as "US". A code
 * that is some airline's own (U2 is easyJet's, so U268 is a real flight) never
 * goes here. Only the site's own airline is ever suggested. */
const LOOKALIKE_CODES: Readonly<Record<string, readonly string[]>> = { UA: ["US"] };

/** The site's own flight a look-alike code most likely meant (US852 → UA852),
 * offered as a link, never a redirect: the typed code could be meant as typed. */
export function lookalikeFlight(pinned: AirlineConfig, raw: string): string | null {
  const fn = canonicalFlightInput(raw);
  for (const code of LOOKALIKE_CODES[pinned.iata] ?? []) {
    const m = fn.match(/^([A-Z]+)(\d{1,4})$/);
    if (m && m[1] === code) return canonicalFlightFor(flightInputRules(pinned), m[2]);
  }
  return null;
}

/** Two airport codes run together (IADLAX, IAD-LAX, "IAD to LAX"), each one
 * an airport on record. The caller still checks the pair is flown. */
export function typedAirportPair(raw: string): { origin: string; destination: string } | null {
  const m = raw
    .trim()
    .toUpperCase()
    .match(/^([A-Z]{3})(?:\s*(?:-|–|>|→|\s|\bTO\b)\s*)?([A-Z]{3})$/);
  if (!m || m[1] === m[2]) return null;
  return airportTimezone(m[1]) && airportTimezone(m[2])
    ? { origin: m[1], destination: m[2] }
    : null;
}
