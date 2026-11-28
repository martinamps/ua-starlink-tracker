/**
 * Airports that changed their IATA code: the old code answers as the new one
 * wherever a visitor meets it (an address, a box, a link), so one place is one
 * page. Stored rows keep the code they were written under; only what we show
 * and link moves. Two codes that are both in use for one field (BSL and MLH,
 * the Basel-Mulhouse EuroAirport) are no rename and stay apart.
 * Dependency-free: the browser's airport picker reads it too.
 */
const RENAMED: Readonly<Record<string, string>> = {
  // West Palm Beach, from 18 Aug 2026.
  PBI: "DJT",
};

/** "PBI" → "DJT"; any other code, uppercased, as it came. */
export function currentAirportCode(code: string): string {
  const upper = code.toUpperCase();
  return RENAMED[upper] ?? upper;
}

/** Was this code retired for another? */
export function isRetiredAirportCode(code: string): boolean {
  return Object.hasOwn(RENAMED, code.toUpperCase());
}

/** "DJT" → ["PBI"]: the codes a place went by before. */
export function formerAirportCodes(code: string): string[] {
  const upper = code.toUpperCase();
  return Object.keys(RENAMED).filter((old) => RENAMED[old] === upper);
}

/** A route page's address, under each airport's code now. */
export function routePlannerPath(origin: string, destination: string): string {
  return `/route-planner/${currentAirportCode(origin)}/${currentAirportCode(destination)}`;
}
