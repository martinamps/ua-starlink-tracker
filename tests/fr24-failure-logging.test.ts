/**
 * FR24 outage logging fires once per real failure.
 *
 * cachedFlightAssignments caches a rejected promise for ASSIGNMENT_FAILURE_TTL
 * and replays it to every request in that window, and concurrent requests all
 * await the same promise. Logging at the consumer therefore produced 3-4
 * identical lines per real failure (observed in production: three at the same
 * millisecond). The log lives at the producer's rejection handler instead,
 * which runs exactly once per fetch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cachedFlightAssignments, setAssignmentFetcher } from "../src/api/flight-verdict";
import { Fr24UnavailableError } from "../src/api/flightradar24-api";

let lines: string[] = [];
let origErr: typeof console.error;

beforeEach(() => {
  lines = [];
  origErr = console.error;
  console.error = (l: string) => lines.push(String(l));
});

afterEach(() => {
  console.error = origErr;
  setAssignmentFetcher(null);
});

const fr24Lines = () => lines.filter((l) => l.includes("FR24 assignment lookup failed"));

describe("FR24 failure logging", () => {
  test("logs once per real fetch, not once per awaiting request", async () => {
    let fetches = 0;
    setAssignmentFetcher(async () => {
      fetches++;
      throw new Fr24UnavailableError("FR24 down");
    });
    const now = 1_700_000_000;
    // Three concurrent requests for the same flight+date share one promise.
    await Promise.allSettled([
      cachedFlightAssignments("UA2666", now, now),
      cachedFlightAssignments("UA2666", now, now),
      cachedFlightAssignments("UA2666", now, now),
    ]);
    // Two more inside the failure-cache window replay the same rejection.
    await Promise.allSettled([
      cachedFlightAssignments("UA2666", now, now + 10),
      cachedFlightAssignments("UA2666", now, now + 20),
    ]);
    expect(fetches).toBe(1);
    expect(fr24Lines().length).toBe(1);
  });

  test("a genuinely new failure after the window logs again", async () => {
    setAssignmentFetcher(async () => {
      throw new Fr24UnavailableError("FR24 down");
    });
    const now = 1_700_000_000;
    await Promise.allSettled([cachedFlightAssignments("UA777", now, now)]);
    await Promise.allSettled([cachedFlightAssignments("UA777", now, now + 3600)]);
    expect(fr24Lines().length).toBe(2);
  });

  test("a successful lookup logs nothing", async () => {
    setAssignmentFetcher(async () => []);
    const now = 1_700_000_000;
    await cachedFlightAssignments("UA1", now, now);
    expect(fr24Lines().length).toBe(0);
  });
});
