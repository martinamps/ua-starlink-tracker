/**
 * A seeded United fleet and a stub of united.com, for running the verifier and
 * fleet discovery against a fake clock. Nothing here opens a network socket:
 * the checker and the flight lookup are both stand-ins, and every call the
 * jobs make to the stand-in checker is recorded with the clock's time.
 */

import type { Database } from "bun:sqlite";
import { setSystemTime } from "bun:test";
import type { VerifyPlaneDeps } from "../src/scripts/fleet-discovery";
import type { StarlinkCheckResult } from "../src/scripts/united-starlink-checker";

export const HOUR = 3600;
export const DAY = 24 * HOUR;

export interface SimCheck {
  /** Clock time the check started (unix seconds). */
  at: number;
  tail: string;
  kind: "equipped" | "unequipped";
  /** Which job asked. */
  by: "verifier" | "discovery";
  /** Seconds past the discovery due time, read before the check rewrote it. */
  lateBy: number;
}

export interface SimFleet {
  equipped: string[];
  unequipped: string[];
  checks: SimCheck[];
  /** The stand-ins, for each job: the same answers, recorded under its name. */
  verifier: Required<VerifyPlaneDeps>;
  discovery: Required<VerifyPlaneDeps>;
  /** After a restart: the database handle the stand-ins should read from now on. */
  reopen(db: Database): void;
  /** Move every scheduled flight ahead of the clock, past the next refresh. */
  refreshFlights(db: Database, nowSec: number): void;
  /** From now on the stand-in reads Starlink on this tail: it has been fitted. */
  retrofit(tail: string): void;
  /** Give a tail a scheduled flight, as the flight updater does once it is listed. */
  scheduleFlight(db: Database, tail: string, nowSec: number): void;
}

/** Deterministic spread in [0, 1): seeds must not depend on Math.random. */
const spread = (i: number, salt: number) => ((i * 2654435761 + salt * 40503) % 100000) / 100000;

function insertLog(db: Database, tail: string, at: number, provider: string): void {
  db.query(
    `INSERT INTO starlink_verification_log
       (tail_number, source, checked_at, has_starlink, wifi_provider, aircraft_type, flight_number, error, tail_confirmed, airline)
     VALUES (?, 'united', ?, ?, ?, 'Boeing 737-900', 'UA99', NULL, 1, 'UA')`
  ).run(tail, at, provider === "Starlink" ? 1 : 0, provider);
}

/**
 * `equipped` settled-Starlink tails (listed, confirmed, last read on
 * united.com between 0 and 80 hours ago unless `lastReadHoursAgo` says) and `unequipped` negative tails. Each
 * tail's discovery turn falls somewhere in the next `dueWithinDays`. One
 * equipped tail in `noFlightEvery` has no scheduled flight, so only discovery,
 * which looks flights up itself, can reach it.
 */
