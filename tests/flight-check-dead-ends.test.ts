/**
 * What travellers type where a flight number goes: a tail read off the
 * aircraft, an airline's name for its code, a flight of an airline this site
 * does not check. Each gets the answer the site already holds, on United's
 * site, Alaska's and the hub.
 *
 * The rule pinned throughout: nothing here is a new page. A typed thing we
 * can answer redirects to the one existing address; one we can't stays a 404
 * out of the index, and no sitemap, llms.txt or page lists any of them.
 * Seeded on a fresh database, so every tail is one the test wrote.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { spelledOutFlight } from "../src/airlines/flight-number";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { typedFlight, typedTail } from "../src/server/typed-dead-ends";
import { addFleet, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const AS = SITES.alaska.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const SITES_WITH_FLIGHT_PAGES = [
  { host: UA, cfg: AIRLINES.UA, name: "UNITED", tail: "N1UA" },
  { host: AS, cfg: AIRLINES.AS, name: "ALASKA", tail: "N7AS" },
] as const;

let db: Database;
let app: ReturnType<typeof createApp>;

// Loopback is exempt from the page rate limit, which the hostile sweep would trip.
const get = (path: string, host: string) =>
  app.dispatch(req(path, host, { headers: { "x-forwarded-for": "127.0.0.1" } }));

async function page(path: string, host: string) {
  const res = await get(path, host);
  return { res, body: await res.text() };
}

const robotsOf = (body: string) => body.match(/<meta name="robots" content="([^"]+)"/)?.[1] ?? "";

/** The notice above the form, where a /check-flight 404 explains itself. */
function noticeOf(body: string): string {
  const start = body.indexOf('<div class="mb-4 rounded');
  if (start < 0) throw new Error("no notice on the page");
  return body.slice(start, body.indexOf("<form", start));
}

/** A dead end that stays one: 404, out of the index, cacheable at the edge. */
function expectDeadEnd(res: Response, body: string, label: string) {
  expect(res.status, label).toBe(404);
  expect(robotsOf(body), label).toContain("noindex");
  expect(res.headers.get("Cache-Control") ?? "", label).toContain("s-maxage");
}

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N1UA", "Starlink");
  addFleet(db, "N1UA", "confirmed", { verifiedWifi: "Starlink" });
  addPlane(db, "N7AS", "Starlink", { airline: "AS", aircraft: "Boeing 737 MAX 9" });
  addFleet(db, "N7AS", "confirmed", {
    airline: "AS",
    aircraftType: "Boeing 737 MAX 9",
    verifiedWifi: "Starlink",
  });
  addFleet(db, "N2HA", "confirmed", { airline: "HA", aircraftType: "Airbus A330-200" });
  app = createApp(db);
});

