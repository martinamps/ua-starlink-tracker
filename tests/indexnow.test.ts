/**
 * IndexNow: a newly listed tail leads to one capped submission of the pages
 * that changed, to a stand-in engine. Nothing here reaches a real endpoint:
 * every submitter is built with the stand-in's address.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import {
  AIRLINE_FACTS,
  type AirlineFactsEntry,
  ROLLOUT_TIMELINES,
  type RolloutTimeline,
} from "../src/airlines/rollout-facts";
import { COUNTERS, metrics } from "../src/observability/metrics";
import {
  DAILY_URL_CAP,
  FACT_PAGES_PER_PASS,
  FACT_TAIL_RESERVE,
  FLIGHT_DAILY_CAP,
  FLIGHT_PAGES_PER_PASS,
  type IndexNow,
  WAITING_MAX_AGE_SEC,
  WAITING_MAX_TAILS,
  announceFlightPages,
  createIndexNow,
  ensureIndexNowKey,
  factChangePages,
  factPrints,
  indexNowOn,
  pingIndexNow,
  readIndexNowKey,
} from "../src/scripts/indexnow";
import { createApp } from "../src/server/app";
import { addFleet, addPlane, makeFreshDb, openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const AS = SITES.alaska.canonicalHost;
const KEY_SHAPE = /^[A-Za-z0-9-]{8,128}$/;

interface Submission {
  host: string;
  key: string;
  urlList: string[];
  contentType: string | null;
}

let engine: ReturnType<typeof Bun.serve>;
let endpoint: string;
let received: Submission[] = [];
let answer: { status: number; headers?: Record<string, string>; delayMs?: number } = {
  status: 200,
};
/** Per-host answers that win over `answer`: one site failing, another not. */
let statusFor: Record<string, number> = {};

const counted: Array<Record<string, unknown>> = [];
const originalIncrement = metrics.increment;

beforeAll(() => {
  engine = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Omit<Submission, "contentType">;
      received.push({ ...body, contentType: request.headers.get("content-type") });
      if (answer.delayMs) await Bun.sleep(answer.delayMs);
      return new Response("", {
        status: statusFor[body.host] ?? answer.status,
        headers: answer.headers,
      });
    },
  });
  endpoint = `http://127.0.0.1:${engine.port}/indexnow`;
  metrics.increment = (name, tags) => {
    if (name === COUNTERS.VENDOR_REQUEST && tags?.vendor === "indexnow") counted.push({ ...tags });
  };
});

afterAll(() => {
  metrics.increment = originalIncrement;
  engine.stop(true);
});

let db: Database;
let app: ReturnType<typeof createApp>;
let key: string;
let clock: number;
let indexNow: IndexNow;

const minutes = (n: number) => {
  clock += n * 60_000;
};

/** A listed, observed United tail whose page serves and indexes. */
function listUnited(tail: string, aircraft = "Boeing 737-900") {
  addPlane(db, tail, "Starlink", { aircraft });
  addFleet(db, tail, "confirmed", { verifiedWifi: "Starlink", aircraftType: aircraft });
}

function build(overrides: Partial<Parameters<typeof createIndexNow>[0]> = {}) {
  return createIndexNow({
    db,
    key,
    dispatch: app.dispatch,
    endpoint,
    now: () => clock,
    timeoutMs: 2000,
    ...overrides,
  });
}

beforeEach(() => {
  received = [];
  counted.length = 0;
  answer = { status: 200 };
  statusFor = {};
  clock = Date.parse("2026-11-25T12:00:00Z");
  db = makeFreshDb();
  listUnited("N501GJ");
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date(clock).toISOString()
  );
  key = ensureIndexNowKey(db, {}) as string;
  app = createApp(db);
  indexNow = build();
});

afterEach(() => db.close());

const forHost = (host: string) => received.filter((s) => s.host === host);
const pathsFor = (host: string) =>
  forHost(host).flatMap((s) => s.urlList.map((u) => u.slice(`https://${host}`.length)));

describe("the key", () => {
  test("is made once, kept in the database, and has the protocol's shape", () => {
    expect(key).toMatch(KEY_SHAPE);
    expect(ensureIndexNowKey(db, {})).toBe(key);
    expect(readIndexNowKey(db, {})).toBe(key);
    const other = makeFreshDb();
    expect(ensureIndexNowKey(other, {})).not.toBe(key);
    other.close();
  });

  test("a deployment's own INDEXNOW_KEY wins, unless it is not a key", () => {
    expect(readIndexNowKey(db, { INDEXNOW_KEY: "abcdef0123456789" })).toBe("abcdef0123456789");
    for (const bad of [
      "short",
      "has space 12345",
      "../../etc/passwd",
      "a".repeat(129),
      "k<y>12345",
    ]) {
      expect(readIndexNowKey(db, { INDEXNOW_KEY: bad }), bad).toBe(key);
    }
  });

  test("an INDEXNOW_KEY of the wrong shape is warned about once, and never printed", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const cases: Array<[string, RegExp]> = [
        ["sh0rt", /shorter than 8/],
        ["a".repeat(129), /longer than 128/],
        ["k<y>12345_secret", /other than letters, digits and hyphens/],
        ["abcdef0123456789\n", /whitespace/],
      ];
      for (const [bad, cause] of cases) {
        lines.length = 0;
        expect(ensureIndexNowKey(db, { INDEXNOW_KEY: bad })).toBe(key);
        const warned = lines.filter((l) => l.includes("INDEXNOW_KEY"));
        expect(warned.length, bad).toBe(1);
        expect(JSON.parse(warned[0]).level).toBe("warn");
        expect(warned[0]).toMatch(cause);
        expect(warned[0]).toContain("falling back");
        expect(warned[0].includes(bad.trim()), bad).toBe(false);
        expect(warned[0].includes(key)).toBe(false);
      }
      lines.length = 0;
      expect(ensureIndexNowKey(db, { INDEXNOW_KEY: "abcdef0123456789" })).toBe("abcdef0123456789");
      expect(ensureIndexNowKey(db, {})).toBe(key);
      expect(ensureIndexNowKey(db, { INDEXNOW_KEY: "" })).toBe(key);
      expect(ensureIndexNowKey(db, { INDEXNOW_KEY: "short", INDEXNOW_DISABLED: "1" })).toBeNull();
      expect(lines.filter((l) => l.includes("INDEXNOW_KEY"))).toEqual([]);
    } finally {
      console.error = original;
    }
  });

  test("reading never writes: a readonly database with no key has none", () => {
    const snapshot = openSnapshot();
    expect(readIndexNowKey(snapshot, {})).toBeNull();
    snapshot.close();
  });

  test("the key file is served on every live site and matches the key", async () => {
    for (const host of [UA, HUB, AS]) {
      const res = await app.dispatch(req(`/${key}.txt`, host));
      expect(res.status, host).toBe(200);
      expect(res.headers.get("content-type"), host).toContain("text/plain");
      expect(await res.text(), host).toBe(key);
    }
  });

  test("no other address answers as a key file", async () => {
    for (const path of [`/${key}x.txt`, `/x${key}.txt`, `/${key}`, `/${key}.txt/`, "/.txt"]) {
      expect((await app.dispatch(req(path, UA))).status, path).toBe(404);
    }
  });

  test("the key is never a route metric tag", () => {
    expect(app.routeTags.filter((t) => t.includes(key))).toEqual([]);
    expect(Object.keys(app.routes).filter((r) => r.includes(key))).toEqual([]);
  });
});

