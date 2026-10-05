/**
 * "Every flight on this route": GET /api/route-flights, the board on the route
 * pages, and the entry points into it. Snapshot tests assert shapes only; the
 * synthetic DB pins the behavior (per-leg odds, codeshare collapse, weekday
 * gaps, one-offs, past dates, tenant isolation) with rows it seeds itself.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { ROUTE_BOARD_MIN_OBSERVATIONS, buildRouteFlightBoard } from "../src/api/route-flights";
import { departureLocalDate } from "../src/database/assignment-log";
import { getSitemapRoutes } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { DAY_SEC, isoDateDaysAgo, unixNow } from "../src/database/sql/windows";
import { createApp } from "../src/server/app";
import {
  addFleet,
  addFlight,
  addPlane,
  bodyOf,
  jsonOf,
  makeFreshDb,
  openSnapshot,
  req,
} from "./helpers";

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

const page = (path: string, host = UA, a = app) =>
  a.dispatch(req(path, host, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } }));

function someRoute() {
  const routes = getSitemapRoutes(db, "UA");
  if (routes.length === 0) throw new Error("snapshot has no routes — run bun run test:setup");
  return routes[0];
}

/** Far enough out that no assignment or live lookup answers: a pure forecast. */
const FORECAST_DATE = isoDateDaysAgo(-20);

