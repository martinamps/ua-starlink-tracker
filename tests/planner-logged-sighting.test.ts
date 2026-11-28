/**
 * A dated planner leg reads confirmed where the flight check answers verified
 * Yes from a logged sighting: a listed tail an earlier lookup named on the
 * flight, newer than our last read of that tail's schedule. The planner read
 * the schedule alone, so the day's answer could say verified Yes while the
 * planner's leg read unconfirmed (UA5406 ORD-GRR on 2026-11-28).
 *
 * The other cases are the ones the flight check doesn't answer Yes from, and
 * the planner must not confirm: a sighting older than the tail's last
 * schedule read, a withdrawn one, a newer tail on the departure (in either
 * spelling), a schedule row for the number on the date, an unverified tail.
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
const HUB = "airlinestarlinktracker.com";
// Three days out, so the fixture never ages into the past.
const DATE = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const DAY_BEFORE = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
const DEP = () => utc(`${DATE}T15:00:00Z`);

let db: Database;
let reader: ReturnType<ReturnType<typeof createReaderFactory>>;
let app: ReturnType<typeof createApp>;
let tails = 0;

function plane(wifi: string | null, lastFlightCheck: number | null = null): string {
  const tail = `N5${String(++tails).padStart(3, "0")}`;
  addPlane(db, tail, wifi);
  db.query("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = ?").run(
    lastFlightCheck,
    tail
  );
  return tail;
}

/** A lookup's sighting of `tail` on the date's 15:00Z departure, `ageSec` before it. */
function sighting(
  fn: string,
  dep: string,
  arr: string,
  tail: string,
  ageSec: number,
  withdrawn = false
) {
  const t = DEP();
  db.query(
    `INSERT INTO flight_assignment_log (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number, starlink, departure_time, arrival_time, first_seen, last_seen, withdrawn_at)
     VALUES ('UA', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
  ).run(fn, DATE, dep, arr, tail, t, t + 3600, t - ageSec, t - ageSec, withdrawn ? t : null);
}

function schedule(
  fn: string,
  dep: string,
  arr: string,
  tail: string,
  iso: string,
  writtenAt: number
) {
  const t = utc(iso);
  db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
  ).run(tail, fn, dep, arr, t, t + 3600, writtenAt);
}

// The flight's own history says Starlink, and it flew the day before on a
// listed tail, so the planner has the leg; only the confirmed flag shows
// what the planner read for the date.
function known(fn: string, op: string, dep: string, arr: string) {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 12; i++) {
    db.query(
      `INSERT INTO starlink_verification_log (tail_number, flight_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
       VALUES (?, ?, 'united', ?, 1, 'Starlink', 1, 'UA')`
    ).run(`N9${fn.slice(2)}`, fn, now - 86400 * (i + 1));
  }
  schedule(op, dep, arr, plane("Starlink"), `${DAY_BEFORE}T15:00:00Z`, now - 86400);
}

interface Case {
  name: string;
  flight: string;
  dep: string;
  arr: string;
  seed: () => void;
  confirmed: boolean;
  /** Where the flight check's stored answer differs, and why that is its fault. */
  checkSays?: boolean;
}

const CASES: Case[] = [
  {
    name: "a fresh sighting of a verified tail",
    flight: "UA5406",
    dep: "ORD",
    arr: "GRR",
    seed: () => sighting("UA5406", "ORD", "GRR", plane("Starlink"), 3600),
    confirmed: true,
  },
  {
    name: "a fresh sighting under the operator's spelling",
    flight: "UA5411",
    dep: "ORD",
    arr: "MSN",
    seed: () => sighting("SKW5411", "ORD", "MSN", plane("Starlink"), 3600),
    confirmed: true,
  },
  {
    name: "a sighting older than the tail's last schedule read",
    flight: "UA5412",
    dep: "ORD",
    arr: "CID",
    seed: () => sighting("UA5412", "ORD", "CID", plane("Starlink", DEP() - 60), 3600),
    confirmed: false,
  },
  {
    name: "a withdrawn sighting",
    flight: "UA5413",
    dep: "ORD",
    arr: "DSM",
    seed: () => sighting("UA5413", "ORD", "DSM", plane("Starlink"), 3600, true),
    confirmed: false,
  },
  {
    name: "a newer tail logged on the departure, same spelling",
    flight: "UA5414",
    dep: "ORD",
    arr: "FSD",
    seed: () => {
      sighting("UA5414", "ORD", "FSD", plane("Starlink"), 7200);
      sighting("UA5414", "ORD", "FSD", plane("None"), 3600);
    },
    confirmed: false,
  },
  {
    name: "a newer listed tail logged on the departure, other spelling",
    flight: "UA5415",
    dep: "ORD",
    arr: "FAR",
    seed: () => {
      sighting("SKW5415", "ORD", "FAR", plane("Starlink"), 7200);
      sighting("OO5415", "ORD", "FAR", plane("None"), 3600);
    },
    confirmed: false,
    // getListedSightings keeps the newest tail per spelling, not per
    // departure, so the flight check still answers from the older Starlink
    // tail here. The planner keeps the newest across spellings and doesn't.
    checkSays: true,
  },
  {
    name: "a schedule row for the number on the date",
    flight: "UA5416",
    dep: "ORD",
    arr: "TVC",
    seed: () => {
      sighting("UA5416", "ORD", "TVC", plane("Starlink"), 600);
      schedule("SKW5416", "ORD", "TVC", plane("None"), `${DATE}T15:00:00Z`, DEP() - 3600);
    },
    confirmed: false,
  },
  {
    name: "a fresh sighting of a listed, unverified tail",
    flight: "UA5417",
    dep: "ORD",
    arr: "LAN",
    seed: () => sighting("UA5417", "ORD", "LAN", plane(null), 3600),
    confirmed: false,
  },
];

beforeAll(() => {
  setAssignmentFetcher(async () => []);
  db = makeFreshDb();
  for (const c of CASES) {
    known(c.flight, `SKW${c.flight.slice(2)}`, c.dep, c.arr);
    c.seed();
  }
  reader = createReaderFactory(db)("UA");
  app = createApp(db);
});
afterAll(() => {
  setAssignmentFetcher(null);
  db.close();
});

const mid = () => utc(`${DATE}T12:00:00Z`);

describe("the planner confirms a leg from a logged sighting as the flight check does", () => {
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

describe("/api/plan-route agrees with the stored flight check", () => {
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

      // The hub's answer reads what lookups stored, with no lookup of its own.
      const check = await bodyOf(
        app,
        `/api/check-any-flight?flight_number=${c.flight}&date=${DATE}&origin=${c.dep}&destination=${c.arr}`,
        HUB
      );
      const answer = JSON.parse(check.text) as { hasStarlink: boolean | null; confidence: string };
      const verifiedYes = answer.hasStarlink === true && answer.confidence === "verified";
      for (const l of legs) expect(l.confirmed).toBe(c.confirmed);
      expect(verifiedYes).toBe(c.checkSays ?? c.confirmed);
    });
  }
});
