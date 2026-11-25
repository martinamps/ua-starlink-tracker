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
  FR24_REQUEST_DEADLINE_MS,
  FR24_REQUEST_MAX_QUEUE_MS,
  cachedFlightAssignments,
  setAssignmentFetcher,
} from "../src/api/flight-verdict";
import {
  FR24_ASSIGNMENT_FETCH_TIMEOUT_MS,
  FR24_QUEUE_SHED_MESSAGE,
  FlightRadar24API,
  Fr24UnavailableError,
  MIN_REQUEST_INTERVAL,
  assignmentFetchTimeoutMs,
  reserveFr24Slot,
  resetFr24SlotClock,
} from "../src/api/flightradar24-api";
import type { FR24FetchResult } from "../src/api/fr24-browser-transport";
import { createReaderFactory } from "../src/database/reader";
import {
  COUNTERS,
  classifyLookupCaller,
  metrics,
  normalizeLookupCaller,
} from "../src/observability";
import { createApp } from "../src/server/app";
import { CHROME_EXTENSION_ID } from "../src/utils/chrome-extension";
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

// The extension checks three cards at a time (CARD_CONCURRENCY in
// chrome-extension/content.js) and gives each check FETCH_TIMEOUT_MS.
describe("request-path lookups wait two slots inside the extension's timeout", () => {
  beforeEach(() => resetFr24SlotClock());

  const extensionTimeoutMs = async () => {
    const src = await Bun.file(
      new URL("../chrome-extension/background.js", import.meta.url).pathname
    ).text();
    const m = src.match(/FETCH_TIMEOUT_MS = ([\d_]+)/);
    if (!m) throw new Error("FETCH_TIMEOUT_MS not found in the extension");
    return Number(m[1].replaceAll("_", ""));
  };
  const cardConcurrency = async () => {
    const src = await Bun.file(
      new URL("../chrome-extension/content.js", import.meta.url).pathname
    ).text();
    const m = src.match(/CARD_CONCURRENCY = (\d+)/);
    if (!m) throw new Error("CARD_CONCURRENCY not found in the extension");
    return Number(m[1]);
  };

  test("every card of one extension pass gets a slot; the next caller is shed", async () => {
    const t = Date.now();
    const cards = await cardConcurrency();
    const waits = Array.from({ length: cards }, () =>
      reserveFr24Slot(t, FR24_REQUEST_MAX_QUEUE_MS)
    );
    expect(waits).toEqual(waits.map((_, i) => i * MIN_REQUEST_INTERVAL));
    expect(reserveFr24Slot(t, FR24_REQUEST_MAX_QUEUE_MS)).toBeNull();
  });

  test("the wait is longer, the rate is not: slots stay one interval apart", () => {
    const t = Date.now();
    const a = reserveFr24Slot(t, FR24_REQUEST_MAX_QUEUE_MS) as number;
    const b = reserveFr24Slot(t, FR24_REQUEST_MAX_QUEUE_MS) as number;
    const c = reserveFr24Slot(t, FR24_REQUEST_MAX_QUEUE_MS) as number;
    expect(b - a).toBe(MIN_REQUEST_INTERVAL);
    expect(c - b).toBe(MIN_REQUEST_INTERVAL);
  });

  test("worst case, two slots waited and a fetch that times out, beats the extension", async () => {
    const worstFetch = assignmentFetchTimeoutMs(
      FR24_REQUEST_DEADLINE_MS,
      FR24_REQUEST_MAX_QUEUE_MS
    );
    expect(FR24_REQUEST_MAX_QUEUE_MS).toBe(2 * MIN_REQUEST_INTERVAL);
    expect(FR24_REQUEST_MAX_QUEUE_MS + worstFetch).toBe(FR24_REQUEST_DEADLINE_MS);
    // A second of headroom for the trip to the server and back.
    expect(FR24_REQUEST_DEADLINE_MS).toBeLessThanOrEqual((await extensionTimeoutMs()) - 1000);
    // FR24 answers in 2.1s at p99; the squeezed fetch must still outlast that.
    expect(worstFetch).toBeGreaterThanOrEqual(4000);
  });

  test("the fetch timeout is what the wait left, never more than the usual one", () => {
    expect(assignmentFetchTimeoutMs(undefined, 60_000)).toBe(FR24_ASSIGNMENT_FETCH_TIMEOUT_MS);
    expect(assignmentFetchTimeoutMs(FR24_REQUEST_DEADLINE_MS, 0)).toBe(
      FR24_ASSIGNMENT_FETCH_TIMEOUT_MS
    );
    expect(assignmentFetchTimeoutMs(FR24_REQUEST_DEADLINE_MS, 4100)).toBe(4900);
    expect(assignmentFetchTimeoutMs(FR24_REQUEST_DEADLINE_MS, 20_000)).toBe(0);
  });

  test("three lookups at once all reach FR24, the last with a shorter fetch", async () => {
    const timeouts: number[] = [];
    const api = new FlightRadar24API(async (_url, timeoutMs) => {
      timeouts.push(timeoutMs as number);
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
        deadlineMs: FR24_REQUEST_DEADLINE_MS,
      })
    );
    const now = Math.floor(Date.now() / 1000);
    const started = performance.now();
    const results = await Promise.allSettled(
      ["UA1", "UA2", "UA3"].map((fn) => cachedFlightAssignments(fn, now + 86400, now))
    );
    const elapsed = performance.now() - started;
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(timeouts.length).toBe(3);
    expect(timeouts[0]).toBe(FR24_ASSIGNMENT_FETCH_TIMEOUT_MS);
    expect(elapsed).toBeGreaterThanOrEqual(FR24_REQUEST_MAX_QUEUE_MS - 50);
    for (const [i, timeout] of timeouts.entries()) {
      expect(i * MIN_REQUEST_INTERVAL + timeout).toBeLessThanOrEqual(FR24_REQUEST_DEADLINE_MS);
    }
    expect(timeouts[2]).toBeGreaterThanOrEqual(4000);
  }, 10_000);
});

