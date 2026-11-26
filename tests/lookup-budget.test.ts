/**
 * Each caller's share of the live FR24 lookups: one caller's batch must not
 * take the queue from the next person, and a caller past its share must get
 * exactly the estimate a full queue gives.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  FR24_REQUEST_BUCKET_PER_MIN,
  FR24_REQUEST_MAX_QUEUE_MS,
  cachedFlightAssignments,
  setAssignmentFetcher,
} from "../src/api/flight-verdict";
import {
  FR24_QUEUE_SHED_MESSAGE,
  Fr24UnavailableError,
  MIN_REQUEST_INTERVAL,
  reserveFr24Slot,
  resetFr24SlotClock,
} from "../src/api/flightradar24-api";
import {
  FAN_OUT_ALLOWANCE,
  LOOKUP_IN_HAND_MAX_SEC,
  LookupBudget,
  SINGLE_ALLOWANCE,
  asLookupAsker,
  lookupAllowance,
} from "../src/api/lookup-budget";
import {
  COUNTERS,
  classifyLookupCaller,
  classifyUserAgent,
  metrics,
  normalizeLookupCaller,
  normalizeLookupShedReason,
} from "../src/observability";
import { createApp } from "../src/server/app";
import { makeSyntheticDb, mcpReq, toolText, utc } from "./helpers";

const T0 = utc("2030-01-01T08:00:00Z");
const TARGET = utc("2030-01-01T12:00:00Z");
const HOST = "unitedstarlinktracker.com";
const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
// TEST-NET addresses (RFC 5737): nobody's.
const BATCH = "203.0.113.7";
const PERSON = "198.51.100.23";
const QUEUE_PLACES = FR24_REQUEST_MAX_QUEUE_MS / MIN_REQUEST_INTERVAL + 1;

beforeEach(() => resetFr24SlotClock());
afterEach(() => setAssignmentFetcher(null));

type ShedTags = Record<string, string | number>;

async function sheds(run: () => Promise<unknown>): Promise<ShedTags[]> {
  const seen: ShedTags[] = [];
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
}

/**
 * Stands in for FR24 behind the real queue: every lookup claims a place by
 * the production rule at one frozen instant (so a place, once taken, stays
 * taken), is shed if none is left, and otherwise hangs until released.
 */
function queuedFetcher() {
  const at = Date.now();
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  setAssignmentFetcher((flightNumber) => {
    if (reserveFr24Slot(at, FR24_REQUEST_MAX_QUEUE_MS) === null) {
      return Promise.reject(new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE));
    }
    asked.push(flightNumber);
    return new Promise((resolve) => waiting.push(() => resolve([])));
  });
  return {
    asked,
    release: () => {
      for (const done of waiting.splice(0)) done();
    },
  };
}

const nearDate = () => new Date((Date.now() / 1000 + 3600) * 1000).toISOString().slice(0, 10);

function checkFlight(
  fn: string,
  address: string,
  opts: { query?: string; headers?: Record<string, string> } = {}
): Request {
  return new Request(
    `http://x/api/check-flight?flight_number=${fn}&date=${nearDate()}${opts.query ?? ""}`,
    {
      headers: {
        Host: HOST,
        "user-agent": CHROME,
        "cf-connecting-ip": address,
        ...opts.headers,
      },
    }
  );
}

/** Lets every dispatched request run up to its first real wait. */
const settle = () => Bun.sleep(20);

