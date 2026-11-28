/**
 * MCP check_flight asked for a leg we hold no row for, on a number we hold
 * that date: "leg unmatched", the legs we do hold and what they fly on, and
 * the leg's own local date where the held run has it. Never the per-number
 * prior (~2% with no history) while the date's run sits on a verified
 * Starlink tail, and never a yes the leg's aircraft may not carry. FR24 is
 * stubbed empty: no outside request.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { createApp } from "../src/server/app";
import { addFleet, addPlane, jsonOf, makeFreshDb, postMcp } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const HOUR = 3600;
const MIN = 60;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
const dayStart = (Math.floor(now / DAY) + 2) * DAY;
// UA176's GUM departure is 10:20 local on NEXT; its PNI → TKK hop departs
// past local midnight, so on NEXT that leg is unmatched.
const NEXT = isoDay(dayStart + DAY);
const NEXT2 = isoDay(dayStart + 2 * DAY);
const at = (h: number, m = 0) => dayStart + h * HOUR + m * MIN;

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  setAssignmentFetcher(async () => []);
  const db: Database = makeFreshDb();
  const leg = (tail: string, fn: string, from: string, to: string, dep: number, arr: number) =>
    db
      .query(
        `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline) VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
      )
      .run(tail, fn, from, to, dep, arr, now);
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  addPlane(db, "N37308", "Starlink", { aircraft: "Boeing 737 MAX 8" });
  addFleet(db, "N37308", "confirmed", {
    verifiedWifi: "Starlink",
    verifiedAt: now - DAY,
    aircraftType: "Boeing 737 MAX 8",
  });
  leg("N37308", "UA176", "GUM", "PNI", at(34, 20), at(36, 55));
  leg("N37308", "UA176", "PNI", "TKK", at(37, 45), at(39, 5));
  leg("N37308", "UA176", "TKK", "GUM", at(39, 55), at(41, 30));
  // A firm no: SFO → DEN on a verified Viasat tail.
  addPlane(db, "N2005", "Viasat");
  addFleet(db, "N2005", "negative", { verifiedWifi: "Viasat" });
  leg("N2005", "UA2333", "SFO", "DEN", at(40), at(42, 30));
  app = createApp(db);
});

afterAll(() => setAssignmentFetcher(null));

async function mcpText(host: string, args: Record<string, string>): Promise<string> {
  const r = await postMcp(app, host, "tools/call", { name: "check_flight", arguments: args });
  expect(r.result.isError).toBeFalsy();
  return r.result.content.map((c: { text: string }) => c.text).join("\n");
}

const LEAD = /^\*\*UA\d+ on \d{4}-\d{2}-\d{2}\*\*: leg unmatched\. We hold no /;
const PERCENT = /\d+% Starlink probability/;

describe("MCP check_flight on an unmatched leg", () => {
  for (const host of [UA, HUB]) {
    test(`${host}: a leg past local midnight shows what we hold, never a low estimate or a yes`, async () => {
      const text = await mcpText(host, {
        flight_number: "UA176",
        date: NEXT,
        origin: "PNI",
        destination: "TKK",
      });
      expect(text).toMatch(LEAD);
      expect(text).toContain("PNI → TKK leg");
      expect(text).not.toMatch(PERCENT);
      expect(text).not.toContain("Yes!");
      expect(text).toContain("GUM → PNI, departs");
      expect(text).toContain("verified Starlink aircraft");
      // The held run's own PNI → TKK departs the next local date: point there.
      expect(text).toContain(`check UA176 with date ${NEXT2} for that leg`);
      expect(text).toContain("no flight history");
    });
  }

  test("the hinted date answers that leg exactly", async () => {
    const b = await jsonOf(
      app,
      `/api/check-flight?flight_number=UA176&date=${NEXT2}&origin=PNI&destination=TKK`,
      UA
    );
    expect(b.leg.match).toBe("exact");
    expect(b.hasStarlink).toBe(true);
  });

  test("ICAO K/P forms of an unmatched leg read the same as IATA", async () => {
    const iata = await mcpText(UA, {
      flight_number: "UA176",
      date: NEXT,
      origin: "TKK",
      destination: "GUM",
    });
    const icao = await mcpText(UA, {
      flight_number: "UA176",
      date: NEXT,
      origin: "PTKK",
      destination: "PGUM",
    });
    expect(icao).toBe(iata);
    expect(icao).toMatch(LEAD);
  });

  test("origin alone, unmatched, names the leg from it", async () => {
    const text = await mcpText(UA, { flight_number: "UA176", date: NEXT, origin: "TKK" });
    expect(text).toContain("no leg from TKK");
    expect(text).toContain(`check UA176 with date ${NEXT2}`);
    expect(text).not.toMatch(PERCENT);
  });

  test("a leg off a firm no's route says what that aircraft carries", async () => {
    const text = await mcpText(UA, {
      flight_number: "UA2333",
      date: NEXT,
      origin: "LAX",
      destination: "ORD",
    });
    expect(text).toMatch(LEAD);
    expect(text).toContain("SFO → DEN, departs");
    expect(text).toContain("Viasat WiFi aircraft, not Starlink");
    expect(text).not.toContain("check UA2333 with date");
    expect(text).not.toMatch(PERCENT);
  });

  test("a matched leg is untouched", async () => {
    const text = await mcpText(UA, {
      flight_number: "UA176",
      date: NEXT,
      origin: "GUM",
      destination: "PNI",
    });
    expect(text).not.toMatch(LEAD);
    expect(text).toContain("Yes!");
  });

  test("hostile leg input never errors and never prints the estimate for this flight", async () => {
    for (const [origin, destination] of [
      ["XX1", "TKK"],
      ["PNI", "PNI"],
      ["ZZZZ", "QQQQ"],
      ["'; DROP", "<b>"],
      ["KPNI", "PTKK"],
      ["pni", " tkk "],
      ["PNI", "KTKK"],
    ]) {
      const text = await mcpText(UA, { flight_number: "UA176", date: NEXT, origin, destination });
      expect(text).not.toMatch(PERCENT);
    }
  });

  test("a number we hold nothing for keeps the estimate", async () => {
    const text = await mcpText(UA, {
      flight_number: "UA9876",
      date: NEXT,
      origin: "SFO",
      destination: "DEN",
    });
    expect(text).not.toMatch(LEAD);
    expect(text).toMatch(PERCENT);
  });

  test("REST is unchanged: the unmatched leg still answers null with match unmatched", async () => {
    const b = await jsonOf(
      app,
      `/api/check-flight?flight_number=UA176&date=${NEXT}&origin=PNI&destination=TKK`,
      UA
    );
    expect(b.hasStarlink).toBeNull();
    expect(b.leg.match).toBe("unmatched");
  });
});