describe("the switch", () => {
  const saved = process.env.INDEXNOW_DISABLED;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "INDEXNOW_DISABLED");
    else process.env.INDEXNOW_DISABLED = saved;
  });

  test("on only in production with jobs enabled", () => {
    expect(indexNowOn({ NODE_ENV: "production" })).toBe(true);
    expect(indexNowOn({})).toBe(false);
    expect(indexNowOn({ NODE_ENV: "development" })).toBe(false);
    expect(indexNowOn({ NODE_ENV: "test" })).toBe(false);
    expect(indexNowOn({ NODE_ENV: "production", DISABLE_JOBS: "1" })).toBe(false);
    expect(indexNowOn({ NODE_ENV: "production", INDEXNOW_DISABLED: "1" })).toBe(false);
  });

  test("off for 1 or true in any case; anything else leaves it on", () => {
    for (const value of ["1", "true", "TRUE", "True", " true ", " 1\n"]) {
      expect(indexNowOn({ NODE_ENV: "production", INDEXNOW_DISABLED: value }), value).toBe(false);
      expect(readIndexNowKey(db, { INDEXNOW_DISABLED: value }), value).toBeNull();
    }
    for (const value of ["", "0", "false", "no", "off", "11", "truthy"]) {
      expect(indexNowOn({ NODE_ENV: "production", INDEXNOW_DISABLED: value }), value).toBe(true);
    }
  });

  test("off: no key is made or read, and the key file is gone", async () => {
    const off = { NODE_ENV: "production", INDEXNOW_DISABLED: "1" };
    const fresh = makeFreshDb();
    expect(ensureIndexNowKey(fresh, off)).toBeNull();
    expect(readIndexNowKey(fresh, {})).toBeNull();
    fresh.close();
    expect(readIndexNowKey(db, off)).toBeNull();
    expect(readIndexNowKey(db, { ...off, INDEXNOW_KEY: "abcdef0123456789" })).toBeNull();

    process.env.INDEXNOW_DISABLED = "1";
    const offApp = createApp(db);
    expect((await offApp.dispatch(req(`/${key}.txt`, UA))).status).toBe(404);
  });

  test("this process never activated a submitter, so a ping sends nothing", async () => {
    pingIndexNow("UA", ["/", "/fleet"]);
    expect(await announceFlightPages("UA", ["UA1"])).toBe("noop");
    await Bun.sleep(50);
    expect(received).toEqual([]);
  });
});

describe("a newly listed tail", () => {
  test("the first look records the list and submits nothing", async () => {
    await indexNow.announceNewTails();
    expect(received).toEqual([]);
    expect(counted).toEqual([]);
  });

  test("leads to one submission per live site, of that site's changed pages", async () => {
    await indexNow.announceNewTails();
    listUnited("N502GJ");
    await indexNow.announceNewTails();

    expect(forHost(UA).length).toBe(1);
    expect(forHost(HUB).length).toBe(1);
    expect(received.length).toBe(2);
    for (const s of received) {
      expect(s.key).toBe(key);
      expect(s.contentType).toContain("application/json");
      expect(s.urlList.length).toBeGreaterThan(0);
      expect(s.urlList.length).toBeLessThan(10);
      for (const u of s.urlList) expect(u.startsWith(`https://${s.host}/`), u).toBe(true);
      expect(new Set(s.urlList).size).toBe(s.urlList.length);
    }
    const own = pathsFor(UA);
    expect(own).toContain("/");
    expect(own).toContain("/fleet");
    expect(own).toContain("/fleet/N502GJ");
    expect(own).toContain("/newly-equipped");
    expect(own).toContain("/feed.xml");
    // The tail that was already listed is not news.
    expect(own).not.toContain("/fleet/N501GJ");
    const hub = pathsFor(HUB);
    expect(hub).toContain("/");
    expect(hub.filter((p) => p.startsWith("/fleet/"))).toEqual([]);

    expect(counted.map((t) => t.status)).toEqual(["success", "success"]);
    for (const t of counted)
      expect(t).toEqual({ vendor: "indexnow", type: "ping", airline: "united", status: "success" });
  });

  test("every submitted address is one the site serves, 200 and indexable", async () => {
    await indexNow.announceNewTails();
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    for (const s of received) {
      for (const u of s.urlList) {
        const res = await app.dispatch(req(new URL(u).pathname, s.host));
        expect(res.status, u).toBe(200);
        expect(await res.text(), u).not.toMatch(/<meta name="robots" content="[^"]*noindex/);
      }
    }
  });

  test("is announced once: a second look sends nothing more", async () => {
    await indexNow.announceNewTails();
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    const after = received.length;
    minutes(30);
    await indexNow.announceNewTails();
    await indexNow.announceNewTails();
    expect(received.length).toBe(after);
  });

  test("a tail that leaves the list and returns is not news again", async () => {
    await indexNow.announceNewTails();
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    const after = received.length;
    db.query("DELETE FROM starlink_planes WHERE TailNumber = 'N502GJ'").run();
    minutes(30);
    await indexNow.announceNewTails();
    addPlane(db, "N502GJ", "Starlink");
    minutes(30);
    await indexNow.announceNewTails();
    expect(received.length).toBe(after);
  });

  test("a restart remembers what was announced and what was sent", async () => {
    await indexNow.announceNewTails();
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    const after = received.length;
    await build().announceNewTails();
    expect(received.length).toBe(after);
  });

  test("a bulk import names a few tail pages, not all of them", async () => {
    await indexNow.announceNewTails();
    for (let i = 0; i < 30; i++) listUnited(`N6${String(i).padStart(2, "0")}UA`);
    await indexNow.announceNewTails();
    expect(forHost(UA).length).toBe(1);
    expect(forHost(UA)[0].urlList.length).toBeLessThan(12);
  });
});

