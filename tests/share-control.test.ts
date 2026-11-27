/**
 * The share control on a flight answer, and its count.
 *
 * Seeded on a fresh database. What is pinned: every verdict's card carries
 * exactly one control whose address is the answer's own page (canonical host,
 * date and leg kept); an answer with nothing to pass on carries none; a tap is
 * counted as one fixed word and the site, only for a browser calling from our
 * own page, and adds no value to the `route` tag; and the browser bundle holds
 * neither the tail pages' address nor the beacon's as one liftable string.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import {
  type AnswerContext,
  type CheckFlightBody,
  renderFlightAnswer,
  shareOffered,
} from "../src/client/flight-answer";
import { checkPageShare } from "../src/client/flight-search";
import { shareControlHtml } from "../src/client/share";
import { COUNTERS, metrics, normalizeShareAction } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { SHARE_TAP_PATH } from "../src/server/share-tap";
import { addFleet, addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const AS = SITES.alaska.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const SOON = isoDay(now + 2 * DAY);
const LONG_AGO = isoDay(now - 30 * DAY);
const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N37529", "Starlink", { aircraft: "Boeing 737 MAX 9" });
  addFleet(db, "N37529", "confirmed", {
    aircraftType: "Boeing 737 MAX 9",
    verifiedWifi: "Starlink",
    verifiedAt: now - DAY,
  });
  addFlight(db, "N37529", "UA1932", "DEN", now + 2 * DAY, { arrivalAirport: "ORD" });
  addFleet(db, "N4VIA", "negative", {
    aircraftType: "Boeing 737-900",
    verifiedWifi: "Viasat",
    verifiedAt: now - DAY,
  });
  addFlight(db, "N4VIA", "UA500", "IAH", now + 2 * DAY, { arrivalAirport: "EWR" });
  addPlane(db, "N644AS", "Starlink", { airline: "AS", aircraft: "737-700" });
  addFleet(db, "N644AS", "confirmed", {
    airline: "AS",
    aircraftType: "737-700",
    verifiedWifi: "Starlink",
  });
  addFlight(db, "N644AS", "AS12", "SEA", now + 2 * DAY, { arrivalAirport: "SFO", airline: "AS" });
  app = createApp(db);
});

const page = async (host: string, path: string, headers: Record<string, string> = {}) => {
  const res = await app.dispatch(req(path, host, { headers }));
  return { status: res.status, html: await res.text() };
};

/** Every share control in a page or card, as its decoded address. */
const shareLinks = (html: string) =>
  [...html.matchAll(/<a href="([^"]*)"[^>]*data-share[^>]*>/g)].map((m) =>
    m[1].replaceAll("&amp;", "&")
  );

describe("the card", () => {
  const SHARE = `https://${UA}/check-flight/UA403/${SOON}`;
  const ctx: AnswerContext = {
    flightNumber: "UA403",
    date: SOON,
    daysOut: 2,
    origin: "DEN",
    originZone: "America/Denver",
    nowSec: now,
    airlineName: "United Airlines",
    zoneFor: () => "America/Denver",
    liveTv: null,
    watchEnabled: true,
    routePlannerEnabled: true,
    tailPages: true,
    host: UA,
    shareUrl: SHARE,
  };
  const flight = {
    tail_number: "N37529",
    aircraft_type: "Boeing 737 MAX 9",
    flight_number: "UA403",
    departure_airport: "DEN",
    arrival_airport: "ORD",
    departure_time: now + 2 * DAY,
  };
  const bodies: Array<[string, CheckFlightBody, Partial<AnswerContext>]> = [
    ["yes", { hasStarlink: true, confidence: "verified", flights: [flight] }, {}],
    [
      "partial",
      { hasStarlink: true, confidence: "verified", flights: [flight] },
      {
        dayLegs: [
          {
            origin: "ORD",
            destination: "FLL",
            departure_time: now + 2 * DAY + 5 * HOUR,
            tail: "N4VIA",
            starlink: false,
            dated: true,
          },
        ],
      },
    ],
    [
      "no",
      {
        hasStarlink: false,
        fallback: { segments: [{ tail_number: "N4VIA", hasStarlink: false }] },
      },
      {},
    ],
    ["no", { hasStarlink: false, message: "The assigned aircraft doesn't have Starlink." }, {}],
    [
      "likely",
      { hasStarlink: null, confidence: "predicted", prediction: { probability: 0.9 } },
      {},
    ],
    [
      "unlikely",
      { hasStarlink: null, confidence: "predicted", prediction: { probability: 0.02 } },
      {},
    ],
    ["unknown", { hasStarlink: null, message: "No assignment yet." }, {}],
  ];

  test.each(bodies)("a %s answer ends with one control to its own page", (tone, body, extra) => {
    const answer = renderFlightAnswer(body, { ...ctx, ...extra });
    expect(answer.tone).toBe(tone as typeof answer.tone);
    expect(shareLinks(answer.html)).toEqual([SHARE]);
    // Inside the card, as its last line, with a status line beside it.
    expect(answer.html).toMatch(/data-share-status[^>]*><\/span><\/p><\/div>$/);
    expect(answer.html.match(/<div/g)?.length).toBe(answer.html.match(/<\/div>/g)?.length);
  });

  test("one wording for every verdict, and it asks for nothing", () => {
    const labels = new Set(
      bodies.map(([, body, extra]) => {
        const html = renderFlightAnswer(body, { ...ctx, ...extra }).html;
        return html.match(/data-share[^>]*>([^<]*)<\/a>/)?.[1];
      })
    );
    expect([...labels]).toEqual(["Share this answer"]);
  });

  test("no control where there is nothing to pass on", () => {
    const failed = { error: "Lookup failed" };
    expect(shareOffered(failed, ctx)).toBe(false);
    expect(shareLinks(renderFlightAnswer(failed, ctx).html)).toEqual([]);
    const past = { ...ctx, date: LONG_AGO, daysOut: -30 };
    const body = { hasStarlink: null, prediction: { probability: 0.9 } };
    expect(shareOffered(body, past)).toBe(false);
    expect(shareLinks(renderFlightAnswer(body, past).html)).toEqual([]);
    // An answer with no page of its own (no address given) has no control.
    const { shareUrl: _, ...noPage } = ctx;
    expect(shareLinks(renderFlightAnswer(bodies[0][1], noPage).html)).toEqual([]);
  });

  test("the address is escaped into the attribute", () => {
    const html = shareControlHtml('https://x.example/a?b="1"&c=<2>');
    expect(html).toContain('href="https://x.example/a?b=&quot;1&quot;&amp;c=&lt;2&gt;"');
  });

  test("a listed tail still links its page", () => {
    const html = renderFlightAnswer(bodies[0][1], ctx).html;
    expect(html).toContain('<a href="/fleet/N37529"');
  });
});

