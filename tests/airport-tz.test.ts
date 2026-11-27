import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/scripts/qatar-schedule-ingester";
import { AIRPORT_TZ, airportLocalDate, secondsToFirstLocalMidnight } from "../src/utils/airport-tz";

describe("AIRPORT_TZ coverage", () => {
  // An unmapped departure airport falls back to the UTC day, which files a
  // late-evening Qatar departure under the wrong service date.
  test("every Qatar ingester route airport has a timezone", () => {
    const missing = [...new Set(ROUTES.flat())].filter((a) => !AIRPORT_TZ[a]);
    expect(missing).toEqual([]);
  });
});

describe("secondsToFirstLocalMidnight", () => {
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  // The date holds one second before the answer and has turned at it.
  const turnsAt = (airport: string, nowSec: number, sec: number) =>
    airportLocalDate(airport, nowSec + sec - 1) === airportLocalDate(airport, nowSec) &&
    airportLocalDate(airport, nowSec + sec) !== airportLocalDate(airport, nowSec);

  test("lands on the second an airport's local date turns, DST days included", () => {
    // Denver's fall-back day runs 25 hours; spring-forward runs 23.
    for (const iso of ["2026-11-01T07:30:00Z", "2027-03-14T07:30:00Z", "2026-11-27T12:00:00Z"]) {
      const now = at(iso);
      const sec = secondsToFirstLocalMidnight(["DEN"], now);
      expect(sec, iso).not.toBeNull();
      expect(turnsAt("DEN", now, sec ?? 0), iso).toBe(true);
    }
  });

  test("takes the earliest zone, and counts none it cannot map", () => {
    const now = at("2026-11-27T07:12:00Z");
    const den = secondsToFirstLocalMidnight(["DEN"], now) ?? 0;
    const lax = secondsToFirstLocalMidnight(["LAX"], now) ?? 0;
    expect(secondsToFirstLocalMidnight(["LAX", "DEN", "QQQ"], now)).toBe(Math.min(den, lax));
    expect(secondsToFirstLocalMidnight(["QQQ"], now)).toBeNull();
    expect(secondsToFirstLocalMidnight([], now)).toBeNull();
  });
});
