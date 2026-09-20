/**
 * MCP answers that must agree with themselves and with the other tools: the
 * fleet filter vs get_fleet_stats, the alternatives table vs the headline and
 * the date asked about, search output vs what check_flight accepts, and the
 * hub's route tools vs the carriers it answers per flight.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { handleMcpRequest } from "../src/api/mcp-server";
import type { Scope } from "../src/database/reader";
import { createReaderFactory } from "../src/database/reader";
import { addQatarRow, makeSyntheticDb, mcpReq } from "./helpers";

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const isoDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

let db: Database;
let factory: ReturnType<typeof createReaderFactory>;

function plane(tail: string, airline: string, fleet: string): void {
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
     VALUES ('E175', 'StrLnk', '2026-01-01', ?, 'SkyWest', ?, 'Starlink', ?)`
  ).run(tail, fleet, airline);
}

function flight(tail: string, fn: string, o: string, d: string, dep: number, airline: string) {
  db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tail, fn, o, d, dep, dep + 2 * 3600, dep, airline);
}

async function call(scope: Scope, name: string, args: Record<string, unknown>) {
  const r = await handleMcpRequest(
    mcpReq("unitedstarlinktracker.com", "tools/call", { name, arguments: args }),
    scope,
    factory
  );
  const result = (await r.json()).result as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: result.content[0].text, isError: result.isError === true };
}

async function rpc(scope: Scope, method: string) {
  const r = await handleMcpRequest(mcpReq("unitedstarlinktracker.com", method, {}), scope, factory);
  return (await r.json()).result;
}

// The flight asked about: mainline number, no history, so the fleet prior is
// low enough (<20%) to embed the alternatives table.
const FN = "UA1212";
const tomorrow = () => isoDate(now() + DAY);

beforeAll(() => {
  db = makeSyntheticDb();
  plane("N660QX", "AS", "horizon");
  plane("N897AK", "AS", "mainline");
  plane("N196SY", "AS", "horizon");
  plane("N204HA", "HA", "mainline");
  const soon = now() + 6 * 3600;
  flight("N196SY", "OO3292", "SAN", "AUS", soon, "AS");
  flight("N204HA", "ASA9917", "GUM", "CRK", soon, "HA");

  // Route history says IDA→ORD; tomorrow the number flies SFO→PSP.
  db.query(
    `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, 'IDA', 'ORD', 12600, ?, ?, 20)`
  ).run(FN, now() - 3 * DAY, now() - 3600);
  const dep = Math.floor(Date.parse(`${tomorrow()}T18:00:00Z`) / 1000);
  setAssignmentFetcher(async (fn) =>
    fn === FN
      ? [
          {
            origin: "SFO",
            destination: "PSP",
            departure_time: dep,
            arrival_time: dep + 5400,
            tail_number: null,
            aircraft_model: null,
          },
        ]
      : []
  );
  factory = createReaderFactory(db);
});

afterAll(() => {
  setAssignmentFetcher(null);
  db.close();
});

describe("list_starlink_aircraft", () => {
  test("express covers every non-mainline label (AS stores 'horizon')", async () => {
    const express = await call("AS", "list_starlink_aircraft", { fleet: "express" });
    expect(express.text).toContain("N660QX");
    expect(express.text).not.toContain("N897AK");
    const mainline = await call("AS", "list_starlink_aircraft", { fleet: "mainline" });
    expect(mainline.text).toContain("N897AK");
    expect(mainline.text).not.toContain("N660QX");
  });
});

describe("predict_flight_starlink alternatives", () => {
  test("a dated query uses that date's route, not the flight's usual one", async () => {
    const { text } = await call("UA", "predict_flight_starlink", {
      flight_number: FN,
      date: tomorrow(),
    });
    expect(text).toContain("<present_verbatim>");
    expect(text).toContain("SFO→PSP");
    expect(text).not.toContain("IDA→ORD");
  });

  test("the person's own row repeats the headline odds", async () => {
    const { text } = await call("UA", "predict_flight_starlink", { flight_number: FN });
    const headline = text.match(/~(\d+)% Starlink probability/)?.[1];
    expect(headline).toBeDefined();
    const own = text.split("\n").filter((l) => l.includes("direct — your flight"));
    expect(own.length).toBeGreaterThan(0);
    for (const row of own) {
      expect(row).toContain(`| ${FN} |`);
      expect(row).toContain(`| ~${headline}% |`);
    }
    expect(text).not.toContain("direct — baseline");
  });

  test("junk flight numbers are rejected before any lookup", async () => {
    for (const flight_number of ["XX", "UA12345", "UA"]) {
      const r = await call("UA", "predict_flight_starlink", { flight_number });
      expect(r.isError, flight_number).toBe(true);
      expect(r.text).toContain("not a valid flight number");
    }
  });
});

describe("check_flight", () => {
  test("the hub never calls a missing near-term assignment unusual", async () => {
    const { text } = await call("ALL", "check_flight", { flight_number: FN, date: tomorrow() });
    expect(text).toContain("Starlink probability");
    expect(text).not.toContain("unusual");
    expect(text).not.toContain("not yet published");
  });

  test("impossible calendar dates are errors on every dated tool", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["check_flight", { flight_number: FN, date: "2026-02-30" }],
      ["predict_flight_starlink", { flight_number: FN, date: "2026-02-30" }],
      ["plan_starlink_itinerary", { origin: "SFO", destination: "EWR", date: "2026-02-30" }],
    ];
    for (const [name, args] of cases) {
      const r = await call("UA", name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text).toContain("invalid date");
    }
  });

  test("the hub points operating-carrier codes at the marketing number", async () => {
    const r = await call("ALL", "check_flight", { flight_number: "SKW5000", date: tomorrow() });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("UA5000");
    expect(r.text).not.toContain("Airline not tracked");
    const untracked = await call("ALL", "check_flight", {
      flight_number: "DL100",
      date: tomorrow(),
    });
    expect(untracked.text).toContain("Airline not tracked");
  });
});

describe("search_starlink_flights", () => {
  test("prints the number check_flight takes, never a raw callsign", async () => {
    const as = await call("AS", "search_starlink_flights", { origin: "SAN" });
    expect(as.text).toContain("AS3292 SAN→AUS");
    expect(as.text).not.toContain("OO3292");
    expect(as.text).toMatch(/^Found 1 confirmed Starlink flight for/);
    const ha = await call("HA", "search_starlink_flights", { origin: "GUM" });
    expect(ha.text).toContain("AS9917 GUM→CRK");
    expect(ha.text).not.toContain("ASA9917");
  });
});

describe("route tools", () => {
  test("K-prefixed ICAO codes resolve; the same airport twice is an error", async () => {
    const icao = await call("UA", "predict_route_starlink", {
      origin: "KSFO",
      destination: "KEWR",
    });
    expect(icao.text).not.toContain("Unknown airport code");
    for (const name of ["predict_route_starlink", "plan_starlink_itinerary"]) {
      const same = await call("UA", name, { origin: "SFO", destination: "sfo" });
      expect(same.isError, name).toBe(true);
      expect(same.text).toContain("are the same");
    }
  });

  test("the hub answers a Qatar-only route from the published schedule", async () => {
    addQatarRow(db, "QR1", now() + DAY, "Starlink", { equipmentCode: "77W" });
    addQatarRow(db, "QR3", now() + DAY + 3600, "None", { equipmentCode: "388" });
    for (const name of ["predict_route_starlink", "plan_starlink_itinerary"]) {
      const { text, isError } = await call("ALL", name, { origin: "DOH", destination: "LHR" });
      expect(isError, name).toBe(false);
      expect(text).toContain("Qatar Airways");
      expect(text).toMatch(/\d+ of \d+ scheduled departures/);
      expect(text).not.toContain("No route data");
    }
  });

  test("an unserved hub route still names the per-flight carriers", async () => {
    const { text } = await call("ALL", "predict_route_starlink", {
      origin: "DOH",
      destination: "CDG",
    });
    expect(text).toContain("No route data");
    expect(text).toContain("Qatar Airways");
  });
});

describe("tool descriptions per host", () => {
  const tool = (tools: { name: string; description: string }[], name: string) =>
    tools.find((t) => t.name === name)?.description ?? "";

  test("model-less hosts don't promise the itinerary planner or its tables", async () => {
    const as = await rpc("AS", "tools/list");
    expect(tool(as.tools, "plan_starlink_itinerary")).not.toContain("PRIMARY TRAVEL-PLANNING TOOL");
    expect(tool(as.tools, "predict_flight_starlink")).toContain("an Alaska Airlines flight number");
    const init = await rpc("AS", "initialize");
    expect(init.instructions).not.toContain("EMBED a markdown table");
    expect(init.instructions).not.toContain("multi-stop, coverage ratio");

    const ua = await rpc("UA", "initialize");
    expect(ua.instructions).toContain("EMBED a markdown table");
    const hub = await rpc("ALL", "tools/list");
    expect(tool(hub.tools, "check_flight")).toContain("tracked-airline flight number");
    const fnHint = hub.tools.find((t: { name: string }) => t.name === "check_flight").inputSchema
      .properties.flight_number.description;
    expect(fnHint).not.toContain("OO4680");
  });
});
