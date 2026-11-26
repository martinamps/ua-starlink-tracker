/**
 * Airport pages name the place, not only the code, and never pass UTC off as
 * local time.
 *
 * The names table is hand-read data, so the tests hold its shape (one clean
 * label per airport, a city with several airports says which) and the rule
 * that matters most: a code the table lacks prints alone, never beside an
 * empty or borrowed name.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { TITLE_MAX } from "../src/airlines/aircraft-pages";
import { AIRLINES, SITES } from "../src/airlines/registry";
import {
  airportDek,
  airportMetaDescription,
  airportTitle,
  buildAirportBoard,
} from "../src/api/airport-board";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { AIRPORT_COORDS } from "../src/utils/airport-geo";
import {
  AIRPORT_NAMES,
  airportCity,
  airportPlaceName,
  airportWithCode,
} from "../src/utils/airport-names";
import { AIRPORT_TZ, airportTimezone } from "../src/utils/airport-tz";
import { addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);
// Three letters no table holds: the page for it has no name and no zone.
const UNKNOWN = "QQX";

describe("the names table", () => {
  const entries = Object.entries(AIRPORT_NAMES);

  test("every entry is an IATA code with a clean, printable name", () => {
    expect(entries.length).toBeGreaterThan(200);
    for (const [code, parts] of entries) {
      expect(code, code).toMatch(/^[A-Z]{3}$/);
      expect(parts.length, code).toBeGreaterThanOrEqual(1);
      expect(parts.length, code).toBeLessThanOrEqual(2);
      for (const part of parts) {
        expect(part, code).toBe((part as string).trim());
        // Letters, spaces and the few marks a place name carries: no mojibake
        // (U+FFFD, "Ã©"), no register leftovers ("Ferno (VA)").
        expect(part, code).toMatch(/^[\p{L}][\p{L} .,'/-]*[\p{L}.]$/u);
        expect(part, code).not.toMatch(/�|Ã|Â|\s{2}/);
        // The spoken name, not the register's.
        expect(part, code).not.toMatch(/\b(International|Airport|Regional|Municipal)\b/);
      }
    }
  });

  test("no two airports print the same place", () => {
    const byName = new Map<string, string[]>();
    for (const [code] of entries) {
      const name = airportPlaceName(code) as string;
      byName.set(name, [...(byName.get(name) ?? []), code]);
    }
    const shared = [...byName.values()]
      .filter((codes) => codes.length > 1)
      // One airport under its old code and its new one.
      .filter((codes) => codes.join() !== "DJT,PBI");
    expect(shared).toEqual([]);
  });

  test("a city with several airports says which one, on every one of them", () => {
    const byCity = new Map<string, string[]>();
    for (const [code, [city]] of entries) byCity.set(city, [...(byCity.get(city) ?? []), code]);
    for (const [city, codes] of byCity) {
      if (codes.length < 2 || codes.join() === "DJT,PBI") continue;
      const unnamed = codes.filter((c) => !AIRPORT_NAMES[c][1]);
      // The city's one airline airport may go by the city alone ("Kansas City").
      expect(unnamed.length, city).toBeLessThanOrEqual(1);
    }
    for (const code of ["ORD", "MDW", "IAD", "DCA", "LGA", "JFK", "LHR", "NRT", "HND", "IAH"]) {
      expect(AIRPORT_NAMES[code]?.[1], code).toBeTruthy();
    }
  });

  test("the label puts the place beside the code, once", () => {
    for (const [code, [city]] of entries) {
      const label = airportWithCode(code);
      expect(label.endsWith(` (${code})`), code).toBe(true);
      expect(label.startsWith(city), code).toBe(true);
      // An airport people call by its code is not "New York JFK (JFK)".
      expect(label.split(code).length, code).toBe(2);
    }
    expect(airportWithCode("ord")).toBe(airportWithCode("ORD"));
  });

  test("the name printed beside a code never repeats the code", () => {
    // The ranking and a destination row print the code, then this: "JFK New York".
    expect(airportPlaceName("JFK")).toBe("New York");
    expect(airportPlaceName("LGA")).toBe("New York LaGuardia");
    for (const [code] of entries) {
      expect(airportPlaceName(code)?.split(/[ ,/]+/), code).not.toContain(code);
    }
  });

  test("an airport named for a city it is not in takes the city it is in", () => {
    // "New York Stewart" is 60 miles from New York: its times are Newburgh's.
    expect(airportCity("SWF")).toBe("Newburgh");
    expect(airportWithCode("SWF")).toBe("Newburgh Stewart (SWF)");
  });

  test("two codes the register lists under another code still have a name", () => {
    for (const code of ["KIV", "MLH"]) {
      expect(airportTimezone(code), code).toBeTruthy();
      expect(airportWithCode(code), code).not.toBe(code);
    }
  });

  test("a code the table lacks comes back alone", () => {
    expect(AIRPORT_NAMES[UNKNOWN]).toBeUndefined();
    expect(airportWithCode(UNKNOWN)).toBe(UNKNOWN);
    expect(airportPlaceName(UNKNOWN)).toBeNull();
    expect(airportCity(UNKNOWN)).toBeNull();
  });
});

describe("timezone coverage for the pages", () => {
  test("every airport with a name or a coordinate has a zone the runtime knows", () => {
    const codes = new Set([...Object.keys(AIRPORT_NAMES), ...Object.keys(AIRPORT_COORDS)]);
    expect([...codes].filter((c) => !AIRPORT_TZ[c])).toEqual([]);
    for (const [code, zone] of Object.entries(AIRPORT_TZ)) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), code).not.toThrow();
    }
  });
});

describe("the page", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const page = async (path: string) =>
    (
      await app.dispatch(
        req(path, UA, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
      )
    ).text();
  const board = (airport: string) =>
    buildAirportBoard(AIRLINES.UA, createReaderFactory(db)("UA"), airport);
  const tag = (doc: string, re: RegExp) =>
    (doc.match(re)?.[1] ?? "").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
  const title = (doc: string) => tag(doc, /<title>([^<]*)<\/title>/);
  const description = (doc: string) => tag(doc, /<meta name="description" content="([^"]*)"/);

  beforeAll(() => {
    db = makeFreshDb();
    addPlane(db, "N1VER", "Starlink");
    addFlight(db, "N1VER", "UA100", "ORD", now + 3 * HOUR, { arrivalAirport: "DEN" });
    addFlight(db, "N1VER", "UA101", "IAH", now + 9 * HOUR, { arrivalAirport: UNKNOWN });
    addFlight(db, "N1VER", "UA102", UNKNOWN, now + 14 * HOUR, { arrivalAirport: "IAH" });
    app = createApp(db);
  });

  test("names the city and airport beside the code where a reader looks", async () => {
    const place = airportWithCode("ORD");
    expect(place).not.toBe("ORD");
    const body = await page("/routes/ORD");
    expect(title(body)).toContain(place);
    expect(body).toContain(`Which flights from ${place.replace("'", "&#x27;")} have Starlink?`);
    expect(description(body)).toContain(place);
    expect(airportDek(board("ORD"))).toContain(`from ${place} in`);
    // Once in each: labelling, not a list of city words.
    for (const text of [title(body), description(body).split(" The next is ")[0]]) {
      expect(text.split(AIRPORT_NAMES.ORD[0]).length, text).toBe(2);
    }
    // The address is the code's, unchanged.
    expect(body).toContain(`<link rel="canonical" href="https://${UA}/routes/ORD"`);
  });

  test("a destination row names its city, and one we cannot name stays a code", async () => {
    const body = await page("/routes/ORD");
    expect(body).toContain(airportPlaceName("DEN") as string);
    const iah = await page("/routes/IAH");
    expect(iah).toContain(`IAH to ${UNKNOWN}`);
    expect(iah).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  test("an airport we have no name for keeps its code alone", async () => {
    const body = await page(`/routes/${UNKNOWN}`);
    expect(title(body)).toBe(`Which United Flights From ${UNKNOWN} Have Starlink?`);
    expect(body).toContain(`Which flights from ${UNKNOWN} have Starlink?`);
    expect(body).not.toContain(`(${UNKNOWN})`);
    expect(body).not.toContain("()");
    expect(body).not.toMatch(/from\s+have Starlink|\bnull\b|\bundefined\b/);
  });

  test("an airport with no mapped timezone says UTC, never 'local'", async () => {
    expect(airportTimezone(UNKNOWN)).toBeFalsy();
    expect(board(UNKNOWN).localTimes).toBe(false);
    const body = await page(`/routes/${UNKNOWN}`);
    expect(body).toContain(`Times are in UTC: we hold no time zone for ${UNKNOWN}.`);
    expect(body).not.toContain("Times local to");
    for (const d of board(UNKNOWN).departures) expect(d.time).toMatch(/ UTC$/);
  });

  test("an airport with a zone prints its own clock and says whose", async () => {
    expect(board("ORD").localTimes).toBe(true);
    const body = await page("/routes/ORD");
    expect(body).toContain(`Times local to ${airportCity("ORD")}.`);
    expect(body).not.toContain("Times are in UTC");
    for (const d of board("ORD").departures) expect(d.time).not.toMatch(/ UTC$/);
  });

  test("a long place name costs the description its count of destinations, not the next flight", () => {
    const base = board("ORD");
    const next = base.departures[0];
    const says = `The next is ${next.flight_number} to`;
    // Where the whole lead and the next flight fit, nothing changes.
    const fits = airportMetaDescription(base, 400);
    expect(fits).toContain(airportDek(base));
    expect(fits).toContain(`${says} ${airportWithCode(next.destination)} on`);
    let kept = 0;
    let shortened = 0;
    for (const code of Object.keys(AIRPORT_NAMES)) {
      const b = { ...base, airport: code, place: airportWithCode(code) };
      const d = airportMetaDescription(b, 158);
      expect(d.length, d).toBeLessThanOrEqual(158);
      expect(d, code).toContain(b.place);
      if (!d.includes(says)) {
        // Dropped only where even the short lead and the bare code do not fit.
        expect(d).toBe(airportDek(b));
        continue;
      }
      kept++;
      if (!d.startsWith(airportDek(b))) {
        shortened++;
        expect(d.startsWith(airportDek(b, { destinations: false })), d).toBe(true);
        // The count is given up only when keeping it would have lost the flight.
        const whole = `${airportDek(b)} ${says} ${next.destination} on ${next.day} at ${next.time}.`;
        expect(whole.length, code).toBeGreaterThan(158);
      }
    }
    expect(shortened).toBeGreaterThan(0);
    expect(kept / Object.keys(AIRPORT_NAMES).length).toBeGreaterThan(0.9);
  });

  test("every title fits the title budget, and no description is cut mid-sentence", () => {
    const base = board("ORD");
    for (const code of Object.keys(AIRPORT_NAMES)) {
      const b = { ...base, airport: code, place: airportWithCode(code) };
      const t = airportTitle(b);
      expect(t.length, t).toBeLessThanOrEqual(TITLE_MAX);
      expect(t, code).toContain(b.place);
      const d = airportMetaDescription(b, 158);
      expect(d.endsWith("."), d).toBe(true);
      expect(d, code).toContain(b.place);
    }
  });
});
