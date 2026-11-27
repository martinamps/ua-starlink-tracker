/**
 * Which stored legs count as "the other leg" of a date we hold part of.
 *
 * A dated page whose yes holds for one leg names the number's other legs of
 * that day. It took them from the route cache: any city pair seen under the
 * number in 30 days. Replayed on three months of United's flights, 62% of the
 * legs so named were not flown that day (a pair the number had left, a one-off,
 * a leg of another weekday), and 13% of dated yes pages read partial with
 * nothing else flying. A leg now counts only where the number was held on it
 * beside a leg of this date, on one local date in the last 30 days or still
 * to fly.
 *
 * Seeded on a fresh database: no outside request is made.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { legsHeldTogether } from "../src/api/check-flight-core";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { logFlightAssignments, pruneAssignmentLog } from "../src/database/assignment-log";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
// Tomorrow by UTC; 15:00Z to 23:00Z fall on that same date at every US airport.
const DATE = isoDay(now + DAY);
const at = (hourUtc: number, dayOffset = 0) =>
  Math.floor(Date.parse(`${DATE}T00:00:00Z`) / 1000) + dayOffset * DAY + hourUtc * HOUR;

let db: Database;
let app: ReturnType<typeof createApp>;

function addStarlink(tail: string) {
  addPlane(db, tail, "Starlink", { aircraft: "Boeing 737-900" });
  addFleet(db, tail, "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
}

function addRoute(fn: string, origin: string, destination: string, seen: number, lastSeen: number) {
  db.query(
    `INSERT OR REPLACE INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, ?, ?, 10800, ?, ?, ?)`
  ).run(fn, origin, destination, now - 200 * DAY, lastSeen, seen);
}

/** Legs held under the number on one local date, `dayOffset` days from DATE. */
function held(fn: string, legs: [string, string][], dayOffset: number) {
  logFlightAssignments(
    db,
    "UA",
    "N9PAST",
    legs.map(([departure_airport, arrival_airport], i) => ({
      flight_number: fn,
      departure_airport,
      arrival_airport,
      departure_time: at(15 + 3 * i, dayOffset),
      arrival_time: at(17 + 3 * i, dayOffset),
    })),
    Math.min(now, at(15, dayOffset))
  );
}

const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");

