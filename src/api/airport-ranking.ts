/**
 * "Which airports have the most Starlink flights?": the ranking on /routes
 * and the rank each airport page quotes.
 *
 * A count of departures scheduled on listed aircraft for one dated local day,
 * never a share: the schedule tables hold Starlink planes alone. The airline's
 * own hub figure rides beside ours as the airline's, dated, and nothing is
 * worked out from it.
 */

import { type HubFigures, hubFigures } from "../airlines/hub-figures";
import type { AirlineConfig } from "../airlines/registry";
import type { ScopedReader } from "../database/reader";
import { unixNow } from "../database/sql/windows";

/**
 * An airport is ranked from this many departures on the day. On a measured
 * day a third of the airports with any had exactly one: a tie of dozens that
 * a single aircraft swap reorders. Those are listed, not ranked.
 */
export const AIRPORT_RANK_MIN_DEPARTURES = 2;

/** Rows shown before the fold-out. */
export const AIRPORT_RANK_OPEN_ROWS = 25;

export interface AirportRankRow {
  /** 1 for the most departures; airports with equal counts share a rank. */
  rank: number;
  airport: string;
  /** The airport's next local day, YYYY-MM-DD: the day `departures` is for. */
  date: string;
  departures: number;
  /** The airline's own per-day figure for this airport, when it published one. */
  airlineFigure: number | null;
}

export interface AirportRanking {
  /** Short airline name ("United"). */
  airline: string;
  rows: AirportRankRow[];
  /** Airports under the ranking's minimum, A to Z. */
  unranked: string[];
  /** The local day most rows are for; rows on another say so. */
  date: string | null;
  figures: HubFigures | null;
}

export function buildAirportRanking(
  cfg: AirlineConfig,
  reader: ScopedReader,
  nowSec = unixNow()
): AirportRanking {
  const counts = reader.getAirportDayCounts();
  const figures = hubFigures(cfg.code, nowSec);
  const rows: AirportRankRow[] = [];
  for (const c of counts) {
    if (c.departures < AIRPORT_RANK_MIN_DEPARTURES) continue;
    const prev = rows[rows.length - 1];
    rows.push({
      rank: prev && prev.departures === c.departures ? prev.rank : rows.length + 1,
      airport: c.airport,
      date: c.date,
      departures: c.departures,
      airlineFigure: figures?.perDay[c.airport] ?? null,
    });
  }
  const perDate = new Map<string, number>();
  for (const r of rows) perDate.set(r.date, (perDate.get(r.date) ?? 0) + 1);
  const date = [...perDate].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  return {
    airline: cfg.shortName,
    rows,
    unranked: counts
      .filter((c) => c.departures < AIRPORT_RANK_MIN_DEPARTURES)
      .map((c) => c.airport)
      .sort(),
    date,
    figures,
  };
}
