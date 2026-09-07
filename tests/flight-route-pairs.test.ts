/**
 * Route-pair ordering.
 *
 * flight_routes.seen_count accumulates for the life of a flight number, so a
 * retired leg out-counts the current one forever once a number is reassigned.
 * Callers treat routes[0] as "the" route (page title, meta description, Flight
 * JSON-LD), so a currently-scheduled leg must sort ahead of a heavier historical
 * one — otherwise every permalink for a reassigned flight advertises a route it
 * no longer flies.
 *
 * The live upcoming_flights window only reaches ~47h ahead, so most permalinks
 * have no scheduled leg at all and fall through to the route cache. These cover
 * that fallback too, where silence only *discounts* frequency: last_seen_at
 * stamps just when a Starlink-equipped tail happens to draw the leg, so silence
 * is noisy evidence and a leg has to out-earn the discount to take routes[0].
 * The negative cases below — a lone sighting against hundreds, a heavy leg one
 * second past the grace period, legs that are all ancient, corrupt future
 * timestamps — matter as much as the reassignment case: each is a way the
 * ordering could invent a wrong title for a permalink main gets right.
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

const DAY = 86400;

function seedCachedRoute(
  db: ReturnType<typeof makeSyntheticDb>,
  flightNumber: string,
  origin: string,
  destination: string,
  seenCount: number,
  lastSeenAt: number
) {
  db.run(
    `INSERT INTO flight_routes
       (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, ?, ?, 7200, ?, ?, ?)`,
    [flightNumber, origin, destination, lastSeenAt - 200 * DAY, lastSeenAt, seenCount]
  );
}

describe("getFlightRoutePairs staleness discount", () => {
  // The shape behind the stale-title report: no near-term assignment, so every
  // leg is history-only and the scheduled tier can't break the tie. Counts and
  // airports here are illustrative, not transcribed from any live row.
  const now = utc("2026-08-29T12:00:00Z");

  test("a long-retired leg loses routes[0] to the leg that replaced it", () => {
    const db = makeSyntheticDb();
    // A reassigned number: the old pair stopped being flown eight months ago but
    // keeps its lifetime count forever, while the pair that replaced it has been
    // accumulating since. Silence that long discounts the old leg to its floor,
    // an eighth, which the replacement's 40 observations clear.
    seedCachedRoute(db, "UA800", "IAH", "EWR", 240, now - 240 * DAY);
    seedCachedRoute(db, "UA800", "EWR", "SFO", 40, now - 3 * DAY);
    const rows = getFlightRoutePairs(db, ["UA800"], "UA", now);

    expect(rows[0].departure_airport).toBe("EWR");
    expect(rows[0].arrival_airport).toBe("SFO");
    expect(rows[0].scheduled).toBe(0);
    expect(rows[0].times).toBeLessThan(rows[1].times);
    // Demoted, never dropped: the page still lists the number's route history,
    // and a cold-tail permalink always has a route to put in its title.
    expect(rows.map((r) => r.arrival_airport)).toEqual(["SFO", "EWR"]);
    db.close();
  });

  test("frequency still decides between legs that are both current", () => {
    const db = makeSyntheticDb();
    // A one-off diversion seen most recently must not outrank the daily leg.
    seedCachedRoute(db, "UA88", "ORD", "LHR", 300, now - 2 * DAY);
    seedCachedRoute(db, "UA88", "ORD", "SNN", 1, now - 3600);
    const rows = getFlightRoutePairs(db, ["UA88"], "UA", now);

    expect(rows[0].arrival_airport).toBe("LHR");
    expect(rows.every((r) => r.last_seen_at !== null)).toBe(true);
    db.close();
  });

  test("a merely stale heavy leg still outranks a one-off seen minutes ago", () => {
    const db = makeSyntheticDb();
    // A gap of days proves nothing: last_seen_at stamps only when a Starlink tail
    // draws this leg, which at mainline penetration skips a daily route for a week
    // about a quarter of the time. Inside the grace period nothing is discounted,
    // so the 300 observations decide — a diversion must not become the page title.
    seedCachedRoute(db, "UA89", "ORD", "LHR", 300, now - 10 * DAY);
    seedCachedRoute(db, "UA89", "ORD", "SNN", 1, now - 3600);
    const rows = getFlightRoutePairs(db, ["UA89"], "UA", now);

    expect(rows.map((r) => r.arrival_airport)).toEqual(["LHR", "SNN"]);
    db.close();
  });

  test("crossing the grace period doesn't flip the title on the clock alone", () => {
    // The failure a hard cutoff has: one second of elapsed time swapping a page's
    // title, meta description and JSON-LD, then swapping back on the next stamp.
    // The discount starts at zero, so the two sides of the boundary must agree.
    const across = [now - 30 * DAY + 1, now - 30 * DAY - 1].map((lastSeen) => {
      const db = makeSyntheticDb();
      seedCachedRoute(db, "UA91", "ATL", "EWR", 82, lastSeen);
      seedCachedRoute(db, "UA91", "ORD", "DCA", 3, now - 2 * DAY);
      const rows = getFlightRoutePairs(db, ["UA91"], "UA", now);
      db.close();
      return rows.map((r) => `${r.departure_airport}-${r.arrival_airport}`);
    });

    expect(across[0]).toEqual(["ATL-EWR", "ORD-DCA"]);
    expect(across[1]).toEqual(across[0]);
  });

  test("a lone sighting never unseats a leg with orders more evidence", () => {
    const db = makeSyntheticDb();
    // The commonest production shape: a heavy leg silent for months against a
    // single stray observation inside the grace period. The discount bottoms out
    // at an eighth, so 116 observations survive as 14.5 and the stray stays put —
    // one sighting is not evidence that the other 116 stopped happening.
    seedCachedRoute(db, "UA92", "LAX", "SLC", 116, now - 100 * DAY);
    seedCachedRoute(db, "UA92", "DTW", "DEN", 1, now - 20 * DAY);
    const rows = getFlightRoutePairs(db, ["UA92"], "UA", now);

    expect(rows.map((r) => r.arrival_airport)).toEqual(["SLC", "DEN"]);
    db.close();
  });

  test("an ancient heavy leg still outranks a lighter, less ancient one", () => {
    const db = makeSyntheticDb();
    // Staleness must never decide on its own. Measured from the number's own
    // freshest leg instead of from `now`, the SNN row would be "current" by
    // construction and would take the title on one observation.
    seedCachedRoute(db, "UA90", "ORD", "LHR", 300, now - 200 * DAY);
    seedCachedRoute(db, "UA90", "ORD", "SNN", 1, now - 40 * DAY);
    const rows = getFlightRoutePairs(db, ["UA90"], "UA", now);

    expect(rows.map((r) => r.arrival_airport)).toEqual(["LHR", "SNN"]);
    db.close();
  });

  test("a leg whose origin equals its destination never reaches the caller", () => {
    const db = makeSyntheticDb();
    // Returns and diversions come back logged as A->A. Left in, such a row can
    // title a permalink "(MIA -> MIA)", emit JSON-LD with identical departure and
    // arrival airports, and link to /route-planner/MIA/MIA, which 404s by design.
    seedCachedRoute(db, "UA93", "MIA", "MIA", 1, now - 15 * DAY);
    seedCachedRoute(db, "UA93", "FAB", "ORD", 12, now - 37 * DAY);
    const rows = getFlightRoutePairs(db, ["UA93"], "UA", now);

    expect(rows.map((r) => r.departure_airport)).toEqual(["FAB"]);
    db.close();
  });

  test("a future-dated last_seen_at counts as no evidence, not the freshest", () => {
    const db = makeSyntheticDb();
    // The snapshot carries a row dated 2036. Scored as fresh it would outrank
    // every real leg forever, since no cutoff ever catches up to it.
    seedCachedRoute(db, "UA100", "EWR", "TLV", 1, utc("2036-08-19T04:59:55Z"));
    seedCachedRoute(db, "UA100", "EWR", "FCO", 90, now - 2 * DAY);
    seedCachedRoute(db, "UA100", "IAD", "MUC", 400, now - 120 * DAY);
    const rows = getFlightRoutePairs(db, ["UA100"], "UA", now);

    expect(rows[0].arrival_airport).toBe("FCO");
    expect(rows[rows.length - 1].arrival_airport).toBe("TLV");
    db.close();
  });

  test("a future-dated leg with no fresh sibling doesn't sort first", () => {
    const db = makeSyntheticDb();
    // The cold-tail shape the fix exists for: nothing is inside the window, so a
    // corrupt row is the only thing a naive freshness test could call current.
    seedCachedRoute(db, "UA101", "EWR", "TLV", 1, utc("2036-08-19T04:59:55Z"));
    seedCachedRoute(db, "UA101", "IAH", "EWR", 165, now - 40 * DAY);
    seedCachedRoute(db, "UA101", "EWR", "SFO", 8, now - 45 * DAY);
    const rows = getFlightRoutePairs(db, ["UA101"], "UA", now);

    expect(rows[0].arrival_airport).not.toBe("TLV");
    expect(rows.map((r) => r.arrival_airport)).toEqual(["EWR", "SFO", "TLV"]);
    db.close();
  });

  test("a scheduled leg still wins over a fresher history-only leg", () => {
    const db = makeSyntheticDb();
    seedCachedRoute(db, "UA5547", "DEN", "XWA", 415, now - 3600);
    const dep = now + 6 * 3600;
    db.run(
      `INSERT INTO upcoming_flights
         (tail_number, flight_number, departure_airport, arrival_airport,
          departure_time, arrival_time, last_updated, airline)
       VALUES ('N77777', 'UA5547', 'SDF', 'ORD', ?, ?, ?, 'UA')`,
      [dep, dep + 5400, now]
    );
    const rows = getFlightRoutePairs(db, ["UA5547"], "UA", now);

    expect(rows[0].departure_airport).toBe("SDF");
    expect(rows[0].scheduled).toBe(1);
    expect(rows[0].last_seen_at).toBe(now);
    db.close();
  });
});
