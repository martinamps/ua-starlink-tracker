/**
 * Ghost upcoming_flights rows: tails that stop refreshing used to leave their
 * rows behind forever (some from March in the August snapshot), and a ghost
 * counted as "scheduled" outranked any amount of live route history in
 * permalink titles.
 */

import { describe, expect, test } from "bun:test";
import {
  UPCOMING_PRUNE_AGE_SEC,
  getFlightRoutePairs,
  pruneStaleUpcomingFlights,
} from "../src/database/database";
import { cappedFutureShareByAirline } from "../src/scripts/data-freshness";
import { addFlight, makeSyntheticDb, utc } from "./helpers";

const NOW = utc("2026-09-18T12:00:00Z");
const DAY = 86400;

describe("pruneStaleUpcomingFlights", () => {
  test("rows past the prune age are archived to departure_log and removed", () => {
    const db = makeSyntheticDb();
    addFlight(db, "N100UA", "UA100", "ORD", NOW - UPCOMING_PRUNE_AGE_SEC - 3600);
    addFlight(db, "N100UA", "UA101", "ORD", NOW - 30 * DAY + 3600);
    addFlight(db, "N200AS", "AS200", "SEA", NOW - 5 * DAY, { airline: "AS" });
    addFlight(db, "N100UA", "UA102", "ORD", NOW - DAY);
    addFlight(db, "N100UA", "UA103", "ORD", NOW + DAY);

    const pruned = pruneStaleUpcomingFlights(db, NOW);

    expect(pruned).toEqual({ UA: 2, AS: 1 });
    const left = db
      .query("SELECT flight_number FROM upcoming_flights ORDER BY departure_time")
      .all() as { flight_number: string }[];
    expect(left.map((r) => r.flight_number)).toEqual(["UA102", "UA103"]);

    const logged = db
      .query("SELECT tail_number, departed_at FROM departure_log WHERE departed_at < ?")
      .all(NOW - UPCOMING_PRUNE_AGE_SEC) as { tail_number: string }[];
    expect(logged.length).toBe(3);
    db.close();
  });

  test("a clean table prunes nothing", () => {
    const db = makeSyntheticDb();
    addFlight(db, "N100UA", "UA103", "ORD", NOW + DAY);
    expect(pruneStaleUpcomingFlights(db, NOW)).toEqual({});
    db.close();
  });
});

describe("getFlightRoutePairs ghost demotion", () => {
  test("a months-old upcoming row no longer outranks live route history", () => {
    const db = makeSyntheticDb();
    db.run(
      `INSERT INTO upcoming_flights
         (tail_number, flight_number, departure_airport, arrival_airport,
          departure_time, arrival_time, last_updated, airline)
       VALUES ('N13227', 'UA1211', 'DFW', 'ORD', ?, ?, ?, 'UA')`,
      [NOW - 180 * DAY, NOW - 180 * DAY + 7200, NOW - 181 * DAY]
    );
    db.run(
      `INSERT INTO flight_routes
         (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
       VALUES ('UA1211', 'IAH', 'ATL', 7200, ?, ?, 19)`,
      [NOW - 60 * DAY, NOW - DAY]
    );

    const rows = getFlightRoutePairs(db, ["UA1211"], "UA", NOW);

    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.scheduled === 0)).toBe(true);
    expect(`${rows[0].departure_airport}-${rows[0].arrival_airport}`).toBe("IAH-ATL");
    db.close();
  });
});

describe("cappedFutureShareByAirline", () => {
  test("counts only tails at the cap whose first row is over an hour past refresh", () => {
    const db = makeSyntheticDb();
    const insert = (tail: string, firstDep: number, n: number) => {
      for (let i = 0; i < n; i++) {
        db.run(
          `INSERT INTO upcoming_flights
             (tail_number, flight_number, departure_airport, arrival_airport,
              departure_time, arrival_time, last_updated, airline)
           VALUES (?, ?, 'ORD', 'DEN', ?, ?, ?, 'UA')`,
          [tail, `UA${i}`, firstDep + i * 3 * 3600, firstDep + i * 3 * 3600 + 7200, NOW]
        );
      }
    };
    insert("N1", NOW + 12 * 3600, 4);
    insert("N2", NOW + 600, 4);
    insert("N3", NOW + 12 * 3600, 3);

    const rows = cappedFutureShareByAirline(db, 4);
    expect(rows.length).toBe(1);
    expect(rows[0].airline).toBe("UA");
    expect(rows[0].share).toBeGreaterThan(0);
    expect(rows[0].share).toBeLessThan(1);
    db.close();
  });
});