describe("a shed lookup is tagged with who called", () => {
  const sheds = async (run: () => Promise<unknown>) => {
    const seen: Record<string, unknown>[] = [];
    const original = metrics.increment;
    metrics.increment = (name, tags) => {
      if (name === COUNTERS.VENDOR_REQUEST && tags?.status === "shed") seen.push({ ...tags });
    };
    try {
      await run();
    } finally {
      metrics.increment = original;
    }
    return seen;
  };
  const req = (path: string, headers: Record<string, string> = {}) => {
    const url = new URL(`https://unitedstarlinktracker.com${path}`);
    return [new Request(url, { headers }), url] as const;
  };
  const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
  const API = "/api/check-flight?flight_number=UA1&date=2030-01-01";

  test("the caller is told from what the request already carries", () => {
    expect(classifyLookupCaller(...req(`${API}&client=ext-2.2.0`, { "user-agent": CHROME }))).toBe(
      "extension"
    );
    expect(
      classifyLookupCaller(
        ...req(API, { "user-agent": CHROME, origin: `chrome-extension://${CHROME_EXTENSION_ID}` })
      )
    ).toBe("extension");
    expect(
      classifyLookupCaller(...req(API, { "user-agent": CHROME, "sec-fetch-site": "same-origin" }))
    ).toBe("page");
    for (const headers of [
      { "user-agent": CHROME },
      { "user-agent": CHROME, "sec-fetch-site": "cross-site" },
      { "user-agent": CHROME, origin: "chrome-extension://someoneelsesextensionid" },
      { "user-agent": "curl/8.5.0", "sec-fetch-site": "same-origin" },
      { "user-agent": "node" },
      {},
    ]) {
      expect(classifyLookupCaller(...req(API, headers))).toBe("other");
    }
  });

  test("the tag holds three words, whatever is passed", () => {
    for (const raw of ["page", "extension", "other"]) expect(normalizeLookupCaller(raw)).toBe(raw);
    for (const raw of [null, undefined, "", "Page", "extension,env:prod", "x".repeat(500)]) {
      expect(normalizeLookupCaller(raw)).toBe("other");
    }
  });

  test("queue, bucket and breaker sheds each carry caller and airline", async () => {
    const queue = await sheds(async () => {
      countingFetcher(() => Promise.reject(new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE)));
      await cachedFlightAssignments("UA20", TARGET, T0, "extension").catch(() => {});
      await cachedFlightAssignments("UA21", TARGET, T0, "page").catch(() => {});
      await cachedFlightAssignments("UA22", TARGET, T0).catch(() => {});
      await Bun.sleep(0);
    });
    expect(queue.map((t) => [t.reason, t.caller])).toEqual([
      ["queue", "extension"],
      ["queue", "page"],
      ["queue", "other"],
    ]);

    const bucket = await sheds(async () => {
      countingFetcher();
      for (let i = 0; i <= FR24_REQUEST_BUCKET_PER_MIN; i++) {
        await cachedFlightAssignments(`UA${300 + i}`, TARGET, T0, "page").catch(() => {});
      }
    });
    expect(bucket.map((t) => [t.reason, t.caller])).toEqual([["bucket", "page"]]);

    const breaker = await sheds(async () => {
      countingFetcher(throttled);
      await cachedFlightAssignments("UA30", TARGET, T0, "extension").catch(() => {});
      await Bun.sleep(0);
      await cachedFlightAssignments("UA31", TARGET, T0 + 1, "extension").catch(() => {});
    });
    expect(breaker.map((t) => [t.reason, t.caller])).toEqual([["breaker", "extension"]]);

    for (const t of [...queue, ...bucket, ...breaker]) {
      expect(t.vendor).toBe("fr24");
      expect(t.type).toBe("assignments");
      expect(t.airline).toBe("united");
    }
  });

  test("/api/check-flight hands its caller to the lookup", async () => {
    const db = makeSyntheticDb();
    const app = createApp(db);
    const now = Math.floor(Date.now() / 1000);
    const date = new Date((now + 3600) * 1000).toISOString().slice(0, 10);
    const seen = await sheds(async () => {
      countingFetcher(() => Promise.reject(new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE)));
      const ask = (fn: string, extra: string, headers: Record<string, string>) =>
        app.dispatch(
          new Request(`http://x/api/check-flight?flight_number=${fn}&date=${date}${extra}`, {
            headers: { Host: "unitedstarlinktracker.com", "user-agent": CHROME, ...headers },
          })
        );
      const responses = [
        await ask("UA9101", "&client=ext-2.2.0", {}),
        await ask("UA9102", "", { "sec-fetch-site": "same-origin" }),
        await ask("UA9103", "", {}),
      ];
      for (const r of responses) expect(r.status).toBe(200);
      await Bun.sleep(0);
    });
    expect(seen.map((t) => t.caller)).toEqual(["extension", "page", "other"]);
    db.close();
  });
});