describe("one caller's batch and the next person's lookup", () => {
  test("a batch from one address leaves a queue place, and the next caller gets it", async () => {
    const db = makeSyntheticDb();
    const app = createApp(db);
    const fr24 = queuedFetcher();
    let batch: Promise<Response>[] = [];
    let person: Response | undefined;

    const seen = await sheds(async () => {
      batch = Array.from({ length: 15 }, (_, i) =>
        app.dispatch(checkFlight(`UA${9200 + i}`, BATCH))
      );
      await settle();
      const asking = app.dispatch(
        checkFlight("UA9300", PERSON, { headers: { "sec-fetch-site": "same-origin" } })
      );
      await settle();
      fr24.release();
      person = await asking;
      await Promise.all(batch);
    });

    expect(fr24.asked.filter((fn) => fn !== "UA9300")).toHaveLength(SINGLE_ALLOWANCE.atOnce);
    expect(fr24.asked).toContain("UA9300");
    expect(seen).toHaveLength(15 - SINGLE_ALLOWANCE.atOnce);
    for (const t of seen) {
      expect(t.reason).toBe("budget");
      expect(t.caller).toBe("api");
      expect(t.airline).toBe("united");
    }
    expect(person?.status).toBe(200);
    expect(JSON.stringify(await person?.json())).not.toContain("busy");
    db.close();
  });

  test("without a share kept, the same batch takes every place and the next caller is shed", async () => {
    const db = makeSyntheticDb();
    const app = createApp(db);
    const fr24 = queuedFetcher();
    let person: Response | undefined;

    const seen = await sheds(async () => {
      // A local address is unmetered by the limiter and keeps no share: this
      // is the queue as it was for every caller before the budget.
      const batch = Array.from({ length: 15 }, (_, i) =>
        app.dispatch(checkFlight(`UA${9200 + i}`, "127.0.0.1"))
      );
      await settle();
      const asking = app.dispatch(
        checkFlight("UA9300", PERSON, { headers: { "sec-fetch-site": "same-origin" } })
      );
      await settle();
      fr24.release();
      person = await asking;
      await Promise.all(batch);
    });

    expect(fr24.asked).toHaveLength(QUEUE_PLACES);
    expect(fr24.asked).not.toContain("UA9300");
    expect(seen.every((t) => t.reason === "queue")).toBe(true);
    expect(seen.filter((t) => t.caller === "page")).toHaveLength(1);
    expect(JSON.stringify(await person?.json())).toContain("busy");
    db.close();
  });

  test("past its share a caller gets, byte for byte, the answer a full queue gives", async () => {
    const db = makeSyntheticDb();
    const app = createApp(db);
    const ask = async (address: string) => {
      const res = await app.dispatch(checkFlight("UA9400", address));
      return {
        status: res.status,
        type: res.headers.get("content-type"),
        cors: res.headers.get("access-control-allow-origin"),
        retryAfter: res.headers.get("retry-after"),
        body: await res.text(),
      };
    };

    setAssignmentFetcher(() => Promise.reject(new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE)));
    const queueShed = await ask(PERSON);

    const fr24 = queuedFetcher();
    const held = Array.from({ length: SINGLE_ALLOWANCE.atOnce }, (_, i) =>
      app.dispatch(checkFlight(`UA${9410 + i}`, BATCH))
    );
    await settle();
    let overBudget: Awaited<ReturnType<typeof ask>> | undefined;
    const seen = await sheds(async () => {
      overBudget = await ask(BATCH);
    });
    fr24.release();
    await Promise.all(held);

    expect(seen.map((t) => t.reason)).toEqual(["budget"]);
    expect(fr24.asked).not.toContain("UA9400");
    expect(overBudget).toEqual(queueShed);
    expect(overBudget?.status).toBe(200);
    expect(overBudget?.retryAfter).toBeNull();
    expect(overBudget?.body).toContain("Live assignment lookup is busy; showing our estimate.");
    db.close();
  });

  test("an assistant's calls share one address and keep the whole queue, tagged mcp past it", async () => {
    const db = makeSyntheticDb();
    const app = createApp(db);
    const fr24 = queuedFetcher();
    // check_flight also names the route; a stored one keeps that off FR24.
    const now = Math.floor(Date.now() / 1000);
    for (const fn of ["UA9500", "UA9501", "UA9502", "UA9510"]) {
      db.query(
        `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
         VALUES (?, 'SFO', 'EWR', 18000, ?, ?, 3)`
      ).run(fn, now - 3600, now);
    }
    const call = (fn: string) =>
      app.dispatch(
        mcpReq(
          HOST,
          "tools/call",
          { name: "check_flight", arguments: { flight_number: fn, date: nearDate() } },
          { headers: { "cf-connecting-ip": BATCH } }
        )
      );
    let last: Response | undefined;
    let held: Promise<Response>[] = [];
    const seen = await sheds(async () => {
      held = Array.from({ length: FAN_OUT_ALLOWANCE.atOnce }, (_, i) => call(`UA${9500 + i}`));
      await settle();
      last = await call("UA9510");
    });
    const asked = [...fr24.asked];
    fr24.release();
    await Promise.all(held);

    expect(asked).toEqual(["UA9500", "UA9501", "UA9502"]);
    // Twice: check_flight asks once for the verdict and once more for the
    // route's legs, and each ask past the share is counted.
    expect(seen.map((t) => [t.reason, t.caller])).toEqual([
      ["budget", "mcp"],
      ["budget", "mcp"],
    ]);
    const answer = toolText(await last?.json());
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("Live assignment lookup is busy; showing our estimate.");
    db.close();
  });

  test("a second ask for a flight already being looked up joins it and costs nothing", async () => {
    const db = makeSyntheticDb();
    const app = createApp(db);
    const fr24 = queuedFetcher();
    const seen = await sheds(async () => {
      const all = Array.from({ length: 10 }, () => app.dispatch(checkFlight("UA9600", BATCH)));
      await settle();
      fr24.release();
      for (const res of await Promise.all(all)) expect(res.status).toBe(200);
    });
    expect(fr24.asked).toEqual(["UA9600"]);
    expect(seen).toEqual([]);
    db.close();
  });

  test("no address reaches a metric tag", async () => {
    const db = makeSyntheticDb();
    const app = createApp(db);
    queuedFetcher();
    const tags: string[] = [];
    const original = metrics.increment;
    metrics.increment = (_name, t) => {
      tags.push(JSON.stringify(t ?? {}));
    };
    try {
      const all = Array.from({ length: 6 }, (_, i) =>
        app.dispatch(checkFlight(`UA${9700 + i}`, BATCH))
      );
      await settle();
      setAssignmentFetcher(null);
      await Promise.race([Promise.all(all), settle()]);
    } finally {
      metrics.increment = original;
    }
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).not.toContain(BATCH);
    db.close();
  });
});

