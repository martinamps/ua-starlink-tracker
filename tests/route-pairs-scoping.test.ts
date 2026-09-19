/**
 * Tenant scoping of the route cache.
 *
 * flight_routes carries no airline, and United's lookup variants include the
 * SkyWest operating prefixes (OO/SKW), which SkyWest also flies for Alaska. So
 * UA3371's variants matched Alaska's OO3371 STS-PDX (seen 367 times) and the
 * United permalink was titled "STS → PDX" and linked a /route-planner page that
 * 404s. These pin the corroboration rule: tenant-prefixed rows always count,
 * operating-prefix rows only when the tenant's own data backs that number.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  SITEMAP_STALE_DAYS,
  corroboratedRouteFilter,
  flightNumberHasData,
  getFlightRoutePairs,
  getObservationAnchor,
  getSitemapFlights,
  getSitemapRoutes,
} from "../src/database/database";
import { makeSyntheticDb, utc } from "./helpers";

const NOW = utc("2026-08-29T00:00:00Z");

function route(db: Database, fn: string, o: string, d: string, seen: number, lastSeen = NOW) {
  db.run(
    `INSERT INTO flight_routes
       (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, ?, ?, 6000, ?, ?, ?)`,
    [fn, o, d, lastSeen - 86400, lastSeen, seen]
  );
}

function scheduled(db: Database, fn: string, o: string, d: string, airline: string, dep = NOW) {
  db.run(
    `INSERT INTO upcoming_flights
       (tail_number, flight_number, departure_airport, arrival_airport,
        departure_time, arrival_time, last_updated, airline)
     VALUES ('N100SY', ?, ?, ?, ?, ?, ?, ?)`,
    [fn, o, d, dep, dep + 6000, dep - 3600, airline]
  );
}

const pairs = (db: Database, variants: string[]) =>
  getFlightRoutePairs(db, variants, "UA", NOW).map(
    (r) => `${r.departure_airport}-${r.arrival_airport}`
  );

describe("getFlightRoutePairs tenant scoping", () => {
  test("another carrier's SkyWest route never reaches a United permalink", () => {
    const db = makeSyntheticDb();
    route(db, "OO3371", "STS", "PDX", 367);
    route(db, "SKW3371", "STS", "PDX", 31);
    route(db, "AS2331", "STS", "PDX", 666);
    route(db, "UA3371", "ROC", "IAD", 3);
    scheduled(db, "OO3371", "STS", "PDX", "AS");
    const got = pairs(db, ["UA3371", "OO3371", "SKW3371"]);
    expect(got).toContain("ROC-IAD");
    expect(got).not.toContain("STS-PDX");
  });

  test("pair-level evidence alone does not admit an operating row", () => {
    // United flies SFO-SNA on some number, but not on this one.
    const db = makeSyntheticDb();
    route(db, "UA5555", "SFO", "SNA", 50);
    route(db, "OO3492", "SFO", "SNA", 1052);
    route(db, "UA3492", "CMH", "EWR", 4);
    expect(pairs(db, ["UA3492", "OO3492", "SKW3492"])).not.toContain("SFO-SNA");
  });

  test("an operating number on the tenant's schedule is still included", () => {
    const db = makeSyntheticDb();
    route(db, "OO4628", "ABQ", "DEN", 12);
    scheduled(db, "OO4628", "ABQ", "DEN", "UA");
    expect(pairs(db, ["UA4628", "OO4628", "SKW4628"])).toContain("ABQ-DEN");
  });

  test("an operating row on the same number's own marketing pair adds its count", () => {
    const db = makeSyntheticDb();
    route(db, "UA5210", "DEN", "BZN", 10);
    route(db, "SKW5210", "DEN", "BZN", 5);
    route(db, "SKW5210", "SEA", "BOI", 40);
    const rows = getFlightRoutePairs(db, ["UA5210", "OO5210", "SKW5210"], "UA", NOW);
    expect(rows.map((r) => `${r.departure_airport}-${r.arrival_airport}`)).toEqual(["DEN-BZN"]);
    expect(rows[0].times).toBe(15);
  });

  test("another airline's schedule claim vetoes an otherwise corroborated row", () => {
    const db = makeSyntheticDb();
    route(db, "UA3001", "PDX", "SJC", 1);
    route(db, "OO3001", "PDX", "SJC", 105);
    scheduled(db, "OO3001", "PDX", "SJC", "AS");
    const rows = getFlightRoutePairs(db, ["UA3001", "OO3001", "SKW3001"], "UA", NOW);
    expect(rows.find((r) => r.departure_airport === "PDX")?.times).toBe(1);
  });

  test("an empty airline filter admits nothing", () => {
    expect(corroboratedRouteFilter(["UA1"], []).clause).toBe("1=0");
  });
});

describe("flightNumberHasData tenant scoping", () => {
  test("other-carrier-only operating rows do not back a United permalink", () => {
    const db = makeSyntheticDb();
    route(db, "OO3001", "PDX", "SJC", 105);
    route(db, "SKW3001", "PDX", "SJC", 2);
    expect(flightNumberHasData(db, ["UA3001", "SKW3001", "OO3001"], "UA")).toBe(false);
  });

  test("a tenant-prefixed row still backs the permalink", () => {
    const db = makeSyntheticDb();
    route(db, "UA3371", "ROC", "IAD", 3);
    expect(flightNumberHasData(db, ["UA3371", "SKW3371", "OO3371"], "UA")).toBe(true);
  });
});

describe("sitemap staleness", () => {
  test("anchors on the airline's newest observation, not the wall clock", () => {
    const db = makeSyntheticDb();
    route(db, "UA1", "SFO", "EWR", 10, NOW);
    route(db, "UA2", "SFO", "ORD", 10, NOW + 86400 * 365 * 10);
    expect(getObservationAnchor(db, "UA", NOW + 60)).toBe(NOW);
    expect(getObservationAnchor(db, "NOPE", NOW)).toBe(0);
  });

  test("drops long-silent entries unless they are scheduled", () => {
    const db = makeSyntheticDb();
    const stale = NOW - (SITEMAP_STALE_DAYS + 5) * 86400;
    route(db, "UA10", "SFO", "EWR", 10, NOW);
    route(db, "UA11", "DEN", "BOS", 10, stale);
    route(db, "UA12", "IAH", "LAX", 10, stale);
    scheduled(db, "UA12", "IAH", "LAX", "UA", stale);
    const flights = getSitemapFlights(db, "UA").map((f) => f.flight_number);
    expect(flights).toContain("UA10");
    expect(flights).not.toContain("UA11");
    expect(flights).toContain("UA12");
    const routes = getSitemapRoutes(db, "UA").map((r) => `${r.origin}-${r.destination}`);
    expect(routes).toContain("SFO-EWR");
    expect(routes).not.toContain("DEN-BOS");
    expect(routes).toContain("IAH-LAX");
  });
});
