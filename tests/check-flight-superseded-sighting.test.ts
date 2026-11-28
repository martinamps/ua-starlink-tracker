/**
 * The stored flight check (the hub's REST answers and its MCP check_flight)
 * can answer from a logged sighting: a listed tail that a lookup named on the
 * flight after our last read of that tail. Only the newest tail logged on the
 * departure counts, and the departure is the flight's, not one spelling's.
 *
 * A lookup logs the number it was asked (AS3448). A tail read logs the
 * flight as FR24 calls it, which the log keeps for SkyWest-for-Alaska
 * (SKW3448): SKW and OO fly United's numbers too, so they don't collapse to
 * AS. United's own codes all collapse to UA, so a UA departure has one
 * spelling in the log; the UA cases guard the answers that must not move.
 *
 * Seeded through the real writers on a fresh database; no outside request.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { logFlightAssignments } from "../src/database/assignment-log";
import { updateFlights, updateLastFlightCheck } from "../src/database/database";
import { createApp } from "../src/server/app";
import { addPlane, bodyOf, makeFreshDb, mcpTool, utc } from "./helpers";

const HUB = "airlinestarlinktracker.com";
// Three days out, so the fixture never ages into the past.
const DATE = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const DEP = () => utc(`${DATE}T15:00:00Z`);
const HOUR = 3600;

let db: Database;
let app: ReturnType<typeof createApp>;
let tails = 0;

/** A listed tail the flight updater has not read since before the sightings. */
function listed(airline: "UA" | "AS", wifi: string | null): string {
  const tail = `N6${String(++tails).padStart(2, "0")}X`;
  addPlane(db, tail, wifi, { airline, aircraft: "Embraer E175" });
  db.query("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = ?").run(
    DEP() - 12 * HOUR,
    tail
  );
  return tail;
}

const leg = (fn: string, dep: string, arr: string, at = DEP()) => ({
  flight_number: fn,
  departure_airport: dep,
  arrival_airport: arr,
  departure_time: at,
  arrival_time: at + HOUR,
});

/** A request lookup's sighting, as logResolvedAssignments writes it. */
function lookupSaw(
  airline: string,
  fn: string,
  dep: string,
  arr: string,
  tail: string,
  at: number
) {
  logFlightAssignments(db, airline, tail, [leg(fn, dep, arr)], at);
}

/** The flight updater's read of one tail at `at`, as pollTailFlights runs it. */
function tailRead(tail: string, flights: ReturnType<typeof leg>[], at: number) {
  const now = Date.now;
  Date.now = () => at * 1000;
  try {
    updateFlights(db, tail, flights);
    updateLastFlightCheck(db, tail, true);
  } finally {
    Date.now = now;
  }
}

interface Case {
  name: string;
  flight: string;
  dep: string;
  arr: string;
  seed: () => void;
  verifiedYes: boolean;
}

