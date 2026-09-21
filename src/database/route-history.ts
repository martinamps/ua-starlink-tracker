import type { Database } from "bun:sqlite";
import { canonicalPermalinkFor, permalinkFlightNumber } from "../airlines/flight-number";
import { AIRLINES } from "../airlines/registry";
import { prefixGlob } from "./sql/fragments";

/**
 * Newest route-cache sighting (unix sec) per marketing number on a pair, keyed
 * by the same normalized spelling getRouteFlightNumbers emits, so a route page
 * can date the numbers it lists as history.
 */
export function getRouteFlightLastSeen(
  db: Database,
  origin: string,
  destination: string,
  airline: string
): Map<string, number> {
  const cfg = AIRLINES[airline];
  const out = new Map<string, number>();
  if (!cfg) return out;
  const marketing = canonicalPermalinkFor(cfg);
  const rows = db
    .query(
      `SELECT flight_number, last_seen_at FROM flight_routes
       WHERE origin = ? AND destination = ? AND flight_number GLOB ?`
    )
    .all(origin, destination, prefixGlob(cfg.iata)) as Array<{
    flight_number: string;
    last_seen_at: number;
  }>;
  for (const r of rows) {
    const fn = permalinkFlightNumber(cfg, r.flight_number);
    if (!marketing.test(fn)) continue;
    out.set(fn, Math.max(out.get(fn) ?? 0, r.last_seen_at));
  }
  return out;
}