describe("the dated page", () => {
  test.each([
    [UA, "UA1932"],
    [UA, "UA500"],
    [AS, "AS12"],
  ])("%s %s carries one control to its canonical address", async (host, fn) => {
    const { status, html } = await page(host, `/check-flight/${fn}/${SOON}`);
    expect(status).toBe(200);
    expect(shareLinks(html)).toEqual([`https://${host}/check-flight/${fn}/${SOON}`]);
    // The re-check renders the same card in the browser, so it needs the address too.
    expect(html).toContain(`"shareUrl":"https://${host}/check-flight/${fn}/${SOON}"`);
  });

  test("a page asked about one leg shares that leg", async () => {
    const { html } = await page(UA, `/check-flight/UA1932/${SOON}?origin=DEN&destination=ORD`);
    expect(shareLinks(html)).toEqual([
      `https://${UA}/check-flight/UA1932/${SOON}?origin=DEN&destination=ORD`,
    ]);
  });

  test("the address is the canonical host's, whatever host served the page", async () => {
    const { html } = await page(UA, `/check-flight/UA1932/${SOON}?utm_source=x&ref=y`);
    expect(shareLinks(html)).toEqual([`https://${UA}/check-flight/UA1932/${SOON}`]);
  });

  test("no control on an undated page, a past date, or the form", async () => {
    for (const path of [
      "/check-flight/UA1932",
      `/check-flight/UA1932/${LONG_AGO}`,
      "/check-flight",
    ]) {
      expect(shareLinks((await page(UA, path)).html), path).toEqual([]);
    }
  });
});

describe("the hub's answer", () => {
  const pages = { [AIRLINES.UA.name]: { url: `https://${UA}/check-flight`, site: "United" } };

  test("shares the airline site's page for the flight and date, which is served", async () => {
    const html = checkPageShare({ airline: AIRLINES.UA.name }, pages, "ua 1932", SOON);
    const [href] = shareLinks(html);
    expect(href).toBe(`https://${UA}/check-flight/UA1932/${SOON}`);
    expect((await page(UA, new URL(href).pathname)).status).toBe(200);
  });

  test("no control without such a page: an error, an airline with no site, no real date", () => {
    const ua = AIRLINES.UA.name;
    expect(checkPageShare({ error: "x", airline: ua }, pages, "UA1", SOON)).toBe("");
    expect(checkPageShare({ airline: "Qatar Airways" }, pages, "QR1", SOON)).toBe("");
    expect(checkPageShare({ airline: ua }, pages, "UA1", "")).toBe("");
    expect(checkPageShare({ airline: ua }, pages, "<b>", SOON)).toBe("");
  });

  test("the hub page loads the script that wires it", async () => {
    const { html } = await page(HUB, "/");
    expect(html).toMatch(/<script[^>]+src="\/static\/hub\.[a-z0-9]+\.js"/);
  });
});

describe("the browser bundles", () => {
  const bundle = async (host: string, path: string, name: string) => {
    const { html } = await page(host, path);
    const src = html.match(new RegExp(`src="(/static/${name}\\.[a-z0-9]+\\.js)"`))?.[1];
    expect(src, `${name} on ${host}${path}`).toBeDefined();
    return (await app.dispatch(req(src as string, host))).text();
  };

  test("hold no tail-page or beacon address a crawler could lift and request", async () => {
    for (const code of [
      await bundle(UA, `/check-flight/UA1932/${SOON}`, "check-flight"),
      await bundle(HUB, "/", "hub"),
    ]) {
      expect(code).toContain("data-share");
      expect(code).not.toContain("/fleet/");
      expect(code).not.toContain("/static/share");
      expect(code).not.toContain("share/tap");
    }
  });
});

