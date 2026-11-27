/**
 * Per-flight aircraft-assignment history (Starlink Watch) and same-day
 * Starlink alternatives on a route.
 *
 * upcoming_flights is rewritten per tail on every refresh, so it can say which
 * tail flies a flight now but never that the tail changed. This log keeps one
 * row per (flight, local date, leg, tail) the updater has ever seen, which is
 * what a swap is: two tails for one leg. Rows come from tails the updater
 * tracks (starlink_planes) and from the legs a check-flight FR24 lookup
 * resolved, so a swap onto an untracked tail nobody has looked up shows up as
 * the flight vanishing, not as a row — consumers must not read absence as a swap.
 */

import type { Database } from "bun:sqlite";
import {
  buildAirlineFlightNumberVariants,
  detectAirline,
  ensureAirlinePrefix,
  normalizeAirlineFlightNumber,
} from "../airlines/flight-number";
import { AIRLINES, type AirlineConfig } from "../airlines/registry";
import type { Flight } from "../types";
import { airportLocalDate, icaoToIata } from "../utils/airport-tz";
import { isRegistration } from "../utils/outside-text";
import type { FlightAssignmentRow } from "./database";
import {
  equippedSql,
  modHoldSql,
  settledNegativeJoin,
  starlinkFlag,
  tailEquippedSql,
  tailEvidence,
} from "./sql/equipped";
import { airlineIn, firstReadStampSql, placeholders } from "./sql/fragments";
import { DAY_SEC } from "./sql/windows";

export const ASSIGNMENT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS flight_assignment_log (
    airline TEXT NOT NULL,
    flight_number TEXT NOT NULL,
    dep_date TEXT NOT NULL,
    departure_airport TEXT NOT NULL,
    arrival_airport TEXT,
    tail_number TEXT NOT NULL,
    starlink INTEGER,
    departure_time INTEGER,
    arrival_time INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    withdrawn_at INTEGER,
    PRIMARY KEY (airline, flight_number, dep_date, departure_airport, tail_number)
  );
  CREATE INDEX IF NOT EXISTS idx_fal_dep_date ON flight_assignment_log(dep_date);
  CREATE INDEX IF NOT EXISTS idx_fal_route
    ON flight_assignment_log(departure_airport, arrival_airport);
  CREATE INDEX IF NOT EXISTS idx_fal_tail
    ON flight_assignment_log(tail_number, departure_time);
  CREATE INDEX IF NOT EXISTS idx_fal_dep_time
    ON flight_assignment_log(departure_airport, departure_time);
  CREATE TABLE IF NOT EXISTS flown_assignments (
    airline TEXT NOT NULL,
    flight_number TEXT NOT NULL,
    dep_date TEXT NOT NULL,
    departure_airport TEXT NOT NULL,
    arrival_airport TEXT,
    tail_number TEXT NOT NULL,
    starlink INTEGER,
    departure_time INTEGER,
    arrival_time INTEGER,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (airline, flight_number, dep_date, departure_airport, tail_number)
  );
  CREATE INDEX IF NOT EXISTS idx_fa_dep_date ON flown_assignments(dep_date);
  CREATE TABLE IF NOT EXISTS unread_aircraft_log (
    airline TEXT NOT NULL,
    flight_number TEXT NOT NULL,
    dep_date TEXT NOT NULL,
    departure_airport TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    cleared_at INTEGER,
    PRIMARY KEY (airline, flight_number, dep_date, departure_airport)
  );
