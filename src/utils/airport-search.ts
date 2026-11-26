/**
 * "chicago" -> O'Hare and Midway: the names table searched by what a visitor
 * types. The table (airport-names.ts) is the only source of airports; the
 * short alias list (airport-aliases.ts) adds other names for places it holds,
 * never an airport. A city neither has is not found, and the box says so.
 *
 * Pure and DOM-free: the browser's picker runs it (src/client/airport-picker)
 * and the tests run the same code.
 */
import { PLACE_ALIASES } from "./airport-aliases";
import { AIRPORT_NAMES, airportPlaceName } from "./airport-names";

export interface AirportMatch {
  code: string;
  /** "Chicago O'Hare": the place as airportPlaceName prints it. */
  name: string;
}

interface Row extends AirportMatch {
  /**
   * The folded name in each spelling a visitor may type, for a whole-phrase
   * prefix ("new y" -> "new york"; "saint l" and "st l" -> "st louis").
   */
  phrases: string[];
  /** Each phrase with its spaces closed up: "newyork", "laguardia". */
  squashed: string[];
  words: string[];
}

/** Longest text a search reads: the longest name is 31 characters. */
export const AIRPORT_QUERY_MAX = 40;

/**
 * Lowercase, accents dropped, everything but letters and digits a space:
 * "São Paulo" and "sao  paulo" fold alike, and so do "O'Hare" and "ohare".
 */
