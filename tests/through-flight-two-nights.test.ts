/**
 * A daily through flight past local midnight, with two consecutive nights
 * stored. The middle date then holds the earlier night's later legs on their
 * own local date, and the later night's past midnight: one pair from two
 * nights, possibly on two planes. A leg asked for on that date is the one
 * departing on it at its origin, the date a ticket prints, and the whole-number
 * answer lists each pair once, from that departure.
 *
 * UA176 as our schedule held it on 28 Nov 2026 (GUM 20:20 → PNI, PNI 00:45 →
 * TKK, TKK 01:55 → GUM), seeded on a fresh database. Guam, Pohnpei and Chuuk
 * keep no daylight time. No outside request is made.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { createApp } from "../src/server/app";
import { airportLocalDate } from "../src/utils/airport-tz";
import { addFleet, addPlane, jsonOf, makeFreshDb, postMcp } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const MIN = 60;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const dayStart = (Math.floor(now / DAY) + 2) * DAY;
const D = isoDay(dayStart);
const NEXT = isoDay(dayStart + DAY);
const at = (h: number, m = 0) => dayStart + h * HOUR + m * MIN;

interface Flight {
  departure_airport: string;
  arrival_airport: string;
  departure_time: number;
  tail_number?: string;
}
const pairs = (body: { flights: Flight[] }) =>
  body.flights.map((f) => `${f.departure_airport}-${f.arrival_airport}`).sort();
const pniTkk = (body: { flights: Flight[] }) =>
  body.flights.filter((f) => f.departure_airport === "PNI" && f.arrival_airport === "TKK");

function seed(earlierStarlink: boolean) {
  const db = makeFreshDb();
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  if (earlierStarlink) {
    addPlane(db, "N17306", "Starlink", { aircraft: "Boeing 737 MAX 8" });
    addFleet(db, "N17306", "confirmed", {
      verifiedWifi: "Starlink",
      verifiedAt: now - DAY,
      aircraftType: "Boeing 737 MAX 8",
    });
  } else {
    addFleet(db, "N17306", "negative", {
      verifiedWifi: "None",
      verifiedAt: now - DAY,
      aircraftType: "Boeing 737 MAX 8",
    });
  }
  addPlane(db, "N37308", "Starlink", { aircraft: "Boeing 737 MAX 8" });
  addFleet(db, "N37308", "confirmed", {
    verifiedWifi: "Starlink",
    verifiedAt: now - DAY,
    aircraftType: "Boeing 737 MAX 8",
  });
  // The run of D on N17306, the run of NEXT on N37308.
  for (const [tail, o] of [
    ["N17306", 0],
    ["N37308", 24],
  ] as const) {
    const leg = (from: string, to: string, dep: number, arr: number) =>
      db
        .query(
          `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
           VALUES (?, 'UA176', ?, ?, ?, ?, ?, 'UA')`
        )
        .run(tail, from, to, dep, arr, now);
    leg("GUM", "PNI", at(o + 10, 20), at(o + 12, 55));
    leg("PNI", "TKK", at(o + 13, 45), at(o + 15, 5));
    leg("TKK", "GUM", at(o + 15, 55), at(o + 17, 30));
  }
  return db;
}

afterAll(() => setAssignmentFetcher(null));

test("the fixture is the real shape", () => {
  expect(airportLocalDate("GUM", at(10, 20))).toBe(D);
  expect(airportLocalDate("PNI", at(13, 45))).toBe(NEXT);
  expect(airportLocalDate("GUM", at(34, 20))).toBe(NEXT);
  expect(airportLocalDate("PNI", at(37, 45))).not.toBe(NEXT);
});

describe("the earlier night on a plane without Starlink", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    setAssignmentFetcher(async () => []);
    db = seed(false);
    app = createApp(db);
  });
  const api = (date: string, extra = "") =>
    jsonOf(app, `/api/check-flight?flight_number=UA176&date=${date}${extra}`, UA);

  test("a leg asked on the middle date is never the later night's plane", async () => {
    const body = await api(NEXT, "&origin=PNI&destination=TKK");
    expect(body.hasStarlink).not.toBe(true);
    expect(body.leg.match).not.toBe("exact");
    expect(body.flights.some((f: Flight) => f.tail_number === "N37308")).toBe(false);
  });

  test("MCP check_flight says no yes for that leg", async () => {
    const r = await postMcp(app, UA, "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA176", date: NEXT, origin: "PNI", destination: "TKK" },
    });
    const text = r.result.content[0].text as string;
    expect(text).not.toContain("Yes!");
    expect(text).not.toContain("N37308");
  });

  test("the whole-number answer doesn't list the later night's PNI → TKK", async () => {
    const body = await api(NEXT);
    expect(pniTkk(body)).toEqual([]);
    expect(pairs(body)).toEqual(["GUM-PNI"]);
    const r = await postMcp(app, UA, "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA176", date: NEXT },
    });
    expect(r.result.content[0].text as string).not.toContain("PNI→TKK");
  });

  test("a whole-journey ask on the middle date is never answered as its first hop", async () => {
    const body = await api(NEXT, "&origin=GUM&destination=TKK");
    expect(body.leg).toMatchObject({ match: "unscoped", reason: "ambiguous_leg" });
  });

  test("the later night's own date still holds its legs past midnight", async () => {
    const body = await api(isoDay(dayStart + 2 * DAY), "&origin=PNI&destination=TKK");
    expect(body.leg.match).toBe("exact");
    expect(pniTkk(body).map((f) => f.departure_time)).toEqual([at(37, 45)]);
  });
});

describe("both nights on Starlink planes", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    setAssignmentFetcher(async () => []);
    db = seed(true);
    app = createApp(db);
  });
  const api = (date: string, extra = "") =>
    jsonOf(app, `/api/check-flight?flight_number=UA176&date=${date}${extra}`, UA);

  test("a leg asked on the middle date is the one departing that local date", async () => {
    const body = await api(NEXT, "&origin=PNI&destination=TKK");
    expect(body.leg.match).toBe("exact");
    expect(pniTkk(body).map((f) => [f.departure_time, f.tail_number])).toEqual([
      [at(13, 45), "N17306"],
    ]);
  });

  test("the whole-number answer holds each pair once, from that local date", async () => {
    const body = await api(NEXT);
    expect(pairs(body)).toEqual(["GUM-PNI", "PNI-TKK", "TKK-GUM"]);
    expect(pniTkk(body).map((f) => f.departure_time)).toEqual([at(13, 45)]);
    const r = await postMcp(app, UA, "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA176", date: NEXT },
    });
    expect((r.result.content[0].text as string).match(/PNI→TKK/g)?.length).toBe(1);
  });

  test("the flight's first date still holds all its legs", async () => {
    const body = await api(D);
    expect(pairs(body)).toEqual(["GUM-PNI", "PNI-TKK", "TKK-GUM"]);
  });
});