`;

/** Kept past departure so a feed refreshed the day after still shows the swap. */
const ASSIGNMENT_LOG_RETENTION_DAYS = 7;

/**
 * How long a past flight's rows are kept in flown_assignments, and so how far
 * back a Watch feed still answers. A feed can be subscribed 330 days ahead and
 * calendar apps poll it long after the flight (two months later in the traced
 * week), so a year lets the event stay true for as long as a calendar shows it
 * in a year view, while the table and the set of answerable URLs stay bounded.
 * The route and airport readers scan flight_assignment_log whole, which is why
 * the long tail lives in its own table instead of a longer retention there.
 */
export const FLOWN_RETENTION_DAYS = 365;

const LOG_COLUMNS =
  "airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number, starlink, departure_time, arrival_time, first_seen, last_seen";

export interface AssignmentLogRow {
  airline: string;
  flight_number: string;
  dep_date: string;
  departure_airport: string;
  arrival_airport: string | null;
  tail_number: string;
  starlink: number | null;
  departure_time: number | null;
  arrival_time: number | null;
  first_seen: number;
  last_seen: number;
}

function utcDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/** The traveler's printed date: departure-airport local, UTC when unmapped. */
export function departureLocalDate(departureAirport: string, departureTime: number): string {
  return airportLocalDate(icaoToIata(departureAirport), departureTime) ?? utcDate(departureTime);
}

/**
 * 1/0/null from the one evidence ranking (sql/equipped.ts). A registration can
 * be listed under two airlines; the logging airline's listing wins, and a
 * partner leg (AS832 on a Hawaiian tail) falls back to the tail's own.
 */
export function tailStarlinkFlag(db: Database, tailNumber: string, airline: string): number | null {
  const listed = db
    .query(
      `SELECT verified_wifi, ${modHoldSql("starlink_planes.TailNumber", "starlink_planes.airline")} AS in_mod
       FROM starlink_planes WHERE TailNumber = ?
       ORDER BY airline = ? DESC, id LIMIT 1`
    )
    .get(tailNumber, airline) as { verified_wifi: string | null; in_mod: number } | null;
  const fleet = db
    .query("SELECT starlink_status FROM united_fleet WHERE tail_number = ?")
    .get(tailNumber) as { starlink_status: string | null } | null;
  return starlinkFlag(tailEvidence({ listed, fleet, inMod: listed?.in_mod === 1 }));
}

// A cached lookup is replayed for an hour, so a sighting can arrive after a
// newer one: it then moves nothing the newer one set.
const NEWER = "excluded.last_seen >= last_seen";

/**
 * Upsert one row per scheduled leg; first_seen survives, last_seen moves
 * forward only. `now` is when the sighting was made: for a lookup, when it
 * was fetched. A sighting older than the row's withdrawal leaves it withdrawn.
 */
export function logFlightAssignments(
  db: Database,
  airline: string,
  tailNumber: string,
  flights: Pick<
    Flight,
    "flight_number" | "departure_airport" | "arrival_airport" | "departure_time" | "arrival_time"
  >[],
  now: number
): void {
  if (flights.length === 0 || !isRegistration(tailNumber)) return;
  const cfg = AIRLINES[airline];
  const starlink = tailStarlinkFlag(db, tailNumber, airline);
  const upsert = db.query(`
    INSERT INTO flight_assignment_log
      (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number,
       starlink, departure_time, arrival_time, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (airline, flight_number, dep_date, departure_airport, tail_number) DO UPDATE SET
      arrival_airport = CASE WHEN ${NEWER} THEN excluded.arrival_airport ELSE arrival_airport END,
      starlink = excluded.starlink,
      departure_time = CASE WHEN ${NEWER} THEN excluded.departure_time ELSE departure_time END,
      arrival_time = CASE WHEN ${NEWER} THEN excluded.arrival_time ELSE arrival_time END,
      last_seen = MAX(last_seen, excluded.last_seen),
      withdrawn_at = CASE WHEN withdrawn_at > excluded.last_seen THEN withdrawn_at END
  `);
  for (const f of flights) {
    if (!f.flight_number || !f.departure_airport) continue;
    const flightNumber = cfg
      ? ensureAirlinePrefix(cfg, f.flight_number)
      : f.flight_number.trim().toUpperCase();
    upsert.run(
      airline,
      flightNumber,
      departureLocalDate(f.departure_airport, f.departure_time),
      f.departure_airport,
      f.arrival_airport || null,
      tailNumber,
      starlink,
      f.departure_time,
      f.arrival_time,
      now,
      now
    );
  }
}

export interface ResolvedLeg {
  tail_number: string;
  origin: string;
  destination: string;
  departure_time: number;
  arrival_time: number;
}

/**
 * The legs a request-path FR24 lookup answered with, so DB-only readers (the
 * Watch feed) can serve the same tail without their own FR24 call.
 * Best-effort: readonly DBs (tests, MCP snapshot) just skip.
 */
export function logResolvedAssignments(
  db: Database,
  airlines: readonly string[],
  flightNumber: string,
  legs: readonly ResolvedLeg[],
  now: number
): void {
  const cfg = detectAirline(
    flightNumber,
    airlines.map((a) => AIRLINES[a]).filter((c): c is AirlineConfig => !!c)
  );
  if (!cfg) return;
  const byTail = new Map<string, ResolvedLeg[]>();
  for (const l of legs) byTail.set(l.tail_number, [...(byTail.get(l.tail_number) ?? []), l]);
  try {
    for (const [tail, tailLegs] of byTail) {
      logFlightAssignments(
        db,
        cfg.code,
        tail,
        tailLegs.map((l) => ({
          flight_number: flightNumber,
          departure_airport: l.origin,
          arrival_airport: l.destination,
          departure_time: l.departure_time,
          arrival_time: l.arrival_time,
        })),
        now
      );
    }
  } catch {}
}

/** A departure a lookup returned, with the aircraft it named there, if any. */
export interface ReturnedDeparture {
  /** "" when the lookup's origin was not shaped like an airport. */
  origin: string;
  departure_time: number;
  tail_number: string | null;
}

/**
 * A lookup that returns a departure without a tail we logged on it is newer
 * knowledge than the logged sighting: the aircraft was swapped away, or the
 * lookup no longer vouches for it. The row is stamped, not deleted, since the
 * Watch feed's swap history reads it; getListedSightings skips a stamped row,
 * and seeing the tail on the departure again clears the stamp. A departure the
 * lookup did not return at all withdraws nothing: absence is not a swap.
 * `now` is when the lookup was fetched, so a cached one replayed later
 * withdraws no sighting made after it.
 */
export function withdrawUnreturnedSightings(
  db: Database,
  airlines: readonly string[],
  flightNumber: string,
  returned: readonly ReturnedDeparture[],
  now: number
): void {
  const cfg = detectAirline(
    flightNumber,
    airlines.map((a) => AIRLINES[a]).filter((c): c is AirlineConfig => !!c)
  );
  if (!cfg || returned.length === 0) return;
  const variants = buildAirlineFlightNumberVariants(cfg, flightNumber);
  // The lookup and the log may spell an airport two ways (KSEA, SEA).
  const departureKey = (origin: string, depDate: string) => `${icaoToIata(origin)}|${depDate}`;
  // A returned departure, by airport and local date, or by its time alone
  // where the lookup's origin could not be read, with the tails named on it.
  const placed = new Map<string, Set<string>>();
  const unplaced = new Map<number, Set<string>>();
  const tailsAt = <K>(map: Map<K, Set<string>>, key: K) => {
    const tails = map.get(key) ?? new Set<string>();
    map.set(key, tails);
    return tails;
  };
  for (const r of returned) {
    const tails = r.origin
      ? tailsAt(placed, departureKey(r.origin, departureLocalDate(r.origin, r.departure_time)))
      : tailsAt(unplaced, r.departure_time);
    if (r.tail_number) tails.add(r.tail_number);
  }
  const a = airlineIn(airlines);
  try {
    const rows = db
      .query(
        `SELECT rowid AS id, departure_airport, dep_date, departure_time, tail_number
         FROM flight_assignment_log
         WHERE ${a.sql} AND flight_number IN (${placeholders(variants)})
           AND last_seen <= ? AND withdrawn_at IS NULL`
      )
      .all(...a.params, ...variants, now) as Array<{
      id: number;
      departure_airport: string;
      dep_date: string;
      departure_time: number | null;
      tail_number: string;
    }>;
    const stamp = db.query("UPDATE flight_assignment_log SET withdrawn_at = ? WHERE rowid = ?");
    for (const row of rows) {
      const returnedAt = [
        placed.get(departureKey(row.departure_airport, row.dep_date)),
        row.departure_time === null ? undefined : unplaced.get(row.departure_time),
      ];
      if (returnedAt.some((tails) => tails && !tails.has(row.tail_number))) stamp.run(now, row.id);
    }
  } catch {}
}

/** A departure a lookup returned, and whether it named an aircraft there we could not read. */
export interface DepartureReading {
  /** "" when the lookup's origin was not shaped like an airport. */
  origin: string;
  departure_time: number;
  unread: boolean;
}

/**
 * A lookup that names an aircraft we can't read logs no tail, so an answer
 * made from stored data alone would not know the flight has an aircraft we
 * know nothing about. Each such departure is marked here instead. A later
 * lookup that returns the departure with nothing unread on it clears the
 * mark; one that does not return it leaves it, as absence is not news. A mark
 * with no airport can't be matched to a departure, so any later lookup that
 * returns a departure clears it and sets it again if it still stands.
 *
 * `now` is when the lookup was fetched, and a row keeps both times: seen_at,
 * the newest lookup that named an unread aircraft there (0 for none), and
 * cleared_at, the newest that returned the departure without one. The mark
 * stands while seen_at is not older than cleared_at, so an older lookup
 * replayed from the cache after a newer one cleared it changes nothing. A
 * tie keeps the mark: it can only take an answer away.
 */
export function noteUnreadAircraft(
  db: Database,
  airlines: readonly string[],
  flightNumber: string,
  returned: readonly DepartureReading[],
  now: number
): void {
  const cfg = detectAirline(
    flightNumber,
    airlines.map((a) => AIRLINES[a]).filter((c): c is AirlineConfig => !!c)
  );
  if (!cfg || returned.length === 0) return;
  const variants = buildAirlineFlightNumberVariants(cfg, flightNumber);
  const departures = new Map<string, { origin: string; date: string; unread: boolean }>();
  for (const r of returned) {
    const origin = icaoToIata(r.origin);
    const date = departureLocalDate(origin, r.departure_time);
    const key = `${origin}|${date}`;
    const unread = r.unread || (departures.get(key)?.unread ?? false);
    departures.set(key, { origin, date, unread });
  }
  const a = airlineIn(airlines);
  const flight = `${a.sql} AND flight_number IN (${placeholders(variants)})`;
  const stored = ensureAirlinePrefix(cfg, flightNumber);
  try {
    db.transaction(() => {
      db.query(
        `UPDATE unread_aircraft_log SET cleared_at = MAX(COALESCE(cleared_at, 0), ?)
         WHERE ${flight} AND departure_airport = ''`
      ).run(now, ...a.params, ...variants);
      for (const d of departures.values()) {
        if (d.unread) {
          db.query(
            `INSERT INTO unread_aircraft_log (airline, flight_number, dep_date, departure_airport, seen_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (airline, flight_number, dep_date, departure_airport) DO UPDATE SET
               seen_at = MAX(seen_at, excluded.seen_at)`
          ).run(cfg.code, stored, d.date, d.origin, now);
        } else {
          const cleared = db
            .query(
              `UPDATE unread_aircraft_log SET cleared_at = MAX(COALESCE(cleared_at, 0), ?)
               WHERE ${flight} AND dep_date = ? AND departure_airport = ?`
            )
            .run(now, ...a.params, ...variants, d.date, d.origin);
          // No row yet: one is kept all the same, so a lookup fetched before
          // this one that lands after it finds the departure already cleared.
          if (cleared.changes === 0) {
            db.query(
              `INSERT OR IGNORE INTO unread_aircraft_log
                 (airline, flight_number, dep_date, departure_airport, seen_at, cleared_at)
               VALUES (?, ?, ?, ?, 0, ?)`
            ).run(cfg.code, stored, d.date, d.origin, now);
          }
        }
      }
    })();
  } catch {}
}

/**
 * Did the newest lookup to return one of the flight's departures on that
 * local date name an aircraft there we could not read. False on a database
 * this version never booted on (a read-only copy), which lacks the table or
 * its cleared_at column. `orLater` asks about that date and every later one,
 * for an answer about the number with no date.
 */
export function hasUnreadAircraft(
  db: Database,
  airlines: readonly string[],
  variants: readonly string[],
  depDate: string,
  orLater = false
): boolean {
  if (variants.length === 0) return false;
  const a = airlineIn(airlines);
  try {
    return !!db
      .query(
        `SELECT 1 FROM unread_aircraft_log
         WHERE ${a.sql} AND flight_number IN (${placeholders(variants)})
           AND dep_date ${orLater ? ">=" : "="} ?
           AND seen_at > 0 AND seen_at >= COALESCE(cleared_at, 0) LIMIT 1`
      )
      .get(...a.params, ...variants, depDate);
  } catch {
    return false;
  }
}

/** Rows leaving the log move to flown_assignments, which trims at a year. */
export function pruneAssignmentLog(db: Database, now: number): void {
  const cutoff = utcDate(now - ASSIGNMENT_LOG_RETENTION_DAYS * DAY_SEC);
  db.transaction(() => {
    db.query(
      `INSERT OR REPLACE INTO flown_assignments (${LOG_COLUMNS})
       SELECT ${LOG_COLUMNS} FROM flight_assignment_log WHERE dep_date < ? AND dep_date >= ?`
    ).run(cutoff, utcDate(now - FLOWN_RETENTION_DAYS * DAY_SEC));
    db.query("DELETE FROM flight_assignment_log WHERE dep_date < ?").run(cutoff);
    db.query("DELETE FROM unread_aircraft_log WHERE dep_date < ?").run(cutoff);
    db.query("DELETE FROM flown_assignments WHERE dep_date < ?").run(
      utcDate(now - FLOWN_RETENTION_DAYS * DAY_SEC)
    );
  })();
}

// Rows logged before the write refused them can hold a lookup's raw text,
// and every reader of these rows prints the tail.
const printable = (r: { tail_number: string }) => isRegistration(r.tail_number);

/** Every tail seen assigned to the flight on its local date, oldest first. */
export function getAssignmentHistory(
  db: Database,
  airlines: readonly string[],
  variants: readonly string[],
  depDate: string
): AssignmentLogRow[] {
  if (variants.length === 0) return [];
  const a = airlineIn(airlines);
  return (
    db
      .query(
        `SELECT * FROM flight_assignment_log
       WHERE ${a.sql} AND flight_number IN (${placeholders(variants)}) AND dep_date = ?
       ORDER BY first_seen ASC, tail_number ASC`
      )
      .all(...a.params, ...variants, depDate) as AssignmentLogRow[]
  ).filter(printable);
}

/** The aircraft last logged on one departure of a flight. */
export interface LoggedAircraft {
  dep_date: string;
  departure_airport: string;
  arrival_airport: string | null;
  tail_number: string;
  /** From the fleet list, then the tail's listing; null for a tail in neither. */
  aircraft_type: string | null;
  equipped: boolean;
}

/**
 * The newest tail logged for each departure of the flight (one local date, or
 * every date the log still holds), with its type from our own fleet list. A
 * swap leaves two tails on a departure; only the later sighting is current.
 */
export function getLoggedAircraft(
  db: Database,
  airlines: readonly string[],
  variants: readonly string[],
  depDate?: string
): LoggedAircraft[] {
  if (variants.length === 0) return [];
  const a = airlineIn(airlines, "l.airline");
  const scope = airlineIn(airlines, "_t.airline");
  const listed = airlineIn(airlines, "_l.airline");
  const rows = db
    .query(
      `SELECT l.dep_date, l.departure_airport, l.arrival_airport, l.tail_number,
              COALESCE(
                (SELECT _t.aircraft_type FROM united_fleet _t
                 WHERE _t.tail_number = l.tail_number AND ${scope.sql} LIMIT 1),
                (SELECT _l.Aircraft FROM starlink_planes _l
                 WHERE _l.TailNumber = l.tail_number AND ${listed.sql} ORDER BY _l.id LIMIT 1)
              ) AS aircraft_type,
              CASE WHEN ${tailEquippedSql("l.tail_number")} THEN 1 ELSE 0 END AS equipped
       FROM flight_assignment_log l
       WHERE ${a.sql} AND l.flight_number IN (${placeholders(variants)})
         ${depDate ? "AND l.dep_date = ?" : ""}
       ORDER BY l.dep_date ASC, l.last_seen DESC, l.first_seen DESC`
    )
    .all(
      ...scope.params,
      ...listed.params,
      ...a.params,
      ...variants,
      ...(depDate ? [depDate] : [])
    ) as Array<Omit<LoggedAircraft, "equipped"> & { equipped: number }>;
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    if (!printable(r)) return [];
    const key = `${r.dep_date}|${r.departure_airport}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...r, equipped: r.equipped === 1 }];
  });
}

