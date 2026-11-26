/**
 * What a traveller calls a place when the names table files its airports
 * under another name: "New York" for Newark, "DC" for Dulles, and the city
 * codes airline sites take (NYC, LON).
 *
 * Short and by hand. A row belongs here only if:
 *  - every airport it names is in the names table (airport-names.ts), and
 *  - each is that city's own airport, or carries the city's IATA code: no
 *    neighbouring city under a city's name (no Baltimore under Washington, no
 *    Oakland under San Francisco, no Stewart under New York), and no state,
 *    country or region as a way to one airport.
 * It is not a list of search terms: a spelling the search already finds
 * ("chicago", "vegas", "san fran") does not need a row.
 *
 * `names` are folded as foldPlace folds them: lowercase, no punctuation. The
 * search reads them with spaces and dots aside, so "dc" is also "D.C.".
 * No name here may be a code the table holds: a typed code always wins.
 */
export interface PlaceAlias {
  names: readonly string[];
  airports: readonly string[];
}

// biome-ignore format: one place per line keeps the list readable
export const PLACE_ALIASES: readonly PlaceAlias[] = [
  // IATA's city code NYC covers JFK, LaGuardia and Newark; Newark is United's
  // New York hub. Stewart is left out: it is in Newburgh, 60 miles away.
  { names: ["new york", "new york city", "nyc", "ny"], airports: ["JFK", "LGA", "EWR"] },
  // The table's two Washington airports. Baltimore shares the city code WAS
  // and is left out: it is another city.
  { names: ["washington dc", "dc", "was"], airports: ["IAD", "DCA"] },
  // City codes, for the airports the table files under that city.
  { names: ["chi"], airports: ["ORD", "MDW"] },
  { names: ["lon"], airports: ["LHR", "LGW", "STN"] },
  { names: ["par"], airports: ["CDG", "ORY"] },
  { names: ["tyo"], airports: ["HND", "NRT"] },
  { names: ["mil"], airports: ["MXP", "LIN"] },
  { names: ["rom"], airports: ["FCO"] },
  { names: ["bjs"], airports: ["PEK", "PKX"] },
  // A city's everyday short name, for its one airport in the table.
  { names: ["la"], airports: ["LAX"] },
  { names: ["philly"], airports: ["PHL"] },
  { names: ["nola"], airports: ["MSY"] },
];

/**
 * The airports behind letters shaped like a code that are a place's name
 * instead: a city code ("NYC") or "nola". Null for anything else. For the two
 * readers that meet such letters without the names table: the planner's page
 * before its names file has loaded, and the plan address.
 */
export function placeCodeAirports(text: string): readonly string[] | null {
  const typed = text.trim().toLowerCase();
  if (!/^[a-z]{3,4}$/.test(typed)) return null;
  return PLACE_ALIASES.find(({ names }) => names.includes(typed))?.airports ?? null;
}

/** "JFK, LGA or EWR": a row's airports as a sentence offers them. */
export function orList(codes: readonly string[]): string {
  return codes.length > 1
    ? `${codes.slice(0, -1).join(", ")} or ${codes[codes.length - 1]}`
    : (codes[0] ?? "");
}
