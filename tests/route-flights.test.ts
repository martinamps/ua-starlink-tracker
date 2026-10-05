/**
 * "Every flight on this route": GET /api/route-flights, the board on the route
 * pages, and the entry points into it. Snapshot tests assert shapes only; the
 * synthetic DB pins the behavior (codeshare collapse, assignment wording,
 * weekday filter, tenant isolation) with rows it seeds itself.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { ROUTE_BOARD_MIN_OBSERVATIONS, buildRouteFlightBoard } from "../src/api/route-flights";
import { departureLocalDate } from "../src/database/assignment-log";
import { getSitemapRoutes } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { DAY_SEC, unixNow } from "../src/database/sql/windows";
import { createApp } from "../src/server/app";
import { addFleet, addPlane, bodyOf, jsonOf, makeFreshDb, openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const AS_HOST = SITES.alaska.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const QR_HOST = SITES.qatar.canonicalHost;

let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const page = (path: string, host = UA) =>
  app.dispatch(
    req(path, host, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
  );

function someRoute() {
  const routes = getSitemapRoutes(db, "UA");
  if (routes.length === 0) throw new Error("snapshot has no routes — run bun run test:setup");
  return routes[0];
}

const ROW_KEYS = [
  "flight_number",
  "typical_departure",
  "weekdays",
  "departures_logged",
  "operates_on_date",
  "probability",
  "n_observations",
  "confidence",
  "basis",
  "enough_history",
  "odds_label",
  "aircraft_types",
  "assignment",
  "summary",
];

describe("GET /api/route-flights", () => {
  test("answers a served pair with the board shape, CORS-open and cacheable", async () => {
    const { origin, destination } = someRoute();
    const res = await app.dispatch(
      req(`/api/route-flights?origin=${origin}&destination=${destination}`, UA)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("max-age");
    const b = await res.json();
    expect(b.origin).toBe(origin);
    expect(b.destination).toBe(destination);
    expect(b.airline).toBe(AIRLINES.UA.name);
    expect(b.date).toBeNull();
    expect(typeof b.nonstop).toBe("boolean");
    expect(b.min_observations).toBe(ROUTE_BOARD_MIN_OBSERVATIONS);
    expect(b.note).toContain("Planes can be swapped");
    expect(Array.isArray(b.flights)).toBe(true);
    for (const f of b.flights) {
      expect(Object.keys(f).sort()).toEqual([...ROW_KEYS].sort());
      expect(f.flight_number).toMatch(/^UA\d{1,4}$/);
      // The caveat lives once, in the note — never repeated per row.
      expect(f.summary).not.toMatch(/swap|guarantee/i);
    }
  });

  test("rows are ordered by odds, rows without enough history last", async () => {
    const { origin, destination } = someRoute();
    const b = await jsonOf(
      app,
      `/api/route-flights?origin=${origin}&destination=${destination}`,
      UA
    );
    const key = (f: { enough_history: boolean; probability: number | null }) =>
      (f.enough_history ? 2 : 0) + (f.probability ?? -1);
    for (let i = 1; i < b.flights.length; i++) {
      expect(key(b.flights[i - 1])).toBeGreaterThanOrEqual(key(b.flights[i]));
    }
  });

  test("odds match the flight's own prediction", async () => {
    const { origin, destination } = someRoute();
    const b = await jsonOf(
      app,
      `/api/route-flights?origin=${origin}&destination=${destination}`,
      UA
    );
    for (const f of b.flights.slice(0, 3)) {
      const p = await jsonOf(app, `/api/predict-flight?flight_number=${f.flight_number}`, UA);
      expect(f.probability).toBe(p.probability);
      expect(f.n_observations).toBe(p.n_observations);
    }
  });

  test("a date filters to that weekday and is echoed", async () => {
    const { origin, destination } = someRoute();
    const b = await jsonOf(
      app,
      `/api/route-flights?origin=${origin}&destination=${destination}&date=2026-10-08`,
      UA
    );
    expect(b.date).toBe("2026-10-08");
    expect(b.weekday).toBe("Thu");
    for (const f of b.flights) expect(f.operates_on_date).not.toBe(false);
  });

  test("bad input is a 400, never a 500", async () => {
    for (const q of [
      "",
      "origin=SFO",
      "origin=SFO&destination=SFO",
      "origin=SF&destination=ORD",
      "origin=SFO&destination=ORD&date=2026-02-30",
      "origin=SFO&destination=ORD&date=tomorrow",
    ]) {
      const { status } = await bodyOf(app, `/api/route-flights?${q}`, UA);
      expect(status, q).toBe(400);
    }
  });

  test("K-prefixed ICAO codes resolve to the IATA pair", async () => {
    const b = await jsonOf(app, "/api/route-flights?origin=KSFO&destination=KORD", UA);
    expect(b.origin).toBe("SFO");
    expect(b.destination).toBe("ORD");
  });

  test("hosts without the planner 404", async () => {
    for (const host of [HUB, QR_HOST]) {
      const { status } = await bodyOf(app, "/api/route-flights?origin=SFO&destination=ORD", host);
      expect(status, host).toBe(404);
    }
  });
});

describe("route page board", () => {
  test("leads with the question and the nonstop board", async () => {
    const { origin, destination } = someRoute();
    const res = await page(`/route-planner/${origin}/${destination}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(
      `<title>Which ${AIRLINES.UA.shortName} ${origin} to ${destination} Flights Have Starlink?`
    );
    expect(body).toContain(`Which ${origin} to ${destination} flights have Starlink?`);
    const board = body.indexOf('id="all-flights"');
    expect(board).toBeGreaterThan(0);
    expect(body.indexOf("Flight numbers on this route")).toBeGreaterThan(board);
    const section = body.slice(board, body.indexOf("Flight numbers on this route"));
    expect(section.match(/swapped/g)?.length ?? 0).toBe(1);
    expect(section).not.toContain("(verified)");
  });

  test("a date filters the board; a bad one is ignored", async () => {
    const { origin, destination } = someRoute();
    for (const q of ["?date=2026-10-08", "?date=nope"]) {
      const res = await page(`/route-planner/${origin}/${destination}${q}`);
      expect(res.status, q).toBe(200);
      expect(await res.text()).toContain('id="all-flights"');
    }
  });

  test("the planner renders the board container and a date field", async () => {
    const body = await (await page("/route-planner")).text();
    expect(body).toContain('id="route-flights"');
    expect(body).toContain('id="travel-date"');
  });

  test("airline homepages link into the planner; the hub does not", async () => {
    expect(await (await page("/")).text()).toContain('id="home-route-board-link"');
    expect(await (await page("/", HUB)).text()).not.toContain('id="home-route-board-link"');
  });
});

// ── synthetic: behavior on rows the test seeds ───────────────────────────────

describe("board behavior (synthetic)", () => {
  const now = unixNow();
  const dayStart = Math.floor(now / DAY_SEC) * DAY_SEC;
  // 14:00Z is 7am at SFO in either daylight or standard time.
  const at = (offsetDays: number) => dayStart + offsetDays * DAY_SEC + 14 * 3600;
  let sdb: Database;
  let sapp: ReturnType<typeof createApp>;

  function log(airline: string, fn: string, tail: string, dep: number, lastSeen = now) {
    sdb
      .query(
        `INSERT INTO flight_assignment_log
           (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number,
            starlink, departure_time, arrival_time, first_seen, last_seen)
         VALUES (?, ?, ?, 'SFO', 'ORD', ?, NULL, ?, ?, ?, ?)`
      )
      .run(
        airline,
        fn,
        departureLocalDate("SFO", dep),
        tail,
        dep,
        dep + 4 * 3600,
        lastSeen,
        lastSeen
      );
  }

  beforeAll(() => {
    sdb = makeFreshDb();
    addPlane(sdb, "N111UA", "Starlink", { aircraft: "Airbus A321-271NX" });
    addFleet(sdb, "N111UA", "confirmed", { aircraftType: "Airbus A321-271NX" });
    addFleet(sdb, "N222UA", "negative", { aircraftType: "Boeing 757-224" });
    addPlane(sdb, "N644AS", "Starlink", { airline: "AS", aircraft: "737-700" });
    // UA100: five logged days, offsets -7..-3, plus tomorrow on an equipped tail.
    for (const d of [-7, -6, -5, -4, -3]) log("UA", "UA100", "N222UA", at(d));
    log("UA", "UA100", "N111UA", at(1));
    // A regional codeshare logged under its operating spelling.
    log("UA", "SKW5212", "N222UA", at(-2));
    // Alaska's own flight on the same pair.
    log("AS", "AS999", "N644AS", at(-2));
    sapp = createApp(sdb);
  });

  afterAll(() => sdb.close());

  const board = (date?: string) =>
    buildRouteFlightBoard(AIRLINES.UA, createReaderFactory(sdb)("UA"), "SFO", "ORD", {
      date,
      nowSec: now,
    });

  test("operating spellings collapse to the marketed number", () => {
    const fns = board().flights.map((f) => f.flight_number);
    expect(fns).toContain("UA5212");
    expect(fns).not.toContain("SKW5212");
  });

  test("the upcoming tail is named with its equipped status", () => {
    const row = board().flights.find((f) => f.flight_number === "UA100");
    expect(row?.assignment?.tail_number).toBe("N111UA");
    expect(row?.assignment?.starlink).toBe("verified");
    expect(row?.assignment?.label).toMatch(
      /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} · N111UA · Starlink$/
    );
    expect(row?.typical_departure).toMatch(/^7:00 AM P[DS]T$/);
    expect(row?.aircraft_types[0]).toBe("757");
    expect(row?.summary).toContain(`Next: ${row?.assignment?.label}.`);
  });

  test("a weekday the flight was never seen on drops it; thin history stays", () => {
    const unseen = new Date((dayStart + 6 * DAY_SEC) * 1000).toISOString().slice(0, 10);
    const fns = board(unseen).flights.map((f) => f.flight_number);
    expect(fns).not.toContain("UA100");
    expect(fns).toContain("UA5212");
  });

  test("no flight history means no percentage", () => {
    for (const f of board().flights) {
      if ((f.n_observations ?? 0) < ROUTE_BOARD_MIN_OBSERVATIONS) {
        expect(f.enough_history).toBe(false);
        expect(f.odds_label).toBe("Not enough history");
      }
    }
  });

  test("each host sees only its own airline's flights", async () => {
    const ua = await bodyOf(sapp, "/api/route-flights?origin=SFO&destination=ORD", UA);
    expect(ua.status).toBe(200);
    expect(ua.text).toContain("UA100");
    expect(ua.text).not.toContain("AS999");
    expect(ua.text).not.toContain("N644AS");

    const as = await bodyOf(sapp, "/api/route-flights?origin=SFO&destination=ORD", AS_HOST);
    expect(as.status).toBe(200);
    expect(as.text).toContain("AS999");
    expect(as.text).not.toContain("UA100");
    expect(as.text).not.toContain("N111UA");
  });
});
