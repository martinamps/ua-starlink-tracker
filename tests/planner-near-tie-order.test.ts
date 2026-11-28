/**
 * The planner's final order is a total order.
 *
 * It once counted two options within two points of score as tied and then
 * fell back to fewer legs and more Starlink hours. That pairwise test is not
 * transitive: with three near-equal options A beat C on score, C beat B on
 * hours and B beat A on legs, so which one came third depended on what else
 * was in the pool. Found on 2026-11-27: Guam to Newark showed Houston third
 * on one checkout and San Juan third on another, though neither had changed.
 *
 * The line: options rank by score band, then legs, then hours, then exact
 * score, then the legs themselves, each a key of the option alone. Any input
 * order gives the same output, and an option more than one band better than
 * another always ranks above it.
 */

import { describe, expect, test } from "bun:test";
import { type Itinerary, compareItineraries } from "../src/scripts/starlink-predictor";

const leg = (route: string, flight: string) =>
  ({
    route,
    flight_number: flight,
    probability: 0.5,
    confidence: "medium",
    n_observations: 10,
    method: "route_history",
    duration_hours: 2,
  }) as unknown as Itinerary["legs"][number];

function option(
  name: string,
  via: string[],
  ratio: number | null,
  hours: number | null,
  coverage: Itinerary["coverage"] = "full"
): Itinerary {
  const stops = ["GUM", ...via, "EWR"];
  return {
    via,
    legs: stops.slice(1).map((to, i) => leg(`${stops[i]}-${to}`, `UA${name}${i}`)),
    joint_probability: 0.5,
    at_least_one_probability: 0.5,
    coverage,
    total_flight_hours: 10,
    expected_starlink_hours: hours,
    coverage_ratio: ratio,
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}

const names = (list: Itinerary[]) => list.map((it) => it.legs[0].flight_number);
const sorted = (list: Itinerary[]) => [...list].sort(compareItineraries);

// Scores (ratio less 0.04 a stop): A 0.25, B 0.235, C 0.22. A and B are
// within 0.02, B and C are, A and C are not: the old rule's cycle.
const A = option("A", ["HNL", "SFO"], 0.33, 3);
const B = option("B", ["IAH"], 0.275, 2);
const C = option("C", ["SJU"], 0.26, 2.5);

describe("compareItineraries", () => {
  test("three near-equal options come out the same in every input order", () => {
    const orders = permutations([A, B, C]).map((p) => names(sorted(p)));
    for (const order of orders) expect(order).toEqual(orders[0]);
    expect(orders[0]).toEqual(["UAA0", "UAC0", "UAB0"]);
  });

  test("the order of two options doesn't depend on a third", () => {
    const others = [
      option("D", ["ORD"], 0.27, 1),
      option("E", ["MIA"], 0.9, 9),
      option("F", [], 0.24, 2.4),
      option("G", ["BOS"], null, null),
      option("H", ["DCA"], 0.26, 2.5, "partial"),
    ];
    const rank = (list: Itinerary[]) =>
      names(sorted(list)).filter((n) => n === "UAB0" || n === "UAC0");
    for (const extra of permutations(others).slice(0, 40)) {
      expect(rank([B, ...extra, C])).toEqual(["UAC0", "UAB0"]);
      expect(rank([C, ...extra.slice(2), B])).toEqual(["UAC0", "UAB0"]);
    }
  });

  test("an option more than one band better ranks first whatever its legs and hours", () => {
    const clear = option("X", ["HNL", "SFO"], 0.36, 0.1);
    const near = option("Y", [], 0.255, 9);
    expect(names(sorted([near, clear]))).toEqual(["UAX0", "UAY0"]);
    expect(names(sorted([clear, near]))).toEqual(["UAX0", "UAY0"]);
  });

  test("full before partial, and an unknown ratio after a known one", () => {
    const full = option("P", ["IAH"], 0.1, 1);
    const partial = option("Q", ["IAH"], 0.9, 9, "partial");
    const unknown = option("R", ["SFO"], null, null);
    for (const p of permutations([full, partial, unknown]))
      expect(names(sorted(p))).toEqual(["UAP0", "UAR0", "UAQ0"]);
  });

  test("is a strict total order on a random pool", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const hubs = ["HNL", "SFO", "IAH", "SJU", "ORD", "MIA", "DCA"];
    const pool = Array.from({ length: 60 }, (_, i) => {
      const via = hubs.slice(i % 7, (i % 7) + Math.floor(rand() * 3));
      const ratio = rand() < 0.1 ? null : 0.2 + Math.floor(rand() * 8) * 0.005;
      const hours = rand() < 0.1 ? null : Math.floor(rand() * 4) * 0.5;
      return option(`${i}_`, via, ratio, hours, rand() < 0.2 ? "partial" : "full");
    });
    for (const a of pool) {
      expect(compareItineraries(a, a)).toBe(0);
      for (const b of pool) {
        if (a !== b)
          expect(Math.sign(compareItineraries(a, b))).toBe(
            -Math.sign(compareItineraries(b, a)) || 0
          );
        if (a !== b) expect(compareItineraries(a, b)).not.toBe(0);
        for (const c of pool.slice(0, 20)) {
          if (compareItineraries(a, b) < 0 && compareItineraries(b, c) < 0)
            expect(compareItineraries(a, c)).toBeLessThan(0);
        }
      }
    }
    const first = names(sorted(pool));
    for (let k = 0; k < 10; k++) {
      const shuffled = [...pool].sort(() => rand() - 0.5);
      expect(names(sorted(shuffled))).toEqual(first);
    }
  });
});
