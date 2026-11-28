/**
 * "Tell me if this changes": browser notices for one flight on one date.
 *
 * Seeded on fresh databases. What is pinned: with the switch off nothing is
 * queued or sent, no key is made, the subscribe addresses answer as the
 * static directory always did, and the dated page is the same page; with it
 * on, a browser on our own page is stored as its push endpoint, keys, flight,
 * date and leg alone; the aircraft log's writers (the flight updater and a
 * lookup's resolved legs) queue one notice for a first assignment and one for
 * a swap, never a second for the same state; the sender posts each once,
 * encrypted for that browser; a departed flight's subscriptions go, and so
 * does every subscription of a browser the push service calls gone.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { logResolvedAssignments } from "../src/database/assignment-log";
import { updateFlights } from "../src/database/database";
import {
  MAX_PER_ENDPOINT,
  NOTICE_SWITCH_KEY,
  sendFlightNotices,
} from "../src/database/flight-notice";
import { COUNTERS, metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { airportLocalDate } from "../src/utils/airport-tz";
import { b64url, fromB64url } from "../src/utils/web-push";
import { addFleet, addPlane, jsonIsland, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const OUR_PAGE = {
  "sec-fetch-site": "same-origin",
  "user-agent": BROWSER,
  "content-type": "application/json",
};
const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);
// Two days out at noon UTC: assigned, inside the feed's reach, not yet flown.
const DEP = Math.floor((now + 2 * 86400) / 86400) * 86400 + 12 * HOUR;
const DATE = airportLocalDate("DEN", DEP) as string;
const FN = "UA1492";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/test-browser-1";

let db: Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = makeFreshDb();
  app = createApp(db, { assetArchive: null });
});
afterEach(() => db.close());

const switchOn = () =>
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')").run(NOTICE_SWITCH_KEY);
const switchOff = () => db.query("DELETE FROM meta WHERE key = ?").run(NOTICE_SWITCH_KEY);

/** A browser's real push keys, with the private half to read what we send. */
async function browser() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, keys: { p256dh: b64url(p256dh), auth: b64url(auth) }, auth, p256dh };
}
type Browser = Awaited<ReturnType<typeof browser>>;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8)
  );
}

