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
import { logFlightAssignments } from "../src/database/assignment-log";
import { updateFlights, updateLastFlightCheck } from "../src/database/database";
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
      expect(verifiedYes).toBe(c.confirmed);
    });
  }
});

/**
 * Alaska's SkyWest flights through the real writers: a lookup logs the
 * number asked (AS3442), a tail read keeps FR24's SKW3442, so the newer tail
 * read is no sighting the whole-day read can rank. The planner must still let
 * it outrank the older Starlink sighting.
 */
describe("Alaska: a newer tail read under the operator's spelling outranks a sighting", () => {
  const HOUR = 3600;
  let asDb: Database;
  let asReader: ReturnType<ReturnType<typeof createReaderFactory>>;
  let asApp: ReturnType<typeof createApp>;
  let n = 0;

  function listed(wifi: string | null): string {
    const tail = `N7${String(++n).padStart(2, "0")}X`;
    addPlane(asDb, tail, wifi, { airline: "AS", aircraft: "Embraer E175" });
    asDb
      .query("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = ?")
      .run(DEP() - 12 * HOUR, tail);
    return tail;
  }
  const leg = (fn: string, dep: string, arr: string, at = DEP()) => ({
    flight_number: fn,
    departure_airport: dep,
    arrival_airport: arr,
    departure_time: at,
    arrival_time: at + HOUR,
  });
  function tailRead(tail: string, flights: ReturnType<typeof leg>[], at: number) {
    const now = Date.now;
    Date.now = () => at * 1000;
    try {
      updateFlights(asDb, tail, flights);
      updateLastFlightCheck(asDb, tail, true);
    } finally {
      Date.now = now;
    }
  }
  // The flight flew the day before on a Starlink tail, so the planner has the leg.
  function known(fn: string, dep: string, arr: string) {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 12; i++) {
      asDb
        .query(
          `INSERT INTO starlink_verification_log (tail_number, flight_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
           VALUES (?, ?, 'alaska', ?, 1, 'Starlink', 1, 'AS')`
        )
        .run(`N8${fn.slice(2)}`, fn, now - 86400 * (i + 1));
    }
    const t = utc(`${DAY_BEFORE}T15:00:00Z`);
    asDb
      .query(
        `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'AS')`
      )
      .run(listed("Starlink"), `SKW${fn.slice(2)}`, dep, arr, t, t + HOUR, now - 86400);
  }

  const AS_CASES: Case[] = [
    {
      name: "a lone sighting of a verified tail",
      flight: "AS3441",
      dep: "SEA",
      arr: "BOI",
      seed: () =>
        logFlightAssignments(
          asDb,
          "AS",
          listed("Starlink"),
          [leg("AS3441", "SEA", "BOI")],
          DEP() - 6 * HOUR
        ),
      confirmed: true,
    },
    {
      // The tail read put another tail on the flight after the sighting, and
      // a later read took it off again: its log row stays, under SKW3442.
      name: "a newer tail read under the operator's spelling",
      flight: "AS3442",
      dep: "SEA",
      arr: "GEG",
      seed: () => {
        logFlightAssignments(
          asDb,
          "AS",
          listed("Starlink"),
          [leg("AS3442", "SEA", "GEG")],
          DEP() - 6 * HOUR
        );
        const other = listed("None");
        tailRead(other, [leg("SKW3442", "SEA", "GEG")], DEP() - 4 * HOUR);
        tailRead(other, [leg("SKW3999", "SEA", "PDX", DEP() + 3 * HOUR)], DEP() - 2 * HOUR);
      },
      confirmed: false,
    },
  ];

  beforeAll(() => {
    asDb = makeFreshDb();
    for (const c of AS_CASES) {
      known(c.flight, c.dep, c.arr);
      c.seed();
    }
    asReader = createReaderFactory(asDb)("AS");
    asApp = createApp(asDb);
  });
  afterAll(() => asDb.close());

  for (const c of AS_CASES) {
    test(`${c.flight} ${c.dep}-${c.arr}: ${c.name} reads confirmed=${c.confirmed}`, async () => {
      const legs = planItinerary(asReader, c.dep, c.arr, {
        maxItineraries: 12,
        maxStops: 0,
        targetDateUnix: mid(),
      })
        .flatMap((it) => it.legs)
        // The planner names the leg by United's prefix (UA3442) whatever the scope.
        .filter((l) => l.flight_number.slice(2) === c.flight.slice(2));
      expect(legs.length).toBeGreaterThan(0);
      for (const l of legs) expect(l.confirmed).toBe(c.confirmed);

      const check = await bodyOf(
        asApp,
        `/api/check-any-flight?flight_number=${c.flight}&date=${DATE}&origin=${c.dep}&destination=${c.arr}`,
        HUB
      );
      const answer = JSON.parse(check.text) as { hasStarlink: boolean | null; confidence: string };
      const verifiedYes = answer.hasStarlink === true && answer.confidence === "verified";
      expect(verifiedYes).toBe(c.checkSays ?? c.confirmed);
    });
  }
});
