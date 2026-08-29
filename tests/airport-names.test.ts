/**
 * The airport name/city reference table behind /airport/{IATA} titles.
 * Coverage is pinned against airport-geo's coordinate table (the tracked
 * route network's vocabulary): an airport entering the network without a
 * name here would ship a nameless page, so the gap fails loud.
 */
import { describe, expect, test } from "bun:test";
import { AIRPORT_COORDS } from "../src/utils/airport-geo";
import { AIRPORT_NAMES, airportInfo } from "../src/utils/airport-names";

describe("AIRPORT_NAMES", () => {
  test("covers every airport in the coordinate table", () => {
    const missing = Object.keys(AIRPORT_COORDS).filter((k) => !AIRPORT_NAMES[k]);
    expect(missing).toEqual([]);
  });

  test("every entry is a plausible name + city, keyed by IATA", () => {
    for (const [code, info] of Object.entries(AIRPORT_NAMES)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(info.name.length).toBeGreaterThan(3);
      expect(info.city.length).toBeGreaterThan(1);
      // The city is the SERP-facing word — a bare IATA code there means the
      // row was stubbed, not sourced.
      expect(info.city).not.toBe(code);
    }
  });

  // Static facts, so exact values are safe to pin — these are the majors a
  // reviewer would spot-check first.
  const MAJORS: Array<[string, string, string]> = [
    ["EWR", "Newark Liberty International Airport", "Newark"],
    ["ORD", "Chicago O'Hare International Airport", "Chicago"],
    ["DEN", "Denver International Airport", "Denver"],
    ["IAH", "George Bush Intercontinental Airport", "Houston"],
    ["SFO", "San Francisco International Airport", "San Francisco"],
    ["LAX", "Los Angeles International Airport", "Los Angeles"],
    ["IAD", "Washington Dulles International Airport", "Washington"],
    ["SEA", "Seattle-Tacoma International Airport", "Seattle"],
    ["HNL", "Daniel K. Inouye International Airport", "Honolulu"],
    ["DOH", "Hamad International Airport", "Doha"],
  ];
  test.each(MAJORS)("%s = %s (%s)", (code, name, city) => {
    expect(AIRPORT_NAMES[code]).toEqual({ name, city });
  });

  test("airportInfo returns null for unknown codes, never a guess", () => {
    expect(airportInfo("QQQ")).toBeNull();
    expect(airportInfo("EWR")?.city).toBe("Newark");
  });
});
