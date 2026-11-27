/**
 * Airport pages at /routes/{airport}: the Starlink departures from one airport.
 *
 * Seeded on a fresh database, so the rules are pinned on rows the test wrote:
 * the URL space is bounded by real data (unknown codes 404, one spelling per
 * airport), a thin airport serves but stays out of the index and the sitemap,
 * and every number on the page is one a reader could recount from its rows.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { AIRLINES } from "../src/airlines/registry";
import {
  AIRPORT_INDEX_MIN_DEPARTURES,
  airportDek,
  buildAirportBoard,
  firstIndexedAirports,
  indexableAirports,
} from "../src/api/airport-board";
import {
  AIRPORT_HISTORY_DAYS,
  STARLINK_FLOWN_SQL,
  getAirportHistory,
} from "../src/database/airports";
import { logFlightAssignments } from "../src/database/assignment-log";
import { createReaderFactory } from "../src/database/reader";
import { createApp, parseAirportPath } from "../src/server/app";
import { airportLocalDate, secondsToFirstLocalMidnight } from "../src/utils/airport-tz";
import { addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

let db: Database;
let app: ReturnType<typeof createApp>;

/** A departure `tail` flew `daysAgo` days back: logged with its pair, and archived as departed. */
function addFlown(
  tail: string,
  fn: string,
  origin: string,
  destination: string,
  daysAgo: number,
  hour = 1
) {
  const departure_time = now - daysAgo * DAY + hour * HOUR;
  logFlightAssignments(
    db,
    "UA",
    tail,
    [
      {
        flight_number: fn,
        departure_airport: origin,
        arrival_airport: destination,
        departure_time,
        arrival_time: departure_time + 2 * HOUR,
      },
    ],
    now
  );
  db.query(
    "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?, ?, ?, 'UA')"
  ).run(tail, origin, departure_time);
}

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N1VER", "Starlink");
  addPlane(db, "N2LIST", null);
  // No listing: a tail the schedule holds that is not a Starlink plane.
  addFlight(db, "N3NONE", "UA300", "DEN", now + 2 * HOUR, { arrivalAirport: "ORD" });

  // DEN: a busy station. Three Starlink departures in the window, two a day flown.
  addFlight(db, "N1VER", "UA100", "DEN", now + 3 * HOUR, { arrivalAirport: "ORD" });
  addFlight(db, "N2LIST", "UAL200", "DEN", now + 5 * HOUR, { arrivalAirport: "SFO" });
  addFlight(db, "N1VER", "UA101", "DEN", now + 30 * HOUR, { arrivalAirport: "ORD" });
  // Past the 48 hours: not this window's.
  addFlight(db, "N1VER", "UA102", "DEN", now + 60 * HOUR, { arrivalAirport: "ORD" });
  for (let d = 1; d < AIRPORT_HISTORY_DAYS; d++) {
    addFlown("N1VER", "UA100", "DEN", "ORD", d);
    addFlown("N2LIST", "UA200", "DEN", "SFO", d);
    // Later that day: one plane leaves one airport at one time once.
    addFlown("N2LIST", "UA210", "DEN", "YYZ", d, 4);
  }
  // Logged for a plane that never left on it (swapped away): not flown.
  logFlightAssignments(
    db,
    "UA",
    "N2LIST",
    [
      {
        flight_number: "UA220",
        departure_airport: "DEN",
        arrival_airport: "LAX",
        departure_time: now - DAY,
        arrival_time: now - DAY + HOUR,
      },
    ],
    now
  );
  // Older than the history span.
  addFlown("N1VER", "UA100", "DEN", "ORD", AIRPORT_HISTORY_DAYS + 1);

  // GJT: a thin station. One Starlink departure in the window, one flown.
  addFlight(db, "N2LIST", "UA400", "GJT", now + 8 * HOUR, { arrivalAirport: "DEN" });
  addFlown("N2LIST", "UA400", "GJT", "DEN", 2);

  // ORD: arrivals only in the schedule, but the route cache knows it as an origin.
  db.query(
    `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES ('UA900', 'ORD', 'DEN', 9000, ?, ?, 1)`
  ).run(now - DAY, now - 60);

  // A census month for Denver: the page must print no share from it.
  db.query(
    "INSERT INTO bts_monthly_routes (month, origin, dest, performed) VALUES (?, ?, ?, ?)"
  ).run(censusMonth(), "DEN", "ORD", 600);

  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  app = createApp(db);
});