describe("a caller walking flight numbers for minutes", () => {
  const asBatch = <T>(run: () => T) => asLookupAsker({ caller: "api", key: `api:${BATCH}` }, run);
  const asPerson = <T>(run: () => T) =>
    asLookupAsker({ caller: "page", key: `api:${PERSON}` }, run);

  // One new flight a second for two minutes, each answered at once.
  async function walk(as: <T>(run: () => T) => T): Promise<number> {
    let reached = 0;
    setAssignmentFetcher(async () => {
      reached++;
      return [];
    });
    for (let s = 0; s < 120; s++) {
      await as(() => cachedFlightAssignments(`UA${1000 + s}`, TARGET, T0 + s)).catch(() => {});
    }
    return reached;
  }

  test("it is held to its burst and six a minute, and FR24 is asked less, never more", async () => {
    const reached = await walk(asBatch);
    expect(reached).toBe(SINGLE_ALLOWANCE.burst + 2 * SINGLE_ALLOWANCE.perMin - 1);
    // The shared bucket alone let the same walk through 15 + 15 a minute.
    const unbudgeted = await walk((run) => run());
    expect(reached).toBeLessThan(unbudgeted);
  });

  test("the shared bucket is still there for the next person", async () => {
    let seen = await sheds(async () => {
      await walk(asBatch);
      await asPerson(() => cachedFlightAssignments("UA7", TARGET, T0 + 120));
    });
    expect(new Set(seen.map((t) => t.reason))).toEqual(new Set(["budget"]));
    expect(new Set(seen.map((t) => t.caller))).toEqual(new Set(["api"]));

    setAssignmentFetcher(null);
    seen = await sheds(async () => {
      await walk((run) => run());
    });
    // Without shares the walk empties the bucket everyone draws from.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((t) => t.reason))).toEqual(new Set(["bucket"]));
  });

  test("a lookup shed by the queue is given back: it took nobody's place", async () => {
    setAssignmentFetcher(() => Promise.reject(new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE)));
    const seen = await sheds(async () => {
      for (let i = 0; i < 3 * SINGLE_ALLOWANCE.burst; i++) {
        await asBatch(() => cachedFlightAssignments(`UA${2000 + i}`, TARGET, T0)).catch(() => {});
        await Bun.sleep(0);
      }
    });
    expect(seen).toHaveLength(3 * SINGLE_ALLOWANCE.burst);
    expect(seen.every((t) => t.reason === "queue")).toBe(true);
  });

  test("a lookup with no caller named keeps no share: background and direct calls are untouched", async () => {
    let reached = 0;
    setAssignmentFetcher(async () => {
      reached++;
      return [];
    });
    for (let i = 0; i < FR24_REQUEST_BUCKET_PER_MIN; i++) {
      await cachedFlightAssignments(`UA${3000 + i}`, TARGET, T0);
    }
    expect(reached).toBe(FR24_REQUEST_BUCKET_PER_MIN);
  });
});

