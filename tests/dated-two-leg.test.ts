/**
 * A dated flight page with no leg chosen, for a number that flies two legs
 * that day. Its description, share picture and answer card named the first
 * leg's plane alone, and its Flight JSON-LD named whichever leg departs
 * soonest from now, so a traveller on the other leg read the wrong plane.
 * Each leg now carries its own plane, and the structured data lists the
 * date's legs in departure order.
 *
 * Seeded on a fresh database: no outside request is made.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { type AnswerContext, renderFlightAnswer } from "../src/client/flight-answer";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeFreshDb, readableText, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
// Tomorrow by UTC; 15:00Z and 19:00Z fall on that same date at every US airport.
const DATE = isoDay(now + DAY);
const at = (hourUtc: number) => Math.floor(Date.parse(`${DATE}T00:00:00Z`) / 1000) + hourUtc * HOUR;

let db: Database;
let app: ReturnType<typeof createApp>;

function addStarlink(tail: string, aircraft = "Boeing 737-900") {
  addPlane(db, tail, "Starlink", { aircraft });
  addFleet(db, tail, "confirmed", {
    verifiedWifi: "Starlink",
    verifiedAt: now - DAY,
    aircraftType: aircraft,
  });
}

/** History ranks the later leg first, as UA1421's does (FLL → IAD over ORD → FLL). */
function addRoutes(fn: string, legs: [string, string, number][]) {
  for (const [origin, destination, seen] of legs) {
    db.query(
      `INSERT OR REPLACE INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
       VALUES (?, ?, ?, 10800, ?, ?, ?)`
    ).run(fn, origin, destination, now - 90 * DAY, now - HOUR, seen);
  }
}

beforeAll(() => {
  setAssignmentFetcher(async () => []);
  db = makeFreshDb();
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  for (const tail of ["N1LEG", "N2LEG", "N3SAME", "N4ONE"]) addStarlink(tail);

  // UA1421: two legs that day on two planes.
  addFlight(db, "N1LEG", "UA1421", "ORD", at(15), { arrivalAirport: "FLL" });
  addFlight(db, "N2LEG", "UA1421", "FLL", at(19), { arrivalAirport: "IAD" });
  addRoutes("UA1421", [
    ["FLL", "IAD", 40],
    ["ORD", "FLL", 38],
  ]);
  // UA1500: two legs that day on one plane.
  addFlight(db, "N3SAME", "UA1500", "ORD", at(15), { arrivalAirport: "FLL" });
  addFlight(db, "N3SAME", "UA1500", "FLL", at(19), { arrivalAirport: "IAD" });
  addRoutes("UA1500", [
    ["FLL", "IAD", 40],
    ["ORD", "FLL", 38],
  ]);
  // UA1600: one leg.
  addFlight(db, "N4ONE", "UA1600", "DEN", at(15), { arrivalAirport: "ORD" });
  addRoutes("UA1600", [["DEN", "ORD", 40]]);

  app = createApp(db);
});
afterAll(() => setAssignmentFetcher(null));

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

async function page(path: string) {
  const res = await app.dispatch(req(path, UA));
  expect(res.status).toBe(200);
  const html = await res.text();
  const meta = (attr: string, name: string) =>
    decode(html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1] ?? "");
  return {
    title: decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""),
    description: meta("name", "description"),
    ogDescription: meta("property", "og:description"),
    imageAlt: meta("property", "og:image:alt"),
    text: readableText(html),
    /** The Flight JSON-LD blocks' legs, in page order. */
    flights: [
      ...html.matchAll(
        /"departureAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\},"arrivalAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\}/g
      ),
    ].map((m) => `${m[1]}-${m[2]}`),
  };
}

