import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/scripts/qatar-schedule-ingester";
import { AIRPORT_TZ, zonedWallTimeSec } from "../src/utils/airport-tz";

describe("AIRPORT_TZ coverage", () => {
  // An unmapped departure airport falls back to the UTC day, which files a
  // late-evening Qatar departure under the wrong service date.
  test("every Qatar ingester route airport has a timezone", () => {
    const missing = [...new Set(ROUTES.flat())].filter((a) => !AIRPORT_TZ[a]);
    expect(missing).toEqual([]);
  });
});

describe("zonedWallTimeSec", () => {
  const iso = (sec: number) => new Date(sec * 1000).toISOString();

  test("a wall time on a date reads back at that zone's offset", () => {
    expect(iso(zonedWallTimeSec("2026-11-28", 8 * 60 + 15, "America/Denver"))).toBe(
      "2026-11-28T15:15:00.000Z"
    );
    expect(iso(zonedWallTimeSec("2026-12-10", 23 * 60 + 59, "Asia/Tokyo"))).toBe(
      "2026-12-10T14:59:00.000Z"
    );
  });

  test("each side of a DST change takes the offset in force then", () => {
    // New York springs forward at 2:00 on 2026-03-08.
    expect(iso(zonedWallTimeSec("2026-03-08", 60, "America/New_York"))).toBe(
      "2026-03-08T06:00:00.000Z"
    );
    expect(iso(zonedWallTimeSec("2026-03-08", 3 * 60 + 30, "America/New_York"))).toBe(
      "2026-03-08T07:30:00.000Z"
    );
    const skipped = zonedWallTimeSec("2026-03-08", 2 * 60 + 30, "America/New_York");
    expect(Math.abs(skipped - Date.parse("2026-03-08T07:00:00Z") / 1000)).toBeLessThanOrEqual(3600);
  });
});
