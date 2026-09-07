/**
 * Route-pair ordering.
 *
 * flight_routes.seen_count accumulates for the life of a flight number, so a
 * retired leg out-counts the current one forever once a number is reassigned.
 * Callers treat routes[0] as "the" route (page title, meta description, Flight
 * JSON-LD), so a currently-scheduled leg must sort ahead of a heavier historical
 * one — otherwise every permalink for a reassigned flight advertises a route it
 * no longer flies.
 */

import { describe, expect, test } from "bun:test";
import { cacheFlightRoute, getFlightRoutePairs } from "../src/database/database";
import { makeSyntheticDb, utc } from "./helpers";

function seedReassignedFlight() {
  const db = makeSyntheticDb();
  // The retired leg: flown for months, huge seen_count, no longer scheduled.
  db.run(
    `INSERT INTO flight_routes
       (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES ('UA1340', 'IAH', 'EWR', 10800, ?, ?, 240)`,
    [utc("2025-01-01T00:00:00Z"), utc("2026-05-01T00:00:00Z")]
  );
  // The current leg: only a handful of live rows, but it is what actually flies.
  const dep = utc("2026-08-15T17:55:00Z");
  for (let i = 0; i < 3; i++) {
    db.run(
      `INSERT INTO upcoming_flights
         (tail_number, flight_number, departure_airport, arrival_airport,
          departure_time, arrival_time, last_updated, airline)
       VALUES ('N12345', 'UA1340', 'EWR', 'SFO', ?, ?, ?, 'UA')`,
      [dep + i * 86400, dep + i * 86400 + 21600, dep]
    );
  }
  return db;
}

describe("getFlightRoutePairs ordering", () => {
  test("a scheduled leg outranks a heavier historical leg", () => {
    const db = seedReassignedFlight();
    const rows = getFlightRoutePairs(db, ["UA1340"], "UA");

    expect(rows.length).toBe(2);
    // routes[0] is what the title/meta/JSON-LD advertise.
    expect(rows[0].departure_airport).toBe("EWR");
    expect(rows[0].arrival_airport).toBe("SFO");
    expect(rows[0].scheduled).toBe(1);
    // The retired leg is still surfaced, just demoted despite its higher count.
    expect(rows[1].departure_airport).toBe("IAH");
    expect(rows[1].scheduled).toBe(0);
    expect(rows[1].times).toBeGreaterThan(rows[0].times);
    db.close();
  });

  test("history-only flights keep most-flown-first ordering", () => {
    const db = makeSyntheticDb();
    for (const [origin, destination, seen] of [
      ["ORD", "DEN", 12],
      ["ORD", "LAX", 90],
    ] as const) {
      db.run(
        `INSERT INTO flight_routes
           (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
         VALUES ('UA4242', ?, ?, 7200, ?, ?, ?)`,
        [origin, destination, utc("2026-01-01T00:00:00Z"), utc("2026-08-01T00:00:00Z"), seen]
      );
    }
    const rows = getFlightRoutePairs(db, ["UA4242"], "UA");

    expect(rows.map((r) => r.arrival_airport)).toEqual(["LAX", "DEN"]);
    expect(rows.every((r) => r.scheduled === 0)).toBe(true);
    db.close();
  });

  test("a leg that is both scheduled and historical merges into one row", () => {
    const db = makeSyntheticDb();
    db.run(
      `INSERT INTO flight_routes
         (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
       VALUES ('UA7', 'SFO', 'SIN', 61200, ?, ?, 30)`,
      [utc("2026-01-01T00:00:00Z"), utc("2026-08-10T00:00:00Z")]
    );
    const dep = utc("2026-08-16T12:00:00Z");
    db.run(
      `INSERT INTO upcoming_flights
         (tail_number, flight_number, departure_airport, arrival_airport,
          departure_time, arrival_time, last_updated, airline)
       VALUES ('N54321', 'UA7', 'SFO', 'SIN', ?, ?, ?, 'UA')`,
      [dep, dep + 61200, dep]
    );
    const rows = getFlightRoutePairs(db, ["UA7"], "UA");

    expect(rows.length).toBe(1);
    expect(rows[0].scheduled).toBe(1);
    expect(rows[0].times).toBe(31);
    db.close();
  });
});

/**
 * The cacheFlightRoute write edge.
 *
 * flight_routes is written from caller-supplied lookup input (MCP/API) and
 * enumerated by the sitemap, so this guard is the only thing standing between
 * an arbitrary caller string and an advertised permalink the router 404s. It
 * is also the only thing that can silently DROP a real operating-carrier
 * callsign — nothing prunes this table, so an over-tight predicate degrades a
 * carrier's route coverage invisibly. Both directions are pinned here: the
 * guard was previously deletable with the whole suite still green.
 */
describe("cacheFlightRoute write-edge validation", () => {
  const persisted = (fn: string): boolean => {
    const db = makeSyntheticDb();
    cacheFlightRoute(db, fn, "SFO", "EWR", 18000, utc("2026-08-01T00:00:00Z"));
    const row = db.query("SELECT 1 FROM flight_routes WHERE flight_number = ?").get(fn) as unknown;
    db.close();
    return row !== null;
  };

  // Real callsign shapes observed in production flight_routes. The suffixed
  // ICAO form is 3.5% of rows and the sole source of most Qatar route pairs;
  // dropping it would skew airlineServesAirports, which gates inferred_absent.
  test.each([
    ["UA1340", "marketing IATA"],
    ["SKW4726", "operating-carrier ICAO"],
    ["QTR16A", "ICAO with disambiguating suffix"],
    ["SKW302M", "ICAO with disambiguating suffix"],
    ["UAL353T", "ICAO with disambiguating suffix"],
    ["ASH611A", "ICAO with disambiguating suffix"],
    ["MX69A", "short IATA with suffix"],
  ])("persists %s (%s)", (fn) => {
    expect(persisted(fn)).toBe(true);
  });

  // Junk the guard exists to keep out of the sitemap. UA63986 is the row that
  // actually leaked: five digits, real data behind it, and a hard 404.
  test.each([
    ["UA63986", "over the router's 4-digit permalink cap"],
    ["A0ACFF", "ICAO hex transponder address"],
    ["N217HA", "tail number, not a flight number"],
    ["B1", "no flight digits"],
    ["K4035", "single-letter prefix"],
    ["SKWW5424", "doubled carrier prefix"],
    ["", "empty"],
  ])("rejects %s (%s)", (fn) => {
    expect(persisted(fn)).toBe(false);
  });
});
