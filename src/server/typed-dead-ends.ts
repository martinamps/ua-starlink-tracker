/**
 * What a traveller typed where a flight number goes, when it is not a flight
 * this host answers: an airline's name for its code, a flight of another
 * airline, or a tail number read off the aircraft. Each resolves to a page
 * that already exists, or to nothing. No new address is minted here.
 */

import {
  CANONICAL_FLIGHT_PERMALINK,
  canonicalFlightInput,
  detectMarketingCarrier,
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
