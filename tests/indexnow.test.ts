/**
 * IndexNow: a newly listed tail leads to one capped submission of the pages
 * that changed, to a stand-in engine. Nothing here reaches a real endpoint:
 * every submitter is built with the stand-in's address.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { COUNTERS, metrics } from "../src/observability/metrics";
import {
  DAILY_URL_CAP,
  type IndexNow,
  createIndexNow,
  ensureIndexNowKey,
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

const counted: Array<Record<string, unknown>> = [];
const originalIncrement = metrics.increment;

beforeAll(() => {
  engine = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Omit<Submission, "contentType">;
      received.push({ ...body, contentType: request.headers.get("content-type") });
      if (answer.delayMs) await Bun.sleep(answer.delayMs);
      return new Response("", { status: answer.status, headers: answer.headers });
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

  test("a refusal is counted, logged, and not retried", async () => {
    for (const status of [400, 403, 422, 500]) {
      received = [];
      counted.length = 0;
      answer = { status };
      minutes(15);
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
