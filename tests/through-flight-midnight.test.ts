/**
 * A through flight whose later legs depart after local midnight. Airlines date
 * the whole flight by its first departure, so those legs fly on the flight's
 * date though their own airports have turned the day. Each leg used to answer
 * only on its own local date, so the flight's date held the first leg alone:
 * a GUM → TKK ticket on UA176 was answered as its GUM → PNI hop, with "we hold
 * no GUM → TKK leg", when we held all three.
 *
 * The shapes are United's island hoppers as our schedule held them on 28 Nov
 * 2026. Guam, Pohnpei, Chuuk and Majuro keep no daylight time, so the local
 * clock of each leg is the same on every date. Seeded on a fresh database; no
 * outside request is made.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { createApp } from "../src/server/app";
import { THROUGH_STOP_MAX_SEC, airportLocalDate, legsOnFlightDate } from "../src/utils/airport-tz";
import { addFleet, addPlane, jsonOf, makeFreshDb, postMcp, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const MIN = 60;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
// Two UTC days out: every leg below is still to fly at any hour of today.
const dayStart = (Math.floor(now / DAY) + 2) * DAY;
const D = isoDay(dayStart);
const NEXT = isoDay(dayStart + DAY);
const at = (h: number, m = 0) => dayStart + h * HOUR + m * MIN;

let db: Database;
let app: ReturnType<typeof createApp>;

function leg(tail: string, fn: string, from: string, to: string, dep: number, arr: number) {
  db.query(
    `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
  ).run(tail, fn, from, to, dep, arr, now);
}

beforeAll(() => {
  setAssignmentFetcher(async () => []);
  db = makeFreshDb();
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  for (const tail of ["N17306", "N37308"]) {
    addPlane(db, tail, "Starlink", { aircraft: "Boeing 737 MAX 8" });
    addFleet(db, tail, "confirmed", {
      verifiedWifi: "Starlink",
      verifiedAt: now - DAY,
      aircraftType: "Boeing 737 MAX 8",
    });
  }
  // UA176: GUM 20:20 → PNI 23:55, PNI 00:45 → TKK, TKK 01:55 → GUM (local).
  leg("N17306", "UA176", "GUM", "PNI", at(10, 20), at(12, 55));
  leg("N17306", "UA176", "PNI", "TKK", at(13, 45), at(15, 5));
  leg("N17306", "UA176", "TKK", "GUM", at(15, 55), at(17, 30));
  // The next day's UA176 leaves Guam 17 hours after the last leg lands: a new flight.
  leg("N17306", "UA176", "GUM", "PNI", at(34, 20), at(36, 55));
  // UA132 eastbound over the date line: HNL 07:20, then Majuro the next local day.
  leg("N37308", "UAL132", "HNL", "MAJ", at(17, 20), at(22, 35));
  leg("N37308", "UAL132", "MAJ", "PNI", at(23, 35), at(25, 50));
  leg("N37308", "UA132", "PNI", "TKK", at(26, 50), at(28, 10));
  leg("N37308", "UA132", "TKK", "GUM", at(29, 0), at(30, 35));
  app = createApp(db);
});
afterAll(() => setAssignmentFetcher(null));

const legsOf = (body: { flights: { departure_airport: string; arrival_airport: string }[] }) =>
  body.flights.map((f) => `${f.departure_airport}-${f.arrival_airport}`).sort();

async function api(fn: string, date: string, extra = "") {
  return jsonOf(app, `/api/check-flight?flight_number=${fn}&date=${date}${extra}`, UA);
}

describe("the fixture is the real shape", () => {
  test("UA176's later legs depart on the next local day at their own airports", () => {
    expect(airportLocalDate("GUM", at(10, 20))).toBe(D);
    expect(airportLocalDate("PNI", at(13, 45))).toBe(NEXT);
    expect(airportLocalDate("TKK", at(15, 55))).toBe(NEXT);
  });
  test("UA132's Majuro leg departs on the next local day", () => {
    expect(airportLocalDate("HNL", at(17, 20))).toBe(D);
    expect(airportLocalDate("MAJ", at(23, 35))).toBe(NEXT);
  });
});

describe("the flight's own date holds all its legs", () => {
  test("/api/check-flight answers UA176 on its date with all three legs", async () => {
    const body = await api("UA176", D);
    expect(body.hasStarlink).toBe(true);
    expect(legsOf(body)).toEqual(["GUM-PNI", "PNI-TKK", "TKK-GUM"]);
  });

  test("UA132 on its date holds the legs past the date line", async () => {
    const body = await api("UA132", D);
    expect(legsOf(body)).toEqual(["HNL-MAJ", "MAJ-PNI", "PNI-TKK", "TKK-GUM"]);
  });

  test("a ticket boarded mid-route still answers on its own local date", async () => {
    const body = await api("UA176", NEXT);
    // PNI → TKK and TKK → GUM of the first flight, and the next flight's first leg.
    expect(legsOf(body)).toEqual(["GUM-PNI", "PNI-TKK", "TKK-GUM"]);
  });

  test("a whole-journey ticket is never answered as its first hop", async () => {
    const body = await api("UA176", D, "&origin=GUM&destination=TKK");
    expect(body.leg).toMatchObject({ match: "unscoped", reason: "ambiguous_leg" });
    expect(legsOf(body)).toEqual(["GUM-PNI", "PNI-TKK", "TKK-GUM"]);
  });

  test("a later leg asked on the flight's date is that leg", async () => {
    const body = await api("UA176", D, "&origin=PNI&destination=TKK");
    expect(body.leg).toMatchObject({ match: "exact" });
    expect(legsOf(body)).toEqual(["PNI-TKK"]);
  });

  test("MCP check_flight names the later legs on the flight's date", async () => {
    const r = await postMcp(app, UA, "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA176", date: D },
    });
    const text = r.result.content[0].text as string;
    expect(text).toContain("GUM→PNI");
    expect(text).toContain("PNI→TKK");
    expect(text).toContain("TKK→GUM");
  });

  test("the dated page lists every leg in its structured data", async () => {
    const res = await app.dispatch(req(`/check-flight/UA176/${D}`, UA));
    expect(res.status).toBe(200);
    const html = await res.text();
    const flights = [
      ...html.matchAll(
        /"departureAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\},"arrivalAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\}/g
      ),
    ].map((m) => `${m[1]}-${m[2]}`);
    expect(flights).toEqual(["GUM-PNI", "PNI-TKK", "TKK-GUM"]);
  });
});

describe("legsOnFlightDate", () => {
  const start = dayStart;
  const end = dayStart + DAY;
  const mk = (from: string, to: string, dep: number, arr: number) => ({
    departure_airport: from,
    arrival_airport: to,
    departure_time: dep,
    arrival_time: arr,
  });

  test("a leg after a stop longer than a through flight's is not the same flight", () => {
    const first = mk("GUM", "PNI", at(10, 20), at(12, 55));
    const late = mk("PNI", "TKK", at(12, 55) + THROUGH_STOP_MAX_SEC + MIN, at(19));
    const on = legsOnFlightDate(D, [first, late], start, end);
    expect(on.has(first)).toBe(true);
    expect(on.has(late)).toBe(false);
  });

  test("a leg from another airport does not continue the flight", () => {
    const first = mk("GUM", "PNI", at(10, 20), at(12, 55));
    const other = mk("KSA", "TKK", at(13, 45), at(15, 5));
    expect(legsOnFlightDate(D, [first, other], start, end).has(other)).toBe(false);
  });

  test("with no leg on the date, nothing is carried in", () => {
    const next = mk("PNI", "TKK", at(13, 45), at(15, 5));
    expect(legsOnFlightDate(D, [next], start, end).size).toBe(0);
  });
});
