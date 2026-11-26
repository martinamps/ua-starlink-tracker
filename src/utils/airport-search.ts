/**
 * "chicago" -> O'Hare and Midway: the names table searched by what a visitor
 * types. The table (airport-names.ts) is the only source of names; this adds
 * none, so a city it lacks is not found and a visitor falls back to the code.
 *
 * Pure and DOM-free: the browser's picker runs it (src/client/airport-picker)
 * and the tests run the same code.
 */
import { AIRPORT_NAMES, airportPlaceName } from "./airport-names";

export interface AirportMatch {
  code: string;
  /** "Chicago O'Hare": the place as airportPlaceName prints it. */
  name: string;
}

interface Row extends AirportMatch {
  /** The folded name, for a whole-phrase prefix ("new y" -> "new york"). */
  phrase: string;
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

let rows: Row[] | null = null;
function table(): Row[] {
  if (rows) return rows;
  rows = Object.keys(AIRPORT_NAMES).map((code) => {
    const name = airportPlaceName(code) as string;
    const phrase = foldPlace(name);
    // "O'Hare" answers to "ohare" and to "hare".
    const apart = foldPlace(name.replace(/'/g, " "));
    return { code, name, phrase, words: [...new Set(`${phrase} ${apart}`.split(" "))] };
  });
  return rows;
}

/** A three-letter code the table holds, or a K/P ICAO spelling of one. */
function tableCode(text: string): string | null {
  const upper = text.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(upper) && AIRPORT_NAMES[upper]) return upper;
  if (/^[KP][A-Z]{3}$/.test(upper) && AIRPORT_NAMES[upper.slice(1)]) return upper.slice(1);
  return null;
}

/**
 * Airports matching what was typed, best first: the code typed exactly, names
 * that start with the text, names with a later word that does ("hare",
 * "dulles"), then codes that start with it. Within a rank, the airports in
 * `prefer` come first in its order (the ones this airline flies most, so
 * "chicago" leads with O'Hare on United's site), then by name.
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
  const ranked: Array<{ rank: number; row: Row }> = [];
  for (const row of table()) {
    let rank = -1;
    if (row.code === exact) rank = 0;
    else if (row.phrase.startsWith(q)) rank = 1;
    else if (tokens.every((t) => row.words.some((w) => w.startsWith(t)))) rank = 2;
    else if (codePrefix && row.code.startsWith(codePrefix)) rank = 3;
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
 * exactly as before this existed: three letters the table holds, or a K/P
 * ICAO spelling, go through untouched (the ICAO form as typed, since the API
 * reads it). Other text is a name: one match is that airport, several are a
 * choice. Three or four letters that match nothing still go through as a
 * code, so the API answers for them as it always has.
 */
export function resolveAirport(text: string, prefer: readonly string[] = []): AirportResolution {
  const typed = text.trim();
  const upper = typed.toUpperCase();
  const code = tableCode(typed);
  if (code) return { kind: "code", code: upper, name: airportPlaceName(code) };
  const { matches, total } = searchAirports(typed, 8, prefer);
  if (total === 1) return { kind: "code", code: matches[0].code, name: matches[0].name };
  if (total > 1) return { kind: "choose", matches, total };
  if (/^[A-Z]{3,4}$/.test(upper)) return { kind: "code", code: upper, name: null };
  return { kind: "none" };
}
