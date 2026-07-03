/**
 * The coordinate table + detour math backing the itinerary planner's
 * geographic gate. Distances are asserted against well-known published
 * great-circle values with a loose tolerance, not exact figures.
 */
import { describe, expect, test } from "bun:test";
import { AIRPORT_COORDS, airportDistanceMiles, detourBoundMiles } from "../src/utils/airport-geo";
import { AIRPORT_TZ } from "../src/utils/airport-tz";

describe("airportDistanceMiles", () => {
  // Guards the two hand-maintained per-airport tables against drift. A code
  // in the tz table but not here would silently disable the detour gate for
  // every itinerary touching it, so the coordinate table must be a superset.
  test("covers every airport the timezone table knows about", () => {
    const missing = Object.keys(AIRPORT_TZ).filter((k) => !AIRPORT_COORDS[k]);
    expect(missing).toEqual([]);
  });

  // Published great-circle distances (statute miles).
  const KNOWN: Array<[string, string, number]> = [
    ["SFO", "JFK", 2586],
    ["OGG", "SFO", 2338],
    ["LAX", "SFO", 337],
    ["EWR", "LHR", 3465],
    ["ORD", "LGA", 733],
  ];

  test.each(KNOWN)("%s-%s ≈ %d mi", (a, b, expected) => {
    const d = airportDistanceMiles(a, b);
    expect(d).not.toBeNull();
    // 2% tolerance: haversine on a spherical Earth vs published geodesic values.
    expect(Math.abs((d as number) - expected) / expected).toBeLessThan(0.02);
    // Symmetric.
    expect(airportDistanceMiles(b, a)).toBeCloseTo(d as number, 6);
  });

  test("same airport is 0; unknown code is null, never a guess", () => {
    expect(airportDistanceMiles("SFO", "SFO")).toBe(0);
    expect(airportDistanceMiles("QQQ", "SFO")).toBeNull();
    expect(airportDistanceMiles("SFO", "QQQ")).toBeNull();
  });

  test("every coordinate is a plausible lat/lon", () => {
    for (const [code, [lat, lon]] of Object.entries(AIRPORT_COORDS)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lon)).toBeLessThanOrEqual(180);
      // (0,0) is the null-island signature of a bad source row.
      expect(lat !== 0 || lon !== 0).toBe(true);
    }
  });
});

describe("detourBoundMiles", () => {
  const via = (a: string, h: string, b: string) =>
    (airportDistanceMiles(a, h) as number) + (airportDistanceMiles(h, b) as number);

  test("ratio dominates on long hauls, additive slack on short hops", () => {
    expect(detourBoundMiles(2000)).toBe(3000);
    expect(detourBoundMiles(100)).toBe(350);
    // Crossover: 1.5x and +250 agree at 500 mi.
    expect(detourBoundMiles(500)).toBe(750);
  });

  test("kills the reported OGG→SFO-via-San-Antonio pathology", () => {
    const direct = airportDistanceMiles("OGG", "SFO") as number;
    expect(via("OGG", "SAT", "SFO")).toBeGreaterThan(detourBoundMiles(direct));
    // ...while a genuinely on-the-way LAX connection is allowed.
    expect(via("OGG", "LAX", "SFO")).toBeLessThan(detourBoundMiles(direct));
  });
});