describe("a missed announcement is made up", () => {
  const tailPage = (tail: string) => `/fleet/${tail}`;
  const timesSent = (host: string, path: string) => pathsFor(host).filter((p) => p === path).length;
  const waitingTails = () =>
    (
      JSON.parse(
        (
          db.query("SELECT value FROM meta WHERE key = 'UA:indexnowWaiting'").get() as {
            value: string;
          } | null
        )?.value ?? "[]"
      ) as Array<{ tail: string }>
    ).map((w) => w.tail);
  /** Passes five minutes apart, as the job runs them. */
  async function passes(n: number, instance: IndexNow = indexNow) {
    for (let i = 0; i < n; i++) {
      minutes(5);
      await instance.announceNewTails();
    }
  }
  /** The most addresses `host` was sent inside any 24 hours. */
  function worstDay(host: string, sentAt: Array<[string, number]>): number {
    const times = sentAt.filter(([h]) => h === host).map(([, at]) => at);
    return Math.max(
      0,
      ...times.map((t) => times.filter((u) => u >= t && u < t + 86_400_000).length)
    );
  }

  test("first seen at the day's cap: sent whole once there is room, once", async () => {
    await indexNow.announceNewTails();
    const filler = Array.from({ length: DAILY_URL_CAP }, (_, i): [string, number] => [
      `https://${UA}/filler-${i}`,
      Math.floor(clock / 1000),
    ]);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('ALL:indexnowSent:united', ?)").run(
      JSON.stringify({ sent: filler })
    );
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    expect(forHost(UA)).toEqual([]);
    expect(forHost(HUB).length).toBe(1);
    expect(counted.map((t) => t.status)).toEqual(["shed", "success"]);
    expect(waitingTails()).toEqual(["N502GJ"]);

    // Still full an hour short of a day later.
    minutes(23 * 60 - 5);
    await passes(1);
    expect(forHost(UA)).toEqual([]);
    minutes(60);
    await passes(1);
    expect(forHost(UA).length).toBe(1);
    expect(pathsFor(UA)).toContain(tailPage("N502GJ"));
    expect(pathsFor(UA)).toContain("/fleet");
    expect(waitingTails()).toEqual([]);

    await passes(4);
    expect(timesSent(UA, tailPage("N502GJ"))).toBe(1);
    // The hub accepted it the first time and is not told again.
    expect(forHost(HUB).length).toBe(1);
  });

  test("an announcement that only half fits under the cap waits for all of it", async () => {
    await indexNow.announceNewTails();
    const filler = Array.from({ length: DAILY_URL_CAP - 2 }, (_, i): [string, number] => [
      `https://${UA}/filler-${i}`,
      Math.floor(clock / 1000),
    ]);
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('ALL:indexnowSent:united', ?)").run(
      JSON.stringify({ sent: filler })
    );
    listUnited("N502GJ");
    await passes(3);
    expect(forHost(UA)).toEqual([]);
    minutes(24 * 60);
    await passes(1);
    expect(forHost(UA).length).toBe(1);
    expect(pathsFor(UA)).toContain(tailPage("N502GJ"));
    expect(pathsFor(UA)).toContain("/");
  });

  test("first seen in a 429 pause: sent when the pause ends, once", async () => {
    await indexNow.announceNewTails();
    answer = { status: 429, headers: { "Retry-After": "7200" } };
    expect(await indexNow.submit("UA", ["/methodology"])).toBe("rate_limited");
    answer = { status: 200 };
    received = [];

    listUnited("N502GJ");
    await passes(12);
    expect(forHost(UA)).toEqual([]);
    expect(waitingTails()).toEqual(["N502GJ"]);
    await passes(13);
    expect(forHost(UA).length).toBe(1);
    expect(pathsFor(UA)).toContain(tailPage("N502GJ"));
    await passes(4);
    expect(timesSent(UA, tailPage("N502GJ"))).toBe(1);
    expect(forHost(HUB).length).toBe(1);
  });

  test("answered with a 429 itself: sent after the time the engine asked, once", async () => {
    await indexNow.announceNewTails();
    answer = { status: 429, headers: { "Retry-After": "1800" } };
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    expect(forHost(UA).length).toBe(1);
    expect(forHost(HUB).length).toBe(1);
    answer = { status: 200 };
    received = [];
    await passes(5);
    expect(received).toEqual([]);
    await passes(2);
    expect(forHost(UA).length).toBe(1);
    expect(forHost(HUB).length).toBe(1);
    expect(pathsFor(UA)).toContain(tailPage("N502GJ"));
    await passes(4);
    expect(received.length).toBe(2);
  });

  test("a failed send (refused, unreachable, timed out) is retried, once accepted never again", async () => {
    const failing: Array<[string, () => IndexNow]> = [
      ["500", () => build()],
      ["403", () => build()],
      ["unreachable", () => build({ endpoint: "http://127.0.0.1:1/indexnow" })],
      [
        "thrown",
        () =>
          build({
            fetch: (() => {
              throw new Error("boom");
            }) as unknown as typeof fetch,
          }),
      ],
      ["timeout", () => build({ timeoutMs: 50 })],
    ];
    await indexNow.announceNewTails();
    let n = 0;
    for (const [how, make] of failing) {
      const tail = `N51${n++}GJ`;
      received = [];
      answer =
        how === "500" || how === "403"
          ? { status: Number(how) }
          : how === "timeout"
            ? { status: 200, delayMs: 400 }
            : { status: 200 };
      listUnited(tail);
      minutes(7 * 60);
      await make().announceNewTails();
      expect(waitingTails(), how).toEqual([tail]);

      answer = { status: 200 };
      received = [];
      // Five minutes on the site is still backing off.
      await passes(1);
      expect(received, how).toEqual([]);
      await passes(1);
      expect(timesSent(UA, tailPage(tail)), how).toBe(1);
      expect(forHost(HUB).length, how).toBe(1);
      expect(waitingTails(), how).toEqual([]);
      await passes(4);
      expect(timesSent(UA, tailPage(tail)), how).toBe(1);
      expect(received.length, how).toBe(2);
    }
  });

  test("a restart between the miss and the retry loses nothing", async () => {
    await indexNow.announceNewTails();
    answer = { status: 500 };
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    expect(waitingTails()).toEqual(["N502GJ"]);
    answer = { status: 200 };
    received = [];

    const restarted = build();
    await passes(1, restarted);
    expect(received).toEqual([]);
    await passes(1, build());
    expect(timesSent(UA, tailPage("N502GJ"))).toBe(1);
    expect(forHost(HUB).length).toBe(1);
    await passes(4, build());
    expect(received.length).toBe(2);
  });

  test("one site accepted and the other failed: only the other is retried", async () => {
    await indexNow.announceNewTails();
    statusFor = { [HUB]: 500 };
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    expect(forHost(UA).length).toBe(1);
    expect(forHost(HUB).length).toBe(1);
    statusFor = {};
    await passes(4);
    minutes(7 * 60);
    await passes(2);
    expect(forHost(UA).length).toBe(1);
    expect(forHost(HUB).length).toBe(2);
    expect(waitingTails()).toEqual([]);
  });

  test("tails that pile up while sends fail go out together, oldest named first", async () => {
    await indexNow.announceNewTails();
    answer = { status: 500 };
    const tails = ["N521GJ", "N522GJ", "N523GJ", "N524GJ", "N525GJ", "N526GJ", "N527GJ"];
    for (const tail of tails) {
      listUnited(tail);
      await passes(1);
    }
    expect(waitingTails()).toEqual(tails);
    answer = { status: 200 };
    received = [];
    minutes(7 * 60);
    await passes(1);
    expect(forHost(UA).length).toBe(1);
    const named = pathsFor(UA).filter((p) => /^\/fleet\/N/.test(p));
    expect(named).toEqual(tails.slice(0, 5).map(tailPage));
    expect(waitingTails()).toEqual([]);
    await passes(4);
    expect(forHost(UA).length).toBe(1);
  });

  test("an outage of days stays inside the cap, backs off, and is made up after it", async () => {
    await indexNow.announceNewTails();
    answer = { status: 500 };
    const sentAt: Array<[string, number]> = [];
    listUnited("N502GJ");
    let seen = 0;
    for (let i = 0; i < 12 * 24 * 3; i++) {
      await passes(1);
      for (const s of received.slice(seen)) for (const _ of s.urlList) sentAt.push([s.host, clock]);
      seen = received.length;
    }
    for (const host of [UA, HUB]) {
      expect(worstDay(host, sentAt), host).toBeLessThanOrEqual(DAILY_URL_CAP);
      // Tries, not one per pass: 864 passes ran.
      expect(forHost(host).length, host).toBeLessThan(30);
      expect(forHost(host).length, host).toBeGreaterThan(3);
    }
    expect(waitingTails()).toEqual(["N502GJ"]);

    answer = { status: 200 };
    const before = received.length;
    minutes(24 * 60);
    await passes(2);
    const made = received.slice(before);
    expect(made.filter((s) => s.host === UA).length).toBe(1);
    expect(made.filter((s) => s.host === HUB).length).toBe(1);
    expect(made.find((s) => s.host === UA)?.urlList).toContain(`https://${UA}/fleet/N502GJ`);
    expect(waitingTails()).toEqual([]);
  });

  test("what waits is bounded: it falls off after the longest wait", async () => {
    await indexNow.announceNewTails();
    answer = { status: 500 };
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    expect(waitingTails()).toEqual(["N502GJ"]);
    clock += (WAITING_MAX_AGE_SEC - 600) * 1000;
    await indexNow.announceNewTails();
    expect(waitingTails()).toEqual(["N502GJ"]);
    clock += 601 * 1000;
    answer = { status: 200 };
    received = [];
    await indexNow.announceNewTails();
    expect(waitingTails()).toEqual([]);
    await passes(3);
    minutes(26 * 60);
    await passes(1);
    expect(received).toEqual([]);
  });

  test("what waits is bounded: past the most that may wait, the newest are not queued", async () => {
    await indexNow.announceNewTails();
    answer = { status: 500 };
    const first: string[] = [];
    for (let i = 0; i < WAITING_MAX_TAILS; i++) first.push(`N8${String(i).padStart(2, "0")}UA`);
    for (const tail of first) listUnited(tail);
    await indexNow.announceNewTails();
    for (let i = 0; i < 25; i++) listUnited(`N9${String(i).padStart(2, "0")}UA`);
    await passes(1);
    expect(waitingTails()).toEqual(first);
    answer = { status: 200 };
    received = [];
    minutes(7 * 60);
    await passes(1);
    expect(forHost(UA).length).toBe(1);
    expect(waitingTails()).toEqual([]);
    // The ones that fell off are not news later either.
    await passes(4);
    expect(forHost(UA).length).toBe(1);
  });

  test("a waiting tail that is off the list keeps waiting and goes out when it is back", async () => {
    await indexNow.announceNewTails();
    answer = { status: 500 };
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    answer = { status: 200 };
    received = [];
    db.query("DELETE FROM starlink_planes WHERE TailNumber = 'N502GJ'").run();
    await passes(12);
    expect(received).toEqual([]);
    expect(waitingTails()).toEqual(["N502GJ"]);
    addPlane(db, "N502GJ", "Starlink", { aircraft: "Boeing 737-900" });
    await passes(1);
    expect(timesSent(UA, tailPage("N502GJ"))).toBe(1);
    await passes(4);
    expect(timesSent(UA, tailPage("N502GJ"))).toBe(1);
  });

  test("the first pass sends nothing for tails already listed, whatever the engine answers", async () => {
    for (const status of [200, 429, 500]) {
      const fresh = makeFreshDb();
      for (const tail of ["N501GJ", "N502GJ", "N503GJ"]) {
        addPlane(fresh, tail, "Starlink", { aircraft: "Boeing 737-900" });
        addFleet(fresh, tail, "confirmed", {
          verifiedWifi: "Starlink",
          aircraftType: "Boeing 737-900",
        });
      }
      answer = { status };
      received = [];
      counted.length = 0;
      const local = createIndexNow({
        db: fresh,
        key,
        dispatch: createApp(fresh).dispatch,
        endpoint,
        now: () => clock,
      });
      await local.announceNewTails();
      answer = { status: 200 };
      for (const wait of [5, 5, 10, 60, 7 * 60, 26 * 60]) {
        minutes(wait);
        await local.announceNewTails();
      }
      expect(received, String(status)).toEqual([]);
      expect(counted, String(status)).toEqual([]);
      expect(
        fresh.query("SELECT value FROM meta WHERE key LIKE '%indexnowWaiting'").all(),
        String(status)
      ).toEqual([]);
      fresh.close();
    }
  });

  test("a list recorded by the earlier job is kept: nothing on it is sent after a deploy", async () => {
    listUnited("N502GJ");
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('UA:indexnowAnnounced', ?)").run(
      JSON.stringify(["N501GJ", "N502GJ"])
    );
    await passes(3);
    expect(received).toEqual([]);
    listUnited("N503GJ");
    await passes(1);
    expect(pathsFor(UA)).toContain(tailPage("N503GJ"));
    expect(pathsFor(UA)).not.toContain(tailPage("N502GJ"));
  });

  test("a broken waiting list in the database is survived", async () => {
    await indexNow.announceNewTails();
    for (const junk of [
      "{not json",
      '{"a":1}',
      '[null, 3, {"tail":5}, {"tail":"N1","at":"x","sites":["united"]}, {"tail":"<script>","at":1,"sites":"united"}]',
      JSON.stringify([
        { tail: "../../api/data", at: Math.floor(clock / 1000), sites: ["united", "nowhere"] },
      ]),
    ]) {
      db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('UA:indexnowWaiting', ?)").run(
        junk
      );
      minutes(15);
      await indexNow.announceNewTails();
    }
    for (const s of received) {
      for (const u of s.urlList) expect(u, u).not.toMatch(/api|script|\.\./);
    }
    listUnited("N502GJ");
    await passes(3);
    expect(timesSent(UA, tailPage("N502GJ"))).toBe(1);
  });
});