describe("a tail number typed where a flight goes", () => {
  test("United: a tail we track goes to its own page, whatever the spelling or date", async () => {
    for (const path of [
      "/check-flight/N1UA",
      "/check-flight/n1ua",
      "/check-flight/N1UA/2026-11-25",
      "/check-flight/%20n1ua%20/",
    ]) {
      const res = await get(path, UA);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(`https://${UA}/fleet/N1UA`);
    }
    expect((await get("/fleet/N1UA", UA)).status).toBe(200);
  });

  test("Alaska: no tail pages, so a tail we track goes to its row on the fleet page", async () => {
    for (const path of ["/check-flight/N7AS", "/check-flight/n7as/2026-11-25", "/fleet/N7AS"]) {
      const res = await get(path, AS);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(`https://${AS}/fleet#t-N7AS`);
    }
    expect((await page("/fleet", AS)).body).toContain('id="t-N7AS"');
  });

  test("the hub: to the airline's tail page where it has one, else the hub's own fleet row", async () => {
    for (const path of ["/check-flight/N1UA", "/check-flight/N1UA/2026-11-25", "/fleet/n1ua"]) {
      const res = await get(path, HUB);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(`https://${UA}/fleet/N1UA`);
    }
    for (const [path, tail] of [
      ["/check-flight/N7AS", "N7AS"],
      ["/fleet/N7AS", "N7AS"],
      ["/fleet/N2HA", "N2HA"],
    ]) {
      const res = await get(path, HUB);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(`https://${HUB}/fleet#t-${tail}`);
      expect((await page("/fleet", HUB)).body, tail).toContain(`id="t-${tail}"`);
    }
  });

  test("a tail we don't track is a 404 that says so and offers the fleet", async () => {
    for (const { host, cfg } of SITES_WITH_FLIGHT_PAGES) {
      const { res, body } = await page("/check-flight/N9ZZZ", host);
      expectDeadEnd(res, body, host);
      const notice = noticeOf(body);
      expect(notice, host).toContain("looks like an aircraft tail number");
      expect(notice, host).toContain(`one of the ${cfg.shortName} aircraft we track`);
      expect(notice, host).toContain('href="/fleet"');
      expect(body, host).toContain('id="check-flight-form"');
    }
  });

  test("another airline's tail is not this site's: no redirect, and no word on whose it is", async () => {
    const onUnited = await page("/check-flight/N7AS", UA);
    expectDeadEnd(onUnited.res, onUnited.body, "N7AS on United");
    expect(noticeOf(onUnited.body)).not.toContain("Alaska");
    const onAlaska = await page("/check-flight/N1UA", AS);
    expectDeadEnd(onAlaska.res, onAlaska.body, "N1UA on Alaska");
    expect(noticeOf(onAlaska.body)).not.toContain("United");
  });

  test("/fleet/{tail} for a tail nobody here tracks: a static 404 that echoes nothing typed", async () => {
    for (const host of [UA, AS, HUB]) {
      const plain = await page("/fleet/N9ZZZ", host);
      expectDeadEnd(plain.res, plain.body, host);
      expect(plain.body, host).toContain("Aircraft not found");
      expect(plain.body, host).toContain("The fleet page lists every one.");
      expect(plain.body, host).not.toContain("N9ZZZ");
      const other = await page("/fleet/n8yyy/", host);
      expect(other.body, host).toBe(plain.body);
    }
    const hub = await page("/check-flight/N9ZZZ", HUB);
    expect(hub.body).toContain("Aircraft not found");
    expect(hub.body).not.toContain("N9ZZZ");
  });

  test("bare digits stay a flight number, and a type page still wins its address", async () => {
    // "1" would be tail N1… to resolveTail; where a flight goes it is no tail.
    const res = await get("/check-flight/1", UA);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(typedTail("12345")).toBeNull();
    expect(typedTail(" n37318 ")).toBe("N37318");
    expect((await get("/fleet/737-max-9", AS)).status).not.toBe(302);
  });
});

describe("an airline's name in place of its code", () => {
  test("the site's own airline: one permanent hop to the coded flight", async () => {
    for (const { host, cfg, name } of SITES_WITH_FLIGHT_PAGES) {
      const to = (rest: string) => `https://${host}/check-flight/${cfg.iata}${rest}`;
      const cases: Array<[string, string]> = [
        [`/check-flight/${name}654`, to("654")],
        [`/check-flight/${name.toLowerCase()}%20654`, to("654")],
        [`/check-flight/${encodeURIComponent(cfg.name)}%200654/2026-11-26`, to("654/2026-11-26")],
        [`/check-flight/${name}654?origin=SEA`, to("654?origin=SEA")],
      ];
      for (const [path, location] of cases) {
        const res = await get(path, host);
        expect(res.status, path).toBe(301);
        expect(res.headers.get("location"), path).toBe(location);
      }
    }
  });

  test("the hub sends a named or coded flight to that airline's own check page", async () => {
    const cases: Array<[string, string]> = [
      ["/check-flight/ALASKA654", `https://${AS}/check-flight/AS654`],
      ["/check-flight/united%20123/2026-11-26", `https://${UA}/check-flight/UA123/2026-11-26`],
      ["/check-flight/UA123", `https://${UA}/check-flight/UA123`],
      ["/check-flight/asa0654", `https://${AS}/check-flight/AS654`],
    ];
    for (const [path, location] of cases) {
      const res = await get(path, HUB);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe(location);
    }
  });

  test("only names in the registry resolve, and the digits keep the permalink bound", () => {
    expect(spelledOutFlight("ALASKA654")?.flightNumber).toBe("AS654");
    expect(spelledOutFlight("Alaska Airlines 0654")?.flightNumber).toBe("AS654");
    expect(spelledOutFlight("united-123")?.flightNumber).toBe("UA123");
    for (const input of ["DELTA649", "ALASKA", "ALASKA12345", "ALASKA654X", "UA123", "AL654", ""]) {
      expect(spelledOutFlight(input), input).toBeNull();
    }
    // Air France is in the registry and not published: its name resolves nowhere.
    expect(spelledOutFlight("AIRFRANCE12")).toBeNull();
    expect(typedFlight("AF12")).toBeNull();
  });
});