/**
 * Listed tails seen on the flight since the flight updater last read that
 * tail's schedule, shaped as the schedule rows they stand in for. A listed
 * tail in the log and not in upcoming_flights is usually left over from a
 * swap, but not when the sighting is newer than our last schedule read: then
 * the schedule hasn't had the chance to hold it. Only the newest tail logged
 * on a departure counts, so a later sighting of another aircraft outranks it,
 * and so does a later lookup that returned the departure without this tail.
 */
export function getListedSightings(
  db: Database,
  airlines: readonly string[],
  variants: readonly string[],
  start: number,
  end: number
): FlightAssignmentRow[] {
  if (variants.length === 0) return [];
  const a = airlineIn(airlines, "l.airline");
  const listed = airlineIn(airlines, "sp.airline");
  const rows = db
    .query(
      `SELECT 0 AS id, l.tail_number, l.flight_number, l.departure_airport, l.arrival_airport,
              l.departure_time, l.arrival_time, l.last_seen AS last_updated, sp.airline,
              sp.Aircraft AS aircraft_type, sp.OperatedBy, sp.fleet, sp.verified_wifi,
              CASE WHEN _neg.tail_number IS NOT NULL THEN 1 ELSE 0 END AS settled_negative,
              _neg.verified_wifi AS settled_wifi,
              ${firstReadStampSql("sp")} AS first_read_counted_at
       FROM flight_assignment_log l
       INNER JOIN starlink_planes sp ON sp.TailNumber = l.tail_number AND ${listed.sql}
       ${settledNegativeJoin("_neg", "sp.TailNumber", "sp.airline")}
       WHERE ${a.sql} AND l.flight_number IN (${placeholders(variants)})
         AND l.departure_time >= ? AND l.departure_time < ? AND l.arrival_time IS NOT NULL
         AND l.arrival_airport IS NOT NULL
         AND l.last_seen > COALESCE(sp.last_flight_check, 0)
         AND l.withdrawn_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM flight_assignment_log n
           WHERE n.airline = l.airline AND n.flight_number = l.flight_number
             AND n.dep_date = l.dep_date AND n.departure_airport = l.departure_airport
             AND n.tail_number <> l.tail_number
             AND (n.last_seen > l.last_seen
               OR (n.last_seen = l.last_seen AND n.first_seen > l.first_seen)))
         AND NOT (sp.verified_wifi IS NULL AND _neg.tail_number IS NULL
           AND ${modHoldSql("sp.TailNumber", "sp.airline")})
       ORDER BY l.last_seen DESC`
    )
    .all(...listed.params, ...a.params, ...variants, start, end) as FlightAssignmentRow[];
  return rows.filter(printable);
}

