/**
 * Golden snapshots — pre-refactor baseline.
 *
 * Fixtures captured by `bun scripts/capture-golden.ts` against the test
 * snapshot before the multi-airline refactor. These lock the public-contract
 * response shapes so the refactor can be diffed against them. Once
 * createApp(db) exists, this file will assert dispatch() output equals the
 * fixtures byte-for-byte (modulo volatile fields).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const G = "tests/golden";
const load = (name: string) => JSON.parse(readFileSync(`${G}/${name}`, "utf8"));

describe("golden snapshots (pre-refactor baseline)", () => {
  test("api-data: top-level shape", () => {
    const d = load("api-data.json");
    expect(typeof d.totalCount).toBe("number");
    expect(Array.isArray(d.starlinkPlanes)).toBe(true);
    expect(d.starlinkPlanes.length).toBeGreaterThan(0);
    expect(typeof d.lastUpdated).toBe("string");
    expect(d.fleetStats).toBeDefined();
    expect(d.flightsByTail).toBeDefined();
  });

  test("api-check-flight: false-case shape", () => {
    const d = load("api-check-flight-UA123.json");
    expect(d.hasStarlink).toBe(false);
    expect(Array.isArray(d.flights)).toBe(true);
    expect(d.flights.length).toBe(0);
  });

  test("api-check-flight: true-case shape with confidence", () => {
    const d = load("api-check-flight-UA4421.json");
    expect(d.hasStarlink).toBe(true);
    expect(["verified", "likely"]).toContain(d.confidence);
    expect(Array.isArray(d.flights)).toBe(true);
    expect(d.flights.length).toBeGreaterThan(0);
    const f = d.flights[0];
    for (const k of [
      "tail_number",
      "aircraft_type",
      "flight_number",
      "ua_flight_number",
      "departure_airport",
      "arrival_airport",
      "departure_time",
      "arrival_time",
    ]) {
      expect(f[k]).toBeDefined();
    }
  });

  test("mcp-initialize: serverInfo + instructions", () => {
    const d = load("mcp-initialize.json");
    expect(d.result.serverInfo.name).toBeDefined();
    expect(typeof d.result.instructions).toBe("string");
    expect(d.result.capabilities.tools).toBeDefined();
  });

  test("mcp-tools-list: 7 tools with stable names", () => {
    const d = load("mcp-tools-list.json");
    const names = d.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      [
        "check_flight",
        "get_fleet_stats",
        "list_starlink_aircraft",
        "plan_starlink_itinerary",
        "predict_flight_starlink",
        "predict_route_starlink",
        "search_starlink_flights",
      ].sort()
    );
  });
});