describe("the daily cap", () => {
  test("a site never sends more than the cap in 24 hours, then sends again", async () => {
    await indexNow.announceNewTails();
    for (let i = 0; i < 40; i++) {
      listUnited(`N7${String(i).padStart(2, "0")}UA`);
      minutes(15);
      await indexNow.announceNewTails();
    }
    const sent = (host: string) => forHost(host).reduce((n, s) => n + s.urlList.length, 0);
    expect(sent(UA)).toBe(DAILY_URL_CAP);
    expect(sent(HUB)).toBeLessThanOrEqual(DAILY_URL_CAP);
    expect(counted.some((t) => t.status === "shed")).toBe(true);

    const before = sent(UA);
    minutes(25 * 60);
    listUnited("N799UA");
    await indexNow.announceNewTails();
    expect(sent(UA)).toBeGreaterThan(before);
  });

  test("the same address is not sent twice within ten minutes", async () => {
    expect(await indexNow.submit("UA", ["/", "/fleet"])).toBe("success");
    minutes(5);
    expect(await indexNow.submit("UA", ["/", "/fleet"])).toBe("noop");
    minutes(6);
    expect(await indexNow.submit("UA", ["/"])).toBe("success");
    expect(received.map((s) => s.urlList.length)).toEqual([2, 1]);
  });
});