/** Two months back: what the census has when it is current. */
function censusMonth(): string {
  const d = new Date(now * 1000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1)).toISOString().slice(0, 7);
}

const get = (path: string, host = UA) =>
  app.dispatch(
    req(path, host, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
  );
const page = async (path: string) => (await get(path)).text();
const robots = (doc: string) => doc.match(/<meta name="robots" content="([^"]*)"/)?.[1];
const sitemapAirports = async () =>
  [
    ...(await (await app.dispatch(req("/sitemap.xml", UA))).text()).matchAll(
      /<loc>[^<]*\/routes\/([^<]+)<\/loc>/g
    ),
  ].map((m) => m[1]);

describe("parseAirportPath", () => {
  test("accepts one IATA code, in any case, with or without a trailing slash", () => {
    expect(parseAirportPath("/routes/DEN")).toBe("DEN");
    expect(parseAirportPath("/routes/den")).toBe("DEN");
    expect(parseAirportPath("/routes/DEN/")).toBe("DEN");
  });

  test("rejects everything else", () => {
    for (const path of [
      "/routes",
      "/routes/",
      "/routes/DE",
      "/routes/KDEN",
      "/routes/123",
      "/routes/DEN/ORD",
      "/routes/D-N",
    ]) {
      expect(parseAirportPath(path), path).toBeNull();
    }
  });
});