describe("the share is sized from how the extension calls", () => {
  const extensionNumber = async (name: string) => {
    const src = await Bun.file(
      new URL("../chrome-extension/content.js", import.meta.url).pathname
    ).text();
    const m = src.match(new RegExp(`${name} = (\\d+)`));
    if (!m) throw new Error(`${name} not found in the extension`);
    return Number(m[1]);
  };

  test("the largest pass the extension can make is never cut, at the pace the queue allows", async () => {
    const cards = await extensionNumber("CARD_CONCURRENCY");
    const perPass = await extensionNumber("MAX_NEW_LOOKUPS_PER_PASS");
    expect(FAN_OUT_ALLOWANCE.atOnce).toBeGreaterThanOrEqual(cards);

    // Every flight of the pass needs a live lookup, and each takes the next
    // place, one MIN_REQUEST_INTERVAL after the last: the fastest FR24 is asked.
    const budget = new LookupBudget();
    const stepSec = MIN_REQUEST_INTERVAL / 1000;
    for (let i = 0; i < perPass; i++) {
      expect(budget.take("ext:a", FAN_OUT_ALLOWANCE, T0 + i * stepSec)).toBe(true);
      budget.settle("ext:a", { asked: true });
    }
  });

  test("anyone else holds fewer places than the queue has, so one is always left", () => {
    expect(SINGLE_ALLOWANCE.atOnce).toBeLessThan(QUEUE_PLACES);
    expect(FAN_OUT_ALLOWANCE.atOnce).toBeLessThanOrEqual(QUEUE_PLACES);
    for (const caller of ["page", "api", "other"] as const) {
      expect(lookupAllowance(caller)).toBe(SINGLE_ALLOWANCE);
    }
    for (const caller of ["extension", "mcp"] as const) {
      expect(lookupAllowance(caller)).toBe(FAN_OUT_ALLOWANCE);
    }
    // Nobody's steady rate reaches what all callers share.
    expect(SINGLE_ALLOWANCE.perMin).toBeLessThan(FR24_REQUEST_BUCKET_PER_MIN / 2);
    expect(FAN_OUT_ALLOWANCE.perMin).toBeLessThan(FR24_REQUEST_BUCKET_PER_MIN / 2);
  });

  test("a person checking a handful of flights in a minute is never cut", () => {
    const budget = new LookupBudget();
    for (let i = 0; i < 6; i++) {
      expect(budget.take("api:p", SINGLE_ALLOWANCE, T0 + i * 10)).toBe(true);
      budget.settle("api:p", { asked: true });
    }
  });
});

describe("the share itself", () => {
  const one = { atOnce: 2, burst: 3, perMin: 6 };

  test("burst, then one every ten seconds", () => {
    const budget = new LookupBudget();
    const take = (at: number) => {
      const ok = budget.take("k", one, at);
      if (ok) budget.settle("k", { asked: true });
      return ok;
    };
    expect([take(T0), take(T0), take(T0), take(T0)]).toEqual([true, true, true, false]);
    expect(take(T0 + 9)).toBe(false);
    expect(take(T0 + 10)).toBe(true);
    expect(take(T0 + 10)).toBe(false);
    // A long quiet refills to the burst and no further.
    expect([1, 2, 3, 4].map(() => take(T0 + 3600))).toEqual([true, true, true, false]);
  });

  test("at most atOnce in hand; settling frees a hand", () => {
    const budget = new LookupBudget();
    expect(budget.take("k", one, T0)).toBe(true);
    expect(budget.take("k", one, T0)).toBe(true);
    expect(budget.take("k", one, T0)).toBe(false);
    budget.settle("k", { asked: true });
    expect(budget.take("k", one, T0)).toBe(true);
    // Settling more often than taken never opens a hand that was not there.
    for (let i = 0; i < 5; i++) budget.settle("k", { asked: false });
    expect(budget.take("k", one, T0)).toBe(true);
    expect(budget.take("k", one, T0)).toBe(true);
    expect(budget.take("k", one, T0)).toBe(false);
  });

  test("a lookup that never reports back does not lock its caller out for good", () => {
    const budget = new LookupBudget();
    expect(budget.take("k", one, T0)).toBe(true);
    expect(budget.take("k", one, T0)).toBe(true);
    expect(budget.take("k", one, T0 + LOOKUP_IN_HAND_MAX_SEC)).toBe(false);
    expect(budget.take("k", one, T0 + LOOKUP_IN_HAND_MAX_SEC + 1)).toBe(true);
    // And such a caller, once quiet, is swept like any other.
    const swept = new LookupBudget(2);
    swept.take("hung", one, T0);
    swept.take("other", one, T0 + 3600);
    expect(swept.size).toBe(1);
  });

  test("one caller's share is not another's", () => {
    const budget = new LookupBudget();
    for (let i = 0; i < 10; i++) budget.take("a", one, T0);
    expect(budget.take("b", one, T0)).toBe(true);
  });

  test("the map is bounded: idle callers are dropped, then the one that asked longest ago", () => {
    const budget = new LookupBudget(100);
    for (let i = 0; i < 100; i++) {
      budget.take(`idle${i}`, one, T0);
      budget.settle(`idle${i}`, { asked: false });
    }
    expect(budget.size).toBe(100);
    budget.take("new", one, T0 + 1);
    expect(budget.size).toBe(1);

    const busy = new LookupBudget(100);
    for (let i = 0; i < 5000; i++) busy.take(`busy${i}`, one, T0);
    expect(busy.size).toBe(100);
    // The newest are the ones kept, mid-budget; an evicted caller starts afresh.
    expect(busy.take("busy4999", one, T0)).toBe(true);
    expect(busy.take("busy4999", one, T0)).toBe(false);
    busy.settle("busy0", { asked: true });
    expect(busy.size).toBe(100);
  });
});