describe("hostile and odd input", () => {
  test("a tail with strange characters never becomes an address", async () => {
    await indexNow.announceNewTails();
    const strange = [
      'N1"><script>alert(1)</script>',
      "N12/../../admin",
      "/evil.example/x",
      "N1 2",
      "N12\nHost: evil.example",
      "N12?x=1",
      "N12#frag",
      "@evil.example",
      "N1%2F..%2F",
      "",
      "N".repeat(5000),
    ];
    for (const tail of strange) addPlane(db, tail, "Starlink");
    listUnited("N502GJ");
    await indexNow.announceNewTails();

    const all = received.flatMap((s) => s.urlList.map((u) => ({ u, host: s.host })));
    expect(all.length).toBeGreaterThan(0);
    for (const { u, host } of all) {
      expect(new URL(u).host, u).toBe(host);
      expect(u, u).not.toMatch(/evil|script|admin|%2F|\s|\?|#|\.\./i);
    }
    expect(pathsFor(UA)).toContain("/fleet/N502GJ");
    expect(pathsFor(UA).filter((p) => p.startsWith("/fleet/N")).length).toBe(1);
  });

  test("a caller's path cannot leave the site or carry a query", async () => {
    const status = await indexNow.submit("UA", [
      "//evil.example/",
      "https://evil.example/",
      "\\\\evil.example\\x",
      "/\\evil.example",
      "fleet",
      "/fleet?utm=1",
      "/fleet#x",
      "/fleet\r\nX: y",
      "/fleet",
    ]);
    expect(status).toBe("success");
    expect(received.length).toBe(1);
    expect(received[0].urlList).toEqual([`https://${UA}/fleet`]);
  });

  test("a page that 404s or is kept out of the index is not submitted", async () => {
    // On the roster, never read: its page serves but is noindex.
    addFleet(db, "N5NEW", "unknown", { verifiedAt: null });
    expect(await indexNow.submit("UA", ["/fleet/N5NEW", "/fleet/N999ZZ", "/no-such-page"])).toBe(
      "noop"
    );
    expect(received).toEqual([]);
  });

  test("a site that is not live is never submitted for", async () => {
    expect(SITES.hawaiian.live).toBe(false);
    expect(SITES.qatar.live).toBe(false);
    await indexNow.announceNewTails();
    addPlane(db, "N380HA", "Starlink", { airline: "HA", aircraft: "Airbus A330-200" });
    addPlane(db, "A7-BEA", "Starlink", { airline: "QR", aircraft: "Boeing 777-300ER" });
    await indexNow.announceNewTails();
    expect(await indexNow.submit("HA", ["/", "/fleet"])).toBe("noop");
    expect(await indexNow.submit("QR", ["/"])).toBe("noop");
    expect(await indexNow.submit("ZZ", ["/"])).toBe("noop");
    const hosts = new Set(received.map((s) => s.host));
    expect(hosts.has(SITES.hawaiian.canonicalHost)).toBe(false);
    expect(hosts.has(SITES.qatar.canonicalHost)).toBe(false);
    for (const host of hosts) expect([UA, HUB, AS]).toContain(host);
  });

  test("a refusal is counted, logged, and not retried by the caller", async () => {
    for (const status of [400, 403, 422, 500]) {
      received = [];
      counted.length = 0;
      answer = { status };
      // Past the longest pause a run of failures can set.
      minutes(7 * 60);
      expect(await indexNow.submit("UA", ["/"]), String(status)).toBe("error");
      expect(received.length, String(status)).toBe(1);
      expect(counted.map((t) => t.status)).toEqual(["error"]);
    }
  });

  test("a 429 quiets the site for as long as the engine asked", async () => {
    answer = { status: 429, headers: { "Retry-After": "7200" } };
    expect(await indexNow.submit("UA", ["/"])).toBe("rate_limited");
    answer = { status: 200 };
    minutes(60);
    expect(await indexNow.submit("UA", ["/fleet"])).toBe("shed");
    // Another site is not paused by it.
    expect(await indexNow.submit("AS", ["/"])).toBe("success");
    minutes(61);
    expect(await indexNow.submit("UA", ["/fleet"])).toBe("success");
    expect(forHost(UA).length).toBe(2);
    expect(counted.map((t) => t.status)).toEqual(["rate_limited", "shed", "success", "success"]);
  });

  test("a 429 with a strange Retry-After still pauses, within bounds", async () => {
    for (const header of ["soon", "-5", "99999999999", ""]) {
      const fresh = makeFreshDb();
      const local = createIndexNow({
        db: fresh,
        key,
        dispatch: app.dispatch,
        endpoint,
        now: () => clock,
      });
      answer = { status: 429, headers: header ? { "Retry-After": header } : {} };
      expect(await local.submit("UA", ["/"]), header).toBe("rate_limited");
      answer = { status: 200 };
      minutes(9);
      expect(await local.submit("UA", ["/fleet"]), header).toBe("shed");
      minutes(24 * 60 + 1);
      expect(await local.submit("UA", ["/fleet"]), header).toBe("success");
      fresh.close();
    }
  });

  test("a slow answer is abandoned at the deadline", async () => {
    answer = { status: 200, delayMs: 1500 };
    const hurried = build({ timeoutMs: 100 });
    const started = Date.now();
    expect(await hurried.submit("UA", ["/"])).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1200);
    expect(counted.map((t) => t.status)).toEqual(["timeout"]);
  });

  test("an engine that cannot be reached changes nothing for the caller", async () => {
    const unreachable = build({ endpoint: "http://127.0.0.1:1/indexnow" });
    expect(await unreachable.submit("UA", ["/"])).toBe("error");
    const throwing = build({
      fetch: (() => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
    });
    minutes(15);
    expect(await throwing.submit("UA", ["/"])).toBe("error");
    await indexNow.announceNewTails();
  });

  test("a broken ledger or announced list in the database is survived", async () => {
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('ALL:indexnowSent:united', ?)").run(
      '{"sent":"nope","pausedUntil":"x"'
    );
    expect(await indexNow.submit("UA", ["/"])).toBe("success");
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('UA:indexnowAnnounced', ?)").run(
      "{not json"
    );
    const before = received.length;
    await indexNow.announceNewTails();
    expect(received.length).toBe(before);
  });

  test("a page handler that throws or hangs is treated as not served", async () => {
    const broken = build({
      dispatch: () => {
        throw new Error("render failed");
      },
    });
    expect(await broken.submit("UA", ["/"])).toBe("noop");
    expect(received).toEqual([]);
  });
});