describe("a flight of an airline this site does not check", () => {
  test("a sister tracker's flight links straight to that flight there, date kept", async () => {
    const cases = [
      {
        host: UA,
        path: "/check-flight/AS654/2026-11-26",
        href: `https://${AS}/check-flight/AS654/2026-11-26`,
        label: "Check AS654 on the Alaska Starlink Tracker",
      },
      {
        host: UA,
        path: "/check-flight/ALASKA654",
        href: `https://${AS}/check-flight/AS654`,
        label: "Check AS654 on the Alaska Starlink Tracker",
      },
      {
        host: AS,
        path: "/check-flight/UA123",
        href: `https://${UA}/check-flight/UA123`,
        label: "Check UA123 on the United Starlink Tracker",
      },
      {
        host: AS,
        path: "/check-flight/united123",
        href: `https://${UA}/check-flight/UA123`,
        label: "Check UA123 on the United Starlink Tracker",
      },
    ];
    for (const c of cases) {
      const { res, body } = await page(c.path, c.host);
      expectDeadEnd(res, body, c.path);
      const notice = noticeOf(body);
      expect(notice, c.path).toContain(`href="${c.href}"`);
      expect(notice, c.path).toContain(c.label);
      // The one cross-site mention is marked, as the footer's is.
      expect(notice, c.path).toMatch(
        /<p data-cross-site-links[^>]*>(?:(?!<\/p>).)*Starlink Tracker/
      );
    }
  });

  test("an airline we don't track: said plainly, with the list of those we do, and never named", async () => {
    for (const { host, cfg } of SITES_WITH_FLIGHT_PAGES) {
      for (const seg of [
        "DL649",
        "DELTA649",
        "WN12",
        "SOUTHWEST12",
        "LH400",
        "AZ609",
        "US1234",
        "DAL649",
      ]) {
        const { res, body } = await page(`/check-flight/${seg}`, host);
        expectDeadEnd(res, body, `${host} ${seg}`);
        const notice = noticeOf(body);
        expect(notice, seg).toContain(`This site checks ${cfg.shortName} flights only.`);
        expect(notice, seg).toContain("We don&#x27;t track every airline.");
        expect(notice, seg).toContain(`href="https://${HUB}/airlines"`);
        expect(body, seg).not.toMatch(/Delta Air|Southwest Airlines|Lufthansa|ITA Airways/);
        expect(body, seg).toContain('id="check-flight-form"');
      }
    }
  });

  test("an airline without a live site of its own is pointed at the hub's check, unnamed", async () => {
    for (const seg of ["QR1", "HA50", "QATAR1"]) {
      const { res, body } = await page(`/check-flight/${seg}`, UA);
      expectDeadEnd(res, body, seg);
      const notice = noticeOf(body);
      expect(notice, seg).toContain(`href="https://${HUB}/"`);
      expect(notice, seg).not.toMatch(/Qatar|Hawaiian|qatarstarlink|hawaiianstarlink/);
    }
    // An airline in the registry that is not published gets the generic answer.
    const af = noticeOf((await page("/check-flight/AF12", UA)).body);
    expect(af).toContain(`href="https://${HUB}/airlines"`);
    expect(af).not.toContain("France");
  });

  test("the hub has no flight pages: a 404 that says where its check is", async () => {
    const plain = await page("/check-flight/DL649", HUB);
    expectDeadEnd(plain.res, plain.body, "hub DL649");
    expect(plain.body).toContain("No flight page here");
    expect(plain.body).toContain("flights of the airlines we track, and no others");
    expect(plain.body).toContain('href="/airlines"');
    // Static per host: nothing typed reaches the page.
    for (const seg of ["DELTA649", "HA50", "QR1", "null", "banana", "%3Cscript%3E"]) {
      const { res, body } = await page(`/check-flight/${seg}`, HUB);
      expect(res.status, seg).toBe(404);
      expect(body, seg).toBe(plain.body);
    }
  });
});