describe("a dated page of a two-leg flight, no leg chosen", () => {
  test("two planes: each leg is named with its own plane, in departure order", async () => {
    const p = await page(`/check-flight/UA1421/${DATE}`);
    const planes = "(ORD → FLL on N1LEG, FLL → IAD on N2LEG, verified)";
    expect(p.description).toMatch(/^Yes — UA1421 on \w{3} \d{1,2} has Starlink \(/);
    expect(p.description).toContain(planes);
    expect(p.ogDescription).toBe(p.description);
    expect(p.imageAlt).toContain(planes);
    // The answer card prints the same sentence.
    expect(p.text).toContain(planes);
    // The title names the date and no leg: the page answers for both.
    expect(p.title).toMatch(/^Does UA1421 on \w{3} \d{1,2} Have Starlink Wi-Fi\?$/);
  });

  test("two planes: the structured data lists both legs of that date, first leg first", async () => {
    const p = await page(`/check-flight/UA1421/${DATE}`);
    expect(p.flights).toEqual(["ORD-FLL", "FLL-IAD"]);
  });

  test("one plane on both legs: the plane is named once, and both legs are listed", async () => {
    const p = await page(`/check-flight/UA1500/${DATE}`);
    expect(p.description).toMatch(
      /^Yes — UA1500 on \w{3} \d{1,2} has Starlink \(N3SAME, verified\)\. /
    );
    expect(p.description).not.toContain("→");
    expect(p.imageAlt).toMatch(/\(N3SAME, verified\)$/);
    expect(p.flights).toEqual(["ORD-FLL", "FLL-IAD"]);
  });

  test("the share picture of the two-plane date still draws", async () => {
    const res = await app.dispatch(req(`/static/share/flight/UA1421/${DATE}.png`, UA));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("pages that already answer for one leg keep their lines", () => {
  test("a leg-scoped dated page names its own plane and its own leg", async () => {
    const first = await page(`/check-flight/UA1421/${DATE}?origin=ORD&destination=FLL`);
    expect(first.description).toMatch(/has Starlink \(N1LEG, verified\)\. /);
    expect(first.title).toContain("(ORD → FLL)");
    expect(first.flights).toEqual(["ORD-FLL"]);
    const second = await page(`/check-flight/UA1421/${DATE}?origin=FLL&destination=IAD`);
    expect(second.description).toMatch(/has Starlink \(N2LEG, verified\)\. /);
    expect(second.title).toContain("(FLL → IAD)");
    expect(second.flights).toEqual(["FLL-IAD"]);
  });

  test("a one-leg flight's dated page names its plane alone, with one Flight", async () => {
    const p = await page(`/check-flight/UA1600/${DATE}`);
    expect(p.description).toMatch(
      /^Yes — UA1600 on \w{3} \d{1,2} has Starlink \(N4ONE, verified\)\. /
    );
    expect(p.flights).toEqual(["DEN-ORD"]);
  });

  test("the undated page lists one Flight, the leg it opens on", async () => {
    const p = await page("/check-flight/UA1421");
    expect(p.flights).toHaveLength(1);
    expect(p.title).toContain(`(${p.flights[0].replace("-", " → ")})`);
  });

  test("a date with no aircraft assigned yet lists one Flight", async () => {
    const p = await page(`/check-flight/UA1421/${isoDay(now + 20 * DAY)}`);
    expect(p.description).not.toMatch(/^Yes — /);
    expect(p.flights).toHaveLength(1);
  });
});

describe("the answer card's yes, from the API body alone", () => {
  const ctx: AnswerContext = {
    flightNumber: "UA1421",
    date: DATE,
    daysOut: 1,
    origin: "ORD",
    originZone: "America/Chicago",
    nowSec: now,
    airlineName: "United Airlines",
    zoneFor: () => "America/New_York",
    liveTv: {
      likely: "Live TV: likely.",
      possible: "Live TV: possible.",
      no: "Live TV: no.",
    },
    watchEnabled: false,
    routePlannerEnabled: true,
    tailPages: true,
    host: UA,
  };
  const flight = (tail: string | null, from: string | null, to: string | null, type: string) => ({
    tail_number: tail,
    aircraft_type: type,
    flight_number: "UA1421",
    departure_airport: from,
    arrival_airport: to,
    departure_time: at(15),
    fleet_type: "mainline",
  });

  test("ICAO airports read as IATA, and a hostile tail is escaped in the card", () => {
    const answer = renderFlightAnswer(
      {
        hasStarlink: true,
        confidence: "verified",
        flights: [
          flight("N1LEG", "KORD", "KFLL", "Airbus A321-271NX"),
          flight('N2"><b>', "KFLL", "KIAD", "Boeing 737-924(ER)"),
        ],
      },
      ctx
    );
    expect(answer.headline).toContain('(ORD → FLL on N1LEG, FLL → IAD on N2"><b>, verified)');
    expect(answer.html).not.toContain("<b>");
  });

  test("an unverified plane keeps its status after the legs", () => {
    const answer = renderFlightAnswer(
      {
        hasStarlink: true,
        confidence: "likely",
        flights: [
          flight("N1LEG", "ORD", "FLL", "Boeing 737-924(ER)"),
          flight("N2LEG", "FLL", "IAD", "Boeing 737-924(ER)"),
        ],
      },
      ctx
    );
    expect(answer.headline).toMatch(/FLL → IAD on N2LEG, listed, not yet verified\)$/);
  });

  test("a leg with no airports still names its plane", () => {
    const answer = renderFlightAnswer(
      {
        hasStarlink: true,
        confidence: "verified",
        flights: [
          flight("N1LEG", "ORD", "FLL", "Boeing 737-924(ER)"),
          flight("N2LEG", null, null, "Boeing 737-924(ER)"),
        ],
      },
      ctx
    );
    expect(answer.headline).toContain("(ORD → FLL on N1LEG, N2LEG, verified)");
  });

  test("live TV is told per leg only where the two planes' tiers differ", () => {
    // A regional leg has no seatback screens whatever its type; mainline has some.
    const body = (secondFleet: string) => ({
      hasStarlink: true,
      confidence: "verified",
      flights: [
        flight("N1LEG", "ORD", "FLL", "Airbus A321-271NX"),
        { ...flight("N2LEG", "FLL", "IAD", "Airbus A321-271NX"), fleet_type: secondFleet },
      ],
    });
    const tv = (html: string) =>
      readableText(html).match(/(?:[A-Z]{3} → [A-Z]{3}: )?Live TV: \w+\./g) ?? [];
    const alike = renderFlightAnswer(body("mainline"), ctx).html;
    expect(tv(alike)).toHaveLength(1);
    expect(tv(alike)[0]).toMatch(/^Live TV: /);
    const differ = renderFlightAnswer(body("express"), ctx).html;
    expect(tv(differ)).toEqual([
      expect.stringMatching(/^ORD → FLL: Live TV: /),
      "FLL → IAD: Live TV: no.",
    ]);
    expect(differ.match(/href="\/live-tv"/g)).toHaveLength(1);
  });
});
