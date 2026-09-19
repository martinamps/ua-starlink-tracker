/**
 * FR24 registration list → upcoming_flights rows.
 *
 * FR24 returns a tail's flights newest-first. The cap used to run on that
 * order, so a regional tail flying 6-7 legs a day kept its furthest-future
 * legs and lost the leg in the air plus the next several hours.
 */

import { describe, expect, test } from "bun:test";
import {
  type FR24ListFlight,
  FR24_UPCOMING_CAP,
  MIN_REQUEST_INTERVAL,
  parseUpcomingFlights,
  reserveFr24Slot,
} from "../src/api/flightradar24-api";

const NOW = 1_800_000_000;
const HOUR = 3600;

function leg(n: number, dep: number, arr: number): FR24ListFlight {
  return {
    identification: {
      id: null,
      row: n,
      number: { default: `UA${5000 + n}`, alternative: null },
      callsign: `SKW${5000 + n}`,
    },
    airport: {
      origin: { code: { iata: "ORD", icao: "KORD" } },
      destination: { code: { iata: "DEN", icao: "KDEN" } },
    },
    time: {
      scheduled: { departure: dep, arrival: arr },
      real: { departure: null, arrival: null },
      estimated: { departure: null, arrival: null },
    },
  };
}

// 13 future legs 3.5h apart, one airborne leg, two landed legs; newest-first
// like FR24's own ordering.
function newestFirstFixture(): FR24ListFlight[] {
  const future = Array.from({ length: 13 }, (_, i) =>
    leg(i + 1, NOW + HOUR + i * 3.5 * HOUR, NOW + 3 * HOUR + i * 3.5 * HOUR)
  );
  const airborne = leg(0, NOW - 30 * 60, NOW + 90 * 60);
  const landed = [leg(-1, NOW - 5 * HOUR, NOW - 3 * HOUR), leg(-2, NOW - 9 * HOUR, NOW - 7 * HOUR)];
  return [...future.reverse(), airborne, ...landed];
}

describe("parseUpcomingFlights", () => {
  test("nearest first, airborne leg kept, landed legs dropped, capped", () => {
    const out = parseUpcomingFlights(newestFirstFixture(), NOW);

    expect(out.length).toBe(14);
    expect(out.length).toBeLessThanOrEqual(FR24_UPCOMING_CAP);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].departure_time).toBeGreaterThanOrEqual(out[i - 1].departure_time);
    }
    expect(out[0].departure_time).toBeLessThan(NOW);
    expect(out[0].arrival_time).toBeGreaterThan(NOW);
    expect(out.every((f) => f.arrival_time > NOW)).toBe(true);
  });

  test("a cap smaller than the list keeps the nearest legs, not the furthest", () => {
    const out = parseUpcomingFlights(newestFirstFixture(), NOW, 10);

    expect(out.length).toBe(10);
    expect(out[0].departure_time).toBeLessThan(NOW);
    const furthest = Math.max(...newestFirstFixture().map((f) => f.time.scheduled.departure ?? 0));
    expect(out.some((f) => f.departure_time === furthest)).toBe(false);
  });

  test("row shape: callsign flight number and IATA airports", () => {
    const [first] = parseUpcomingFlights(newestFirstFixture(), NOW);
    expect(typeof first.flight_number).toBe("string");
    expect(first.flight_number.startsWith("SKW")).toBe(true);
    expect(first.departure_airport).toMatch(/^[A-Z]{3}$/);
    expect(first.arrival_airport).toMatch(/^[A-Z]{3}$/);
  });
});

// Wall-clock based on purpose: the slot clock is module-global, so a far-future
// stamp would stall any later FR24 call in the same test process.
describe("reserveFr24Slot", () => {
  test("concurrent callers are spaced by at least MIN_REQUEST_INTERVAL", () => {
    const t = Date.now();
    const slots = [reserveFr24Slot(t), reserveFr24Slot(t), reserveFr24Slot(t)].map(
      (w) => t + (w as number)
    );
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i] - slots[i - 1]).toBeGreaterThanOrEqual(MIN_REQUEST_INTERVAL);
    }
  });

  test("a caller after the interval waits nothing", () => {
    const t = Date.now();
    const slot = t + (reserveFr24Slot(t) as number);
    expect(reserveFr24Slot(slot + MIN_REQUEST_INTERVAL + 1)).toBe(0);
  });
});