describe("tags", () => {
  const req = (headers: Record<string, string>, query = "") => {
    const url = new URL(
      `https://${HOST}/api/check-flight?flight_number=UA1&date=2030-01-01${query}`
    );
    return [new Request(url, { headers }), url] as const;
  };

  test("the caller tag holds five words", () => {
    expect(classifyLookupCaller(...req({ "user-agent": CHROME }, "&client=ext-2.2.0"))).toBe(
      "extension"
    );
    expect(
      classifyLookupCaller(...req({ "user-agent": CHROME, "sec-fetch-site": "same-origin" }))
    ).toBe("page");
    for (const headers of [
      { "user-agent": CHROME },
      { "user-agent": CHROME, "sec-fetch-site": "cross-site" },
      { "user-agent": CHROME, "sec-fetch-site": "none" },
    ]) {
      expect(classifyLookupCaller(...req(headers))).toBe("api");
    }
    for (const headers of [
      { "user-agent": CHROME, origin: "chrome-extension://someoneelsesextensionid" },
      { "user-agent": "curl/8.5.0", "sec-fetch-site": "same-origin" },
      { "user-agent": "Mozilla/5.0 (compatible; PageIndexer/1.0)" },
      {},
    ]) {
      expect(classifyLookupCaller(...req(headers))).toBe("other");
    }
    for (const raw of ["page", "api", "extension", "mcp", "other"]) {
      expect(normalizeLookupCaller(raw)).toBe(raw);
    }
    for (const raw of [null, undefined, "", "MCP", "mcp,env:prod", BATCH, "x".repeat(500)]) {
      expect(normalizeLookupCaller(raw)).toBe("other");
    }
  });

  test("the reason tag holds four words", () => {
    for (const raw of ["breaker", "bucket", "queue", "budget"]) {
      expect(normalizeLookupShedReason(raw)).toBe(raw);
    }
    for (const raw of [null, undefined, "", "Budget", "budget,env:prod", BATCH]) {
      expect(normalizeLookupShedReason(raw)).toBe("queue");
    }
  });

  test("PageIndexer is a scraper by its own name, whatever its version", () => {
    expect(classifyUserAgent("Mozilla/5.0 (compatible; PageIndexer/1.0)")).toBe("scraper");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; PageIndexer/2.3; +http://x)")).toBe(
      "scraper"
    );
    expect(classifyUserAgent("pageindexer")).toBe("scraper");
    // A browser is still a browser, and a word that only contains the name is not it.
    expect(classifyUserAgent(CHROME)).toBe("browser");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; MyPageIndexerPro/1.0)")).toBe("browser");
    expect(classifyUserAgent(`${"A".repeat(600)} PageIndexer/1.0`)).not.toBe("scraper");
  });
});
