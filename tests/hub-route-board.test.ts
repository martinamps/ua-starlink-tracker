/**
 * The hub's flight-by-flight route page: /routes/{origin}-{destination} on the
 * multi-airline host, each airline's nonstops on the pair in one list, every
 * row with the answer its airline's own route board gives.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { clockMinutes, hubRouteAirlines } from "../src/api/hub-route-board";
import { oddsCell } from "../src/components/route-flights-copy";
import { departureLocalDate } from "../src/database/assignment-log";
import { DAY_SEC, isoDateDaysAgo, unixNow } from "../src/database/sql/windows";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeFreshDb, readableText, req } from "./helpers";

const HUB = SITES.airline.canonicalHost;
const UA = SITES.united.canonicalHost;
const AS_HOST = SITES.alaska.canonicalHost;

const now = unixNow();
const dayStart = Math.floor(now / DAY_SEC) * DAY_SEC;
const at = (offsetDays: number, hourZ = 14) => dayStart + offsetDays * DAY_SEC + hourZ * 3600;

let db: Database;
let app: ReturnType<typeof createApp>;

function log(airline: string, fn: string, tail: string, dep: number, pair = ["SFO", "ORD"]) {
  db.query(
    `INSERT INTO flight_assignment_log
       (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number,
        starlink, departure_time, arrival_time, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    airline,
    fn,
    departureLocalDate(pair[0], dep),
    pair[0],
    pair[1],
    tail,
    dep,
    dep + 4 * 3600,
    now,
    now
  );
}

function route(fn: string, o: string, d: string) {
  db.query(
    `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, ?, ?, 15000, ?, ?, 5)`
  ).run(fn, o, d, now - 9 * DAY_SEC, now - 3600);
}

const page = (path: string, host = HUB) =>
  app.dispatch(
    req(path, host, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
  );

async function routeBoard(host: string, o: string, d: string) {
  const r = await app.dispatch(req(`/api/route-flights?origin=${o}&destination=${d}`, host));
  return r.json();
}

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N111UA", "Starlink", { aircraft: "Airbus A321-271NX" });
  addFleet(db, "N111UA", "confirmed", { aircraftType: "Airbus A321-271NX" });
  addFleet(db, "N222UA", "negative", { aircraftType: "Boeing 757-224" });
  addPlane(db, "N644AS", "Starlink", { airline: "AS", aircraft: "737-700" });
  addFleet(db, "N644AS", "confirmed", { airline: "AS", aircraftType: "737-700" });
  addFleet(db, "N655AS", "negative", { airline: "AS", aircraftType: "737-800" });
  // UA100 on the Starlink A321neo five days running, assigned again tomorrow.
  for (const d of [-7, -6, -5, -4, -3]) log("UA", "UA100", "N111UA", at(d));
  log("UA", "UA100", "N111UA", at(1));
  addFlight(db, "N111UA", "UA100", "SFO", at(1), { arrivalAirport: "ORD", lastUpdated: now });
  // UA200 later in the day on the 757.
  for (const d of [-6, -5, -4, -3]) log("UA", "UA200", "N222UA", at(d, 20));
  // Alaska's own flight on the pair.
  log("AS", "AS999", "N644AS", at(-3, 16));
  log("AS", "AS999", "N644AS", at(-2, 16));
  addFlight(db, "N644AS", "AS999", "SFO", at(1, 16), {
    arrivalAirport: "ORD",
    airline: "AS",
    lastUpdated: now,
  });
  route("UA100", "SFO", "ORD");
  route("UA200", "SFO", "ORD");
  route("AS999", "SFO", "ORD");
  // A pair that only the route cache remembers: served, but nothing this week.
  db.query(
    `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES ('UA900', 'SFO', 'BOS', 20000, ?, ?, 3)`
  ).run(now - 80 * DAY_SEC, now - 70 * DAY_SEC);
  app = createApp(db);
});

describe("hub /routes/{origin}-{destination}", () => {
  test("lists each airline's nonstops in one table", async () => {
    const res = await page("/routes/SFO-ORD");
    expect(res.status).toBe(200);
    const html = await res.text();
    const text = readableText(html);
    for (const fn of ["UA100", "UA200", "AS999"]) expect(text).toContain(fn);
    expect(text).toContain("United");
    expect(text).toContain("Alaska");
    expect(html).toContain(
      '<link rel="canonical" href="https://airlinestarlinktracker.com/routes/SFO-ORD"'
    );
  });

  test("each row's answer is its airline's own route board's", async () => {
    const html = await (await page("/routes/SFO-ORD")).text();
    for (const [host, airline] of [
      [UA, "UA"],
      [AS_HOST, "AS"],
    ] as const) {
      const board = await routeBoard(host, "SFO", "ORD");
      expect(board.flights.length).toBeGreaterThan(0);
      for (const f of board.flights) {
        expect(f.flight_number.startsWith(airline)).toBe(true);
        const row = html.slice(html.indexOf(`>${f.flight_number}<`));
        const cell = row.slice(0, row.indexOf("</tr>"));
        expect(readableText(cell)).toContain(oddsCell(f));
        if (f.departure_label) expect(readableText(cell)).toContain(f.departure_label);
      }
    }
  });

  test("each airline's source is named, the swap caveat said once", async () => {
    const text = readableText(await (await page("/routes/SFO-ORD")).text())
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, " ");
    expect(text).toMatch(/United: Odds come from [^.]+\./);
    expect(text).toMatch(/Alaska: Odds come from [^.]+\./);
    expect(text.split("Planes can be swapped before departure.").length).toBe(2);
  });

  test("a row links its flight's page on its airline's own site", async () => {
    const html = await (await page("/routes/SFO-ORD")).text();
    expect(html).toContain(`href="https://${UA}/check-flight/UA100"`);
    expect(html).toContain(`href="https://${AS_HOST}/check-flight/AS999"`);
    expect(html).toContain(`href="https://${UA}/route-planner/SFO/ORD"`);
  });

  test("the assigned Starlink plane ranks first, as on the airline's board", async () => {
    const html = await (await page("/routes/SFO-ORD")).text();
    expect(html.indexOf(">UA100<")).toBeLessThan(html.indexOf(">UA200<"));
  });

  test("a date reaches every airline's board", async () => {
    const date = isoDateDaysAgo(-1);
    const html = await (await page(`/routes/SFO-ORD?date=${date}`)).text();
    expect(html).toContain(`value="${date}"`);
    expect(html).toMatch(
      /href="https:\/\/unitedstarlinktracker\.com\/check-flight\/UA100\/\d{4}-\d{2}-\d{2}"/
    );
  });

  test("one spelling per pair; unknown, same-airport and unflown pairs are no page", async () => {
    const lower = await page("/routes/sfo-ord");
    expect(lower.status).toBe(301);
    expect(lower.headers.get("location")).toBe(`https://${HUB}/routes/SFO-ORD`);
    const slash = await page("/routes/SFO-ORD/");
    expect(slash.status).toBe(301);
    for (const p of [
      "/routes/SFO-SFO",
      "/routes/ZZZ-QQQ",
      "/routes/SFO-ORD-DEN",
      "/routes/SFO",
      "/routes/DEN-LAX",
    ]) {
      expect((await page(p)).status).toBe(404);
    }
  });

  test("a pair with nothing this week serves, but does not index", async () => {
    const res = await page("/routes/SFO-BOS");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("noindex");
    expect(readableText(html)).toContain("No nonstop seen this week.");
    expect(await (await page("/routes/SFO-ORD")).text()).not.toContain("noindex");
  });

  test("the way back is linked only where it serves", async () => {
    const html = await (await page("/routes/SFO-ORD")).text();
    expect(html).not.toContain('href="/routes/ORD-SFO"');
  });

  test("only airlines answered flight by flight take part", () => {
    for (const a of hubRouteAirlines()) {
      expect(a.publicInHub).toBe(true);
      expect(a.communitySource).toBeUndefined();
    }
  });

  test("airline sites keep their airport pages and get no pair page", async () => {
    expect((await page("/routes/SFO-ORD", UA)).status).toBe(404);
    expect((await page("/routes/SFO", UA)).status).not.toBe(500);
  });
});

describe("hub route search", () => {
  test("two codes or names go to the pair's page", async () => {
    const r = await page("/routes/?from=sfo&to=ORD");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/routes/SFO-ORD");
    const date = isoDateDaysAgo(-2);
    const d = await page(`/routes/?from=SFO&to=ORD&date=${date}`);
    expect(d.headers.get("location")).toBe(`/routes/SFO-ORD?date=${date}`);
  });

  test("a bad date is dropped, not passed on", async () => {
    const d = await page("/routes/?from=SFO&to=ORD&date=2001-01-01");
    expect(d.headers.get("location")).toBe("/routes/SFO-ORD");
  });

  test("a name that fits several airports offers them, unindexed", async () => {
    const r = await page("/routes/?from=london&to=SFO");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("noindex");
    expect(readableText(html)).toContain("Several airports match");
    expect(html).toContain("from=LHR");
  });

  test("text that names no airport says so, and markup stays text", async () => {
    const r = await page(`/routes/?from=${encodeURIComponent("<b>zz</b>")}&to=SFO`);
    const html = await r.text();
    expect(html).not.toContain("<b>zz</b>");
    expect(readableText(html)).toContain("No airport matches");
  });

  test("an empty search goes home", async () => {
    const r = await page("/routes/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`https://${HUB}/`);
  });
});

describe("hub compare-route", () => {
  test("names the pair's flight page only where it serves", async () => {
    const yes = await (
      await app.dispatch(req("/api/compare-route?origin=SFO&destination=ORD", HUB))
    ).json();
    expect(yes.flights_page).toBe("/routes/SFO-ORD");
    const no = await (
      await app.dispatch(req("/api/compare-route?origin=DEN&destination=LAX", HUB))
    ).json();
    expect(no.flights_page).toBeNull();
  });
});

describe("clockMinutes", () => {
  test("orders clock labels across noon and midnight", () => {
    expect(clockMinutes("12:05 AM")).toBe(5);
    expect(clockMinutes("8:15 AM")).toBe(495);
    expect(clockMinutes("12:30 PM")).toBe(750);
    expect(clockMinutes("11:59 PM")).toBe(1439);
    expect(clockMinutes(null)).toBe(1440);
  });
});