describe("/routes/{airport}", () => {
  test("lists the window's Starlink departures, and only those", async () => {
    const body = await page("/routes/DEN");
    expect(body).toContain("Which flights from Denver (DEN) have Starlink?");
    expect(body).toContain(`<link rel="canonical" href="https://${UA}/routes/DEN"`);
    // The operating spelling UAL200 is the marketed UA200.
    for (const fn of ["UA100", "UA200", "UA101"]) {
      expect(body).toContain(`href="/check-flight/${fn}"`);
    }
    // Not a Starlink plane, and past the window.
    expect(body).not.toContain("/check-flight/UA300");
    expect(body).not.toContain("/check-flight/UA102");
    expect(body).toContain('href="/route-planner/DEN/ORD"');
    expect(body).toContain('href="/route-planner?origin=DEN"');
  });

  test("every count on the board is one its rows add up to", () => {
    const reader = createReaderFactory(db)("UA");
    const board = buildAirportBoard(AIRLINES.UA, reader, "DEN");
    expect(board.departures.map((d) => d.flight_number)).toEqual(["UA100", "UA200", "UA101"]);
    expect(board.departures.map((d) => d.starlink)).toEqual(["verified", "listed", "verified"]);
    expect(board.destinations.map((d) => [d.destination, d.departures.length, d.recent])).toEqual([
      ["ORD", 2, AIRPORT_HISTORY_DAYS - 1],
      ["SFO", 1, AIRPORT_HISTORY_DAYS - 1],
      // Flown lately, nothing assigned yet: listed last. Only the log holds
      // the pair, so its route page would 404 and it is not linked.
      ["YYZ", 0, AIRPORT_HISTORY_DAYS - 1],
    ]);
    expect(board.destinations.map((d) => d.linkable)).toEqual([true, true, false]);
    // The swapped-away leg and the one older than the span are not counted.
    expect(board.history).toEqual({
      days: AIRPORT_HISTORY_DAYS,
      starlink: 3 * (AIRPORT_HISTORY_DAYS - 1),
    });
    expect(airportDek(board)).toBe(
      "3 United departures from Denver (DEN) in the next 48 hours are on Starlink planes, to 2 destinations."
    );
  });

  test("no share of the airport's departures is printed, census row or not", async () => {
    // DEN has a census row and Starlink departures: all a share would need.
    for (const path of ["/routes/DEN", "/routes/GJT", "/routes/ORD"]) {
      const body = await page(path);
      const airportPage = [
        body.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? "",
        ...[...body.matchAll(/<meta[^>]+(?:description|title)[^>]*>/g)].map((m) => m[0]),
        ...[...body.matchAll(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g)].map(
          (m) => m[0]
        ),
        visibleText(body.match(/<body[\s\S]*<\/body>/)?.[0] ?? ""),
      ].join("\n");
      expect(airportPage.length, path).toBeGreaterThan(200);
      expect(airportPage, path).not.toMatch(/\d\s*%|percent|\bshare\b|domestic departures|DOT\b/i);
    }
    const board = buildAirportBoard(AIRLINES.UA, createReaderFactory(db)("UA"), "DEN");
    expect(Object.keys(board).filter((k) => /share|ratio|census/i.test(k))).toEqual([]);
  });

  test("lowercase and trailing-slash spellings 301 to the one canonical address", async () => {
    for (const path of ["/routes/den", "/routes/DEN/", "/routes/Den"]) {
      const res = await get(path);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("location"), path).toBe(`https://${UA}/routes/DEN`);
    }
    const www = await get("/routes/den/", "www.unitedstarlinktracker.com");
    expect(www.status).toBe(301);
    expect(www.headers.get("location")).toBe(`https://${UA}/routes/DEN`);
    expect((await get("/routes/DEN")).status).toBe(200);
  });

  test("an unknown or malformed code is a 404, and the routes page itself still serves", async () => {
    for (const path of ["/routes/QQQ", "/routes/KDEN", "/routes/DEN/ORD", "/routes/12"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await get("/routes")).status).toBe(200);
    const slash = await get("/routes/");
    expect(slash.status).toBe(301);
    expect(slash.headers.get("location")).toBe(`https://${UA}/routes`);
  });

  test("the family is United's only: Alaska and the hub 404", async () => {
    expect((await get("/routes/DEN", SITES.alaska.canonicalHost)).status).toBe(404);
    expect((await get("/routes/DEN", SITES.airline.canonicalHost)).status).toBe(404);
  });
});

describe("index rule", () => {
  test("an airport at the threshold indexes, with structured data", async () => {
    const reader = createReaderFactory(db)("UA");
    expect(getAirportHistory(db, "UA").airports.get("DEN")?.starlink).toBeGreaterThanOrEqual(
      AIRPORT_INDEX_MIN_DEPARTURES
    );
    expect(buildAirportBoard(AIRLINES.UA, reader, "DEN").indexable).toBe(true);
    const body = await page("/routes/DEN");
    expect(robots(body)).toBe("index, follow");
    expect(body).toContain('"@type":"ItemList"');
    expect(body).toContain(`"url":"https://${UA}/route-planner/DEN/ORD"`);
    // Only pairs whose route page serves are listed.
    expect(body).not.toContain("/route-planner/DEN/YYZ");
  });

  test("an airport below it serves, follows links, and stays out of the index", async () => {
    const res = await get("/routes/GJT");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(robots(body)).toBe("noindex, follow");
    expect(body).toContain('href="/check-flight/UA400"');
    expect(body).not.toContain('"@type":"ItemList"');
  });

  test("an airport with a schedule row but no Starlink departure says so", async () => {
    const body = await page("/routes/ORD");
    expect(robots(body)).toBe("noindex, follow");
    expect(body).toContain(
      "No Starlink plane is assigned to a United departure from Chicago O&#x27;Hare (ORD) in the next 48 hours, and none flew from here in the last 6 days."
    );
  });
});