describe("a changed rollout fact", () => {
  // The facts and timelines the submitter sees: copies of the deployed ones,
  // which a test edits the way a deploy would.
  let facts: AirlineFactsEntry[];
  let timelines: Partial<Record<string, RolloutTimeline>>;
  let factsNow: IndexNow;

  const entry = (slug: string) => facts.find((e) => e.slug === slug) as AirlineFactsEntry;
  const addDated = (slug: string, extra: Partial<AirlineFactsEntry["facts"][number]> = {}) =>
    entry(slug).facts.push({
      fact: `A new dated fact for ${slug}.`,
      asOf: "2026-11-26",
      source: { label: "Test", url: `https://example.com/${slug}` },
      ...extra,
    } as AirlineFactsEntry["facts"][number]);

  beforeEach(() => {
    facts = structuredClone(AIRLINE_FACTS);
    timelines = structuredClone(ROLLOUT_TIMELINES);
    factsNow = build({ facts: () => facts, timelines: () => timelines });
  });

  test("the first look records the facts and submits nothing", async () => {
    await factsNow.announceFactChanges();
    minutes(10);
    await factsNow.announceFactChanges();
    expect(received).toEqual([]);
    expect(counted).toEqual([]);
  });

  test("an added dated fact announces the hub timeline and that airline's page, once", async () => {
    await factsNow.announceFactChanges();
    addDated("emirates");
    await factsNow.announceFactChanges();

    expect(received.length).toBe(1);
    expect(pathsFor(HUB)).toEqual(["/timeline", "/airlines/emirates"]);
    expect(counted).toEqual([
      { vendor: "indexnow", type: "fact", airline: "all", status: "success" },
    ]);

    minutes(30);
    await factsNow.announceFactChanges();
    await factsNow.announceFactChanges();
    expect(received.length).toBe(1);
  });

  test("an undated fact changes the airline page, not the timeline", async () => {
    await factsNow.announceFactChanges();
    entry("lufthansa").facts.push({
      fact: "A checked fact.",
      accessed: "2026-11-26",
      source: { label: "Test", url: "https://example.com/lh" },
    });
    await factsNow.announceFactChanges();
    expect(pathsFor(HUB)).toEqual(["/airlines/lufthansa"]);
  });

  test("re-reading an undated source (only accessed moves) is not news", async () => {
    const checked = facts.flatMap((e) => e.facts).find((f) => f.accessed);
    expect(checked).toBeDefined();
    await factsNow.announceFactChanges();
    (checked as { accessed: string }).accessed = "2099-01-01";
    await factsNow.announceFactChanges();
    expect(received).toEqual([]);
  });

  test("a replaced fact announces the type pages it left and the one that replaced it", async () => {
    // Enough 737-900s that the type page serves.
    for (let i = 0; i < 6; i++) listUnited(`N4${i}0UA`);
    await factsNow.announceFactChanges();
    const united = entry("united");
    const current = united.facts.find((f) => !f.superseded && f.aircraftPages?.includes("*"));
    expect(current).toBeDefined();
    (current as { superseded?: true }).superseded = true;
    addDated("united", { aircraftPages: ["737-900"] });
    await factsNow.announceFactChanges();

    const own = pathsFor(UA);
    expect(own).toContain("/fleet/737-900");
    for (const p of own) expect(p.startsWith("/fleet/"), p).toBe(true);
    // United's hub page is kept out of the index (its own site is live), so
    // only the timeline goes out there.
    expect(pathsFor(HUB)).toEqual(["/timeline"]);
    for (const t of counted) expect(t.type).toBe("fact");
    expect(counted.find((t) => t.airline === "united")?.status).toBe("success");
  });

  test("a new milestone on an airline's own timeline announces that site's /timeline", async () => {
    await factsNow.announceFactChanges();
    timelines.UA?.milestones.push({
      date: "2026-11-26",
      title: "A test milestone",
      fact: "Something happened.",
      source: { label: "Test", url: "https://example.com/m", published: "2026-11-26" },
    });
    await factsNow.announceFactChanges();
    expect(pathsFor(UA)).toEqual(["/timeline"]);
    expect(forHost(HUB)).toEqual([]);
  });

  test("which pages a change touches: hub, type pages, and every type page for '*'", () => {
    const before = factPrints(facts, timelines);
    addDated("united", { aircraftPages: ["*"] });
    addDated("iag");
    const pages = factChangePages(before, factPrints(facts, timelines));
    const hub = pages.get("ALL") ?? [];
    expect(hub[0]).toBe("/timeline");
    expect([...hub].sort()).toEqual(["/airlines/iag", "/airlines/united", "/timeline"]);
    const own = pages.get("UA") ?? [];
    expect(own.length).toBeGreaterThan(5);
    for (const p of own) expect(p).toMatch(/^\/fleet\/[a-z0-9-]+$/);
    expect(factChangePages(before, before).size).toBe(0);
  });

  test("a removed airline is a change to the hub timeline", async () => {
    await factsNow.announceFactChanges();
    facts = facts.filter((e) => e.slug !== "emirates");
    await factsNow.announceFactChanges();
    // Its own page would 404 after such a deploy, and the self-check drops
    // it; here the app still serves the deployed facts, so only the timeline
    // is pinned.
    expect(pathsFor(HUB)[0]).toBe("/timeline");
  });

  test("a deploy that touches many airlines goes out a few pages a pass, each once", async () => {
    await factsNow.announceFactChanges();
    const untracked = facts.filter((e) => !e.trackedCode).slice(0, 15);
    for (const e of untracked) addDated(e.slug);
    for (let i = 0; i < 4; i++) {
      await factsNow.announceFactChanges();
      minutes(10);
    }
    for (const s of received) expect(s.urlList.length).toBeLessThanOrEqual(FACT_PAGES_PER_PASS);
    const hub = pathsFor(HUB);
    expect(new Set(hub).size).toBe(hub.length);
    expect(hub[0]).toBe("/timeline");
    for (const e of untracked) expect(hub).toContain(`/airlines/${e.slug}`);
  });

  test("fact sends leave the tails their share of the daily cap", async () => {
    await factsNow.announceFactChanges();
    for (const e of facts.filter((e) => !e.trackedCode)) addDated(e.slug);
    for (let i = 0; i < 12; i++) {
      await factsNow.announceFactChanges();
      minutes(10);
    }
    const sent = forHost(HUB).reduce((n, s) => n + s.urlList.length, 0);
    expect(sent).toBeLessThanOrEqual(DAILY_URL_CAP - FACT_TAIL_RESERVE);
    expect(counted.some((t) => t.status === "shed")).toBe(true);

    // A new tail still gets the hub's room the same day.
    await indexNow.announceNewTails();
    listUnited("N502GJ");
    await indexNow.announceNewTails();
    expect(counted.filter((t) => t.type === "ping").map((t) => t.status)).toEqual([
      "success",
      "success",
    ]);

    // The rest waits, and goes out once the day has passed.
    minutes(25 * 60);
    await factsNow.announceFactChanges();
    expect(forHost(HUB).reduce((n, s) => n + s.urlList.length, 0)).toBeGreaterThan(sent);
  });

  test("a failed send is retried, and once accepted never again", async () => {
    await factsNow.announceFactChanges();
    addDated("emirates");
    answer = { status: 500 };
    await factsNow.announceFactChanges();
    expect(received.length).toBe(1);
    answer = { status: 200 };
    minutes(5);
    await factsNow.announceFactChanges();
    expect(received.length).toBe(1);
    minutes(10);
    // A restart in between: a new submitter on the same database.
    const restarted = build({ facts: () => facts, timelines: () => timelines });
    await restarted.announceFactChanges();
    expect(received.length).toBe(2);
    expect(received[1].urlList.map((u) => u.slice(`https://${HUB}`.length))).toEqual([
      "/timeline",
      "/airlines/emirates",
    ]);
    minutes(30);
    await restarted.announceFactChanges();
    expect(received.length).toBe(2);
  });

  test("a waiting change falls off after the longest wait", async () => {
    await factsNow.announceFactChanges();
    addDated("emirates");
    answer = { status: 403 };
    await factsNow.announceFactChanges();
    minutes(8 * 24 * 60);
    answer = { status: 200 };
    await factsNow.announceFactChanges();
    expect(received.length).toBe(1);
  });

  test("broken records in the database are survived: it records again, sends nothing", async () => {
    await factsNow.announceFactChanges();
    db.query("UPDATE meta SET value = '{not json' WHERE key LIKE 'ALL:indexnowFacts%'").run();
    addDated("emirates");
    await factsNow.announceFactChanges();
    expect(received).toEqual([]);
    addDated("lufthansa");
    await factsNow.announceFactChanges();
    expect(pathsFor(HUB)).toEqual(["/timeline", "/airlines/lufthansa"]);
  });

  test("the deployed facts are what an unconfigured submitter reads", async () => {
    await indexNow.announceFactChanges();
    await indexNow.announceFactChanges();
    expect(received).toEqual([]);
    const stored = db.query("SELECT value FROM meta WHERE key = 'ALL:indexnowFacts'").get() as {
      value: string;
    } | null;
    expect(Object.keys(JSON.parse(stored?.value ?? "{}"))).toContain("facts:UA:united");
  });
});