describe("typed values are hostile input", () => {
  const HOSTILE = [
    "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "N1UA%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
    "ALASKA654%22%3E%3Csvg%20onload%3Dalert(1)%3E",
    "UNITED%0d%0aLocation:%20https://evil.test/123",
    "UNITED123%2F..%2F..%2Fetc",
    "%2F%2Fevil.test%2FN1UA",
    "N1UA%00",
    "'%20OR%201=1--",
    "%E0%A4%A",
    `${"ALASKA".repeat(200)}654`,
    "ＵＮＩＴＥＤ１２３",
  ];

  test("nothing typed is echoed raw, and no redirect leaves our own hosts", async () => {
    const ours = new Set([UA, AS, HUB]);
    for (const host of [UA, AS, HUB]) {
      for (const seg of HOSTILE) {
        for (const path of [
          `/check-flight/${seg}`,
          `/check-flight/${seg}/2026-11-26`,
          `/fleet/${seg}`,
        ]) {
          const res = await get(path, host);
          const body = await res.text();
          const label = `${host}${path}`;
          expect([301, 302, 404], label).toContain(res.status);
          const location = res.headers.get("location");
          if (location) {
            const to = new URL(location);
            expect(ours.has(to.host), label).toBe(true);
            expect(to.pathname, label).toMatch(
              /^\/(?:check-flight\/[A-Z]{2}\d{1,4}(?:\/\d{4}-\d\d-\d\d)?|fleet(?:\/N[A-Z0-9]{1,5})?)$/
            );
          }
          expect(body, label).not.toMatch(/<script>alert|<img src=x|<svg onload/);
          expect(body, label).not.toMatch(
            /(?:href|src|action|content)="(?:https?:)?\/\/evil\.test/
          );
        }
      }
    }
  });

  test("a long entry is cut before it reaches the notice", async () => {
    const { body } = await page(`/check-flight/${"DELTA".repeat(40)}649`, UA);
    expect(noticeOf(body)).toContain("isn&#x27;t a United flight number");
    expect(noticeOf(body)).not.toContain("DELTA".repeat(6));
    expect(body.match(/<h1[^>]*>([^<]*)/)?.[1]).not.toContain("DELTA");
  });
});

describe("nothing here is a new page", () => {
  test("no sitemap, llms.txt or home page lists a dead end or a hop", async () => {
    for (const host of [UA, AS, HUB]) {
      for (const path of ["/sitemap.xml", "/llms.txt", "/"]) {
        const { body } = await page(path, host);
        expect(body, `${host}${path}`).not.toMatch(/check-flight\/(?:N\d|[A-Za-z]{4,}\d)/);
        expect(body, `${host}${path}`).not.toContain("fleet#t-");
      }
    }
  });

  test("the hub's sitemap still lists no flight page, and its /check-flight is still a 404", async () => {
    expect((await page("/sitemap.xml", HUB)).body).not.toContain("/check-flight");
    expect((await get("/check-flight", HUB)).status).toBe(404);
  });

  test("a flight of the site's own airline is untouched", async () => {
    for (const { host, cfg } of SITES_WITH_FLIGHT_PAGES) {
      const { res, body } = await page(`/check-flight/${cfg.iata}123`, host);
      expect(res.status, host).toBe(200);
      expect(body, host).toContain(`Does ${cfg.iata}123 have Starlink Wi-Fi?`);
      const callsign = await get(`/check-flight/${cfg.icao}123`, host);
      expect(callsign.status, host).toBe(301);
      expect(callsign.headers.get("location"), host).toBe(
        `https://${host}/check-flight/${cfg.iata}123`
      );
    }
  });

  test("an airport code or a typo keeps the notice it had", async () => {
    const airport = await page("/check-flight/PHX", UA);
    expect(airport.res.status).toBe(404);
    expect(airport.body).toContain("Looking for an airport or a route?");
    const typo = await page("/check-flight/UA123X", UA);
    expect(typo.res.status).toBe(404);
    expect(noticeOf(typo.body)).toContain("Try something like");
  });
});