/**
 * The same rows for a date already flown: still in the log for its first week,
 * in flown_assignments after. A row lives in exactly one of the two.
 */
export function getFlownAssignmentHistory(
  db: Database,
  airlines: readonly string[],
  variants: readonly string[],
  depDate: string
): AssignmentLogRow[] {
  const recent = getAssignmentHistory(db, airlines, variants, depDate);
  if (recent.length > 0 || variants.length === 0) return recent;
  const a = airlineIn(airlines);
  return (
    db
      .query(
        `SELECT * FROM flown_assignments
       WHERE ${a.sql} AND flight_number IN (${placeholders(variants)}) AND dep_date = ?
       ORDER BY first_seen ASC, tail_number ASC`
      )
      .all(...a.params, ...variants, depDate) as AssignmentLogRow[]
  ).filter(printable);
}

export interface HeldLegDay {
  dep_date: string;
  departure_airport: string;
  arrival_airport: string;
}

/**
 * Every leg held under the flight, once per local date it was held on, for
 * dates in [fromDate, toDate]: the log for the last week and what is still to
 * fly, the flown record before that. Which legs share a date is the only
 * evidence we keep that a number is sold on two city pairs on one day; the
 * route cache counts sightings and has no dates.
 */
export function getHeldLegDays(
  db: Database,
  airlines: readonly string[],
  variants: readonly string[],
  fromDate: string,
  toDate: string
): HeldLegDay[] {
  if (variants.length === 0) return [];
  const a = airlineIn(airlines);
  const from = (table: string) =>
    `SELECT dep_date, departure_airport, arrival_airport FROM ${table}
     WHERE ${a.sql} AND flight_number IN (${placeholders(variants)})
       AND dep_date >= ? AND dep_date <= ? AND arrival_airport IS NOT NULL`;
  const params = [...a.params, ...variants, fromDate, toDate];
  return db
    .query(`${from("flight_assignment_log")} UNION ${from("flown_assignments")}`)
    .all(...params, ...params) as HeldLegDay[];
}

