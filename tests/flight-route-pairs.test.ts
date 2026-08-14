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
import { getFlightRoutePairs } from "../src/database/database";
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
