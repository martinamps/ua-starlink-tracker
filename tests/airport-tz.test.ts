import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/scripts/qatar-schedule-ingester";
import { AIRPORT_TZ } from "../src/utils/airport-tz";

describe("AIRPORT_TZ coverage", () => {
  // An unmapped departure airport falls back to the UTC day, which files a
  // late-evening Qatar departure under the wrong service date.
  test("every Qatar ingester route airport has a timezone", () => {
    const missing = [...new Set(ROUTES.flat())].filter((a) => !AIRPORT_TZ[a]);
    expect(missing).toEqual([]);
  });
});