const ROW_KEYS = [
  "flight_number",
  "typical_departure",
  "departure_label",
  "weekdays",
  "departures_logged",
  "established",
  "operates_on_date",
  "probability",
  "n_observations",
  "n_effective",
  "trend",
  "history",
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
    expect(b.airline).toBe(AIRLINES.UA.shortName);
    expect(b.date).toBeNull();
    expect(typeof b.nonstop).toBe("boolean");
    expect(b.min_observations).toBe(ROUTE_BOARD_MIN_OBSERVATIONS);
    expect(b.note).toMatch(/^Odds come from .+\. Planes can be swapped before departure\.$/);
    for (const f of b.flights) {
      expect(Object.keys(f).sort()).toEqual([...ROW_KEYS].sort());
      expect(f.flight_number).toMatch(/^UA\d{1,4}$/);
      // The caveat lives once, in the note — never repeated per row.
      expect(f.summary).not.toMatch(/swap|guarantee/i);
      if (f.typical_departure) expect(f.typical_departure).toMatch(/^\d{1,2}:\d{2}\s[AP]M$/);
      expect([null, "up", "down"]).toContain(f.trend);
      if (f.enough_history && f.basis === "flight_history") {
        expect(f.n_effective).toBeGreaterThan(0);
        expect(f.n_effective).toBeLessThanOrEqual(f.n_observations + 1e-9);
      }
      if (f.history) {
        expect(Object.keys(f.history).sort()).toEqual([
          "last_14_days",
          "recent",
          "weeks",
          "window",
        ]);
        expect(f.history.weeks.length).toBe(8);
        expect(f.history.recent.length).toBeLessThanOrEqual(6);
        for (const w of f.history.weeks) expect(w.starlink).toBeLessThanOrEqual(w.flights);
      }
    }
  });

  test("odds equal /api/check-flight scoped to the same leg", async () => {
    const { origin, destination } = someRoute();
    const b = await jsonOf(
      app,
      `/api/route-flights?origin=${origin}&destination=${destination}&date=${FORECAST_DATE}`,
      UA
    );
    for (const f of b.flights
      .filter((x: { probability: number | null }) => x.probability !== null)
      .slice(0, 3)) {
      const c = await jsonOf(
        app,
        `/api/check-flight?flight_number=${f.flight_number}&date=${FORECAST_DATE}&origin=${origin}&destination=${destination}`,
        UA
      );
      expect(c.prediction?.probability).toBeCloseTo(f.probability, 6);
    }
  });

  test("a date keeps every row and echoes its weekday", async () => {
    const { origin, destination } = someRoute();
    const plain = await jsonOf(
      app,
      `/api/route-flights?origin=${origin}&destination=${destination}`,
      UA
    );
    const dated = await jsonOf(
      app,
      `/api/route-flights?origin=${origin}&destination=${destination}&date=${FORECAST_DATE}`,
      UA
    );
    expect(dated.date).toBe(FORECAST_DATE);
    expect(dated.weekday).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    expect(dated.flights.length).toBe(plain.flights.length);
  });

  test("bad input is a 400, never a 500", async () => {
    for (const q of [
      "",
      "origin=SFO",
      "origin=SFO&destination=SFO",
      "origin=SF&destination=ORD",
      "origin=XXX&destination=ORD",
      "origin=SFO&destination=ORD&date=2026-02-30",
      "origin=SFO&destination=ORD&date=tomorrow",
      `origin=SFO&destination=ORD&date=${isoDateDaysAgo(3)}`,
      `origin=SFO&destination=ORD&date=${isoDateDaysAgo(-400)}`,
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

  test("/api/compare-route refuses a same-airport pair", async () => {
    const { status } = await bodyOf(app, "/api/compare-route?origin=SFO&destination=SFO", HUB);
    expect(status).toBe(400);
  });
});

describe("route page", () => {
  test("leads with the question, then the board, and nothing that contradicts it", async () => {
    const { origin, destination } = someRoute();
    const res = await page(`/route-planner/${origin}/${destination}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(
      `<title>Which ${AIRLINES.UA.shortName} ${origin} to ${destination} Flights Have Starlink?`
    );
    expect(body).toContain(`Which ${origin} to ${destination} flights have Starlink?`);
    expect(body).toContain('id="all-flights"');
    expect(body).toContain("Nonstop flights");
    expect(body).not.toContain("Flight numbers on this route");
    expect(body).not.toContain("Upcoming Starlink flights");
    expect(body.match(/swapped/g)?.length ?? 0).toBe(1);
    expect(body).not.toContain("(verified)");
  });

  test("a date filters the board; a bad one is ignored", async () => {
    const { origin, destination } = someRoute();
    for (const q of [`?date=${FORECAST_DATE}`, "?date=nope", "?date=2020-01-01"]) {
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
    const home = await (await page("/")).text();
    expect(home).toContain('id="home-route-board-link"');
    expect(home).toContain("Or see which flights on a route have Starlink →");
    expect(await (await page("/", HUB)).text()).not.toContain('id="home-route-board-link"');
  });
});

// ── synthetic: behavior on rows the test seeds ───────────────────────────────

describe("board behavior (synthetic)", () => {
  const now = unixNow();
  const dayStart = Math.floor(now / DAY_SEC) * DAY_SEC;
  // 14:00Z is 7am at SFO in either daylight or standard time.
  const at = (offsetDays: number, hourZ = 14) => dayStart + offsetDays * DAY_SEC + hourZ * 3600;
  let sdb: Database;
  let sapp: ReturnType<typeof createApp>;

  function log(
    airline: string,
    fn: string,
    tail: string,
    dep: number,
    pair: [string, string] = ["SFO", "ORD"],
    lastSeen = now
  ) {
    sdb
      .query(
        `INSERT INTO flight_assignment_log
           (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number,
            starlink, departure_time, arrival_time, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
      )
      .run(
        airline,
        fn,
        departureLocalDate(pair[0], dep),
        pair[0],
        pair[1],
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
    // UA100 is a through flight: a 757 SFO-ORD, then a Starlink A321neo ORD-IAD.
    // Five logged days (-7..-3), so two weekdays are missing from its log.
    for (const d of [-7, -6, -5, -4, -3]) {
      log("UA", "UA100", "N222UA", at(d));
      log("UA", "UA100", "N111UA", at(d, 20), ["ORD", "IAD"]);
    }
    // Tomorrow's SFO-ORD leg already has the A321neo assigned.
    log("UA", "UA100", "N111UA", at(1));
    // A regional codeshare under its operating spelling, two days.
    log("UA", "SKW5212", "N222UA", at(-2, 16));
    log("UA", "SKW5212", "N222UA", at(-1, 16));
    // A one-off: logged on this pair once.
    log("UA", "UA777", "N111UA", at(-2, 18));
    // Alaska's own flight on the same pair.
    log("AS", "AS999", "N644AS", at(-2));
    // The planner prices edges from the live schedule.
    addFlight(sdb, "N111UA", "UA100", "SFO", at(1), { arrivalAirport: "ORD", lastUpdated: now });
    addFlight(sdb, "N111UA", "UA100", "ORD", at(1, 20), {
      arrivalAirport: "IAD",
      lastUpdated: now,
    });
    // Logged on the A321neo yesterday, then gone from its refreshed schedule:
    // a swap to a plane the updater doesn't follow.
    log("UA", "UA300", "N111UA", at(1, 22), ["SFO", "ORD"], now - 7200);
    // UA400 SFO-DEN changed metal: ADS-B saw 757s for six weeks, then
    // A321neos for two; the log has the last few days.
    const sighting = sdb.query(
      "INSERT INTO adsb_flight_draws (flight_number, tail_number, first_seen, last_seen) VALUES (?, ?, ?, ?)"
    );
    for (let d = 1; d <= 56; d++) {
      const t = at(-d, 15) + 600;
      sighting.run("UA400", d <= 14 ? "N111UA" : "N222UA", t, t + 3600);
    }
    for (const d of [-3, -2, -1]) log("UA", "UA400", "N111UA", at(d, 15), ["SFO", "DEN"]);
    addFlight(sdb, "N111UA", "UA400", "SFO", at(1, 15), {
      arrivalAirport: "DEN",
      lastUpdated: now,
    });
    // The route page serves only pairs the route cache knows.
    sdb
      .query(
        `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
         VALUES ('UA100', 'SFO', 'ORD', 15000, ?, ?, 5)`
      )
      .run(at(-7), at(-3));
    sapp = createApp(sdb);
  });

  afterAll(() => sdb.close());

  const board = (date?: string, origin = "SFO", destination = "ORD") =>
    buildRouteFlightBoard(AIRLINES.UA, createReaderFactory(sdb)("UA"), origin, destination, {
      date,
      nowSec: now,
    });
  const row = (b: ReturnType<typeof board>, fn: string) => {
    const r = b.flights.find((f) => f.flight_number === fn);
    if (!r) throw new Error(`${fn} missing from the board`);
    return r;
  };

  test("odds are per leg: the 757 leg and the A321neo leg of one number differ", () => {
    const sfo = row(board(), "UA100");
    const ord = row(board(undefined, "ORD", "IAD"), "UA100");
    expect(sfo.probability).toBe(0);
    expect(sfo.aircraft_types).toEqual(["757"]);
    expect(ord.probability).toBeGreaterThan(0.5);
  });

  test("the board equals check-flight scoped to that leg", async () => {
    const date = isoDateDaysAgo(-20, now);
    const b = board(date);
    const c = await jsonOf(
      sapp,
      `/api/check-flight?flight_number=UA100&date=${date}&origin=SFO&destination=ORD`,
      UA
    );
    expect(c.prediction.probability).toBeCloseTo(row(b, "UA100").probability ?? -1, 6);
  });

  test("plan-route prices a leg as the board and scoped check-flight do", async () => {
    const date = isoDateDaysAgo(-20, now);
    const fromBoard = row(board(date, "ORD", "IAD"), "UA100").probability;
    const check = await jsonOf(
      sapp,
      `/api/check-flight?flight_number=UA100&date=${date}&origin=ORD&destination=IAD`,
      UA
    );
    const plan = await jsonOf(sapp, "/api/plan-route?origin=ORD&destination=IAD", UA);
    const leg = plan.itineraries
      .flatMap(
        (it: { legs: Array<{ flight_number: string; route: string; probability: number }> }) =>
          it.legs
      )
      .find(
        (l: { flight_number: string; route: string }) =>
          l.flight_number === "UA100" && l.route === "ORD-IAD"
      );
    expect(fromBoard).not.toBeNull();
    expect(leg?.probability).toBeCloseTo(fromBoard ?? -1, 6);
    expect(check.prediction.probability).toBeCloseTo(fromBoard ?? -1, 6);
  });

  test("a leg that changed metal reads its new mix, and every surface agrees", async () => {
    const date = isoDateDaysAgo(-20, now);
    const r = row(board(date, "SFO", "DEN"), "UA400");
    expect(r.probability).toBeGreaterThan(0.7);
    expect(r.trend).toBe("up");
    expect(r.n_effective).toBeLessThan(r.n_observations ?? 0);
    expect(r.summary).toMatch(/from \d+ recent flights\./);
    const last = r.history?.weeks.at(-1);
    expect(last?.flights).toBeGreaterThanOrEqual(6);
    expect(last?.starlink).toBe(last?.flights ?? -1);
    expect(r.history?.weeks[0].starlink).toBe(0);

    const check = await jsonOf(
      sapp,
      `/api/check-flight?flight_number=UA400&date=${date}&origin=SFO&destination=DEN`,
      UA
    );
    const plan = await jsonOf(sapp, `/api/plan-route?origin=SFO&destination=DEN&date=${date}`, UA);
    const leg = plan.itineraries
      .flatMap(
        (it: { legs: Array<{ flight_number: string; route: string; probability: number }> }) =>
          it.legs
      )
      .find(
        (l: { flight_number: string; route: string }) =>
          l.flight_number === "UA400" && l.route === "SFO-DEN"
      );
    // Seconds apart, so decay moves the fourth decimal at most.
    expect(check.prediction.probability).toBeCloseTo(r.probability ?? -1, 4);
    expect(leg?.probability).toBeCloseTo(r.probability ?? -1, 4);
  });

  test("operating spellings collapse to the marketed number", () => {
    const fns = board().flights.map((f) => f.flight_number);
    expect(fns).toContain("UA5212");
    expect(fns).not.toContain("SKW5212");
  });

  test("an assigned plane answers the row; the forecast moves to the detail", () => {
    const r = row(board(), "UA100");
    expect(r.assignment?.tail_number).toBe("N111UA");
    expect(r.assignment?.starlink).toBe("verified");
    expect(r.assignment?.past).toBe(false);
    expect(r.assignment?.label).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} · N111UA$/);
    expect(r.departure_label).toMatch(/^usually 7:00 AM$/);
  });

  test("a plane swapped off a future leg no longer answers it", () => {
    const r = board().flights.find((f) => f.flight_number === "UA300");
    expect(r?.assignment ?? null).toBeNull();
  });

  test("a past date names the plane that flew", () => {
    const yesterday = departureLocalDate("SFO", at(-1, 16));
    const r = row(board(yesterday), "UA5212");
    expect(r.assignment?.past).toBe(true);
    expect(r.assignment?.label).toContain("flew on N222UA");
  });

  test("a weekday missing from the log is listed last, never dropped", () => {
    const unseen = departureLocalDate("SFO", at(6));
    const b = board(unseen);
    const r = row(b, "UA100");
    expect(r.operates_on_date).toBe(false);
    const seenOrUnknown = b.flights.filter((f) => f.established && f.operates_on_date !== false);
    const idx = b.flights.indexOf(r);
    for (const f of seenOrUnknown) expect(b.flights.indexOf(f)).toBeLessThan(idx);
  });

  test("a one-off sighting is marked and listed last", () => {
    const b = board();
    const r = row(b, "UA777");
    expect(r.established).toBe(false);
    expect(b.flights.at(-1)?.flight_number).toBe("UA777");
  });

  test("times carry no zone name, so a date across DST can't mislabel them", () => {
    const winter = isoDateDaysAgo(-60, now);
    for (const f of board(winter).flights) {
      if (f.typical_departure) expect(f.typical_departure).not.toMatch(/[PMCE][DS]T/);
    }
  });

  test("few draws give the type share, not a history percentage", () => {
    for (const f of board().flights) {
      if (f.basis === "aircraft_type") expect(f.enough_history).toBe(false);
      if ((f.n_observations ?? 0) < ROUTE_BOARD_MIN_OBSERVATIONS) {
        expect(f.enough_history).toBe(false);
      }
    }
  });

  test("the page lists each board number once and no older sections", async () => {
    const body = await (await page("/route-planner/SFO/ORD", UA, sapp)).text();
    for (const fn of ["UA100", "UA5212", "UA777"]) {
      expect(body.match(new RegExp(`href="/check-flight/${fn}"`, "g"))?.length, fn).toBe(1);
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