async function page(fn: string, date = DATE) {
  const res = await app.dispatch(req(`/check-flight/${fn}/${date}`, UA));
  expect(res.status).toBe(200);
  const html = await res.text();
  return {
    heading: decode(html.match(/<h2 class="font-display[^>]*>(.*?)<\/h2>/)?.[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/ /g, " "),
    tone: html.match(/data-tone="(\w+)"/)?.[1],
    flights: [
      ...html.matchAll(
        /"departureAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\},"arrivalAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\}/g
      ),
    ].map((m) => `${m[1]}-${m[2]}`),
  };
}

const PLAIN_YES = /^Yes — UA\d+ on \w{3} \d{1,2} has Starlink \(N\w+, verified\)$/;

beforeAll(() => {
  setAssignmentFetcher(async () => []);
  db = makeFreshDb();
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) addStarlink(`N${n}YES`);

  // UA2100: a connecting city pair seen once, never held with the day's leg.
  addFlight(db, "N1YES", "UA2100", "ORD", at(15), { arrivalAirport: "FLL" });
  addRoute("UA2100", "ORD", "FLL", 400, now - HOUR);
  addRoute("UA2100", "FLL", "MIA", 1, now - 3 * DAY);
  held("UA2100", [["FLL", "MIA"]], -4);

  // UA2110: the number left ORD → SFO for SFO → DEN twenty days ago. The old
  // pair has the most sightings and was never held on a date with the new one.
  addFlight(db, "N2YES", "UA2110", "SFO", at(17), { arrivalAirport: "DEN" });
  addRoute("UA2110", "ORD", "SFO", 300, now - 20 * DAY);
  addRoute("UA2110", "SFO", "DEN", 60, now - HOUR);
  for (let d = -29; d <= -21; d++) held("UA2110", [["ORD", "SFO"]], d);
  for (let d = -19; d <= -1; d++) held("UA2110", [["SFO", "DEN"]], d);

  // UA2120: one leg a day on different pairs: SFO → DEN on DATE, DEN → ORD the day after.
  addFlight(db, "N3YES", "UA2120", "SFO", at(17), { arrivalAirport: "DEN" });
  addFlight(db, "N4YES", "UA2120", "DEN", at(17, 1), { arrivalAirport: "ORD" });
  held("UA2120", [["DEN", "ORD"]], 1);
  held("UA2120", [["DEN", "ORD"]], -6);
  held("UA2120", [["SFO", "DEN"]], -7);

  // UA2130: both legs held on one date last week; only the first has a plane on DATE.
  addFlight(db, "N5YES", "UA2130", "DEN", at(15), { arrivalAirport: "SFO" });
  held(
    "UA2130",
    [
      ["DEN", "SFO"],
      ["SFO", "CVG"],
    ],
    -6
  );
  addRoute("UA2130", "DEN", "SFO", 90, now - HOUR);
  addRoute("UA2130", "SFO", "CVG", 80, now - 6 * DAY);

  // UA2140: held together 40 days ago, and since then the first leg alone.
  addFlight(db, "N6YES", "UA2140", "DEN", at(15), { arrivalAirport: "SFO" });
  held(
    "UA2140",
    [
      ["DEN", "SFO"],
      ["SFO", "CVG"],
    ],
    -41
  );
  addRoute("UA2140", "SFO", "CVG", 200, now - 2 * DAY);

  // UA2150, the shape of UA2391 on 28 Nov: two legs on Starlink planes, and a
  // third leg first held on the day after DATE, beside the first.
  addFlight(db, "N7YES", "UA2150", "DEN", at(15), { arrivalAirport: "SFO" });
  addFlight(db, "N7YES", "UA2150", "SFO", at(19), { arrivalAirport: "CVG" });
  held(
    "UA2150",
    [
      ["DEN", "SFO"],
      ["CVG", "ORD"],
    ],
    1
  );
  addRoute("UA2150", "CVG", "ORD", 2, now - HOUR);

  // UA2160: SFO → CVG is held with a leg that does not fly on DATE.
  addFlight(db, "N8YES", "UA2160", "DEN", at(15), { arrivalAirport: "SFO" });
  held(
    "UA2160",
    [
      ["LAX", "SFO"],
      ["SFO", "CVG"],
    ],
    -3
  );

  // UA3395, as live on 27 Nov: one leg from a field with no airline service,
  // under a number whose other recent routes end at the same airport.
  addFlight(db, "N9YES", "UA3395", "MDH", at(18), { arrivalAirport: "STL" });
  addRoute("UA3395", "MDH", "STL", 2, now - HOUR);
  addRoute("UA3395", "EWR", "STL", 15, now - HOUR);
  addRoute("UA3395", "ORD", "STL", 39, now - 2 * DAY);
  held("UA3395", [["EWR", "STL"]], -1);
  held("UA3395", [["ORD", "STL"]], -2);

  app = createApp(db);
});
afterAll(() => setAssignmentFetcher(null));

describe("a leg the number was never held on beside the day's leg is not the other leg", () => {
  test("a connecting city pair seen once", async () => {
    const p = await page("UA2100");
    expect(p.heading).toMatch(PLAIN_YES);
    expect(p.tone).toBe("yes");
    expect(p.flights).toEqual(["ORD-FLL"]);
  });

  test("the city pair the number flew before it moved, however often it was seen", async () => {
    const p = await page("UA2110");
    expect(p.heading).toMatch(PLAIN_YES);
    expect(p.flights).toEqual(["SFO-DEN"]);
  });

  test("another day's leg, held for that day only", async () => {
    const p = await page("UA2120");
    expect(p.heading).toMatch(PLAIN_YES);
    expect(p.heading).not.toContain("DEN → ORD");
  });

  test("a leg held beside one that does not fly on the date", async () => {
    expect((await page("UA2160")).heading).toMatch(PLAIN_YES);
  });

  test("legs held together before the 30 days", async () => {
    expect((await page("UA2140")).heading).toMatch(PLAIN_YES);
  });

  test("a number with one leg and routes that end where it ends (UA3395)", async () => {
    const p = await page("UA3395");
    expect(p.heading).toMatch(PLAIN_YES);
    expect(p.flights).toEqual(["MDH-STL"]);
  });
});