/**
 * Has this airline's flight number ever reached our store: a cached route, a
 * scheduled leg, or a logged assignment on any date. Gates the answers we give
 * with no record of the date itself, so an invented number mints no page.
 */
export function isKnownFlightNumber(
  db: Database,
  airlines: readonly string[],
  variants: readonly string[]
): boolean {
  if (variants.length === 0) return false;
  const a = airlineIn(airlines);
  const inVariants = `flight_number IN (${placeholders(variants)})`;
  // flight_routes is airline-agnostic; the variants carry the carrier prefix.
  if (db.query(`SELECT 1 FROM flight_routes WHERE ${inVariants} LIMIT 1`).get(...variants)) {
    return true;
  }
  for (const table of ["upcoming_flights", "flight_assignment_log", "flown_assignments"]) {
    const hit = db
      .query(`SELECT 1 FROM ${table} WHERE ${a.sql} AND ${inVariants} LIMIT 1`)
      .get(...a.params, ...variants);
    if (hit) return true;
  }
  return false;
}

export interface SameDayAlternative {
  flight_number: string;
  departure_time: number;
  tail_number: string;
  aircraft_type: string | null;
}

export interface SameDayAlternativesQuery {
  origin: string;
  destination: string;
  /** Departure-airport local date the traveler is flying. */
  dateLocal: string;
  /** Center of the window — the original flight's departure. */
  aroundUnix: number;
  windowH?: number;
  /** Marketing numbers to leave out (the flight being asked about). */
  exclude?: readonly string[];
  now?: number;
  limit?: number;
}

