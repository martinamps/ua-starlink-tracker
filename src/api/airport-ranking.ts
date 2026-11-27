/**
 * "Which airports have the most Starlink flights?": the ranking on /routes
 * and the rank each airport page quotes.
 *
 * A count of departures on listed aircraft for each airport's local today
 * (gone and still to come), with tomorrow's scheduled count beside it, never a
 * share: the schedule tables hold Starlink planes alone. Ours stands
 * alone: an airline's hub figure belongs beside it only from the airline's own
 * words, and the ones in print name no source.
 */

import type { AirlineConfig } from "../airlines/registry";
import type { ScopedReader } from "../database/reader";

/**
 * An airport is ranked from this many departures on the day. On a measured
 * day a third of the airports with any had exactly one: a tie of dozens that
 * a single aircraft swap reorders. Those are listed, not ranked.
 */
export const AIRPORT_RANK_MIN_DEPARTURES = 2;

/** Rows shown before the fold-out. */
export const AIRPORT_RANK_OPEN_ROWS = 25;

export interface AirportRankRow {
  /** 1 for the most departures today; airports with equal counts share a rank. */
  rank: number;
  airport: string;
  /** The airport's local today, YYYY-MM-DD: the day `departures` is for. */
  date: string;
  /** Today's, gone and still to come: what the ranking orders by. */
  departures: number;
  /** Tomorrow's scheduled departures, and that day. */
  tomorrow: number;
  tomorrowDate: string;
}

export interface AirportRanking {
  /** Short airline name ("United"). */
  airline: string;
  rows: AirportRankRow[];
  /** Airports under the ranking's minimum, A to Z. */
  unranked: string[];
  /** The local today most rows are for; rows on another say so. */
  date: string | null;
}

export function buildAirportRanking(cfg: AirlineConfig, reader: ScopedReader): AirportRanking {
  const counts = reader.getAirportDayCounts();
  const rows: AirportRankRow[] = [];
  for (const c of counts) {
    if (c.today.departures < AIRPORT_RANK_MIN_DEPARTURES) continue;
    const prev = rows[rows.length - 1];
    rows.push({
      rank: prev && prev.departures === c.today.departures ? prev.rank : rows.length + 1,
      airport: c.airport,
      date: c.today.date,
      departures: c.today.departures,
      tomorrow: c.tomorrow.departures,
      tomorrowDate: c.tomorrow.date,
    });
  }
  const perDate = new Map<string, number>();
  for (const r of rows) perDate.set(r.date, (perDate.get(r.date) ?? 0) + 1);
  const date = [...perDate].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return {
    airline: cfg.shortName,
    rows,
    unranked: counts
      .filter((c) => c.today.departures < AIRPORT_RANK_MIN_DEPARTURES)
      .map((c) => c.airport)
      .sort(),
    date,
  };
}