describe("flown query plan", () => {
  test("reads each table by index, never scanning one", () => {
    const plan = (
      db.query(`EXPLAIN QUERY PLAN ${STARLINK_FLOWN_SQL}`).all("UA", 0, now) as {
        detail: string;
      }[]
    ).map((r) => r.detail);
    expect(plan.some((d) => /SEARCH dl USING INDEX idx_dl_departed/.test(d))).toBe(true);
    expect(plan.some((d) => /SEARCH fal USING INDEX idx_fal_tail/.test(d))).toBe(true);
    // The newer-sighting probe: the route index alone walks every row on the pair.
    expect(plan.some((d) => /SEARCH fal2 USING INDEX idx_fal_dep_time/.test(d))).toBe(true);
    expect(plan.filter((d) => /\bSCAN\b/.test(d))).toEqual([]);
  });
});

describe("sitemap rule", () => {
  test("lists exactly the airports whose page indexes", async () => {
    expect(await sitemapAirports()).toEqual(["DEN"]);
    expect(indexableAirports(createReaderFactory(db)("UA"))).toEqual(["DEN"]);
  });

  // The page leads with the airport's own local day, so its answer is new from
  // local midnight: the lastmod is that date, never a clock time that moves
  // with each departure. The page's dateModified tells the same story.
  test("an airport entry's lastmod is its local date, and the page's dateModified agrees", async () => {
    const xml = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const entry = xml.match(/<url>\s*<loc>[^<]*\/routes\/DEN<\/loc>[\s\S]*?<\/url>/)?.[0] ?? "";
    expect(entry).toContain("<changefreq>daily</changefreq>");
    const lastmod = entry.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
    expect(lastmod).toBe(airportLocalDate("DEN", Math.floor(Date.now() / 1000)) ?? undefined);
    expect(lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const body = await page("/routes/DEN");
    expect(body.match(/"dateModified":"([^"]+)"/)?.[1]).toBe(lastmod);
  });

  // The cached copy must not outlive the first airport's midnight, or its
  // lastmod says yesterday while the page says today.
  test("the sitemap is cached no longer than an hour or the next airport midnight", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await app.dispatch(req("/sitemap.xml", UA));
    const maxAge = Number(res.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1]);
    expect(Number.isInteger(maxAge)).toBe(true);
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(maxAge).toBeLessThanOrEqual(secondsToFirstLocalMidnight(["DEN"], before) ?? 3600);
  });

  test("llms.txt names an airport page the sitemap lists", async () => {
    const txt = await (await app.dispatch(req("/llms.txt", UA))).text();
    const linked = txt.match(new RegExp(`https://${UA}/routes/([A-Z]{3})`))?.[1];
    expect(linked).toBe("DEN");
  });
});

