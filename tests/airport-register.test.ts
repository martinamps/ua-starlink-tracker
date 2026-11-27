/**
 * The register under the hand tables (src/utils/airport-register.ts).
 *
 * On 2026-11-27 four pull requests did nothing but place airports by hand,
 * and thirty minutes after the last went live the feed carried three more
 * (ALA, ATQ, PEW). Until a code was placed its pages printed a bare code and
 * UTC times, and the planner offered no connection through it.
 *
 * The lines held here:
 *  - a hand entry always wins, in names, zones, coordinates and country;
 *  - a code the hand tables lack is answered by the register, all three or
 *    none, and a code neither holds stays unknown everywhere;
 *  - the register never reaches a browser bundle.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { normalizeAirportCode, parseLegQuery } from "../src/api/check-flight-core";
import { buildRouteFlightBoard } from "../src/api/route-flights";
import { clientScriptResponse, clientScriptSrc } from "../src/client/bundle";
import { zonesForPage } from "../src/components/check-flight-page";
import { boardDek } from "../src/components/route-flights-copy";
import { buildRouteNetwork } from "../src/components/routes-map/network";
import { getSitemapRoutes } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { unplacedAirportsByAirline } from "../src/scripts/data-freshness";
import { type Itinerary, planRoute, unplacedTripEnds } from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import {
  AIRPORT_COORDS,
  AIRPORT_COUNTRY,
  airportCoords,
  airportCountry,
  airportDistanceMiles,
  nearestAirport,
} from "../src/utils/airport-geo";
import * as hand from "../src/utils/airport-names";
import * as places from "../src/utils/airport-places";
import { registerAirport } from "../src/utils/airport-register";
import { AIRPORT_REGISTER } from "../src/utils/airport-register-data";
import { AIRPORT_TZ, airportTimezone, isPlacedAirportPair } from "../src/utils/airport-tz";
import { addFlight, addPlane, makeFreshDb, req, utc } from "./helpers";

const HAND = Object.keys(AIRPORT_TZ);
const BOTH = HAND.filter((code) => Object.hasOwn(AIRPORT_REGISTER, code));
// The three the gauge named on the evening of 2026-11-27, in no hand table then.
const NEW_CODES = ["ALA", "ATQ", "PEW"];
// Three letters neither a hand table nor the register holds.
const UNKNOWN = "QQX";

/** The zone's offset through a year: two spellings of one clock compare equal. */
const clock = (zone: string) =>
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    .map((m) =>
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
        .format(Date.UTC(2027, m, 15, 12))
        .split(", ")
        .pop()
    )
    .join("|");