/** What the browser reads out of one aes128gcm body (RFC 8291, receiving side). */
async function open(b: Browser, body: Uint8Array): Promise<Record<string, string>> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const sealed = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, b.pair.privateKey, 256)
  );
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode("WebPush: info\0"), ...b.p256dh, ...asPublic]);
  const ikm = await hkdf(b.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, sealed)
  );
  expect(plain[plain.length - 1]).toBe(2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

/** A push service that records what it was sent and answers `status`. */
function pushService(status = 201) {
  const calls: Array<{ url: string; body: Uint8Array; headers: Record<string, string> }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: new Uint8Array(init?.body as Uint8Array),
      headers: init?.headers as Record<string, string>,
    });
    return new Response(null, { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const leg = (departure: number, from = "DEN", to = "SFO") => ({
  flight_number: FN,
  departure_airport: from,
  arrival_airport: to,
  departure_time: departure,
  arrival_time: departure + 2 * HOUR,
});

function seedPlanes() {
  addPlane(db, "N37502", "Starlink", { aircraft: "Boeing 737 MAX 8" });
  addFleet(db, "N37502", "confirmed", {
    aircraftType: "Boeing 737 MAX 8",
    verifiedWifi: "Starlink",
  });
  addPlane(db, "N77525", "Panasonic", { aircraft: "Boeing 737-800" });
  addFleet(db, "N77525", "negative", { aircraftType: "Boeing 737-800", verifiedWifi: "Panasonic" });
}

const subscribe = (
  b: Browser,
  extra: Record<string, unknown> = {},
  headers = OUR_PAGE,
  host = UA
) =>
  app.dispatch(
    req("/static/notice/subscribe", host, {
      method: "POST",
      headers,
      body: JSON.stringify({ endpoint: ENDPOINT, keys: b.keys, f: FN, d: DATE, ...extra }),
    })
  );

const subs = () =>
  db.query("SELECT * FROM flight_notice_subscriptions ORDER BY id").all() as Array<
    Record<string, unknown>
  >;

describe("with the switch off", () => {
  test("the dated page is the same page and carries no control", async () => {
    seedPlanes();
    updateFlights(db, "N37502", [leg(DEP)]);
    const page = async () => (await app.dispatch(req(`/check-flight/${FN}/${DATE}`, UA))).text();
    const off = await page();
    expect(off).toContain("Add this flight to your calendar");
    expect(off).not.toContain("flight-notice");
    expect(off).not.toContain("Tell me if this changes");
    expect(jsonIsland(off, "check-flight-config").noticeKey).toBeUndefined();
    // On, with a key, the control is there; off again, the page is byte for byte the first.
    switchOn();
    await sendFlightNotices(db, { fetch: pushService().fetch });
    const on = await page();
    expect(on).toContain('id="flight-notice"');
    expect(on).toContain("Tell me if this changes");
    switchOff();
    expect(await page()).toBe(off);
  });

  test("the notice addresses answer as the static directory always did", async () => {
    const b = await browser();
    const unknown = await app.dispatch(req("/static/no-such-file", UA));
    const unknownBody = await unknown.text();
    for (const path of ["/static/notice/sw.js", "/static/notice/subscribe"]) {
      const res = await app.dispatch(
        req(
          path,
          UA,
          path.endsWith("subscribe")
            ? {
                method: "POST",
                headers: OUR_PAGE,
                body: JSON.stringify({ endpoint: ENDPOINT, keys: b.keys, f: FN, d: DATE }),
              }
            : {}
        )
      );
      expect(res.status).toBe(unknown.status);
      expect(await res.text()).toBe(unknownBody);
    }
    expect(subs()).toEqual([]);
  });

  test("a stored change queues nothing, the sender posts nothing and makes no key", async () => {
    seedPlanes();
    switchOn();
    expect((await subscribe(await browser())).status).toBe(200);
    switchOff();
    updateFlights(db, "N37502", [leg(DEP)]);
    expect(subs()[0].pending).toBeNull();
    // Even a message left waiting while it was on stays unsent.
    db.query('UPDATE flight_notice_subscriptions SET pending = \'{"title":"x"}\'').run();
    const service = pushService();
    await sendFlightNotices(db, { fetch: service.fetch });
    expect(service.calls).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM flight_notice_keys").get()).toEqual({ n: 0 });
  });
});

describe("with the switch on", () => {
  beforeEach(() => {
    seedPlanes();
    switchOn();
  });

  test("subscribing stores the endpoint, keys, flight and date, and nothing about the visitor", async () => {
    const counted = spyOn(metrics, "increment");
    counted.mockClear();
    const b = await browser();
    const res = await subscribe(b, {}, {
      ...OUR_PAGE,
      "cf-connecting-ip": "203.0.113.7",
    } as typeof OUR_PAGE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [row] = subs();
    expect(Object.keys(row).sort()).toEqual(
      [
        "id",
        "endpoint",
        "p256dh",
        "auth",
        "airline",
        "flight_number",
        "dep_date",
        "origin",
        "told",
        "pending",
        "attempts",
        "created_at",
        "expires_at",
      ].sort()
    );
    expect(row).toMatchObject({
      endpoint: ENDPOINT,
      airline: "UA",
      flight_number: FN,
      dep_date: DATE,
    });
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
    expect(JSON.stringify(row)).not.toContain("Mozilla");
    const tags = counted.mock.calls.filter(([n]) => n === COUNTERS.FLIGHT_NOTICE).map(([, t]) => t);
    expect(tags).toEqual([{ airline: "united", action: "subscribed" }]);
    counted.mockRestore();
  });

  test("only a browser on our own page, for a flight this host serves, is stored", async () => {
    const b = await browser();
    expect((await subscribe(b, {}, { ...OUR_PAGE, "sec-fetch-site": "cross-site" })).status).toBe(
      403
    );
    expect((await subscribe(b, {}, { ...OUR_PAGE, "user-agent": "curl/8.0" })).status).toBe(403);
    expect((await subscribe(b, {}, OUR_PAGE, HUB)).status).toBe(403);
    expect((await subscribe(b, { endpoint: "https://evil.test/x" })).status).toBe(400);
    expect((await subscribe(b, { endpoint: "http://127.0.0.1/x" })).status).toBe(400);
    expect((await subscribe(b, { f: "AS100" })).status).toBe(400);
    expect((await subscribe(b, { f: "ua1492" })).status).toBe(400);
    expect((await subscribe(b, { d: "2020-01-01" })).status).toBe(400);
    expect((await subscribe(b, { keys: { p256dh: "x", auth: "y" } })).status).toBe(400);
    const huge = await app.dispatch(
      req("/static/notice/subscribe", UA, {
        method: "POST",
        headers: OUR_PAGE,
        body: "x".repeat(5000),
      })
    );
    expect(huge.status).toBe(400);
    expect(subs()).toEqual([]);
  });

  test("one browser follows a bounded number of flights", async () => {
    const b = await browser();
    for (let i = 0; i < MAX_PER_ENDPOINT; i++) {
      expect((await subscribe(b, { f: `UA${100 + i}` })).status).toBe(200);
    }
    expect((await subscribe(b, { f: "UA999" })).status).toBe(429);
    // The same flight again is an update, not one more.
    expect((await subscribe(b, { f: "UA100" })).status).toBe(200);
    expect(subs().length).toBe(MAX_PER_ENDPOINT);
  });

  test("first assignment, then a swap, each send one notice; the same plane again sends none", async () => {
    const b = await browser();
    await subscribe(b);
    const service = pushService();
    const send = () => sendFlightNotices(db, { fetch: service.fetch, nowSec: now });

    // The flight updater's write: first assignment.
    updateFlights(db, "N37502", [leg(DEP)]);
    await send();
    expect(service.calls.length).toBe(1);
    expect(service.calls[0].url).toBe(ENDPOINT);
    expect(service.calls[0].headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    const first = await open(b, service.calls[0].body);
    expect(first.title).toBe(`${FN} on ${DATE}: plane assigned`);
    expect(first.body).toContain("N37502");
    expect(first.body).toContain("It has Starlink.");
    expect(first.url).toBe(`/check-flight/${FN}/${DATE}`);

    // The next refresh stores the same plane: no second notice, however often.
    updateFlights(db, "N37502", [leg(DEP)]);
    updateFlights(db, "N37502", [leg(DEP)]);
    await send();
    await send();
    expect(service.calls.length).toBe(1);

    // A lookup's resolved legs name another plane, seen later: a swap.
    logResolvedAssignments(
      db,
      ["UA"],
      FN,
      [
        {
          tail_number: "N77525",
          origin: "DEN",
          destination: "SFO",
          departure_time: DEP,
          arrival_time: DEP + 2 * HOUR,
        },
      ],
      Math.floor(Date.now() / 1000) + 60
    );
    await send();
    expect(service.calls.length).toBe(2);
    const swap = await open(b, service.calls[1].body);
    expect(swap.title).toBe(`${FN} on ${DATE}: plane changed`);
    expect(swap.body).toContain("Plane changed from N37502 to N77525");
    expect(swap.body).toContain("It doesn't have Starlink.");
    await send();
    expect(service.calls.length).toBe(2);
  });

  test("a plane already assigned when the browser subscribes is no news", async () => {
    updateFlights(db, "N37502", [leg(DEP)]);
    await subscribe(await browser());
    const service = pushService();
    updateFlights(db, "N37502", [leg(DEP)]);
    await sendFlightNotices(db, { fetch: service.fetch, nowSec: now });
    expect(service.calls).toEqual([]);
  });

  test("a subscription for one leg hears nothing of the other", async () => {
    await subscribe(await browser(), { o: "SFO" });
    updateFlights(db, "N37502", [leg(DEP)]);
    expect(subs()[0].pending).toBeNull();
  });

  test("subscriptions go after departure, and all of a browser's on a 404 or 410", async () => {
    const b = await browser();
    await subscribe(b);
    await subscribe(b, { f: "UA200" });
    updateFlights(db, "N37502", [leg(DEP)]);
    const gone = pushService(410);
    await sendFlightNotices(db, { fetch: gone.fetch, nowSec: now });
    expect(gone.calls.length).toBe(1);
    expect(subs()).toEqual([]);

    await subscribe(b);
    expect(subs().length).toBe(1);
    // An hour past the logged departure the flight has left.
    const tally = await sendFlightNotices(db, { fetch: pushService().fetch, nowSec: DEP + HOUR });
    expect(tally.expired).toBe(1);
    expect(subs()).toEqual([]);
  });

  test("a push service that keeps failing gets five tries, then the message is dropped", async () => {
    await subscribe(await browser());
    updateFlights(db, "N37502", [leg(DEP)]);
    const failing = pushService(500);
    for (let i = 0; i < 7; i++) await sendFlightNotices(db, { fetch: failing.fetch, nowSec: now });
    expect(failing.calls.length).toBe(5);
    expect(subs()[0].pending).toBeNull();
  });

  test("unsubscribing removes that flight only", async () => {
    const b = await browser();
    await subscribe(b);
    await subscribe(b, { f: "UA200" });
    const res = await app.dispatch(
      req("/static/notice/unsubscribe", UA, {
        method: "POST",
        headers: OUR_PAGE,
        body: JSON.stringify({ endpoint: ENDPOINT, f: FN, d: DATE }),
      })
    );
    expect(res.status).toBe(200);
    expect(subs().map((s) => s.flight_number)).toEqual(["UA200"]);
  });

  test("the key pair lives in the database; only the public half reaches a page", async () => {
    await sendFlightNotices(db, { fetch: pushService().fetch });
    const row = db.query("SELECT public_key, private_jwk FROM flight_notice_keys").get() as {
      public_key: string;
      private_jwk: string;
    };
    expect(fromB64url(row.public_key).length).toBe(65);
    updateFlights(db, "N37502", [leg(DEP)]);
    const html = await (await app.dispatch(req(`/check-flight/${FN}/${DATE}`, UA))).text();
    expect(html).toContain(`data-notice-key="${row.public_key}"`);
    const d = (JSON.parse(row.private_jwk) as { d: string }).d;
    expect(html).not.toContain(d);
    const worker = await app.dispatch(req("/static/notice/sw.js", UA));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toContain("javascript");
    expect(await worker.text()).not.toContain(d);
  });
});
