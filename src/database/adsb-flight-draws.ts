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
 *
 * A draw's airports come from the same sweep, for the same reason: the
 * aggregators report an aircraft on the ground with its position, for every
 * tail in the fleet, where upcoming_flights and flight_routes know a pair
 * only for tracked tails. The tail on the ground at an airport shortly before
 * the draw's first sighting is its origin; shortly after its last, its
 * destination. Either end nobody saw on the ground stays NULL, and so does
 * every row written before the columns existed: nothing here is inferred from
 * the flight number.
 */

import type { Database } from "bun:sqlite";
import { DAY_SEC } from "./sql/windows";

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

/** A draw with the airports it was seen on the ground at; null where it wasn't. */
export interface PlacedAdsbFlightDraw extends AdsbFlightDraw {
  origin: string | null;
  destination: string | null;
}

/** One fleet tail reported on the ground at an airport of the route network. */
export interface AdsbGroundSighting {
  tail_number: string;
  airport: string;
  observed_at: number;
}

/** Sightings of one (flight, tail) closer than this are the same departure. */
const ADSB_DRAW_MERGE_GAP_SEC = 4 * 3600;
export const ADSB_FLIGHT_DRAW_RETENTION_DAYS = 90;

/**
 * How far a ground sighting may sit from the airborne sighting it places.
 * Half an hour is too short to land anywhere else, turn and fly on, so the
 * airport is the one the draw left from or landed at; a longer gap (an
 * oceanic arrival, a field with no receiver) is left unplaced.
 */
export const ADSB_DRAW_PLACE_WINDOW_SEC = 30 * 60;
/** Airborne again sooner than this after a "landing" means the ground report
 * was wrong (no airliner turns in under twenty minutes): the destination is
 * dropped. */
const ADSB_DRAW_MIN_TURN_SEC = 20 * 60;

