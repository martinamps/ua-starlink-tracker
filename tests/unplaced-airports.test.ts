/**
 * An airport code the tables do not hold. The flight feed hands us codes
 * before anyone has checked them: a charter field with no airline service, a
 * code issued last month. Such a code is printed as it came, never with a
 * name or a local time we would have to guess, and its route page is not
 * offered to search until someone checks the code and adds it.
 *
 * Found on 2026-11-27: the live sitemap listed sixteen route pages on eight
 * codes no table held, one of them (MDH to STL) a single charter leg whose
 * board said "Times local to MDH" beside UTC times.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { buildRouteFlightBoard } from "../src/api/route-flights";
import { boardDek } from "../src/components/route-flights-copy";
import { getSitemapRoutes, routeHasData } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { unplacedAirportsByAirline } from "../src/scripts/data-freshness";
import { createApp } from "../src/server/app";
import { AIRPORT_COORDS, airportCountry } from "../src/utils/airport-geo";
import { AIRPORT_NAMES, airportWithCode } from "../src/utils/airport-names";
import { AIRPORT_TZ, airportTimezone, isPlacedAirportPair } from "../src/utils/airport-tz";
import { addFlight, addPlane, makeFreshDb, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);
// Three letters no table holds.
const UNKNOWN = "QQX";

let db: Database;
let app: ReturnType<typeof createApp>;
const get = (path: string) =>
  app.dispatch(req(path, UA, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } }));
const robots = (doc: string) => doc.match(/<meta name="robots" content="([^"]*)"/)?.[1] ?? "";
const board = (origin: string, destination: string) =>
  buildRouteFlightBoard(AIRLINES.UA, createReaderFactory(db)("UA"), origin, destination, {});

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N1VER", "Starlink");
  addFlight(db, "N1VER", "UA100", "ORD", now + 3 * HOUR, { arrivalAirport: "DEN" });
  addFlight(db, "N1VER", "UA3395", UNKNOWN, now + 9 * HOUR, { arrivalAirport: "STL" });
  addFlight(db, "N1VER", "UA102", "STL", now + 15 * HOUR, { arrivalAirport: UNKNOWN });
  app = createApp(db);
});

describe("the airport tables", () => {
  test("zone, name and coordinates are held for one set of codes", () => {
    const codes = Object.keys(AIRPORT_TZ).sort();
    expect(Object.keys(AIRPORT_NAMES).sort()).toEqual(codes);
    expect(Object.keys(AIRPORT_COORDS).sort()).toEqual(codes);
  });

  test("the codes found bare on live route pages are placed", () => {
    for (const code of ["ACT", "ANU", "CLL", "GEO", "LNS", "MDH", "OWB", "XMN"]) {
      expect(airportTimezone(code), code).toBeTruthy();
      expect(airportWithCode(code), code).toEndWith(` (${code})`);
      expect(AIRPORT_COORDS[code], code).toHaveLength(2);
    }
    // Outside the US, so the planner's border rules see them as such.
    expect(airportCountry("ANU")).toBe("AG");
    expect(airportCountry("GEO")).toBe("GY");
    expect(airportCountry("XMN")).toBe("CN");
    expect(airportCountry("MDH")).toBe("US");
  });

  test("the codes the gauge named on its first day are placed", () => {
    const countries = {
      DVO: "PH",
      GYD: "AZ",
      LUN: "ZM",
      MUX: "PK",
      NCL: "GB",
      ORK: "IE",
      SKB: "KN",
      TFU: "CN",
    };
    for (const [code, country] of Object.entries(countries)) {
      expect(airportTimezone(code), code).toBeTruthy();
      expect(airportWithCode(code), code).toEndWith(` (${code})`);
      expect(AIRPORT_COORDS[code], code).toHaveLength(2);
      expect(airportCountry(code), code).toBe(country);
    }
  });

  test("West Palm Beach answers to its new code and its old one", () => {
    expect(airportWithCode("DJT")).toBe("West Palm Beach (DJT)");
    expect(airportTimezone("DJT")).toBe(airportTimezone("PBI"));
  });
});

describe("a pair with an end no table holds", () => {
  test("is told from a placed pair, whichever end it is", () => {
    expect(isPlacedAirportPair("ORD", "DEN")).toBe(true);
    expect(isPlacedAirportPair("ord", "den")).toBe(true);
    expect(isPlacedAirportPair(UNKNOWN, "STL")).toBe(false);
    expect(isPlacedAirportPair("STL", UNKNOWN)).toBe(false);
    expect(isPlacedAirportPair("", "")).toBe(false);
  });

  test("stays out of the sitemap, while the placed pair beside it stays in", async () => {
    const pairs = getSitemapRoutes(db, "UA").map((r) => `${r.origin}-${r.destination}`);
    expect(pairs).toContain("ORD-DEN");
    expect(pairs.filter((p) => p.includes(UNKNOWN))).toEqual([]);
    const xml = await (await get("/sitemap.xml")).text();
    expect(xml).toContain("/route-planner/ORD/DEN<");
    expect(xml).not.toContain(UNKNOWN);
  });

  test("still serves its page, which asks not to be indexed", async () => {
    for (const path of [`/route-planner/${UNKNOWN}/STL`, `/route-planner/STL/${UNKNOWN}`]) {
      expect(routeHasData(db, ...(path.split("/").slice(2) as [string, string]), "UA")).toBe(true);
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(robots(await res.text()), path).toBe("noindex, follow");
    }
    expect(robots(await (await get("/route-planner/ORD/DEN")).text())).toBe("index, follow");
  });

  test("prints the code alone, with no name made up for it", async () => {
    expect(airportWithCode(UNKNOWN)).toBe(UNKNOWN);
    const doc = await (await get(`/route-planner/${UNKNOWN}/STL`)).text();
    expect(doc).toContain(UNKNOWN);
    expect(doc).not.toContain(`(${UNKNOWN})`);
  });
});

describe("the board's clock line", () => {
  test("says UTC when the origin's zone is unknown, and never 'local'", async () => {
    const b = board(UNKNOWN, "STL");
    expect(b.flights.length).toBeGreaterThan(0);
    expect(b.utc_times).toBe(true);
    expect(boardDek(b)).toContain("Times in UTC.");
    expect(boardDek(b)).not.toContain("local");
    const doc = await (await get(`/route-planner/${UNKNOWN}/STL`)).text();
    expect(doc).toContain("Times in UTC.");
    expect(doc).not.toContain(`Times local to ${UNKNOWN}`);
  });

  test("is unchanged for an origin with a zone: no new key, the same sentence", () => {
    const b = board("ORD", "DEN");
    expect("utc_times" in b).toBe(false);
    expect(boardDek(b)).toContain("Times local to ORD.");
    // An unknown destination changes no clock: times are the origin's.
    const out = board("STL", UNKNOWN);
    expect("utc_times" in out).toBe(false);
    expect(boardDek(out)).toContain("Times local to STL.");
  });

  test("the API never answers for a code it cannot place, so its shape is unchanged", async () => {
    const api = (o: string, d: string) => get(`/api/route-flights?origin=${o}&destination=${d}`);
    expect((await api(UNKNOWN, "STL")).status).toBe(400);
    const known = await api("ORD", "DEN");
    expect(known.status).toBe(200);
    expect(Object.keys((await known.json()) as object)).not.toContain("utc_times");
  });
});

describe("the count of unplaced codes", () => {
  test("names each code once per airline, from either end of a flight", () => {
    expect(unplacedAirportsByAirline(db).get("UA")).toEqual([UNKNOWN]);
  });

  test("is an empty list, not a missing airline, when every code is placed", () => {
    const clean = makeFreshDb();
    addPlane(clean, "N2VER", "Starlink");
    addFlight(clean, "N2VER", "UA200", "ORD", now + HOUR, { arrivalAirport: "DJT" });
    expect(unplacedAirportsByAirline(clean).get("UA")).toEqual([]);
    clean.close();
  });

  test("counts a code of any shape the feed stored, lowercase or four letters", () => {
    const odd = makeFreshDb();
    addPlane(odd, "N3VER", "Starlink");
    addFlight(odd, "N3VER", "UA300", "mdh", now + HOUR, { arrivalAirport: "ZZZZ" });
    addFlight(odd, "N3VER", "UA301", "ZZZZ", now + 2 * HOUR, { arrivalAirport: "<b>" });
    expect(unplacedAirportsByAirline(odd).get("UA")).toEqual(["<B>", "ZZZZ"]);
    odd.close();
  });
});