// ATC callsigns (SKW485Y) aren't bookable flight numbers and alias a real
// marketed departure in the same slot.
const CALLSIGN_SHAPED = /^[A-Z]{2,3}\d{1,4}[A-Z]$/;

/**
 * Other departures on the exact origin→destination pair that day on tails not
 * known to be non-Starlink. Scoped by upcoming_flights.airline, so SkyWest rows
 * flown for another tenant (OO/SKW numbers under AS) never leak across.
 * Same-slot duplicates (a stale row left on the pre-swap tail) collapse to the
 * most recently refreshed row.
 */
export function getSameDayStarlinkAlternatives(
  db: Database,
  airlines: readonly string[],
  q: SameDayAlternativesQuery
): SameDayAlternative[] {
  const now = q.now ?? Math.floor(Date.now() / 1000);
  const windowSec = (q.windowH ?? 10) * 3600;
  const a = airlineIn(airlines, "uf.airline");
  const rows = db
    .query(
      `SELECT uf.flight_number, uf.departure_time, uf.tail_number, uf.airline,
              sp.Aircraft AS aircraft_type,
              CASE WHEN ${equippedSql("sp")} THEN 0 ELSE 1 END AS non_starlink
       FROM upcoming_flights uf
       INNER JOIN starlink_planes sp ON sp.TailNumber = uf.tail_number
       WHERE ${a.sql}
         AND uf.departure_airport = ? AND uf.arrival_airport = ?
         AND uf.departure_time > ? AND uf.departure_time BETWEEN ? AND ?
       ORDER BY uf.departure_time ASC, uf.last_updated DESC`
    )
    .all(
      ...a.params,
      q.origin,
      q.destination,
      now,
      q.aroundUnix - windowSec,
      q.aroundUnix + windowSec
    ) as (SameDayAlternative & { airline: string; non_starlink: number })[];

  const exclude = new Set(q.exclude ?? []);
  const seenSlots = new Set<number>();
  const out: SameDayAlternative[] = [];
  for (const r of rows) {
    if (!r.flight_number || CALLSIGN_SHAPED.test(r.flight_number)) continue;
    if (seenSlots.has(r.departure_time)) continue;
    seenSlots.add(r.departure_time);
    // After the slot claim: a stale Starlink row must not outlive the swap
    // that moved its departure onto a non-Starlink tail.
    if (r.non_starlink) continue;
    if (departureLocalDate(q.origin, r.departure_time) !== q.dateLocal) continue;
    const cfg = AIRLINES[r.airline];
    const flightNumber = cfg ? normalizeAirlineFlightNumber(cfg, r.flight_number) : r.flight_number;
    if (exclude.has(flightNumber) || exclude.has(r.flight_number)) continue;
    out.push({
      flight_number: flightNumber,
      departure_time: r.departure_time,
      tail_number: r.tail_number,
      aircraft_type: r.aircraft_type ?? null,
    });
    if (out.length >= (q.limit ?? 3)) break;
  }
  return out;
}
