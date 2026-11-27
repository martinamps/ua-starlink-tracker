/**
 * The planner offers a connection only by way of airports it can place.
 *
 * The flight feed hands us a new code days before anyone adds it to the
 * tables. With no coordinates the detour bound could not be computed for a
 * path through it, and with no country it passed the domestic-hub gate, and
 * both gates kept what they could not check. Found on 2026-11-27: the MCP
 * flight answer offered Denver to Newark and Newark to London by way of
 * St. Kitts (SKB, then unplaced), with "?" for the hours.
 *
 * The line: every airport on a connection has coordinates. So an unplaced
 * code is never a hub, and a trip that itself starts or ends at one keeps its
 * nonstops and is offered no connection.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { createReaderFactory } from "../src/database/reader";
import {
  type Itinerary,
  emptyPlanMessage,
  planItinerary,
  planRoute,
} from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { AIRPORT_COORDS, AIRPORT_COUNTRY } from "../src/utils/airport-geo";
import { AIRPORT_NAMES } from "../src/utils/airport-names";
import { AIRPORT_TZ } from "../src/utils/airport-tz";
import { addFleet, addPlane, bodyOf, makeFreshDb, mcpDirect, toolText, utc } from "./helpers";

// Three letters no table holds.
const UNKNOWN = "QQX";
const UA = SITES.united.canonicalHost;
// Three days out, so the fixture never ages into the past.
const DATE = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
const PLACED = ["DEN", "EWR", "ORD", "IAD", "SFO", "SJU", "ANU", "LHR"];

let db: Database;
let factory: ReturnType<typeof createReaderFactory>;
let reader: ReturnType<ReturnType<typeof createReaderFactory>>;
let app: ReturnType<typeof createApp>;
let tails = 0;

function leg(fn: string, dep: string, arr: string, hhmm: string, hours: number, starlink = true) {
  const tail = `N9${String(++tails).padStart(3, "0")}`;
  addPlane(db, tail, starlink ? "Starlink" : null);
  if (!starlink) addFleet(db, tail, "negative", { verifiedWifi: "None" });
  const t = utc(`${DATE}T${hhmm}:00Z`);
  db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
  ).run(tail, fn, dep, arr, t, t + Math.round(hours * 3600), t);
}

beforeAll(() => {
  db = makeFreshDb();
  // Starlink flights to and from the unplaced airport.
  leg("UA2077", UNKNOWN, "EWR", "18:00", 4.5);
  leg("UA1142", "EWR", UNKNOWN, "13:00", 4.5);
  leg("UA2041", UNKNOWN, "IAD", "18:30", 4.2);
  leg("UA1150", "DEN", UNKNOWN, "12:00", 6);
  leg("UA1160", UNKNOWN, "SFO", "15:00", 8);
  // Starlink flights among placed airports.
  leg("UA5301", "DEN", "ORD", "13:00", 2.5);
  leg("UA5302", "ORD", "EWR", "17:00", 2);
  leg("UA5305", "IAD", "EWR", "12:00", 1.2);
  leg("UA5306", "SJU", "EWR", "14:00", 4);
  // The person's own flights, without Starlink: their answers carry the
  // connections table.
  leg("UA601", "DEN", "EWR", "15:00", 3.8, false);
  leg("UA603", "EWR", "LHR", "23:00", 7, false);
  leg("UA605", "ORD", UNKNOWN, "14:00", 5, false);
  factory = createReaderFactory(db);
  reader = factory("UA");
  app = createApp(db);
});
afterAll(() => db.close());

const mid = () => utc(`${DATE}T12:00:00Z`);
const plan = (o: string, d: string, maxStops = 2) =>
  planRoute(reader, o, d, { maxItineraries: 12, maxStops, targetDateUnix: mid() });
const routes = (its: Itinerary[]) => its.map((it) => it.legs.map((l) => l.route).join(" + "));
const mcp = async (scope: "UA" | "ALL", name: string, args: Record<string, string>) =>
  toolText(await mcpDirect(scope, factory, "tools/call", { name, arguments: args })).text;

describe("the fixture", () => {
  test("its made-up code is in no airport table", () => {
    expect(AIRPORT_COORDS[UNKNOWN]).toBeUndefined();
    expect(AIRPORT_COUNTRY[UNKNOWN]).toBeUndefined();
    expect(AIRPORT_TZ[UNKNOWN]).toBeUndefined();
    expect(AIRPORT_NAMES[UNKNOWN]).toBeUndefined();
    for (const code of PLACED) expect(AIRPORT_COORDS[code], code).toBeDefined();
  });
});

describe("a trip between two placed airports", () => {
  test("is never routed by way of an unplaced one, on every pair and stop limit", () => {
    for (const o of PLACED) {
      for (const d of PLACED) {
        if (o === d) continue;
        for (const maxStops of [1, 2, 3]) {
          for (const targetDateUnix of [mid(), undefined]) {
            const its = planItinerary(reader, o, d, {
              maxItineraries: 12,
              maxStops,
              targetDateUnix,
            });
            for (const it of its) {
              const label = `${o}-${d} ${routes([it])[0]}`;
              expect(it.via, label).not.toContain(UNKNOWN);
              for (const hub of it.via) expect(AIRPORT_COORDS[hub], label).toBeDefined();
              // The "?" of the fault: a connection whose hours nobody could work out.
              expect(it.total_flight_hours, label).not.toBeNull();
              expect(it.coverage_ratio, label).not.toBeNull();
            }
          }
        }
      }
    }
  });

  test("an all-Starlink connection through it is dropped (Denver to San Francisco)", () => {
    expect(routes(plan("DEN", "SFO").itineraries)).not.toContain(`DEN-${UNKNOWN} + ${UNKNOWN}-SFO`);
  });

  test("an any-flight connection through it is dropped in both directions", () => {
    // Starlink leg first, any flight on: Newark to London.
    expect(routes(plan("EWR", "LHR").itineraries)).not.toContain(`EWR-${UNKNOWN} + ${UNKNOWN}-LHR`);
    // Any flight first, Starlink leg on: London to Newark.
    expect(routes(plan("LHR", "EWR").itineraries)).not.toContain(`LHR-${UNKNOWN} + ${UNKNOWN}-EWR`);
  });

  test("keeps its connection through a placed hub", () => {
    expect(routes(plan("DEN", "EWR").itineraries)).toContain("DEN-ORD + ORD-EWR");
  });

  test("with nothing else to offer, the reason is not the unplaced airport", () => {
    const { itineraries, empty } = plan("DEN", "SFO");
    expect(itineraries).toEqual([]);
    expect(empty?.kind).not.toBe("unplaced_airport");
  });
});

describe("a trip to or from an unplaced airport", () => {
  test("keeps its nonstop", () => {
    expect(routes(plan("EWR", UNKNOWN).itineraries)).toEqual([`EWR-${UNKNOWN}`]);
    expect(routes(plan(UNKNOWN, "EWR").itineraries)).toEqual([`${UNKNOWN}-EWR`]);
    expect(routes(plan(UNKNOWN, "SFO").itineraries)).toEqual([`${UNKNOWN}-SFO`]);
  });

  test("is offered no connection, whose detour could not be checked", () => {
    for (const [o, d] of [
      ["ORD", UNKNOWN],
      ["SJU", UNKNOWN],
      [UNKNOWN, "ORD"],
      [UNKNOWN, "EWR"],
      [UNKNOWN, "LHR"],
    ]) {
      for (const it of plan(o, d, 3).itineraries) {
        expect(it.via, `${o}-${d} ${routes([it])[0]}`).toEqual([]);
      }
    }
  });

  test("with no nonstop to offer, says the airport is why", () => {
    for (const [o, d] of [
      ["ORD", UNKNOWN],
      [UNKNOWN, "ORD"],
    ]) {
      const { itineraries, empty } = plan(o, d);
      expect(itineraries).toEqual([]);
      expect(empty).toEqual({ kind: "unplaced_airport", airports: [UNKNOWN] });
    }
  });

  test("asked for nonstops only, the reason stays the plain one", () => {
    expect(plan("ORD", UNKNOWN, 0).empty).toEqual({ kind: "no_route", max_stops: 0 });
  });

  test("the reason reads as a sentence naming the airport", () => {
    const one = emptyPlanMessage({ kind: "unplaced_airport", airports: [UNKNOWN] }, UNKNOWN);
    expect(one).toContain(`${UNKNOWN} is not in our airport tables yet`);
    expect(one).toContain("No nonstop");
    const two = emptyPlanMessage({ kind: "unplaced_airport", airports: [UNKNOWN, "QQZ"] }, "QQZ");
    expect(two).toContain(`${UNKNOWN} and QQZ are not in our airport tables yet`);
  });
});

describe("the MCP answers built on the planner", () => {
  const viaCell = `| ${UNKNOWN} |`;

  test("check_flight's connections table names no unplaced hub", async () => {
    for (const fn of ["UA601", "UA603"]) {
      const text = await mcp("ALL", "check_flight", { flight_number: fn, date: DATE });
      expect(text, fn).toContain("<present_verbatim>");
      expect(text, fn).not.toContain(viaCell);
      expect(text, fn).not.toContain(UNKNOWN);
    }
  });

  test("check_flight still shows the connection through a placed hub", async () => {
    const text = await mcp("ALL", "check_flight", { flight_number: "UA601", date: DATE });
    expect(text).toContain("| UA5301 + UA5302 | ORD |");
  });

  test("a flight to the unplaced airport is answered, with no connection row", async () => {
    const text = await mcp("ALL", "check_flight", { flight_number: "UA605", date: DATE });
    expect(text).toContain(`| ORD→${UNKNOWN} | UA605 | direct — your flight |`);
    const rows = text.split("\n").filter((l) => l.startsWith(`| ORD→${UNKNOWN} |`));
    expect(rows).toHaveLength(1);
  });

  test("plan_starlink_itinerary names no unplaced hub and keeps the nonstop", async () => {
    const placed = await mcp("UA", "plan_starlink_itinerary", {
      origin: "EWR",
      destination: "LHR",
      date: DATE,
    });
    expect(placed).not.toContain(UNKNOWN);
    const to = await mcp("UA", "plan_starlink_itinerary", {
      origin: "EWR",
      destination: UNKNOWN,
      date: DATE,
    });
    expect(to).toContain("**DIRECT**");
    expect(to).toContain("UA1142");
    expect(to).not.toContain("via ");
    const none = await mcp("UA", "plan_starlink_itinerary", {
      origin: "ORD",
      destination: UNKNOWN,
      date: DATE,
    });
    expect(none).toContain(`${UNKNOWN} is not in our airport tables yet`);
    expect(none).not.toContain("via ");
  });
});

describe("/api/plan-route", () => {
  const get = async (o: string, d: string) => {
    const { status, text } = await bodyOf(
      app,
      `/api/plan-route?origin=${o}&destination=${d}&date=${DATE}`,
      UA
    );
    expect(status).toBe(200);
    return JSON.parse(text) as {
      itineraries: Array<{ via: string[]; total_flight_hours: number | null }>;
      message?: string;
    };
  };

  test("no itinerary goes by way of the unplaced airport", async () => {
    for (const [o, d] of [
      ["EWR", "LHR"],
      ["DEN", "SFO"],
      ["DEN", "EWR"],
    ]) {
      for (const it of (await get(o, d)).itineraries) {
        expect(it.via, `${o}-${d}`).not.toContain(UNKNOWN);
        expect(it.total_flight_hours, `${o}-${d}`).not.toBeNull();
      }
    }
  });

  test("a trip to it keeps the nonstop, or says why nothing is listed", async () => {
    const direct = await get("EWR", UNKNOWN);
    expect(direct.itineraries.map((it) => it.via)).toEqual([[]]);
    const none = await get("ORD", UNKNOWN);
    expect(none.itineraries).toEqual([]);
    expect(none.message).toContain(`${UNKNOWN} is not in our airport tables yet`);
  });
});