const CASES: Case[] = [
  {
    name: "AS: a lone sighting of a verified tail",
    flight: "AS3441",
    dep: "SEA",
    arr: "BOI",
    seed: () => lookupSaw("AS", "AS3441", "SEA", "BOI", listed("AS", "Starlink"), DEP() - 6 * HOUR),
    verifiedYes: true,
  },
  {
    // The tail read put the other tail on the flight after the sighting, and
    // a later read took it off again: its log row stays, under SKW3442.
    name: "AS: a newer tail read under the operator's spelling",
    flight: "AS3442",
    dep: "SEA",
    arr: "GEG",
    seed: () => {
      lookupSaw("AS", "AS3442", "SEA", "GEG", listed("AS", "Starlink"), DEP() - 6 * HOUR);
      const other = listed("AS", "None");
      tailRead(other, [leg("SKW3442", "SEA", "GEG")], DEP() - 4 * HOUR);
      tailRead(other, [leg("SKW3999", "SEA", "PDX", DEP() + 3 * HOUR)], DEP() - 2 * HOUR);
    },
    verifiedYes: false,
  },
  {
    name: "AS: an older tail read under the operator's spelling",
    flight: "AS3443",
    dep: "SEA",
    arr: "MSO",
    seed: () => {
      const other = listed("AS", "None");
      tailRead(other, [leg("SKW3443", "SEA", "MSO")], DEP() - 8 * HOUR);
      tailRead(other, [leg("SKW3998", "SEA", "PDX", DEP() + 3 * HOUR)], DEP() - 7 * HOUR);
      lookupSaw("AS", "AS3443", "SEA", "MSO", listed("AS", "Starlink"), DEP() - 6 * HOUR);
    },
    verifiedYes: true,
  },
  {
    name: "AS: a newer tail read from another airport",
    flight: "AS3444",
    dep: "SEA",
    arr: "BZN",
    seed: () => {
      lookupSaw("AS", "AS3444", "SEA", "BZN", listed("AS", "Starlink"), DEP() - 6 * HOUR);
      const other = listed("AS", "None");
      tailRead(other, [leg("SKW3444", "BZN", "SEA")], DEP() - 4 * HOUR);
      tailRead(other, [leg("SKW3997", "SEA", "PDX", DEP() + 3 * HOUR)], DEP() - 2 * HOUR);
    },
    verifiedYes: true,
  },
  {
    name: "UA: a lone sighting of a verified tail",
    flight: "UA5521",
    dep: "ORD",
    arr: "GRR",
    seed: () => lookupSaw("UA", "UA5521", "ORD", "GRR", listed("UA", "Starlink"), DEP() - 6 * HOUR),
    verifiedYes: true,
  },
  {
    name: "UA: a newer tail read under the operator's spelling",
    flight: "UA5522",
    dep: "ORD",
    arr: "MSN",
    seed: () => {
      lookupSaw("UA", "UA5522", "ORD", "MSN", listed("UA", "Starlink"), DEP() - 6 * HOUR);
      const other = listed("UA", "None");
      tailRead(other, [leg("SKW5522", "ORD", "MSN")], DEP() - 4 * HOUR);
      tailRead(other, [leg("SKW5999", "ORD", "DSM", DEP() + 3 * HOUR)], DEP() - 2 * HOUR);
    },
    verifiedYes: false,
  },
];

beforeAll(() => {
  setAssignmentFetcher(async () => []);
  db = makeFreshDb();
  for (const c of CASES) c.seed();
  app = createApp(db);
});
afterAll(() => {
  setAssignmentFetcher(null);
  db.close();
});

type Answer = { hasStarlink: boolean | null; confidence?: string };
const verified = (a: Answer) => a.hasStarlink === true && a.confidence === "verified";

describe("a sighting outranked by a newer tail under another spelling is no verified Yes", () => {
  for (const c of CASES) {
    const q = `flight_number=${c.flight}&date=${DATE}`;
    const scoped = `${q}&origin=${c.dep}&destination=${c.arr}`;

    test(`${c.flight}: ${c.name}, hub /api/check-any-flight`, async () => {
      for (const p of [q, scoped]) {
        const r = await bodyOf(app, `/api/check-any-flight?${p}`, HUB);
        expect(r.status).toBe(200);
        expect(verified(JSON.parse(r.text) as Answer)).toBe(c.verifiedYes);
      }
    });

    test(`${c.flight}: ${c.name}, hub /api/check-flight`, async () => {
      for (const p of [q, scoped]) {
        const r = await bodyOf(app, `/api/check-flight?${p}`, HUB);
        expect(r.status).toBe(200);
        const body = JSON.parse(r.text) as { hasStarlink: boolean | null; flights: unknown[] };
        expect(Array.isArray(body.flights)).toBe(true);
        expect(body.hasStarlink === true).toBe(c.verifiedYes);
      }
    });

    test(`${c.flight}: ${c.name}, hub MCP check_flight`, async () => {
      const { text, isError } = await mcpTool(app, HUB, "check_flight", {
        flight_number: c.flight,
        date: DATE,
      });
      expect(isError).toBe(false);
      expect(text.includes("verified Starlink aircraft")).toBe(c.verifiedYes);
    });
  }
});
