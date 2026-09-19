/**
 * Request-path FR24 budget: a token bucket plus a throttle breaker in front of
 * the live reverse lookup. Scripted callers enumerating flight numbers got FR24
 * throttling the shared session and stalled the background updater; a shed
 * lookup must degrade exactly like an FR24 outage (prediction path, same
 * response shape) without touching FR24.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIRLINES } from "../src/airlines/registry";
import { resolveFlightVerdict } from "../src/api/check-flight-core";
import {
  ASSIGNMENT_EMPTY_CACHE_MIN_LEAD,
  ASSIGNMENT_EMPTY_TTL,
  FR24_BREAKER_BASE_SEC,
  FR24_REQUEST_BUCKET_PER_MIN,
  FR24_REQUEST_MAX_QUEUE_MS,
  cachedFlightAssignments,
  setAssignmentFetcher,
} from "../src/api/flight-verdict";
import {
  FR24_QUEUE_SHED_MESSAGE,
  FlightRadar24API,
  Fr24UnavailableError,
  MIN_REQUEST_INTERVAL,
  reserveFr24Slot,
  resetFr24SlotClock,
} from "../src/api/flightradar24-api";
import type { FR24FetchResult } from "../src/api/fr24-browser-transport";
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

  test("a burst of in-flight throttles opens the breaker once, at the base window", async () => {
    const rejectors: Array<() => void> = [];
    let holding = true;
    const spy = countingFetcher(() =>
      holding
        ? new Promise<never[]>((_, reject) => {
            rejectors.push(() => reject(new Fr24UnavailableError("FR24 assignments error: 429")));
          })
        : throttled()
    );
    const inFlight = [1, 2, 3, 4].map((i) =>
      cachedFlightAssignments(`UA${i}`, TARGET, T0).catch((e) => e)
    );
    holding = false;
    for (const reject of rejectors) reject();
    await Promise.all(inFlight);
    expect(spy.calls).toBe(4);

    await expect(
      cachedFlightAssignments("UA5", TARGET, T0 + FR24_BREAKER_BASE_SEC - 1)
    ).rejects.toThrow("shed");
    await expect(
      cachedFlightAssignments("UA6", TARGET, T0 + FR24_BREAKER_BASE_SEC)
    ).rejects.toThrow("429");
    expect(spy.calls).toBe(5);
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

// The real FlightRadar24API retry/rate-limit path with a fake transport. The
// slot clock is module-global wall time shared with every other test file, so
// each test starts from an empty queue instead of whatever earlier files left.
describe("request-path FR24 queue and retry caps", () => {
  beforeEach(() => resetFr24SlotClock());

  const status429: FR24FetchResult = { status: 429, ok: false, body: "" };
  const nowSec = () => Math.floor(Date.now() / 1000);

  test("reserveFr24Slot past maxWaitMs claims nothing", () => {
    const t = Date.now();
    const first = reserveFr24Slot(t) as number;
    expect(reserveFr24Slot(t, 0)).toBeNull();
    expect(reserveFr24Slot(t)).toBe(first + MIN_REQUEST_INTERVAL);
  });

  test("a caller behind a full queue sheds at once without calling FR24", async () => {
    let calls = 0;
    const api = new FlightRadar24API(async () => {
      calls++;
      return status429;
    });
    reserveFr24Slot();
    reserveFr24Slot();
    const started = performance.now();
    const err = await api
      .getFlightAssignments("UA1", nowSec(), {
        maxRetries: 0,
        maxWaitMs: FR24_REQUEST_MAX_QUEUE_MS,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Fr24UnavailableError);
    expect(err.message).toBe(FR24_QUEUE_SHED_MESSAGE);
    expect(calls).toBe(0);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("the default request-path fetcher is queue-capped", async () => {
    setAssignmentFetcher(null);
    reserveFr24Slot();
    reserveFr24Slot();
    const now = nowSec();
    const started = performance.now();
    await expect(cachedFlightAssignments("UA7", now + 3600, now)).rejects.toThrow(
      FR24_QUEUE_SHED_MESSAGE
    );
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("a queue shed is not cached as an outage and does not open the breaker", async () => {
    let first = true;
    const spy = countingFetcher(async () => {
      if (first) {
        first = false;
        throw new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE);
      }
      return [];
    });
    await expect(cachedFlightAssignments("UA8", TARGET, T0)).rejects.toThrow(
      FR24_QUEUE_SHED_MESSAGE
    );
    await cachedFlightAssignments("UA8", TARGET, T0);
    await cachedFlightAssignments("UA9", TARGET, T0);
    expect(spy.calls).toBe(3);
  });

  test("a queue shed refunds its bucket token", async () => {
    const spy = countingFetcher(() =>
      Promise.reject(new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE))
    );
    for (let i = 0; i < FR24_REQUEST_BUCKET_PER_MIN * 2; i++) {
      await expect(cachedFlightAssignments(`UA${200 + i}`, TARGET, T0)).rejects.toThrow(
        FR24_QUEUE_SHED_MESSAGE
      );
    }
    expect(spy.calls).toBe(FR24_REQUEST_BUCKET_PER_MIN * 2);
  });

  test("two concurrent request-path misses both reach FR24", async () => {
    let calls = 0;
    const api = new FlightRadar24API(async () => {
      calls++;
      return {
        status: 200,
        ok: true,
        body: JSON.stringify({ result: { response: { data: [] } } }),
      };
    });
    setAssignmentFetcher((flightNumber, targetDateUnix) =>
      api.getFlightAssignments(flightNumber, targetDateUnix, {
        maxRetries: 0,
        maxWaitMs: FR24_REQUEST_MAX_QUEUE_MS,
      })
    );
    const now = nowSec();
    const results = await Promise.allSettled([
      cachedFlightAssignments("UA1", now + 86400, now),
      cachedFlightAssignments("UA2", now + 86400, now),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(calls).toBe(2);
  });

  test("maxRetries 0 makes exactly one FR24 call on a 429 and fails without backoff", async () => {
    const fetchedAt: number[] = [];
    const api = new FlightRadar24API(async () => {
      fetchedAt.push(performance.now());
      return status429;
    });
    const err = await api.getFlightAssignments("UA1", nowSec(), { maxRetries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(Fr24UnavailableError);
    expect(err.message).toMatch(/429$/);
    expect(fetchedAt.length).toBe(1);
    expect(performance.now() - fetchedAt[0]).toBeLessThan(1000);
  });
});