export function foldPlace(text: string): string {
  return text
    .slice(0, AIRPORT_QUERY_MAX)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const LONG_FORM: Record<string, string> = { st: "saint", ft: "fort" };
const SHORT_FORM: Record<string, string> = { saint: "st", fort: "ft" };
const respell = (phrase: string, forms: Record<string, string>) =>
  phrase
    .split(" ")
    .map((w) => forms[w] ?? w)
    .join(" ");

/** "st louis" is also "saint louis", "fort worth" also "ft worth": the table holds one spelling each. */
function spellings(phrase: string): string[] {
  return [...new Set([phrase, respell(phrase, LONG_FORM), respell(phrase, SHORT_FORM)])];
}

let rows: Row[] | null = null;
function table(): Row[] {
  if (rows) return rows;
  const codes = Object.keys(AIRPORT_NAMES);
  const sharing = new Map<string, string[]>();
  for (const code of codes) {
    const name = airportPlaceName(code) as string;
    sharing.set(name, [...(sharing.get(name) ?? []), code]);
  }
  rows = codes.map((code) => {
    const name = airportPlaceName(code) as string;
    const phrases = spellings(foldPlace(name));
    // "O'Hare" answers to "ohare" and to "hare".
    const apart = spellings(foldPlace(name.replace(/'/g, " ")));
    // One field under two codes (West Palm Beach's DJT and PBI) would be two
    // rows that read alike: each names the other.
    const twins = (sharing.get(name) ?? []).filter((c) => c !== code);
    return {
      code,
      name: twins.length > 0 ? `${name} (also ${twins.join(", ")})` : name,
      phrases,
      squashed: phrases.map((p) => p.replace(/ /g, "")),
      words: [...new Set([...phrases, ...apart].join(" ").split(" "))],
    };
  });
  return rows;
}

/**
 * The airports an alias names for this text. `whole` when the text is the
 * alias itself, spaces and dots aside ("dc", "D.C.", "new york", "newyork");
 * `started` when it begins one, from three letters on, so "new" already
 * lists Newark but "d" does not list Dulles.
 */
function aliased(q: string): { whole: Set<string>; started: Set<string> } {
  const whole = new Set<string>();
  const started = new Set<string>();
  const closed = q.replace(/ /g, "");
  for (const { names, airports } of PLACE_ALIASES) {
    for (const name of names) {
      const into =
        name.replace(/ /g, "") === closed
          ? whole
          : q.length >= 3 && name.startsWith(q)
            ? started
            : null;
      if (into) for (const code of airports) into.add(code);
    }
  }
  return { whole, started };
}

/** A three-letter code the table holds, or a K/P ICAO spelling of one. */
function tableCode(text: string): string | null {
  const upper = text.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(upper) && AIRPORT_NAMES[upper]) return upper;
  if (/^[KP][A-Z]{3}$/.test(upper) && AIRPORT_NAMES[upper.slice(1)]) return upper.slice(1);
  return null;
}

/** Text this short is not closed up: "san d" must not find Sandusky. */
const SQUASH_MIN = 6;

/**
 * Airports matching what was typed, best first: the code typed exactly, a
 * place's other name typed whole ("dc", "new york", a city code), names that
 * start with the text, names with a later word that does ("hare", "dulles")
 * or that match with the spaces closed up ("la guardia", "newyork"), then
 * codes that start with it. When the text is a place's other name, only that
 * place and names that start the same way are offered: "new york" is the
 * city's airports, not every airport in the state.
 * Within a rank, the airports in `prefer` come first in its order (the ones
 * this airline flies most, so "chicago" leads with O'Hare and "new york"
 * with Newark on United's site), then by name.
 * `total` counts every match, so a caller can say how many it left out.
 */
export function searchAirports(
  query: string,
  limit = 8,
  prefer: readonly string[] = []
): { matches: AirportMatch[]; total: number } {
  const q = foldPlace(query);
  if (!q) return { matches: [], total: 0 };
  const tokens = q.split(" ");
  const exact = tableCode(query);
  const codePrefix = tokens.length === 1 && q.length <= 3 ? q.toUpperCase() : null;
  const squash = q.replace(/ /g, "");
  const closedUp = squash.length >= SQUASH_MIN ? squash : null;
  const { whole, started } = aliased(q);
  const ranked: Array<{ rank: number; row: Row }> = [];
  for (const row of table()) {
    let rank = -1;
    if (row.code === exact) rank = 0;
    else if (whole.has(row.code)) rank = 1;
    else if (started.has(row.code) || row.phrases.some((p) => p.startsWith(q))) rank = 2;
    else if (whole.size > 0) rank = -1;
    else if (tokens.every((t) => row.words.some((w) => w.startsWith(t)))) rank = 3;
    else if (
      closedUp &&
      (row.squashed.some((s) => s.startsWith(closedUp)) ||
        row.words.some((w) => w.startsWith(closedUp)))
    )
      rank = 3;
    else if (codePrefix && row.code.startsWith(codePrefix)) rank = 4;
    if (rank >= 0) ranked.push({ rank, row });
  }
  const place = (code: string) => {
    const i = prefer.indexOf(code);
    return i < 0 ? prefer.length : i;
  };
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      place(a.row.code) - place(b.row.code) ||
      a.row.name.localeCompare(b.row.name)
  );
  return {
    matches: ranked.slice(0, limit).map(({ row }) => ({ code: row.code, name: row.name })),
    total: ranked.length,
  };
}

export type AirportResolution =
  /** Search by this code. `name` is null for a code passed through unread. */
  | { kind: "code"; code: string; name: string | null }
  /** Several airports fit: the visitor chooses. */
  | { kind: "choose"; matches: AirportMatch[]; total: number }
  | { kind: "none" };

/**
 * What a box's text means when the form is sent. A code is read first and
 * exactly as before names existed: three letters the table holds, or a K/P
 * ICAO spelling, go through untouched (the ICAO form as typed, since the API
 * reads it). Other text is a name: one match is that airport, several are a
 * choice, and a place's other name that covers several airports is always a
 * choice. Three letters that match nothing still go through as a code, since
 * the data may hold an airport this table lacks; the plan address refuses
 * one it does not know. Four letters that match nothing are no code at all.
 */
export function resolveAirport(text: string, prefer: readonly string[] = []): AirportResolution {
  const typed = text.trim();
  const upper = typed.toUpperCase();
  const code = tableCode(typed);
  if (code) return { kind: "code", code: upper, name: airportPlaceName(code) };
  const { matches, total } = searchAirports(typed, 8, prefer);
  if (total === 1) return { kind: "code", code: matches[0].code, name: matches[0].name };
  if (total > 1) return { kind: "choose", matches, total };
  if (/^[A-Z]{3}$/.test(upper)) return { kind: "code", code: upper, name: null };
  return { kind: "none" };
}
