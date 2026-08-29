/**
 * The bounded set of /rankings leaderboards. Definitions are static per
 * airline (URL space bounded by construction); each page's row set derives
 * from the live route leaderboard and is additionally gated on data — an
 * empty leaderboard 404s and never enters the sitemap, so both stay agreed.
 */

import type { AirlineConfig } from "../airlines/registry";
import type { RouteLeaderboardRow } from "../database/database";
import { AIRPORT_NAMES } from "../utils/airport-names";

export interface LeaderboardRow extends RouteLeaderboardRow {
  /** Equipped share of tracked departures, 0-100. */
  pct: number;
}

export interface LeaderboardDef {
  slug: string;
  /** Page H1 (question/intent form lives in the meta title). */
  heading: string;
  metaTitle: string;
  metaDescription: string;
  /** On-page one-liner under the H1. */
  lede: string;
  /** Methodology note rendered under the table. */
  note: string;
  select(rows: RouteLeaderboardRow[]): LeaderboardRow[];
}

const withPct = (r: RouteLeaderboardRow): LeaderboardRow => ({
  ...r,
  pct: r.departures > 0 ? Math.round((r.equipped / r.departures) * 100) : 0,
});

const IATA_RE = /^[A-Z]{3}$/;
const validPair = (r: RouteLeaderboardRow) =>
  IATA_RE.test(r.origin) && IATA_RE.test(r.destination) && r.origin !== r.destination;

// Transcon = East Coast <-> West Coast metro airports, either direction.
const TRANSCON_EAST = new Set(["BOS", "JFK", "LGA", "EWR", "PHL", "BWI", "DCA", "IAD"]);
const TRANSCON_WEST = new Set([
  "SEA",
  "PDX",
  "SFO",
  "OAK",
  "SJC",
  "LAX",
  "BUR",
  "LGB",
  "SNA",
  "ONT",
  "SAN",
]);
const isTranscon = (r: RouteLeaderboardRow) =>
  (TRANSCON_EAST.has(r.origin) && TRANSCON_WEST.has(r.destination)) ||
  (TRANSCON_WEST.has(r.origin) && TRANSCON_EAST.has(r.destination));

const byEquippedThenShare = (a: LeaderboardRow, b: LeaderboardRow) =>
  b.equipped - a.equipped ||
  b.pct - a.pct ||
  a.origin.localeCompare(b.origin) ||
  a.destination.localeCompare(b.destination);

const MAX_ROWS = 100;

export function leaderboardDefs(cfg: AirlineConfig): LeaderboardDef[] {
  const short = cfg.shortName;
  const defs: LeaderboardDef[] = [
    {
      slug: "100-percent-starlink-routes",
      heading: `${short} Routes Flying 100% Starlink`,
      metaTitle: `Which ${short} Routes Are 100% Starlink? Live Leaderboard`,
      metaDescription: `${cfg.name} routes where every tracked departure in the next 48 hours is on a Starlink-equipped aircraft — counted from live tail assignments and re-ranked continuously.`,
      lede: "Routes where every tracked departure in the next 48 hours is on a Starlink-equipped aircraft",
      note:
        "Only routes with at least two tracked departures in the window qualify — a 1-for-1 " +
        "route says more about the schedule than the rollout. Assignments publish about two " +
        "days out, so the list changes daily.",
      select: (rows) =>
        rows
          .filter(validPair)
          .filter((r) => r.departures >= 2 && r.equipped === r.departures)
          .map(withPct)
          .sort(
            (a, b) =>
              b.departures - a.departures ||
              a.origin.localeCompare(b.origin) ||
              a.destination.localeCompare(b.destination)
          )
          .slice(0, MAX_ROWS),
    },
    {
      slug: "best-transcon-starlink-routes",
      heading: `Best Transcon Routes for ${short} Starlink`,
      metaTitle: `Best ${short} Transcon Flights for Starlink WiFi — Live Ranking`,
      metaDescription: `Coast-to-coast ${cfg.name} routes ranked by Starlink-equipped departures in the next 48 hours — the flights where five hours of free, fast WiFi matters most.`,
      lede: "Coast-to-coast routes ranked by Starlink-equipped departures — where a five-hour flight with working WiFi matters most",
      note:
        "Transcon here means East Coast metros (BOS/NYC/PHL/BWI/DC) to West Coast metros " +
        "(Seattle to San Diego), both directions, ranked by equipped departures then equipped " +
        "share. Counted from live tail assignments over the next 48 hours.",
      select: (rows) =>
        rows
          .filter(validPair)
          .filter(isTranscon)
          .filter((r) => r.equipped > 0)
          .map(withPct)
          .sort(byEquippedThenShare)
          .slice(0, MAX_ROWS),
    },
  ];
  for (const iata of cfg.hubAirports) {
    const city = AIRPORT_NAMES[iata]?.city ?? iata;
    defs.push({
      slug: `hub-${iata.toLowerCase()}`,
      heading: `${city} (${iata}) Starlink Route Leaderboard`,
      metaTitle: `Which ${short} Flights From ${city} Have Starlink? ${iata} Leaderboard`,
      metaDescription: `${cfg.name} routes out of ${city} (${iata}) ranked by Starlink-equipped departures in the next 48 hours, with each route's equipped share of tracked departures.`,
      lede: `${short} routes from ${city} ranked by Starlink-equipped departures in the next 48 hours`,
      note: `Every ${cfg.name} route from ${iata} with at least one Starlink-equipped departure in the live window, ranked by equipped departures then equipped share. Routes not listed may still get one — assignments publish about two days out.`,
      select: (rows) =>
        rows
          .filter(validPair)
          .filter((r) => r.origin === iata && r.equipped > 0)
          .map(withPct)
          .sort(byEquippedThenShare)
          .slice(0, MAX_ROWS),
    });
  }
  return defs;
}
