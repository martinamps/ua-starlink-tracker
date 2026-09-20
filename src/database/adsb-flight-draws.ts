/**
 * ADS-B flight draws: one row per (marketing flight number, tail) departure,
 * rolled up from adsb_observations callsigns.
 *
 * This is the only unbiased flight-number-to-tail record the project has. The
 * verification log holds only the tails the verifier chose to check (Starlink-
 * suspected ones), so a flight's log draws over-state its Starlink rate; the
 * ADS-B sweep covers the whole fleet. Kept as a rollup rather than queried
 * from adsb_observations on demand because that GROUP BY is a ~2s scan and the
 * predictor rebuilds its model lazily, inside a request.
 *
 * Deliberately never derived from adsb_observations.assigned_flight: that
 * column is only populated when upcoming_flights has the tail, which in
 * practice means Starlink tails, so it is more biased than the log.
 */

import type { Database } from "bun:sqlite";

export interface AdsbFlightDraw {
  flight_number: string;
  tail_number: string;
  first_seen: number;
  last_seen: number;
}

export interface AdsbFlightSighting {
  flight_number: string;
  tail_number: string;
  observed_at: number;
}

/** Sightings of one (flight, tail) closer than this are the same departure. */
export const ADSB_DRAW_MERGE_GAP_SEC = 4 * 3600;
export const ADSB_FLIGHT_DRAW_RETENTION_DAYS = 90;

export function ensureAdsbFlightDrawsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adsb_flight_draws (
      flight_number TEXT NOT NULL,
      tail_number TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (flight_number, tail_number, first_seen)
    );
    CREATE INDEX IF NOT EXISTS idx_adsb_draws_first_seen ON adsb_flight_draws(first_seen);
  `);
}

function hasDrawsTable(db: Database): boolean {
  return !!db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='adsb_flight_draws'")
    .get();
}

/** Collapse sightings into departures before touching the table, so a sweep
 * or a backfill chunk costs one upsert per departure rather than per row. */
function mergeSightings(sightings: readonly AdsbFlightSighting[]): AdsbFlightDraw[] {
  const sorted = [...sightings].sort(
    (a, b) =>
      a.flight_number.localeCompare(b.flight_number) ||
      a.tail_number.localeCompare(b.tail_number) ||
      a.observed_at - b.observed_at
  );
  const runs: AdsbFlightDraw[] = [];
  for (const s of sorted) {
    const last = runs.at(-1);
    if (
      last &&
      last.flight_number === s.flight_number &&
      last.tail_number === s.tail_number &&
      s.observed_at - last.last_seen < ADSB_DRAW_MERGE_GAP_SEC
    ) {
      last.last_seen = Math.max(last.last_seen, s.observed_at);
      continue;
    }
    runs.push({
      flight_number: s.flight_number,
      tail_number: s.tail_number,
      first_seen: s.observed_at,
      last_seen: s.observed_at,
    });
  }
  return runs;
}

/**
 * Fold sightings into the rollup. A run extends the latest stored departure of
 * the same (flight, tail) that started at or before it and ended less than
 * ADSB_DRAW_MERGE_GAP_SEC before it began; otherwise it is a new departure.
 * Matching on "started at or before" rather than "the newest row" keeps the
 * merge correct when the backfill writes older rows after live sweeps.
 */
export function upsertAdsbFlightDraws(
  db: Database,
  sightings: readonly AdsbFlightSighting[]
): number {
  if (sightings.length === 0) return 0;
  const runs = mergeSightings(sightings);
  const findPrior = db.query(
    `SELECT first_seen, last_seen FROM adsb_flight_draws
     WHERE flight_number = ? AND tail_number = ? AND first_seen <= ?
     ORDER BY first_seen DESC LIMIT 1`
  );
  const extend = db.query(
    `UPDATE OR IGNORE adsb_flight_draws SET first_seen = ?, last_seen = ?
     WHERE flight_number = ? AND tail_number = ? AND first_seen = ?`
  );
  const insert = db.query(
    `INSERT OR IGNORE INTO adsb_flight_draws (flight_number, tail_number, first_seen, last_seen)
     VALUES (?, ?, ?, ?)`
  );
  db.transaction(() => {
    for (const r of runs) {
      const prior = findPrior.get(r.flight_number, r.tail_number, r.last_seen) as {
        first_seen: number;
        last_seen: number;
      } | null;
      if (prior && r.first_seen - prior.last_seen < ADSB_DRAW_MERGE_GAP_SEC) {
        extend.run(
          Math.min(prior.first_seen, r.first_seen),
          Math.max(prior.last_seen, r.last_seen),
          r.flight_number,
          r.tail_number,
          prior.first_seen
        );
      } else {
        insert.run(r.flight_number, r.tail_number, r.first_seen, r.last_seen);
      }
    }
  })();
  return runs.length;
}

export function pruneAdsbFlightDraws(db: Database, now: number): void {
  db.query("DELETE FROM adsb_flight_draws WHERE last_seen < ?").run(
    now - ADSB_FLIGHT_DRAW_RETENTION_DAYS * 86400
  );
}

export function countAdsbFlightDraws(db: Database): number {
  if (!hasDrawsTable(db)) return 0;
  return (db.query("SELECT COUNT(*) AS n FROM adsb_flight_draws").get() as { n: number }).n;
}

/** Departures that started at or after `sinceTs`. A database that predates
 * the table (a readonly snapshot) has no draws rather than an error. */
export function getAdsbFlightDraws(db: Database, sinceTs: number): AdsbFlightDraw[] {
  if (!hasDrawsTable(db)) return [];
  return db
    .query(
      `SELECT flight_number, tail_number, first_seen, last_seen
       FROM adsb_flight_draws WHERE first_seen >= ?`
    )
    .all(sinceTs) as AdsbFlightDraw[];
}

/** One flight number's departures since `sinceTs`, by time; a PK-prefix
 * search, so cheap enough for the request path. */
export function getAdsbFlightDrawsFor(
  db: Database,
  flightNumber: string,
  sinceTs: number
): AdsbFlightDraw[] {
  if (!hasDrawsTable(db)) return [];
  return db
    .query(
      `SELECT flight_number, tail_number, first_seen, last_seen
       FROM adsb_flight_draws WHERE flight_number = ? AND first_seen >= ?
       ORDER BY first_seen`
    )
    .all(flightNumber, sinceTs) as AdsbFlightDraw[];
}
