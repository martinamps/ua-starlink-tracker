/**
 * Strict readers for an aircraft type a traveller states ("Airbus A350-1000",
 * as a booking prints it), for an airline whose own statement names one type
 * (TypeStatementRule in the registry). A stated type is the whole of what such
 * an answer rests on, so a reader says "covered" only for a spelling that can
 * mean nothing else: a near-miss is "unclear" or "other", never a yes.
 */

export type StatedTypeMatch = "covered" | "unclear" | "other";

/** "Airbus A350-1000" → "A3501000": the maker's name and every separator
 * dropped, so the readers below compare whole strings, never substrings. */
export function statedTypeKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\bAIRBUS\b/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

/** What may be printed back of a stated type: its letters, digits, spaces and
 * hyphens, bounded. */
export function statedTypeEcho(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9 -]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

// Virgin Atlantic's A350 is the A350-1000 (ICAO A35K, IATA 351). An A350-900
// under a VS number is a partner airline's aircraft, which the statement
// doesn't speak for, so it is left out on purpose.
const VS_A350 = /^(A350|A3501000|A3501041|A35K|351)$/;

export function virginAtlanticA350(raw: string): StatedTypeMatch {
  return VS_A350.test(statedTypeKey(raw)) ? "covered" : "other";
}

// The A320neo by its name, its ICAO and IATA codes and its two engine
// variants. The A321neo is another type, and SAS's words don't name it.
const SK_A320NEO = /^(A320NEO|A20N|32N|A320251N|A320271N)$/;
// A booking's "A320" names the family: it can be an A320neo or an older A320.
const BARE_A320 = /^(A320|320)$/;

export function sasA320neo(raw: string): StatedTypeMatch {
  const key = statedTypeKey(raw);
  if (SK_A320NEO.test(key)) return "covered";
  return BARE_A320.test(key) ? "unclear" : "other";
}