const PLACE_COLUMNS = ["origin TEXT", "destination TEXT", "landed_at INTEGER"] as const;

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
  const existing = new Set(
    (db.query("PRAGMA table_info(adsb_flight_draws)").all() as { name: string }[]).map(
      (c) => c.name
    )
  );
  for (const ddl of PLACE_COLUMNS) {
    if (!existing.has(ddl.split(" ")[0]))
      db.exec(`ALTER TABLE adsb_flight_draws ADD COLUMN ${ddl}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_adsb_draws_tail ON adsb_flight_draws(tail_number, last_seen);
    CREATE INDEX IF NOT EXISTS idx_adsb_draws_pair ON adsb_flight_draws(origin, destination, first_seen);
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
  // Both CASEs read the row as it was: SQLite evaluates every SET expression
  // before it writes any column.
  const extend = db.query(
    `UPDATE OR IGNORE adsb_flight_draws SET first_seen = ?1, last_seen = ?2,
       destination = CASE WHEN landed_at IS NOT NULL AND ?6 - landed_at < ?7
                          THEN NULL ELSE destination END,
       landed_at = CASE WHEN landed_at IS NOT NULL AND ?6 - landed_at < ?7
                        THEN NULL ELSE landed_at END
     WHERE flight_number = ?3 AND tail_number = ?4 AND first_seen = ?5`
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
          prior.first_seen,
          r.first_seen,
          ADSB_DRAW_MIN_TURN_SEC
        );
      } else {
        insert.run(r.flight_number, r.tail_number, r.first_seen, r.last_seen);
      }
    }
  })();
  return runs.length;
}

/**
 * Put this sweep's draws on their airports. `ground` is the sweep's own
 * ground sightings; origins read the earlier ones back from
 * adsb_observations.ground_airport. Call after the sweep's observations and
 * draws are written.
 *
 * Destination: a tail on the ground at an airport closes its latest draw, if
 * that draw was last seen in the air within the window and has no landing
 * yet. A first landing is never overwritten, so a through flight's row (two
 * legs under one number and tail merge into one draw) keeps its first leg.
 * Origin: a draw first seen in this sweep takes the airport its tail was last
 * on the ground at within the window. It is set once, at the draw's start.
 */
export function placeAdsbFlightDraws(
  db: Database,
  now: number,
  ground: readonly AdsbGroundSighting[]
): { origins: number; destinations: number } {
  const latestDraw = db.query(
    `SELECT flight_number, first_seen, destination FROM adsb_flight_draws
     WHERE tail_number = ? AND last_seen >= ? AND last_seen < ?
     ORDER BY last_seen DESC LIMIT 1`
  );
  const land = db.query(
    `UPDATE adsb_flight_draws SET destination = ?, landed_at = ?
     WHERE flight_number = ? AND tail_number = ? AND first_seen = ?`
  );
  const started = db.query(
    "SELECT flight_number, tail_number FROM adsb_flight_draws WHERE first_seen = ? AND origin IS NULL"
  );
  const lastGround = db.query(
    `SELECT ground_airport FROM adsb_observations
     WHERE tail_number = ? AND observed_at >= ? AND observed_at < ?
       AND ground_airport IS NOT NULL
     ORDER BY observed_at DESC LIMIT 1`
  );
  const depart = db.query(
    `UPDATE adsb_flight_draws SET origin = ?
     WHERE flight_number = ? AND tail_number = ? AND first_seen = ?`
  );
  let origins = 0;
  let destinations = 0;
  db.transaction(() => {
    for (const g of ground) {
      const draw = latestDraw.get(
        g.tail_number,
        g.observed_at - ADSB_DRAW_PLACE_WINDOW_SEC,
        g.observed_at
      ) as { flight_number: string; first_seen: number; destination: string | null } | null;
      if (!draw || draw.destination !== null) continue;
      land.run(g.airport, g.observed_at, draw.flight_number, g.tail_number, draw.first_seen);
      destinations++;
    }
    for (const d of started.all(now) as Array<{ flight_number: string; tail_number: string }>) {
      const seen = lastGround.get(d.tail_number, now - ADSB_DRAW_PLACE_WINDOW_SEC, now) as {
        ground_airport: string;
      } | null;
      if (!seen) continue;
      depart.run(seen.ground_airport, d.flight_number, d.tail_number, now);
      origins++;
    }
  })();
  return { origins, destinations };
}

/** How many draws that started in [fromTs, toTs) have each end placed. */
export function countPlacedAdsbFlightDraws(
  db: Database,
  fromTs: number,
  toTs: number
): { both: number; origin_only: number; destination_only: number; neither: number } {
  return db
    .query(
      `SELECT
         COALESCE(SUM(origin IS NOT NULL AND destination IS NOT NULL), 0) AS both,
         COALESCE(SUM(origin IS NOT NULL AND destination IS NULL), 0) AS origin_only,
         COALESCE(SUM(origin IS NULL AND destination IS NOT NULL), 0) AS destination_only,
         COALESCE(SUM(origin IS NULL AND destination IS NULL), 0) AS neither
       FROM adsb_flight_draws WHERE first_seen >= ? AND first_seen < ?`
    )
    .get(fromTs, toTs) as {
    both: number;
    origin_only: number;
    destination_only: number;
    neither: number;
  };
}

/** Draws seen on the ground at both ends of one airport pair, by time. */
export function getAdsbFlightDrawsOnPair(
  db: Database,
  origin: string,
  destination: string,
  sinceTs: number
): PlacedAdsbFlightDraw[] {
  if (!hasDrawsTable(db)) return [];
  return db
    .query(
      `SELECT flight_number, tail_number, first_seen, last_seen, origin, destination
       FROM adsb_flight_draws
       WHERE origin = ? AND destination = ? AND first_seen >= ?
       ORDER BY first_seen`
    )
    .all(origin, destination, sinceTs) as PlacedAdsbFlightDraw[];
}

export function pruneAdsbFlightDraws(db: Database, now: number): void {
  db.query("DELETE FROM adsb_flight_draws WHERE last_seen < ?").run(
    now - ADSB_FLIGHT_DRAW_RETENTION_DAYS * DAY_SEC
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