describe("links into the family", () => {
  test("the home page and /routes link each airport bar to its page", async () => {
    for (const path of ["/", "/routes"]) {
      const body = await page(path);
      expect(body, path).toContain('href="/routes/DEN"');
      for (const m of body.matchAll(/href="(\/routes\/[A-Z]{3})"/g)) {
        expect((await get(m[1])).status, `${path} links ${m[1]}`).toBe(200);
      }
    }
  });

  test("a route page links the airports at both ends whose page indexes", async () => {
    const body = await page("/route-planner/DEN/ORD");
    expect(body).toContain('href="/routes/DEN"');
    // ORD has a page (the route cache knows it) but no Starlink departures
    // flown, so it is noindex and gets no link.
    expect((await get("/routes/ORD")).status).toBe(200);
    expect(body).not.toContain('href="/routes/ORD"');
    // SFO has no United departure on file, so no page and no link.
    const sfo = await page("/route-planner/DEN/SFO");
    expect(sfo).toContain('href="/routes/DEN"');
    expect(sfo).not.toContain('href="/routes/SFO"');
    expect((await get("/routes/SFO")).status).toBe(404);
  });

  // The sitemap's rule, on route pages too: a thin airport's page serves but
  // is noindex, so a route page leaving from it links only the far end.
  test("a route page does not link a thin airport's noindex page", async () => {
    const gjt = await get("/routes/GJT");
    expect(gjt.status).toBe(200);
    expect(robots(await gjt.text())).toContain("noindex");
    const body = await page("/route-planner/GJT/DEN");
    expect(body).toContain('href="/routes/DEN"');
    expect(body).not.toContain('href="/routes/GJT"');
    for (const m of body.matchAll(/href="\/routes\/([A-Z]{3})"/g)) {
      expect(await sitemapAirports(), m[1]).toContain(m[1]);
    }
  });

  test("a tail page links only airports whose page indexes", async () => {
    const body = await page("/fleet/N2LIST");
    expect(body).toContain('href="/routes/DEN"');
    expect(body).not.toContain('href="/routes/GJT"');
    const listed = await sitemapAirports();
    for (const m of body.matchAll(/href="\/routes\/([A-Z]{3})"/g)) {
      expect(listed, m[1]).toContain(m[1]);
    }
  });

  test("a flight page links the airport its legs leave from", async () => {
    const body = await page("/check-flight/UA100");
    expect(body).toContain('href="/routes/DEN"');
    expect(visibleText(body).replace(/\s+/g, " ")).toContain("Starlink flights from Denver (DEN)");
    expect((await get("/routes/DEN")).status).toBe(200);
  });

  // A link from an indexed flight page to a noindex airport page passes
  // nothing, so flight pages link only airports the sitemap lists.
  test("a flight page does not link a thin airport's noindex page", async () => {
    expect((await get("/routes/GJT")).status).toBe(200);
    const body = await page("/check-flight/UA400");
    expect(body).toContain("UA400");
    expect(body).not.toContain('href="/routes/GJT"');
  });

  test("the airport links stop checking once they have enough", () => {
    const reader = createReaderFactory(db)("UA");
    let looked = 0;
    const checked: string[] = [];
    const counting = {
      ...reader,
      getAirportHistory: () => {
        looked++;
        return reader.getAirportHistory();
      },
      airportHasData: (a: string) => {
        checked.push(a);
        return reader.airportHasData(a);
      },
    };
    expect(firstIndexedAirports(counting, ["DEN", "GJT", "ORD"], 1)).toEqual(["DEN"]);
    expect(looked).toBe(1);
    // Only an airport past the index bar reaches the data query.
    looked = 0;
    expect(firstIndexedAirports(counting, ["GJT", "DEN", "DEN", "ORD"], 3)).toEqual(["DEN"]);
    expect(looked).toBe(3);
    expect(checked).toEqual(["DEN", "DEN"]);
  });

  test("an airport page names its place in a breadcrumb trail, indexed or not", async () => {
    for (const code of ["DEN", "GJT"]) {
      const body = await page(`/routes/${code}`);
      const trail = body.match(
        /\{"@context":"https:\/\/schema.org","@type":"BreadcrumbList"[^<]*/
      )?.[0];
      expect(trail, code).toBeDefined();
      const items = JSON.parse(trail ?? "{}").itemListElement as Array<{ item: string }>;
      expect(items.map((i) => i.item)).toEqual([
        `https://${UA}/`,
        `https://${UA}/routes`,
        `https://${UA}/routes/${code}`,
      ]);
    }
  });

  test("every link on an airport page serves", async () => {
    const body = await page("/routes/DEN");
    const hrefs = new Set(
      [...body.matchAll(/href="(\/(?:check-flight|route-planner|routes)[^"]*)"/g)].map((m) => m[1])
    );
    expect(hrefs.size).toBeGreaterThan(4);
    for (const href of hrefs) {
      expect((await get(href)).status, href).toBeLessThan(400);
    }
  });
});

/** Text a reader sees: tags, inline styles and scripts are not the page's words. */
function visibleText(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ");
}
