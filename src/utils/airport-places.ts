/**
 * An airport as people say it, for the server: "Chicago O'Hare (ORD)",
 * "Denver". The hand table (airport-names.ts) answers for every code it
 * holds, through its own functions, untouched. A code it lacks takes the
 * register's municipality (airport-register.ts), so a new code is named the
 * hour the feed first carries it. A code neither holds prints as its code
 * alone.
 *
 * Why a second file: the browser's airport picker bundles airport-names.ts,
 * and the register is ~250 KB that must not ride along. Server code imports
 * the names from here; only the picker's search (airport-search.ts) reads
 * airport-names.ts directly (tests/airport-register.test.ts holds the line).
 */
import * as hand from "./airport-names";
import { registerAirport } from "./airport-register";

interface RegisterName {
  code: string;
  city: string;
  /** With the airport's own name, which the register gives only where a city has several. */
  place: string;
}

/** The register's name, for a code the hand table lacks; null when it holds the code or neither does. */
function registerName(iata: string): RegisterName | null {
  const code = iata.toUpperCase();
  if (Object.hasOwn(hand.AIRPORT_NAMES, code)) return null;
  const reg = registerAirport(code);
  if (!reg) return null;
  return { code, city: reg.city, place: reg.airport ? `${reg.city} ${reg.airport}` : reg.city };
}

/**
 * "Chicago O'Hare", "Denver"; null for a code neither the table nor the
 * register holds. It is printed beside the code.
 */
export function airportPlaceName(iata: string): string | null {
  return registerName(iata)?.place ?? hand.airportPlaceName(iata);
}

/** "Chicago" for ORD: the city alone, for a sentence that needs no airport. */
export function airportCity(iata: string): string | null {
  return registerName(iata)?.city ?? hand.airportCity(iata);
}

/**
 * The place for a sentence that prints no code: "Denver", but "Washington
 * Dulles" where the city has several airports. Null for an unknown code.
 */
export function airportSpokenPlace(iata: string): string | null {
  return registerName(iata)?.place ?? hand.airportSpokenPlace(iata);
}

/** The place beside its code: "Chicago O'Hare (ORD)". An unknown code comes back alone. */
export function airportWithCode(iata: string): string {
  const reg = registerName(iata);
  return reg ? `${reg.place} (${reg.code})` : hand.airportWithCode(iata);
}

/** The city beside its code: "Chicago (ORD)". An unknown code comes back alone. */
export function airportCityWithCode(iata: string): string {
  const reg = registerName(iata);
  return reg ? `${reg.city} (${reg.code})` : hand.airportCityWithCode(iata);
}

/** "Chicago (ORD) to Denver (DEN)": a route as a reader would say it. */
export function routePairLabel(origin: string, destination: string): string {
  return `${airportCityWithCode(origin)} to ${airportCityWithCode(destination)}`;
}

/**
 * "Chicago O'Hare to Denver", to print beside a pair of codes. Null unless
 * both ends have a name: half a pair beside two codes reads as a mistake.
 */
export function routePlaceNames(origin: string, destination: string): string | null {
  const from = airportPlaceName(origin);
  const to = airportPlaceName(destination);
  return from && to ? `${from} to ${to}` : null;
}