describe("a flight page whose answer turned", () => {
  /** Every page serves 200 and indexes: what is under test is the choosing,
   * the cap and the gap, not which flight pages the fresh database has. */
  const servesAll = () =>
    build({
      dispatch: async () =>
        new Response("<html><head></head></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
  const flights = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `UA${from + i + 1}`);

  test("sends that flight's own page on the airline's site, counted as a flight send", async () => {
    const inx = servesAll();
    expect(await inx.announceFlightChanges("UA", ["UA123", "UA5212"])).toBe("success");
    expect(received.length).toBe(1);
    expect(received[0].host).toBe(UA);
    expect(received[0].key).toBe(key);
    expect(pathsFor(UA)).toEqual(["/check-flight/UA123", "/check-flight/UA5212"]);
    expect(counted.map((t) => [t.type, t.status])).toEqual([["flight", "success"]]);
  });

  test("nothing turned, nothing sent", async () => {
    const inx = servesAll();
    expect(await inx.announceFlightChanges("UA", [])).toBe("noop");
    expect(received).toEqual([]);
    expect(counted).toEqual([]);
  });

  test("a page is sent at most once a day, however often its answer turns", async () => {
    const inx = servesAll();
    expect(await inx.announceFlightChanges("UA", ["UA1"])).toBe("success");
    for (let h = 1; h < 24; h++) {
      minutes(60);
      expect(await inx.announceFlightChanges("UA", ["UA1"])).toBe("noop");
    }
    minutes(61);
    expect(await inx.announceFlightChanges("UA", ["UA1"])).toBe("success");
    expect(received.map((s) => s.urlList.length)).toEqual([1, 1]);
  });

  /** One watcher pass an hour for `hours`, each handing over `perPass` new
   * turned flights; returns how many pages were sent. */
  async function hourly(inx: IndexNow, hours: number, perPass: number, start: number) {
    let n = start;
    for (let h = 0; h < hours; h++) {
      await inx.announceFlightChanges("UA", flights(perPass, n));
      n += perPass;
      minutes(60);
    }
    return n;
  }
  const sentTo = (host: string) => forHost(host).reduce((n, s) => n + s.urlList.length, 0);

  test("one pass sends a few pages, most telling first, and keeps none of the rest", async () => {
    const inx = servesAll();
    const turned = flights(40);
    expect(await inx.announceFlightChanges("UA", turned)).toBe("success");
    expect(pathsFor(UA)).toEqual(
      turned.slice(0, FLIGHT_PAGES_PER_PASS).map((fn) => `/check-flight/${fn}`)
    );
    // Not queued: the next pass, with nothing newly turned, sends nothing.
    minutes(60);
    expect(await inx.announceFlightChanges("UA", [])).toBe("noop");
    expect(sentTo(UA)).toBe(FLIGHT_PAGES_PER_PASS);
  });

  test("a site never sends more flight pages than the cap in 24 hours, then sends again", async () => {
    const inx = servesAll();
    const next = await hourly(inx, 24, 40, 0);
    expect(sentTo(UA)).toBeLessThanOrEqual(FLIGHT_DAILY_CAP);
    expect(sentTo(UA)).toBeGreaterThan(0);
    // Spread through the day: no send is larger than one pass's share.
    for (const s of forHost(UA))
      expect(s.urlList.length).toBeLessThanOrEqual(FLIGHT_PAGES_PER_PASS);
    expect(counted.some((t) => t.type === "flight" && t.status === "shed")).toBe(true);
    const before = sentTo(UA);
    minutes(24 * 60);
    expect(await inx.announceFlightChanges("UA", flights(3, next))).toBe("success");
    expect(sentTo(UA)).toBe(before + 3);
  });

  test("flight sends leave the tails' and facts' daily room untouched", async () => {
    const inx = servesAll();
    await indexNow.announceNewTails();
    await hourly(inx, 24, 40, 0);
    listUnited("N777UA");
    await indexNow.announceNewTails();
    const tailSends = forHost(UA).filter((s) => s.urlList.some((u) => u.endsWith("/fleet/N777UA")));
    expect(tailSends.length).toBe(1);
    // And the other way: a day's full main ledger does not stop flights.
    for (let i = 0; i < DAILY_URL_CAP; i++) await indexNow.submit("UA", [`/fleet/N${i}X`]);
    minutes(24 * 60 + 1);
    expect(await inx.announceFlightChanges("UA", ["UA4242"])).toBe("success");
  });

  test("only pages the site serves, 200 and indexable, are sent", async () => {
    // The fresh database knows none of these flights, and a known flight's
    // page is checked with the app's own dispatch.
    const r = await indexNow.announceFlightChanges("UA", ["UA99999", "XX1"]);
    expect(["noop", "success"]).toContain(r);
    for (const u of received.flatMap((s) => s.urlList)) {
      const res = await app.dispatch(new Request(u, { headers: { host: UA } }));
      expect(res.status).toBe(200);
    }
  });

  test("a flight number that is other people's text never leaves the flight path", async () => {
    const inx = servesAll();
    await inx.announceFlightChanges("UA", [
      "../../fleet",
      "UA1?x=1",
      "UA1#a",
      "//evil.example/x",
      "UA 1",
      "UA1\\..",
    ]);
    for (const u of received.flatMap((s) => s.urlList)) {
      const url = new URL(u);
      expect(url.host).toBe(UA);
      expect(url.pathname.startsWith("/check-flight/")).toBe(true);
      expect(url.pathname.slice("/check-flight/".length)).not.toContain("/");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
  });

  test("a site that is not live, or not ours, is never sent for", async () => {
    const inx = servesAll();
    expect(await inx.announceFlightChanges("HA", ["HA50"])).toBe("noop");
    expect(await inx.announceFlightChanges("ZZ", ["ZZ1"])).toBe("noop");
    expect(received).toEqual([]);
  });

  test("a paused site sheds flight pages without sending, and does not keep them", async () => {
    const inx = servesAll();
    answer = { status: 429, headers: { "retry-after": "3600" } };
    expect(await indexNow.submit("UA", ["/"])).toBe("rate_limited");
    received = [];
    counted.length = 0;
    expect(await inx.announceFlightChanges("UA", ["UA1"])).toBe("shed");
    expect(received).toEqual([]);
    expect(counted.map((t) => t.status)).toEqual(["shed"]);
    answer = { status: 200 };
    minutes(61);
    expect(await inx.announceFlightChanges("UA", [])).toBe("noop");
    expect(received).toEqual([]);
  });

  test("a failed flight send is logged once, backs the site off, and is not retried", async () => {
    const inx = servesAll();
    answer = { status: 500 };
    expect(await inx.announceFlightChanges("UA", ["UA1", "UA2"])).toBe("error");
    expect(received.length).toBe(1);
    // The site is quiet for every kind of send now.
    expect(await indexNow.submit("UA", ["/"])).toBe("shed");
    answer = { status: 200 };
    minutes(11);
    // Its places were spent: the same pages are not resent that day.
    expect(await inx.announceFlightChanges("UA", ["UA1", "UA2"])).toBe("noop");
    expect(received.length).toBe(1);
  });

  test("an engine that cannot be reached changes nothing for the caller", async () => {
    const inx = build({
      endpoint: "http://127.0.0.1:1/indexnow",
      dispatch: async () =>
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(["error", "timeout"]).toContain(await inx.announceFlightChanges("UA", ["UA1"]));
  });

  test("a broken flight ledger in the database is survived", async () => {
    const inx = servesAll();
    db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      `ALL:indexnowFlightSent:${SITES.united.key}`,
      "{not json"
    );
    expect(await inx.announceFlightChanges("UA", ["UA1"])).toBe("success");
  });
});