export function seedFleet(
  db: Database,
  t0: number,
  opts: {
    equipped: number;
    unequipped: number;
    dueWithinDays?: number;
    noFlightEvery?: number;
    /** Hours since each equipped tail was last read: spread between the two. */
    lastReadHoursAgo?: [number, number];
  }
): SimFleet {
  const { dueWithinDays = 7, noFlightEvery = 10, lastReadHoursAgo = [0, 80] } = opts;
  const [readMin, readMax] = lastReadHoursAgo;
  const byFlight = new Map<string, string>();
  const flightOf = new Map<string, string>();
  const kindOf = new Map<string, SimCheck["kind"]>();
  const equipped: string[] = [];
  const unequipped: string[] = [];
  const checks: SimCheck[] = [];
  const fitted = new Set<string>();

  const addFleet = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at,
       fleet, operated_by, starlink_status, verified_wifi, verified_at, next_check_after, discovery_priority, airline)
     VALUES (?, 'Boeing 737-900', 'test', 1, ?, 'mainline', 'United Airlines', ?, ?, ?, ?, 0.5, 'UA')`
  );
  const addListing = db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
     VALUES ('Boeing 737-900', 'StrLnk', '2026-01-01', ?, 'United Airlines', 'mainline', 'Starlink', 'UA')`
  );
  const addFlight = db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
     VALUES (?, ?, 'KSFO', 'KEWR', ?, ?, ?, 'UA')`
  );

  db.transaction(() => {
    for (let i = 0; i < opts.equipped; i++) {
      const tail = `N${10000 + i}`;
      const flight = `${1000 + i}`;
      equipped.push(tail);
      byFlight.set(flight, tail);
      flightOf.set(tail, flight);
      kindOf.set(tail, "equipped");
      addListing.run(tail);
      addFleet.run(
        tail,
        t0,
        "confirmed",
        "Starlink",
        t0 - 3 * DAY,
        t0 + Math.floor(spread(i, 1) * dueWithinDays * DAY)
      );
      insertLog(db, tail, t0 - 10 * DAY, "Starlink");
      insertLog(
        db,
        tail,
        t0 - Math.floor((readMin + spread(i, 2) * (readMax - readMin)) * HOUR),
        "Starlink"
      );
      if (noFlightEvery === 0 || i % noFlightEvery !== 0) {
        addFlight.run(tail, `UA${flight}`, t0 + 7 * HOUR, t0 + 12 * HOUR, t0);
      }
    }
    for (let j = 0; j < opts.unequipped; j++) {
      const tail = `N${50000 + j}`;
      const flight = `${5000 + j}`;
      unequipped.push(tail);
      byFlight.set(flight, tail);
      flightOf.set(tail, flight);
      kindOf.set(tail, "unequipped");
      addFleet.run(
        tail,
        t0,
        "negative",
        "Viasat",
        t0 - 12 * DAY,
        t0 + Math.floor(spread(j, 3) * dueWithinDays * DAY)
      );
      insertLog(db, tail, t0 - 20 * DAY, "Viasat");
      insertLog(db, tail, t0 - 12 * DAY, "Viasat");
    }
  })();

  // The handle the stand-in reads the due time from; a restart swaps it.
  let live = db;

  const checkerFor =
    (by: SimCheck["by"]): Required<VerifyPlaneDeps>["checker"] =>
    async (flightNumber, date, origin, dest) => {
      const tail = byFlight.get(flightNumber);
      if (!tail) throw new Error(`stand-in checker asked about an unseeded flight ${flightNumber}`);
      const kind = kindOf.get(tail) as SimCheck["kind"];
      const at = Math.floor(Date.now() / 1000);
      const due = (
        live.query("SELECT next_check_after FROM united_fleet WHERE tail_number = ?").get(tail) as {
          next_check_after: number;
        }
      ).next_check_after;
      checks.push({ at, tail, kind, by, lateBy: at - due });
      const starlink = kind === "equipped" || fitted.has(tail);
      const result: StarlinkCheckResult = {
        hasStarlink: starlink,
        tailNumber: tail,
        shipNumber: null,
        aircraftType: "Boeing 737-900",
        wifiProvider: starlink ? "Starlink" : "Viasat",
        flightNumber,
        date,
        origin,
        destination: dest,
      };
      return result;
    };

  const getFlights: Required<VerifyPlaneDeps>["getFlights"] = async (tail) => {
    const flight = flightOf.get(tail);
    if (!flight) return null;
    const now = Math.floor(Date.now() / 1000);
    return {
      forVerification: {
        flightNumber: flight,
        date: "2026-12-01",
        origin: "SFO",
        destination: "EWR",
      },
      allFlights: [
        {
          flight_number: `UA${flight}`,
          departure_airport: "KSFO",
          arrival_airport: "KEWR",
          departure_time: now + 3 * HOUR,
          arrival_time: now + 8 * HOUR,
        },
      ],
    };
  };

  return {
    equipped,
    unequipped,
    checks,
    verifier: { checker: checkerFor("verifier"), getFlights },
    discovery: { checker: checkerFor("discovery"), getFlights },
    reopen(handle) {
      live = handle;
    },
    refreshFlights(handle, nowSec) {
      handle
        .query("UPDATE upcoming_flights SET departure_time = ?, arrival_time = ?, last_updated = ?")
        .run(nowSec + 7 * HOUR, nowSec + 12 * HOUR, nowSec);
    },
    retrofit(tail) {
      fitted.add(tail);
    },
    scheduleFlight(handle, tail, nowSec) {
      handle
        .query(
          `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
           VALUES (?, ?, 'KSFO', 'KEWR', ?, ?, ?, 'UA')`
        )
        .run(tail, `UA${flightOf.get(tail)}`, nowSec + 7 * HOUR, nowSec + 12 * HOUR, nowSec);
    },
  };
}

/**
 * Walk the clock from `fromSec` to `toSec`, calling each job on its own beat.
 * The jobs' real intervals are 60 s and 90 s; a coarser beat is fine where a
 * test is about cadence in days and never about the two jobs racing.
 */
export async function runClock(opts: {
  db: Database;
  fleet: SimFleet;
  fromSec: number;
  toSec: number;
  verifierEverySec: number;
  discoveryEverySec: number;
  verifierTick: () => Promise<unknown>;
  discoveryTick: () => Promise<unknown>;
}): Promise<void> {
  const step = gcd(opts.verifierEverySec, opts.discoveryEverySec);
  for (let t = opts.fromSec; t < opts.toSec; t += step) {
    setSystemTime(new Date(t * 1000));
    const elapsed = t - opts.fromSec;
    if (elapsed % (6 * HOUR) === 0) opts.fleet.refreshFlights(opts.db, t);
    if (elapsed % opts.verifierEverySec === 0) await opts.verifierTick();
    if (elapsed % opts.discoveryEverySec === 0) await opts.discoveryTick();
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** The most of these start times (unix seconds, ascending) inside any 24 hours. */
export function busiestDay(startTimes: readonly number[]): number {
  let most = 0;
  let from = 0;
  for (let to = 0; to < startTimes.length; to++) {
    while (startTimes[to] - startTimes[from] >= DAY) from++;
    most = Math.max(most, to - from + 1);
  }
  return most;
}

/** Seconds between a tail's consecutive checks, across every tail of `kind`. */
export function gapsBetweenChecks(checks: readonly SimCheck[], kind: SimCheck["kind"]): number[] {
  const last = new Map<string, number>();
  const gaps: number[] = [];
  for (const c of checks) {
    if (c.kind !== kind) continue;
    const prev = last.get(c.tail);
    if (prev !== undefined) gaps.push(c.at - prev);
    last.set(c.tail, c.at);
  }
  return gaps;
}