describe("the register's rows", () => {
  test("each has a name, a point, a country and a zone this runtime knows", () => {
    const codes = Object.keys(AIRPORT_REGISTER);
    expect(codes.length).toBeGreaterThan(3000);
    for (const code of codes) {
      const [city, airport, lat, lon, country, zone] = AIRPORT_REGISTER[code];
      expect(code, code).toMatch(/^[A-Z]{3}$/);
      expect(city.trim(), code).toBe(city);
      expect(city.length, code).toBeGreaterThan(0);
      // A slashed or bracketed register name is cut before it is written.
      expect(city, code).not.toMatch(/[/()<>&"]/);
      expect(airport, code).not.toMatch(/[/()<>&"]/);
      expect(Math.abs(lat), code).toBeLessThanOrEqual(90);
      expect(Math.abs(lon), code).toBeLessThanOrEqual(180);
      expect(country, code).toMatch(/^[A-Z]{2}$/);
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), code).not.toThrow();
    }
  });

  test("a city with several airports says which, and a shared name says where", () => {
    expect(AIRPORT_REGISTER.TFU.slice(0, 2)).toEqual(["Chengdu", "Tianfu"]);
    expect(AIRPORT_REGISTER.CTU.slice(0, 2)).toEqual(["Chengdu", "Shuangliu"]);
    expect(AIRPORT_REGISTER.ARN.slice(0, 2)).toEqual(["Stockholm", "Arlanda"]);
    // London is Heathrow's; the one in Ontario carries its country.
    expect(AIRPORT_REGISTER.YXU[0]).toBe("London, Canada");
    expect(places.airportWithCode("LCY")).toBe("London City (LCY)");
    expect(places.airportSpokenPlace("LCY")).toBe("London City");
    expect(places.airportCityWithCode("LCY")).toBe("London (LCY)");
  });

  test("agree with the hand tables wherever both hold a code", () => {
    // The hand tables are the checked ones: this is the register's own audit.
    expect(BOTH.length).toBeGreaterThan(500);
    for (const code of BOTH) {
      const [, , lat, lon, , zone] = AIRPORT_REGISTER[code];
      expect(clock(zone), code).toBe(clock(AIRPORT_TZ[code]));
      const [hLat, hLon] = AIRPORT_COORDS[code];
      expect(Math.abs(lat - hLat), code).toBeLessThan(0.1);
      expect(Math.abs(lon - hLon), code).toBeLessThan(0.1);
    }
  });
});

describe("a hand entry always wins", () => {
  test("every hand-placed code answers exactly as its own table does", () => {
    for (const code of HAND) {
      expect(airportTimezone(code), code).toBe(AIRPORT_TZ[code]);
      expect(airportCoords(code), code).toBe(AIRPORT_COORDS[code]);
      expect(airportCountry(code), code).toBe(AIRPORT_COUNTRY[code] ?? "US");
      expect(places.airportPlaceName(code), code).toBe(hand.airportPlaceName(code));
      expect(places.airportCity(code), code).toBe(hand.airportCity(code));
      expect(places.airportSpokenPlace(code), code).toBe(hand.airportSpokenPlace(code));
      expect(places.airportWithCode(code), code).toBe(hand.airportWithCode(code));
      expect(places.airportCityWithCode(code), code).toBe(hand.airportCityWithCode(code));
      expect(places.airportWithCode(code.toLowerCase()), code).toBe(hand.airportWithCode(code));
    }
  });

  test("also where the register would have said something else", () => {
    const regName = (code: string) => {
      const [city, airport] = AIRPORT_REGISTER[code];
      return airport ? `${city} ${airport}` : city;
    };
    const differing = BOTH.filter((code) => regName(code) !== hand.airportPlaceName(code));
    // Without such codes the test above would prove nothing.
    expect(differing.length).toBeGreaterThan(100);
    expect(differing).toContain("GOX");
    expect(AIRPORT_REGISTER.GOX[0]).toBe("Mopa");
    expect(places.airportWithCode("GOX")).toBe("Goa Mopa (GOX)");
    expect(AIRPORT_REGISTER.SKB[0]).toBe("Basseterre");
    expect(places.airportWithCode("SKB")).toBe("St. Kitts (SKB)");
    // Territories are filed as the United States by hand; so they stay.
    expect(airportCountry("SJU")).toBe("US");
  });
});

describe("a code the hand tables lack", () => {
  test("the fixture's codes are in no hand table", () => {
    for (const code of [...NEW_CODES, "DBQ", "GLA", UNKNOWN]) {
      expect(AIRPORT_TZ[code], code).toBeUndefined();
      expect(AIRPORT_COORDS[code], code).toBeUndefined();
      expect(hand.AIRPORT_NAMES[code], code).toBeUndefined();
    }
  });

  test("takes its name, zone, point and country from the register", () => {
    expect(places.airportWithCode("ALA")).toBe("Almaty (ALA)");
    expect(airportTimezone("ALA")).toBe("Asia/Almaty");
    expect(airportCountry("ALA")).toBe("KZ");
    expect(places.airportWithCode("ATQ")).toBe("Amritsar (ATQ)");
    expect(airportTimezone("ATQ")).toBe("Asia/Kolkata");
    expect(airportCountry("ATQ")).toBe("IN");
    expect(places.airportWithCode("PEW")).toBe("Peshawar (PEW)");
    expect(airportTimezone("PEW")).toBe("Asia/Karachi");
    expect(airportCountry("PEW")).toBe("PK");
    for (const code of NEW_CODES) {
      expect(airportCoords(code), code).toHaveLength(2);
      expect(airportDistanceMiles("DOH", code), code).toBeGreaterThan(1000);
      expect(places.airportCity(code), code).toBe(places.airportSpokenPlace(code));
      expect(isPlacedAirportPair("DOH", code), code).toBe(true);
      expect(isPlacedAirportPair(code.toLowerCase(), "doh"), code).toBe(true);
    }
    expect(places.routePairLabel("DOH", "ALA")).toBe("Doha (DOH) to Almaty (ALA)");
    expect(places.routePlaceNames("DOH", "ALA")).toBe("Doha to Almaty");
  });

  test("is all or nothing: every register code has all three", () => {
    for (const code of Object.keys(AIRPORT_REGISTER)) {
      expect(airportTimezone(code), code).toBeTruthy();
      expect(airportCoords(code), code).toHaveLength(2);
      expect(places.airportWithCode(code), code).toEndWith(` (${code})`);
    }
  });

  test("stays unknown everywhere when the register lacks it too", () => {
    for (const code of [UNKNOWN, "", "ZZZZ", "AL", "KALA", "<b>", "constructor", "__proto__"]) {
      expect(registerAirport(code), code).toBeUndefined();
      expect(airportTimezone(code), code).toBeUndefined();
      expect(airportCoords(code), code).toBeUndefined();
      expect(airportCountry(code), code).toBeNull();
      expect(places.airportPlaceName(code), code).toBeNull();
      expect(places.airportCity(code), code).toBeNull();
      expect(places.airportSpokenPlace(code), code).toBeNull();
      expect(places.airportWithCode(code), code).toBe(code.toUpperCase());
      expect(places.airportCityWithCode(code), code).toBe(code.toUpperCase());
    }
    expect(places.routePlaceNames("ORD", UNKNOWN)).toBeNull();
    expect(airportDistanceMiles("ORD", UNKNOWN)).toBeNull();
  });

  test("an aircraft's position is still matched against the hand table alone", () => {
    const [lat, lon] = airportCoords("ALA") as readonly [number, number];
    expect(nearestAirport(lat, lon, 3)).toBeNull();
  });

  test("a K or P spelling is read only for a hand-placed airport", () => {
    // The register holds thousands of codes, and four letters that start with
    // K or P must not become one of them: KALA is not Almaty.
    expect(normalizeAirportCode("KORD")).toBe("ORD");
    expect(normalizeAirportCode("KALA")).toBeNull();
    expect(normalizeAirportCode("ALA")).toBe("ALA");
  });
});

describe("pages and answers for a register-placed airport", () => {
  const UA = SITES.united.canonicalHost;
  const HOUR = 3600;
  const now = Math.floor(Date.now() / 1000);
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const get = (path: string) =>
    app.dispatch(
      req(path, UA, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
    );
  const board = (origin: string, destination: string) =>
    buildRouteFlightBoard(AIRLINES.UA, createReaderFactory(db)("UA"), origin, destination, {});

  beforeAll(() => {
    db = makeFreshDb();
    addPlane(db, "N1VER", "Starlink");
    addFlight(db, "N1VER", "UA100", "ORD", now + 3 * HOUR, { arrivalAirport: "DEN" });
    addFlight(db, "N1VER", "UA3395", "ALA", now + 9 * HOUR, { arrivalAirport: "STL" });
    addFlight(db, "N1VER", "UA102", "STL", now + 15 * HOUR, { arrivalAirport: UNKNOWN });
    app = createApp(db);
  });
  afterAll(() => db.close());

  test("the gauge counts only what neither the tables nor the register hold", () => {
    expect(unplacedAirportsByAirline(db).get("UA")).toEqual([UNKNOWN]);
  });

  test("its route page names it and keeps local time", async () => {
    const b = board("ALA", "STL");
    expect(b.flights.length).toBeGreaterThan(0);
    expect("utc_times" in b).toBe(false);
    expect(boardDek(b)).toContain("Times local to ALA.");
    const doc = await (await get("/route-planner/ALA/STL")).text();
    expect(doc).toContain("Almaty (ALA)");
    expect(doc).toContain("Times local to ALA.");
    expect(doc).not.toContain("Times in UTC.");
  });

  test("its pair is offered to search like any placed pair, the unknown one is not", () => {
    const pairs = getSitemapRoutes(db, "UA").map((r) => `${r.origin}-${r.destination}`);
    expect(pairs).toContain("ORD-DEN");
    expect(pairs).toContain("ALA-STL");
    expect(pairs.filter((p) => p.includes(UNKNOWN))).toEqual([]);
  });

  test("a leg asked for by its code is scoped, an unknown code is not", () => {
    expect(parseLegQuery("ALA", "STL")).toEqual({ leg: { origin: "ALA", destination: "STL" } });
    expect(parseLegQuery(UNKNOWN, null).unscoped?.reason).toBe("invalid_airport");
  });

  test("the routes map draws it; an unknown code is in neither list", () => {
    const row = (origin: string, destination: string) =>
      ({ origin, destination, departures: 3 }) as Parameters<typeof buildRouteNetwork>[0][number];
    const net = buildRouteNetwork([row("ORD", "DBQ"), row("ORD", UNKNOWN), row("DOH", "ALA")]);
    const drawn = net.arcs.map((a) => a.key);
    const off = net.offMap.map((o) => o.code);
    expect(drawn).toContain("DBQ-ORD");
    expect(drawn.some((k) => k.includes(UNKNOWN))).toBe(false);
    expect(off).not.toContain(UNKNOWN);
    // Beyond the frame or on it, never dropped for want of a point.
    expect(drawn.includes("ALA-DOH") || off.includes("ALA")).toBe(true);
  });

  test("a flight page hands the browser the zone the server used", () => {
    const base = zonesForPage([]);
    // A page of hand-placed airports sends the very map it always sent.
    expect(zonesForPage(["ORD", "KDEN", null, undefined, UNKNOWN, "GOX"])).toBe(base);
    const withAla = zonesForPage(["ORD", "ALA", "ALA"]);
    expect(withAla).not.toBe(base);
    expect(withAla["Asia/Almaty"]).toBe(`${base["Asia/Almaty"] ?? ""}ALA`);
    expect(base["Asia/Almaty"] ?? "").not.toContain("ALA");
    expect(Object.keys(withAla).filter((z) => withAla[z] !== base[z])).toEqual(["Asia/Almaty"]);
  });
});

describe("the planner and a register-placed airport", () => {
  const DATE = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  let db: Database;
  let reader: ReturnType<ReturnType<typeof createReaderFactory>>;
  let tails = 0;
  const leg = (fn: string, dep: string, arr: string, hhmm: string, hours: number) => {
    const tail = `N8${String(++tails).padStart(3, "0")}`;
    addPlane(db, tail, "Starlink");
    const t = utc(`${DATE}T${hhmm}:00Z`);
    db.query(
      `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
    ).run(tail, fn, dep, arr, t, t + Math.round(hours * 3600), t);
  };
  const plan = (o: string, d: string) =>
    planRoute(reader, o, d, {
      maxItineraries: 12,
      maxStops: 2,
      targetDateUnix: utc(`${DATE}T12:00:00Z`),
    });
  const routes = (its: Itinerary[]) => its.map((it) => it.legs.map((l) => l.route).join(" + "));

  beforeAll(() => {
    db = makeFreshDb();
    // Dubuque lies on the way from Denver to Newark; Glasgow is a trip's end.
    leg("UA5401", "DEN", "DBQ", "13:00", 2.5);
    leg("UA5402", "DBQ", "EWR", "17:00", 2);
    leg("UA5403", "ORD", "EWR", "17:00", 2);
    leg("UA5404", "EWR", "GLA", "23:00", 7);
    // The same shape through a code nobody holds.
    leg("UA5405", "DEN", UNKNOWN, "13:00", 2.5);
    leg("UA5406", UNKNOWN, "EWR", "17:00", 2);
    reader = createReaderFactory(db)("UA");
  });
  afterAll(() => db.close());

  test("counts it as placed, and an unknown code as not", () => {
    expect(unplacedTripEnds("ORD", "GLA")).toEqual([]);
    expect(unplacedTripEnds("dbq", "ala")).toEqual([]);
    expect(unplacedTripEnds("ORD", UNKNOWN)).toEqual([UNKNOWN]);
  });

  test("offers a connection through it, held to the detour bound", () => {
    const { itineraries } = plan("DEN", "EWR");
    expect(routes(itineraries)).toContain("DEN-DBQ + DBQ-EWR");
    expect(routes(itineraries)).not.toContain(`DEN-${UNKNOWN} + ${UNKNOWN}-EWR`);
    for (const it of itineraries) {
      expect(it.total_flight_hours).not.toBeNull();
      expect(it.coverage_ratio).not.toBeNull();
    }
  });

  test("offers a trip that ends at it a connection", () => {
    const { itineraries, empty } = plan("ORD", "GLA");
    expect(routes(itineraries)).toContain("ORD-EWR + EWR-GLA");
    expect(empty?.kind).not.toBe("unplaced_airport");
  });

  test("a hub abroad is still no way to fly a domestic trip", () => {
    // The register's country feeds the same gate the hand table's does.
    expect(airportCountry("GLA")).toBe("GB");
    expect(airportCountry("DBQ")).toBe("US");
  });
});

describe("the browser", () => {
  const BUNDLES = [
    "flight-search",
    "check-flight",
    "hub",
    "home",
    "route-planner",
    "airport-picker",
    "route-board",
    "routes-map",
    "mcp",
  ] as const;

  test("no bundle carries the register", async () => {
    // Names only the register holds; the hand names ride in the picker.
    const marks = ["Almaty", "Peshawar", "Amritsar", "Dubuque", "Asia/Almaty"];
    for (const mark of marks.slice(0, 4)) {
      expect(Object.values(hand.AIRPORT_NAMES).flat()).not.toContain(mark);
    }
    let picker = "";
    for (const name of BUNDLES) {
      const src = clientScriptSrc(name);
      expect(src, name).toBeTruthy();
      const code = await (clientScriptResponse(src as string) as Response).text();
      if (name === "airport-picker") picker = code;
      for (const mark of marks) expect(code.includes(mark), `${name}: ${mark}`).toBe(false);
    }
    // The picker does carry the hand table, so the search above can find a name.
    expect(picker).toContain("Albuquerque");
  });

  test("only the picker's search reads the hand names directly", () => {
    // Anything else under src/ must go through airport-places.ts, or a
    // register-placed airport would print as a bare code there.
    const allowed = new Set(["src/utils/airport-search.ts", "src/utils/airport-places.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          const rel = path.slice(path.indexOf("src/"));
          if (allowed.has(rel)) continue;
          if (/from\s+"[^"]*\/airport-names"/.test(readFileSync(path, "utf8"))) offenders.push(rel);
        }
      }
    };
    walk(join(import.meta.dir, "..", "src"));
    expect(offenders).toEqual([]);
  });

  test("nothing under src/client reaches the register or the files that read it", () => {
    const serverOnly =
      /from\s+"[^"]*\/(airport-register|airport-register-data|airport-places|airport-tz|airport-geo)"/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (serverOnly.test(readFileSync(path, "utf8"))) offenders.push(entry.name);
      }
    };
    walk(join(import.meta.dir, "..", "src", "client"));
    expect(offenders).toEqual([]);
  });
});
