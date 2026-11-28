/**
 * A dated planner leg reads confirmed only when that departure's newest row
 * is on a verified Starlink tail, the row the flight check answers from.
 *
 * After a swap, upcoming_flights holds two rows for one departure: the old
 * tail's, kept until that tail is read again, and the new tail's, written
 * later. The flight check keeps the newest row of each departure; the
 * planner confirmed on any verified row, so a swap off a Starlink tail read
 * confirmed Yes on the planner and No on the flight's own check. Found in the
 * review of the SkyWest planner fix on 2026-11-28.
 *
 * Seeded on a fresh database: no outside request is made.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { createReaderFactory } from "../src/database/reader";
import { type ItineraryLeg, planItinerary } from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { addPlane, bodyOf, makeFreshDb, utc } from "./helpers";

const UA = SITES.united.canonicalHost;
// Three days out, so the fixture never ages into the past.
const DATE = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);

let db: Database;
let reader: ReturnType<ReturnType<typeof createReaderFactory>>;
let app: ReturnType<typeof createApp>;
let tails = 0;

/** One stored row of the 15:00Z departure, written `writtenAfterSec` after the first. */
function row(fn: string, dep: string, arr: string, wifi: string | null, writtenAfterSec: number) {
  const tail = `N6${String(++tails).padStart(3, "0")}`;
  addPlane(db, tail, wifi);
  const t = utc(`${DATE}T15:00:00Z`);
  db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
  ).run(tail, fn, dep, arr, t, t + 3600, t - 86400 + writtenAfterSec);
}

// The flight's own history says Starlink, so only the confirmed flag shows
// which row the planner read.
function history(fn: string) {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 12; i++) {
    db.query(
      `INSERT INTO starlink_verification_log (tail_number, flight_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
       VALUES (?, ?, 'united', ?, 1, 'Starlink', 1, 'UA')`
    ).run(`N7${fn.slice(2)}`, fn, now - 86400 * (i + 1));
  }
}

// Rows in the order they were written: the last one is the newest.
const CASES = [
  {
    name: "swap off a verified tail, two spellings",
    flight: "UA5801",
    dep: "DEN",
    arr: "GJT",
    rows: [
      ["SKW5801", "Starlink"],
      ["OO5801", "None"],
    ],
    confirmed: false,
  },
  {
    name: "swap off a verified tail, one spelling",
    flight: "UA5802",
    dep: "DEN",
    arr: "COS",
    rows: [
      ["SKW5802", "Starlink"],
      ["SKW5802", "None"],
    ],
    confirmed: false,
  },
  {
    name: "swap off a verified tail, spellings the other way",
    flight: "UA5807",
    dep: "DEN",
    arr: "RAP",
    rows: [
      ["OO5807", "Starlink"],
      ["SKW5807", "None"],
    ],
    confirmed: false,
  },
  {
    name: "swap onto a verified tail",
    flight: "UA5808",
    dep: "DEN",
    arr: "MSO",
    rows: [
      ["SKW5808", "None"],
      ["OO5808", "Starlink"],
    ],
    confirmed: true,
  },
  {
    name: "one row on a verified tail",
    flight: "UA5809",
    dep: "DEN",
    arr: "BZN",
    rows: [["SKW5809", "Starlink"]],
    confirmed: true,
  },
] as const;

beforeAll(() => {
  setAssignmentFetcher(async () => []);
  db = makeFreshDb();
  for (const c of CASES) {
    history(c.flight);
    c.rows.forEach(([fn, wifi], i) => row(fn, c.dep, c.arr, wifi, i * 600));
  }
  reader = createReaderFactory(db)("UA");
  app = createApp(db);
});
afterAll(() => {
  setAssignmentFetcher(null);
  db.close();
});

const mid = () => utc(`${DATE}T12:00:00Z`);

describe("the planner reads each departure's newest row", () => {
  for (const c of CASES) {
    test(`${c.flight} ${c.dep}-${c.arr}: ${c.name} reads confirmed=${c.confirmed}`, () => {
      const legs = planItinerary(reader, c.dep, c.arr, {
        maxItineraries: 12,
        maxStops: 0,
        targetDateUnix: mid(),
      })
        .flatMap((it) => it.legs)
        .filter((l) => l.flight_number === c.flight);
      expect(legs.length).toBeGreaterThan(0);
      for (const l of legs) expect(l.confirmed).toBe(c.confirmed);
    });
  }
});

describe("/api/plan-route agrees with /api/check-flight", () => {
  for (const c of CASES) {
    test(`${c.flight} ${c.dep}-${c.arr}: ${c.name}`, async () => {
      const plan = await bodyOf(
        app,
        `/api/plan-route?origin=${c.dep}&destination=${c.arr}&date=${DATE}`,
        UA
      );
      expect(plan.status).toBe(200);
      const legs = (
        (JSON.parse(plan.text) as { itineraries?: { legs: ItineraryLeg[] }[] }).itineraries ?? []
      )
        .flatMap((it) => it.legs)
        .filter((l) => l.flight_number === c.flight);
      expect(legs.length).toBeGreaterThan(0);

      const check = await bodyOf(
        app,
        `/api/check-flight?flight_number=${c.flight}&date=${DATE}&origin=${c.dep}&destination=${c.arr}`,
        UA
      );
      const { hasStarlink } = JSON.parse(check.text) as { hasStarlink: boolean };
      // A confirmed leg is one the flight check also answers Yes.
      for (const l of legs) {
        expect(l.confirmed).toBe(c.confirmed);
        if (l.confirmed) expect(hasStarlink).toBe(true);
      }
      if (!c.confirmed) expect(hasStarlink).toBe(false);
    });
  }
});