describe("the count", () => {
  const spy = spyOn(metrics, "increment");
  afterEach(() => spy.mockClear());
  const counted = (name: string) =>
    spy.mock.calls.filter(([n]) => n === name).map(([, tags]) => tags as Record<string, unknown>);

  const tap = (host: string, body: string | null, headers: Record<string, string> = {}) =>
    app.dispatch(
      req(SHARE_TAP_PATH, host, {
        method: "POST",
        body,
        headers: {
          "sec-fetch-site": "same-origin",
          "user-agent": BROWSER,
          ...headers,
        },
      })
    );

  test.each([
    [UA, "copy", "united"],
    [AS, "sheet", "alaska"],
    [HUB, "copy", "all"],
  ])("a tap on %s is one word and the site", async (host, method, airline) => {
    const res = await tap(host, method);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(counted(COUNTERS.SHARE_CONTROL)).toEqual([{ airline, action: method }]);
  });

  test("the request counter files it under /static: no new route, no new tag key", async () => {
    const before = await app.dispatch(req("/static/nothing-here.png", UA));
    const keys = Object.keys(counted(COUNTERS.HTTP_REQUEST)[0]).sort();
    spy.mockClear();
    await tap(UA, "copy");
    const [request] = counted(COUNTERS.HTTP_REQUEST);
    expect(before.status).toBe(404);
    expect(request.route).toBe("/static");
    expect(Object.keys(request).sort()).toEqual(keys);
    expect(app.routeTags).not.toContain(SHARE_TAP_PATH);
    expect(app.routeTags.some((t) => t.includes("share"))).toBe(false);
  });

  test("nothing but the two words is counted", async () => {
    for (const body of ["", "shown", "COPY", "copy ", "copy\n", "x".repeat(10_000), '{"a":1}']) {
      expect((await tap(UA, body)).status, body.slice(0, 12)).toBe(202);
    }
    expect((await tap(UA, null)).status).toBe(202);
    // A length that lies is not believed.
    expect((await tap(UA, "x".repeat(10_000), { "content-length": "4" })).status).toBe(202);
    expect(counted(COUNTERS.SHARE_CONTROL)).toEqual([]);
    expect(normalizeShareAction("sheet")).toBe("sheet");
    for (const bad of [null, undefined, "", "shown", "Sheet", "constructor"]) {
      expect(normalizeShareAction(bad)).toBeNull();
    }
  });

  test("a caller that is not a browser on our own page is answered and not counted", async () => {
    const callers: Array<Record<string, string>> = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "none" },
      { "sec-fetch-site": "" },
      { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
      { "user-agent": "meta-externalagent/1.1" },
      { "user-agent": "curl/8.5.0" },
      { "user-agent": "" },
      { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
    ];
    for (const headers of callers) {
      expect((await tap(UA, "copy", headers)).status, JSON.stringify(headers)).toBe(202);
    }
    expect(counted(COUNTERS.SHARE_CONTROL)).toEqual([]);
  });

  test("an address lifted from somewhere and fetched is a 405, counted nowhere", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await app.dispatch(
        req(SHARE_TAP_PATH, UA, {
          method,
          headers: { "sec-fetch-site": "same-origin", "user-agent": BROWSER },
        })
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
    expect(counted(COUNTERS.SHARE_CONTROL)).toEqual([]);
  });

  test("a dated answer served to a browser is counted as shown, once, with the site alone", async () => {
    await page(UA, `/check-flight/UA1932/${SOON}?origin=DEN&destination=ORD`, {
      "user-agent": BROWSER,
      referer: "https://www.google.com/search?q=secret",
    });
    await page(AS, `/check-flight/AS12/${SOON}`, { "user-agent": BROWSER });
    expect(counted(COUNTERS.SHARE_CONTROL)).toEqual([
      { airline: "united", action: "shown" },
      { airline: "alaska", action: "shown" },
    ]);
  });

  test("not shown: a robot, a preload, and pages that carry no control", async () => {
    const dated = `/check-flight/UA1932/${SOON}`;
    await page(UA, dated, { "user-agent": "Mozilla/5.0 (compatible; bingbot/2.0)" });
    await page(UA, dated, { "user-agent": "" });
    await page(UA, dated, { "user-agent": BROWSER, "sec-purpose": "prefetch;prerender" });
    await page(UA, "/check-flight/UA1932", { "user-agent": BROWSER });
    await page(UA, `/check-flight/UA1932/${LONG_AGO}`, { "user-agent": BROWSER });
    await page(UA, "/check-flight", { "user-agent": BROWSER });
    expect(counted(COUNTERS.SHARE_CONTROL)).toEqual([]);
  });
});
