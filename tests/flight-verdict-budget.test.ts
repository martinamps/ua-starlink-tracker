/**
 * Request-path FR24 budget: a token bucket plus a throttle breaker in front of
 * the live reverse lookup. Scripted callers enumerating flight numbers got FR24
 * throttling the shared session and stalled the background updater; a shed
 * lookup must degrade exactly like an FR24 outage (prediction path, same
 * response shape) without touching FR24.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { AIRLINES } from "../src/airlines/registry";
import { resolveFlightVerdict } from "../src/api/check-flight-core";
import {
  ASSIGNMENT_EMPTY_CACHE_MIN_LEAD,
  ASSIGNMENT_EMPTY_TTL,
  FR24_BREAKER_BASE_SEC,
  FR24_REQUEST_BUCKET_PER_MIN,
  cachedFlightAssignments,
  setAssignmentFetcher,
} from "../src/api/flight-verdict";
import { Fr24UnavailableError } from "../src/api/flightradar24-api";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { makeSyntheticDb, stubPredict, utc } from "./helpers";

const T0 = utc("2030-01-01T08:00:00Z");
const TARGET = utc("2030-01-01T12:00:00Z");

afterEach(() => setAssignmentFetcher(null));

function countingFetcher(impl: () => Promise<never[]> = async () => []) {
  const spy = { calls: 0 };
  setAssignmentFetcher(() => {
    spy.calls++;
    return impl();
  });
  return spy;
}

const throttled = () => Promise.reject(new Fr24UnavailableError("FR24 assignments error: 429"));

describe("request-path token bucket", () => {
  test("an exhausted bucket sheds without calling FR24, then refills", async () => {
    const spy = countingFetcher();
    for (let i = 0; i < FR24_REQUEST_BUCKET_PER_MIN; i++) {
      await cachedFlightAssignments(`UA${100 + i}`, TARGET, T0);
    }
    expect(spy.calls).toBe(FR24_REQUEST_BUCKET_PER_MIN);

    await expect(cachedFlightAssignments("UA999", TARGET, T0)).rejects.toBeInstanceOf(
      Fr24UnavailableError
    );
    expect(spy.calls).toBe(FR24_REQUEST_BUCKET_PER_MIN);

    await cachedFlightAssignments("UA999", TARGET, T0 + 60);
    expect(spy.calls).toBe(FR24_REQUEST_BUCKET_PER_MIN + 1);
  });

  test("cache hits never spend a token", async () => {
    const spy = countingFetcher(
      async () =>
        [
          {
            origin: "SFO",
            destination: "EWR",
            departure_time: TARGET,
            arrival_time: TARGET + 5 * 3600,
            tail_number: "N100UA",
            aircraft_model: "B739",
          },
        ] as never[]
    );
    for (let i = 0; i < FR24_REQUEST_BUCKET_PER_MIN * 3; i++) {
      await cachedFlightAssignments("UA1", TARGET, T0);
    }
    expect(spy.calls).toBe(1);
  });
});

describe("request-path throttle breaker", () => {
  test("a throttle opens the breaker; it sheds until it expires, then backs off longer", async () => {
    const spy = countingFetcher(throttled);
    await expect(cachedFlightAssignments("UA1", TARGET, T0)).rejects.toThrow("429");
    expect(spy.calls).toBe(1);

    await expect(cachedFlightAssignments("UA2", TARGET, T0 + 10)).rejects.toThrow("shed");
    await expect(
      cachedFlightAssignments("UA3", TARGET, T0 + FR24_BREAKER_BASE_SEC - 1)
    ).rejects.toThrow("shed");
    expect(spy.calls).toBe(1);

    const reopen = T0 + FR24_BREAKER_BASE_SEC;
    await expect(cachedFlightAssignments("UA4", TARGET, reopen)).rejects.toThrow("429");
    expect(spy.calls).toBe(2);

    // Second consecutive throttle doubles the window.
    await expect(
      cachedFlightAssignments("UA5", TARGET, reopen + FR24_BREAKER_BASE_SEC + 1)
    ).rejects.toThrow("shed");
    expect(spy.calls).toBe(2);
  });

  test("a non-throttle failure does not open the breaker", async () => {
    const spy = countingFetcher(() => Promise.reject(new Fr24UnavailableError("timeout")));
    await expect(cachedFlightAssignments("UA1", TARGET, T0)).rejects.toThrow("timeout");
    await expect(cachedFlightAssignments("UA2", TARGET, T0 + 1)).rejects.toThrow("timeout");
    expect(spy.calls).toBe(2);
  });

  test("resolveFlightVerdict degrades to prediction in well under a second on a 429", async () => {
    countingFetcher(throttled);
    const db = makeSyntheticDb();
    const reader = createReaderFactory(db)("UA");
    const now = Math.floor(Date.now() / 1000);
    const today = new Date(now * 1000).toISOString().slice(0, 10);

    const started = performance.now();
    const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA4321", today, {
      now,
      predict: stubPredict(0),
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(v.kind).toBe("prediction");
    db.close();
  });

  test("/api/check-flight keeps its shape while the breaker sheds", async () => {
    const db = makeSyntheticDb();
    const app = createApp(db);
    const now = Math.floor(Date.now() / 1000);
    const today = new Date(now * 1000).toISOString().slice(0, 10);
    const spy = countingFetcher(throttled);
    await expect(cachedFlightAssignments("UA1", now + 43200, now)).rejects.toThrow("429");
    expect(spy.calls).toBe(1);

    const res = await app.dispatch(
      new Request(`http://x/api/check-flight?flight_number=UA4321&date=${today}`, {
        headers: { Host: "unitedstarlinktracker.com" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasStarlink: unknown; flights: unknown };
    expect(body.hasStarlink === null || typeof body.hasStarlink === "boolean").toBe(true);
    expect(Array.isArray(body.flights)).toBe(true);
    expect(spy.calls).toBe(1);
    db.close();
  });
});

describe("empty-result caching", () => {
  test("far-out empties are cached briefly; near-term empties re-poll", async () => {
    const spy = countingFetcher();
    const farNow = TARGET - ASSIGNMENT_EMPTY_CACHE_MIN_LEAD - 60;
    await cachedFlightAssignments("UA10", TARGET, farNow);
    await cachedFlightAssignments("UA10", TARGET, farNow + ASSIGNMENT_EMPTY_TTL - 1);
    expect(spy.calls).toBe(1);
    await cachedFlightAssignments("UA10", TARGET, farNow + ASSIGNMENT_EMPTY_TTL);
    expect(spy.calls).toBe(2);

    await cachedFlightAssignments("UA11", TARGET, T0);
    await cachedFlightAssignments("UA11", TARGET, T0 + 1);
    expect(spy.calls).toBe(4);
  });
});