describe("a leg held beside the day's leg on one date is the other leg", () => {
  test("held together last week: the answer names its leg and the other", async () => {
    const p = await page("UA2130");
    expect(p.heading).toMatch(
      /^UA2130 on \w{3} \d{1,2} has Starlink on DEN → SFO \(N5YES, verified\); we have no aircraft for SFO → CVG yet$/
    );
    expect(p.tone).toBe("partial");
    expect(p.flights).toEqual(["DEN-SFO", "SFO-CVG"]);
  });

  test("first held together on the day after (UA2391): the honest partial stays", async () => {
    const p = await page("UA2150");
    expect(p.heading).toContain("has Starlink on DEN → SFO and SFO → CVG");
    expect(p.heading).toContain("we have no aircraft for CVG → ORD yet");
    expect(p.heading).not.toMatch(/^Yes/);
  });

  test("the flown record counts once the week's log has let the date go", async () => {
    held(
      "UA2170",
      [
        ["DEN", "SFO"],
        ["SFO", "CVG"],
      ],
      -15
    );
    addFlight(db, "N1YES", "UA2170", "DEN", at(15), { arrivalAirport: "SFO" });
    pruneAssignmentLog(db, now);
    const inLog = db
      .query("SELECT COUNT(*) AS n FROM flight_assignment_log WHERE flight_number = 'UA2170'")
      .get() as { n: number };
    expect(inLog.n).toBe(0);
    expect((await page("UA2170")).heading).toContain("we have no aircraft for SFO → CVG yet");
  });
});

describe("legsHeldTogether", () => {
  const reader = () => createReaderFactory(db)("UA");
  const cfg = AIRLINES.UA;

  test("gives each leg with the legs it shared a date with, and nothing for a lone leg", () => {
    const legs = legsHeldTogether(cfg, reader(), "UA2130", DATE, now);
    expect(legs.map((l) => `${l.origin}-${l.destination}`).sort()).toEqual(["DEN-SFO", "SFO-CVG"]);
    for (const l of legs) {
      expect(typeof l.origin).toBe("string");
      expect(Array.isArray(l.heldWith)).toBe(true);
      expect(l.heldWith.length).toBeGreaterThan(0);
    }
    expect(legsHeldTogether(cfg, reader(), "UA2110", DATE, now)).toEqual([]);
    expect(legsHeldTogether(cfg, reader(), "UA2100", DATE, now)).toEqual([]);
  });

  test("reads any spelling of the number, and refuses a date that is none", () => {
    expect(legsHeldTogether(cfg, reader(), "2130", DATE, now).length).toBe(2);
    expect(legsHeldTogether(cfg, reader(), "UAL2130", DATE, now).length).toBe(2);
    expect(legsHeldTogether(cfg, reader(), "UA2130", "not-a-date", now)).toEqual([]);
  });

  test("a date weeks out still reads the last 30 days from today", () => {
    const far = isoDay(now + 20 * DAY);
    expect(legsHeldTogether(cfg, reader(), "UA2130", far, now).length).toBe(2);
  });
});

describe("the public answers keep their shape", () => {
  test("the API body for a number with a one-off route is the same yes, leg by leg", async () => {
    const res = await app.dispatch(req(`/api/check-flight?flight_number=UA2100&date=${DATE}`, UA));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasStarlink: boolean; flights: unknown[] };
    expect(Object.keys(body).sort()).toEqual(["confidence", "flights", "hasStarlink"]);
    expect(body.hasStarlink).toBe(true);
    expect(body.flights).toHaveLength(1);
  });
});
