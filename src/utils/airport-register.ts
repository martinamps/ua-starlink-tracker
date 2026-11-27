/**
 * The register under the hand tables: a name, a zone and a point for an
 * airport code none of them holds yet. The flight feed hands us a code days
 * before anyone places it, and until then its pages printed a bare code and
 * UTC times, and the planner offered no connection through it. On 27 Nov
 * 2026 four pull requests did nothing but place such codes by hand.
 *
 * A hand entry always wins. airport-names.ts, airport-tz.ts and
 * airport-geo.ts read their own table first and ask here only for a code it
 * lacks, so no answer about a hand-placed airport can change; a register row
 * for the same code is never read. The register's name is its municipality,
 * unchecked by a person ("Mopa" where the hand table says "Goa Mopa"): place
 * an airport by hand when its register name reads wrong.
 *
 * A row is all or nothing: name, zone, point and country together, or the
 * code is unknown (scripts/build-airport-register.ts says what a row must
 * pass). So "placed" still has one meaning across the three tables.
 *
 * Placed by the register is not placed by hand. A page about such an airport
 * prints the register's name and local times for whoever opens it, but stays
 * noindex and out of the sitemap, as a bare code's page does, and the log
 * names the code (data-freshness.ts) until someone checks it into the hand
 * tables: airport-tz.ts, isHandPlacedAirport, says why.
 *
 * Server only. The data is ~250 KB and the browser's airport picker reads
 * the hand names alone (airport-names.ts): nothing under src/client
 * may import this file or the three that read it
 * (tests/airport-register.test.ts builds the bundles and looks).
 */
import { AIRPORT_REGISTER } from "./airport-register-data";

export interface RegisterAirport {
  city: string;
  /** The airport's own name, where its city has several: "Tianfu". */
  airport?: string;
  coords: readonly [number, number];
  country: string;
  zone: string;
}

/** The register's row for a three-letter code, in either case; undefined when it has none. */
export function registerAirport(iata: string): RegisterAirport | undefined {
  const code = iata.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || !Object.hasOwn(AIRPORT_REGISTER, code)) return undefined;
  const [city, airport, lat, lon, country, zone] = AIRPORT_REGISTER[code];
  return { city, ...(airport ? { airport } : {}), coords: [lat, lon], country, zone };
}
