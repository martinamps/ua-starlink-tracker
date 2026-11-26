/**
 * MCP's route lookup by flight number (lookupFlightRoutes, L2) asks FR24 only
 * through the request-path guards the tail lookup keeps: the caller's share,
 * the shared bucket, the breaker and a bounded queue wait. When a guard says
 * no, FR24 is not asked and the tool answers exactly as it does when FR24 has
 * no route.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FR24_REQUEST_BUCKET_PER_MIN,
  FR24_REQUEST_MAX_QUEUE_MS,
  cachedFlightAssignments,
  setAssignmentFetcher,
  setRouteFetcher,
} from "../src/api/flight-verdict";
import {
  FR24_QUEUE_SHED_MESSAGE,
  FlightRadar24API,
  type FlightRoute,
  Fr24UnavailableError,
  reserveFr24Slot,
  resetFr24SlotClock,
} from "../src/api/flightradar24-api";
import { FAN_OUT_ALLOWANCE, type LookupAsker, asLookupAsker } from "../src/api/lookup-budget";
import { createReaderFactory } from "../src/database/reader";
import { COUNTERS, metrics } from "../src/observability";
import { makeSyntheticDb, mcpDirect, toolText } from "./helpers";

// TEST-NET address (RFC 5737): nobody's.
const ASSISTANT = { caller: "mcp" as const, key: "mcp:203.0.113.7" };

let db: Database;
let factory: ReturnType<typeof createReaderFactory>;
let asked: string[];
let next = 2000;

/** A mainline number with no history: its fleet prior is low enough to ask for the route. */
const freshNumber = () => `UA${next++}`;

function routeFetcher(answer: (fn: string) => Promise<FlightRoute[]>) {
  setRouteFetcher((fn) => {
    asked.push(fn);
    return answer(fn);
  });
}

/** predict_flight_starlink with no date: L0 is skipped, L1 is empty, so L2 is next. */
async function predict(fn: string, asker: LookupAsker | null = ASSISTANT) {
  const run = () =>
    mcpDirect("UA", factory, "tools/call", {
      name: "predict_flight_starlink",
      arguments: { flight_number: fn },
    });
  const json = asker ? await asLookupAsker(asker, run) : await run();
  return { json, ...toolText(json) };
}

/** The answer a flight gets when FR24 is asked and has no route for it. */
async function noRouteAnswer(asFn: string) {
  const fn = freshNumber();
  routeFetcher(async () => []);
  const before = asked.length;
  const { json } = await predict(fn, { caller: "mcp", key: `mcp:${fn}` });
  expect(asked.length).toBe(before + 1);
  return JSON.stringify(json).replaceAll(fn, asFn);
}

async function routeSheds(run: () => Promise<unknown>) {
  const seen: Record<string, string | number>[] = [];
  const original = metrics.increment;
  metrics.increment = (name, tags) => {
    if (name === COUNTERS.VENDOR_REQUEST && tags?.status === "shed" && tags.type === "routes") {
      seen.push({ ...tags });
    }
  };
  try {
    await run();
  } finally {
    metrics.increment = original;
  }
  return seen;
}

beforeEach(() => {
  resetFr24SlotClock();
  db = makeSyntheticDb();
  factory = createReaderFactory(db);
  asked = [];
  setAssignmentFetcher(async () => []);
  routeFetcher(async () => []);
});

afterEach(() => {
  setRouteFetcher(null);
  setAssignmentFetcher(null);
  db.close();
});

