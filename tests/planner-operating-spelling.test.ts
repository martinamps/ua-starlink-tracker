/**
 * A dated planner leg reads confirmed whatever spelling the departure is
 * stored under.
 *
 * One SkyWest flight reaches upcoming_flights as SKW5771 on one row and
 * OO5771 on another. The route graph keeps an option per stored spelling;
 * when both run on the day with the same odds, the planner keeps the first,
 * and OO sorts before SKW. The confirmed-assignment lookup keyed on the
 * option's own spelling, so when the searched day's verified row was the SKW
 * one, the OO option shown missed it. Found live on 2026-11-28: UA5771 DEN-ASE, UA5993 SLC-ORD
 * and UA5904 ORD-MSN were verified Yes on their dated flight pages and
 * unconfirmed on the planner; the OO-spelled UA6019 and UA5604 read Yes.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { createReaderFactory } from "../src/database/reader";
import { type ItineraryLeg, planItinerary } from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { addPlane, bodyOf, makeFreshDb, utc } from "./helpers";

const UA = SITES.united.canonicalHost;
// Three days out, so the fixture never ages into the past.
const DATE = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const WEEK_BEFORE = new Date(Date.parse(`${DATE}T00:00:00Z`) - 7 * 86400_000)
  .toISOString()
  .slice(0, 10);

let db: Database;
let reader: ReturnType<ReturnType<typeof createReaderFactory>>;
let app: ReturnType<typeof createApp>;
let tails = 0;

function row(
  fn: string,
  dep: string,
  arr: string,
  day: string,
  hhmm: string,
  hours: number,
  verified: boolean
) {
  const tail = `N8${String(++tails).padStart(3, "0")}`;
  addPlane(db, tail, verified ? "Starlink" : null);
  const t = utc(`${day}T${hhmm}:00Z`);
  db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
  ).run(tail, fn, dep, arr, t, t + Math.round(hours * 3600), t);
}

// Each pair: the searched day's departure on a verified Starlink tail under
// one spelling, the same weekday a week before under the other, on a tail
// never verified.
const CASES = [
  {
    flight: "UA5771",
    dep: "DEN",
    arr: "ASE",
    today: "SKW5771",
    before: "OO5771",
    hhmm: "15:00",
    hours: 0.8,
  },
  {
    flight: "UA5993",
    dep: "SLC",
    arr: "ORD",
    today: "SKW5993",
    before: "OO5993",
    hhmm: "14:00",
    hours: 3,
  },
  {
    flight: "UA6019",
    dep: "SFO",
    arr: "SLC",
    today: "OO6019",
    before: "SKW6019",
    hhmm: "17:00",
    hours: 1.8,
  },
  // One spelling only, as most departures are.
  {
    flight: "UA5904",
    dep: "ORD",
    arr: "MSN",
    today: "SKW5904",
    before: null,
    hhmm: "19:00",
    hours: 0.9,
  },
  {
    flight: "UA5604",
    dep: "IAH",
    arr: "MFE",
    today: "OO5604",
    before: null,
    hhmm: "16:00",
    hours: 1.2,
  },
] as const;

// Each flight's own history says Starlink, as the live ones did: the
// confirmed tier then adds no odds, so only the confirmed flag shows the miss.
function history(fn: string, tail: string) {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 12; i++) {
    db.query(
      `INSERT INTO starlink_verification_log (tail_number, flight_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
       VALUES (?, ?, 'united', ?, 1, 'Starlink', 1, 'UA')`
    ).run(tail, fn, now - 86400 * (i + 1));
  }
}

beforeAll(() => {
  db = makeFreshDb();
  for (const c of CASES) {
    history(c.flight, `N7${c.flight.slice(2)}`);
    row(c.today, c.dep, c.arr, DATE, c.hhmm, c.hours, true);
    if (c.before) row(c.before, c.dep, c.arr, WEEK_BEFORE, c.hhmm, c.hours, false);
  }
  reader = createReaderFactory(db)("UA");
  app = createApp(db);
});
afterAll(() => db.close());

const mid = () => utc(`${DATE}T12:00:00Z`);

describe("a dated nonstop on a verified tail", () => {
  for (const c of CASES) {
    test(`${c.flight} ${c.dep}-${c.arr} (searched day stored as ${c.today}) reads confirmed on every leg`, () => {
      const legs = planItinerary(reader, c.dep, c.arr, {
        maxItineraries: 12,
        maxStops: 0,
        targetDateUnix: mid(),
      })
        .flatMap((it) => it.legs)
        .filter((l) => l.flight_number === c.flight);
      expect(legs.length).toBeGreaterThan(0);
      for (const l of legs) expect(l.confirmed).toBe(true);
    });
  }

  test("an undated search confirms nothing", () => {
    for (const c of CASES) {
      const legs = planItinerary(reader, c.dep, c.arr, { maxItineraries: 12, maxStops: 0 }).flatMap(
        (it) => it.legs
      );
      for (const l of legs) expect(l.confirmed).toBe(false);
    }
  });
});

describe("/api/plan-route", () => {
  for (const c of CASES) {
    test(`${c.flight} ${c.dep}-${c.arr} is confirmed on the searched day`, async () => {
      const { status, text } = await bodyOf(
        app,
        `/api/plan-route?origin=${c.dep}&destination=${c.arr}&date=${DATE}`,
        UA
      );
      expect(status).toBe(200);
      const body = JSON.parse(text) as { itineraries?: { legs: ItineraryLeg[] }[] };
      const legs = (body.itineraries ?? [])
        .flatMap((it) => it.legs)
        .filter((l) => l.flight_number === c.flight);
      expect(legs.length).toBeGreaterThan(0);
      for (const l of legs) expect(l.confirmed).toBe(true);
    });
  }
});
