/**
 * The second pass over what travellers type and got nothing for, ranked by
 * a week of people-like requests: a route pair United doesn't fly nonstop,
 * digits with no airline code, a tail read without its N, "US" for United,
 * and "737-8", which names two aircraft types.
 *
 * Same rule as the first pass: nothing here is a new page. A typed thing we
 * can answer goes to an address that already existed; the rest stays a 404
 * out of the index. Seeded on a fresh database, so every row is the test's.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import {
  bareDigitsFlight,
  longNumberDigits,
  lookalikeFlight,
  typedAirportPair,
} from "../src/server/typed-dead-ends";
import { addFleet, addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const AS = SITES.alaska.canonicalHost;
const HUB = SITES.airline.canonicalHost;

let db: Database;
let app: ReturnType<typeof createApp>;

const get = (path: string, host: string) =>
  app.dispatch(req(path, host, { headers: { "x-forwarded-for": "127.0.0.1" } }));

async function page(path: string, host: string) {
  const res = await get(path, host);
  return { res, body: await res.text() };
}

const robotsOf = (body: string) => body.match(/<meta name="robots" content="([^"]+)"/)?.[1] ?? "";

function noticeOf(body: string): string {
  const start = body.indexOf('<div class="mb-4 rounded');
  if (start < 0) throw new Error("no notice on the page");
  return body.slice(start, body.indexOf("<form", start));
}

function expectHop(res: Response, status: number, location: string, label: string) {
  expect(res.status, label).toBe(status);
  expect(res.headers.get("location"), label).toBe(location);
}

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N39450", "Starlink");
  addFleet(db, "N39450", "confirmed", { verifiedWifi: "Starlink" });
  const now = Math.floor(Date.now() / 1000);
  addFlight(db, "N39450", "UA1932", "DEN", now + 6 * 3600, { arrivalAirport: "ORD" });
  // Airports each airline departs from, none of them on a pair the tests ask for.
  const route = db.query(
    `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, ?, ?, 10800, ?, ?, 3)`
  );
  for (const [fn, origin, destination] of [
    ["UA2001", "LGA", "ORD"],
    ["UA2002", "LAS", "DEN"],
    ["UA2003", "EWR", "DEN"],
    ["UA2004", "SFO", "DEN"],
    ["AS2001", "LGA", "SEA"],
    ["AS2002", "LAS", "SEA"],
  ] as const) {
    route.run(fn, origin, destination, now - 86400, now);
  }
  for (const [type, prefix] of [
    ["Boeing 737 MAX 8", "N2701"],
    ["Boeing 737-824", "N7380"],
  ] as const) {
    for (let i = 1; i <= 6; i++) {
      addPlane(db, `${prefix}${i}`, "Starlink", { aircraft: type });
      addFleet(db, `${prefix}${i}`, "confirmed", { aircraftType: type, verifiedWifi: "Starlink" });
    }
  }
  app = createApp(db);
});

describe("a route pair with no route page", () => {
  test("two airports on record: the planner searches the pair, connections included", async () => {
    for (const host of [UA, AS]) {
      expectHop(
        await get("/route-planner/LGA/LAS", host),
        302,
        `https://${host}/route-planner?origin=LGA&destination=LAS`,
        host
      );
    }
    expectHop(
      await get("/route-planner/sfo/nyc", UA),
      301,
      `https://${UA}/route-planner/SFO/NYC`,
      "lowercase is spelled once first"
    );
    expectHop(
      await get("/route-planner/SFO/NYC", UA),
      302,
      `https://${UA}/route-planner?origin=SFO&destination=NYC`,
      "a city code"
    );
  });

  test("a flown pair keeps its page", async () => {
    expect((await get("/route-planner/DEN/ORD", UA)).status).toBe(200);
  });

  test("codes on no airport, three airports, one airport, or the hub: still a 404", async () => {
    for (const path of [
      "/route-planner/QQQ/ZZZ",
      "/route-planner/SFO/QQQ",
      "/route-planner/SFO/SFO",
      "/route-planner/SFO/EWR/ORD",
      "/route-planner/SFO",
    ]) {
      expect((await get(path, UA)).status, path).toBe(404);
    }
    expect((await get("/route-planner/LGA/LAS", HUB)).status).toBe(404);
  });

  test("llms.txt names only route pairs whose page exists, even on thin data", async () => {
    // With no popular routes, llms.txt once fell back to a fixed pair that
    // now hops to the planner, which a < 400 check reads as fine.
    for (const host of [UA, AS]) {
      const body = await (await get("/llms.txt", host)).text();
      const pairs = [...body.matchAll(/https:\/\/[^/\s]+(\/route-planner\/[A-Z]{3}\/[A-Z]{3})\b/g)];
      for (const [, path] of pairs) {
        expect((await get(path, host)).status, `${host} llms.txt names ${path}`).toBe(200);
      }
    }
  });

  test("an end the site's airline never departs from: still a 404", async () => {
    for (const host of [UA, AS]) {
      for (const path of ["/route-planner/LHR/CDG", "/route-planner/LGA/MIA"]) {
        const res = await get(path, host);
        expect(res.status, `${host}${path}`).toBe(404);
        expect(res.headers.get("location"), `${host}${path}`).toBeNull();
      }
    }
  });
});

describe("digits where a flight goes", () => {
  test("one to four digits are the site's own flight, as the search form reads them", async () => {
    for (const [host, code] of [
      [UA, "UA"],
      [AS, "AS"],
    ]) {
      expectHop(
        await get("/check-flight/1618", host),
        301,
        `https://${host}/check-flight/${code}1618`,
        host
      );
      expectHop(
        await get("/check-flight/0654/2026-11-30?origin=SEA", host),
        301,
        `https://${host}/check-flight/${code}654/2026-11-30?origin=SEA`,
        host
      );
    }
    expect((await get("/check-flight/1618", HUB)).status).toBe(404);
  });

  test("zeros alone are no flight: a 404, not a hop to flight 0", async () => {
    for (const path of ["/check-flight/0", "/check-flight/000", "/check-flight/00000"]) {
      const res = await get(path, UA);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
    }
    expect(bareDigitsFlight(AIRLINES.UA, "0")).toBeNull();
    expect(bareDigitsFlight(AIRLINES.UA, "0000")).toBeNull();
    expect(bareDigitsFlight(AIRLINES.UA, "0654")).toBe("UA654");
  });

  test("five digits that are a tail we track, with or without UA, go to the tail", async () => {
    for (const path of [
      "/check-flight/39450",
      "/check-flight/UA39450/2026-11-21",
      "/check-flight/ua%2039450",
    ]) {
      expectHop(await get(path, UA), 302, `https://${UA}/fleet/N39450`, path);
    }
  });

  test("five digits that are no tail: a 404 that says how long a flight number is", async () => {
    for (const path of ["/check-flight/UA41745", "/check-flight/99999/2026-11-25"]) {
      const { res, body } = await page(path, UA);
      expect(res.status, path).toBe(404);
      expect(robotsOf(body), path).toContain("noindex");
      expect(noticeOf(body), path).toContain("United flight numbers have at most four digits.");
    }
    // Alaska's site holds no United tail, and doesn't read United's code as its own.
    const as = await page("/check-flight/UA39450", AS);
    expect(as.res.status).toBe(404);
    expect(noticeOf(as.body)).not.toContain("at most four digits");
  });

  test("six digits and more stay a plain 404", async () => {
    const res = await get("/check-flight/737900", UA);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("US typed for United", () => {
  test("offered United's flight of that number, as a link and not a redirect", async () => {
    for (const path of ["/check-flight/US852", "/check-flight/US852/2026-11-30"]) {
      const { res, body } = await page(path, UA);
      expect(res.status, path).toBe(404);
      expect(robotsOf(body), path).toContain("noindex");
      const notice = noticeOf(body);
      expect(notice, path).toContain("United flight numbers start with UA.");
      expect(notice, path).toContain('href="/check-flight/UA852"');
    }
  });

  test("only on United's site, and never for a code that is an airline's own", async () => {
    expect(noticeOf((await page("/check-flight/US852", AS)).body)).not.toContain("start with");
    // U2 is easyJet's code: U268 is a real flight, not a United typo.
    expect(noticeOf((await page("/check-flight/U268", UA)).body)).not.toContain("start with");
    expect(lookalikeFlight(AIRLINES.UA, "U268")).toBeNull();
    expect(lookalikeFlight(AIRLINES.UA, "US12345")).toBeNull();
    expect(lookalikeFlight(AIRLINES.AS, "US852")).toBeNull();
  });
});

describe("two airport codes where a flight goes", () => {
  test("a pair United flies goes to its route page", async () => {
    for (const path of [
      "/check-flight/DENORD",
      "/check-flight/den-ord",
      "/check-flight/DEN%20to%20ORD",
    ]) {
      expectHop(await get(path, UA), 301, `https://${UA}/route-planner/DEN/ORD`, path);
    }
  });

  test("a typed date rides along as the route page's ?date=", async () => {
    expectHop(
      await get("/check-flight/DENORD/2026-11-30", UA),
      301,
      `https://${UA}/route-planner/DEN/ORD?date=2026-11-30`,
      "dated pair"
    );
    expectHop(
      await get("/check-flight/DENORD/2026-02-30", UA),
      301,
      `https://${UA}/route-planner/DEN/ORD`,
      "a day that doesn't exist is dropped"
    );
  });

  test("a pair nobody here flies, or a six-letter word, keeps its notice", async () => {
    for (const path of ["/check-flight/LGALAS", "/check-flight/ALASKA", "/check-flight/UNITED"]) {
      const res = await get(path, UA);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  test("one airport code: the planner link starts from it", async () => {
    const { body } = await page("/check-flight/ORD", UA);
    expect(noticeOf(body)).toContain('href="/route-planner?origin=ORD"');
    const unknown = await page("/check-flight/QQQ", UA);
    expect(noticeOf(unknown.body)).not.toContain("?origin=");
  });
});

describe("aircraft type names", () => {
  test("737-8 means two types: a 404 that offers both pages", async () => {
    for (const path of ["/fleet/737-8", "/fleet/B737-8/"]) {
      const { res, body } = await page(path, UA);
      expect(res.status, path).toBe(404);
      expect(robotsOf(body), path).toContain("noindex");
      expect(body, path).toContain("Which aircraft did you mean?");
      expect(body, path).toContain('href="/fleet/737-max-8"');
      expect(body, path).toContain('href="/fleet/737-800"');
    }
  });

  test("a type that isn't served here is not offered", async () => {
    const { res, body } = await page("/fleet/737-9", UA);
    expect(res.status).toBe(404);
    expect(body).not.toContain("Which aircraft did you mean?");
  });

  test("a guessed folder in front of a type or a tail goes to its one address", async () => {
    expectHop(await get("/fleet/type/737-MAX-8", UA), 301, `https://${UA}/fleet/737-max-8`, "type");
    expectHop(await get("/fleet/tail/n39450", UA), 301, `https://${UA}/fleet/N39450`, "tail");
    for (const path of ["/fleet/type/747", "/fleet/tail/N00000", "/fleet/type/737-max-8/extra"]) {
      expect((await get(path, UA)).status, path).toBe(404);
    }
  });
});

describe("typed values are hostile input", () => {
  const HOSTILE = [
    "%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "1618%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
    "US852%22%3E%3Csvg%20onload%3Dalert(1)%3E",
    "1618%0d%0aLocation:%20https://evil.test/",
    "39450%2F..%2F..%2Fetc",
    "%2F%2Fevil.test%2F1618",
    "1618%00",
    "DEN%0aORD",
    "%E0%A4%A",
    "9".repeat(1200),
    "１６１８",
    "ＤＥＮＯＲＤ",
  ];

  test("no markup comes back, and no redirect leaves our hosts or our address shapes", async () => {
    const ours = new Set([UA, AS, HUB]);
    for (const host of [UA, AS, HUB]) {
      for (const seg of HOSTILE) {
        for (const path of [
          `/check-flight/${seg}`,
          `/check-flight/${seg}/2026-11-26`,
          `/route-planner/${seg}/LAS`,
          `/route-planner/LGA/${seg}`,
          `/fleet/${seg}`,
          `/fleet/type/${seg}`,
          `/fleet/tail/${seg}`,
        ]) {
          const res = await get(path, host);
          const body = await res.text();
          const label = `${host}${path}`;
          expect([301, 302, 404], label).toContain(res.status);
          const location = res.headers.get("location");
          if (location) {
            const to = new URL(location);
            expect(ours.has(to.host), label).toBe(true);
            expect(`${to.pathname}${to.search}`, label).toMatch(
              /^\/(?:check-flight\/[A-Z]{2}\d{1,4}(?:\/\d{4}-\d\d-\d\d)?|fleet(?:\/[A-Za-z0-9-]{1,40})?|route-planner(?:\/[A-Z]{3}\/[A-Z]{3}(?:\?date=\d{4}-\d\d-\d\d)?|\?origin=[A-Z]{3}&destination=[A-Z]{3})?)$/
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

  test("the readers take only their own shapes", () => {
    expect(bareDigitsFlight(AIRLINES.UA, "12345")).toBeNull();
    expect(bareDigitsFlight(AIRLINES.UA, "12 34")).toBe("UA1234");
    expect(bareDigitsFlight(AIRLINES.UA, "12a")).toBeNull();
    expect(longNumberDigits(AIRLINES.UA, "UA394500")).toBeNull();
    expect(longNumberDigits(AIRLINES.UA, "AS39450")).toBeNull();
    expect(typedAirportPair("DEN/ORD")).toBeNull();
    expect(typedAirportPair("DENDEN")).toBeNull();
    expect(typedAirportPair("QQQZZZ")).toBeNull();
    expect(typedAirportPair("den to ord")).toEqual({ origin: "DEN", destination: "ORD" });
  });
});

describe("nothing here is a new page", () => {
  test("no sitemap or llms.txt lists a hop or a dead end", async () => {
    for (const host of [UA, AS, HUB]) {
      for (const path of ["/sitemap.xml", "/llms.txt"]) {
        const { body } = await page(path, host);
        expect(body, `${host}${path}`).not.toContain("route-planner?origin=");
        expect(body, `${host}${path}`).not.toContain("/fleet/737-8<");
        expect(body, `${host}${path}`).not.toMatch(/check-flight\/\d/);
      }
    }
  });
});