describe("MCP route lookup behind the live-lookup guards", () => {
  test("with the guards open it asks FR24 once and keeps the route", async () => {
    const fn = freshNumber();
    routeFetcher(async () => [
      { origin: "SFO", destination: "EWR", departure_time: 0, duration_sec: 18000 },
    ]);
    const { text } = await predict(fn);
    expect(asked).toEqual([fn]);
    expect(text).toContain("SFO");
    expect(factory("UA").getCachedFlightRoutes(fn, 0).length).toBe(1);
  });

  test("an assistant past its share makes no route call and gets the no-route answer", async () => {
    const fn = freshNumber();
    const expected = await noRouteAnswer(fn);
    asked = [];

    // The assistant's other calls hold every lookup its share allows at once,
    // as a batch of check_flight calls does while FR24 answers.
    const release: (() => void)[] = [];
    setAssignmentFetcher(() => new Promise((resolve) => release.push(() => resolve([]))));
    const held = asLookupAsker(ASSISTANT, () =>
      Array.from({ length: FAN_OUT_ALLOWANCE.atOnce }, (_, i) =>
        cachedFlightAssignments(`UA${9000 + i}`, Math.floor(Date.now() / 1000) + 3600)
      )
    );
    expect(release.length).toBe(FAN_OUT_ALLOWANCE.atOnce);

    let json: unknown;
    const seen = await routeSheds(async () => {
      json = (await predict(fn)).json;
    });
    for (const done of release) done();
    await Promise.all(held);
    expect(asked).toEqual([]);
    expect(seen.map((t) => [t.reason, t.caller])).toEqual([["budget", "mcp"]]);
    expect(JSON.stringify(json)).toBe(expected);
  });

  test("the shared bucket caps everyone's route calls, share or none", async () => {
    const tries = FR24_REQUEST_BUCKET_PER_MIN + 5;
    const seen = await routeSheds(async () => {
      for (let i = 0; i < tries; i++) await predict(freshNumber(), null);
    });
    expect(asked.length).toBe(FR24_REQUEST_BUCKET_PER_MIN);
    expect(seen.length).toBe(tries - FR24_REQUEST_BUCKET_PER_MIN);
    expect(new Set(seen.map((t) => t.reason))).toEqual(new Set(["bucket"]));
  });

  test("a throttle opens the breaker, and the next route lookups stay off FR24", async () => {
    routeFetcher(async () => {
      throw new Error("FR24 routes error: 402");
    });
    const first = await predict(freshNumber());
    expect(first.isError).toBe(false);
    expect(asked.length).toBe(1);

    const fn = freshNumber();
    const expected = await noRouteAnswer(fn);
    // noRouteAnswer swapped the fetcher, but the breaker it reset must be
    // opened again for the case under test.
    routeFetcher(async () => {
      throw new Error("FR24 routes error: 429");
    });
    await predict(freshNumber());
    asked = [];
    let json: unknown;
    const seen = await routeSheds(async () => {
      json = (await predict(fn)).json;
    });
    expect(asked).toEqual([]);
    expect(seen.map((t) => t.reason)).toEqual(["breaker"]);
    expect(JSON.stringify(json)).toBe(expected);
  });

  test("a queue shed gives its token back and answers like no route", async () => {
    const fn = freshNumber();
    const expected = await noRouteAnswer(fn);
    routeFetcher(async () => {
      throw new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE);
    });
    let json: unknown;
    const seen = await routeSheds(async () => {
      json = (await predict(fn)).json;
    });
    expect(seen.map((t) => t.reason)).toEqual(["queue"]);
    expect(JSON.stringify(json)).toBe(expected);

    // Every token came back: the bucket still holds a full minute.
    routeFetcher(async () => []);
    asked = [];
    for (let i = 0; i < FR24_REQUEST_BUCKET_PER_MIN; i++) await predict(freshNumber(), null);
    expect(asked.length).toBe(FR24_REQUEST_BUCKET_PER_MIN);
  });
});

describe("FlightRadar24API.getFlightRoutes on the request path", () => {
  test("a queue longer than the wait it may take is shed before FR24 is asked", async () => {
    let fetched = 0;
    const api = new FlightRadar24API(async () => {
      fetched++;
      return { ok: true, status: 200, body: "{}" } as never;
    });
    const now = Date.now();
    for (let i = 0; i < 5; i++) reserveFr24Slot(now);
    await expect(
      api.getFlightRoutes("UA1", undefined, { maxWaitMs: FR24_REQUEST_MAX_QUEUE_MS })
    ).rejects.toThrow(FR24_QUEUE_SHED_MESSAGE);
    expect(fetched).toBe(0);
  });

  test("an FR24 refusal throws with its status, so the breaker can see a throttle", async () => {
    const api = new FlightRadar24API(async () => ({ ok: false, status: 402, body: "" }) as never);
    await expect(api.getFlightRoutes("UA1")).rejects.toThrow(/error: 402$/);
  });
});
