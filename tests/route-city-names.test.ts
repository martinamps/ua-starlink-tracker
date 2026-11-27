/**
 * Route pages, the flight page's route rows and the airport bars name the
 * city beside the code: people search "United Chicago to Denver Starlink",
 * not "ORD to DEN".
 *
 * It is labelling, so the tests hold the limits as hard as the names: once
 * per place a reader looks, a title and a description that fit whole, a code
 * with no name printed alone, and the page's address unchanged.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { TITLE_MAX } from "../src/airlines/aircraft-pages";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { AIRPORT_INDEX_MIN_DEPARTURES } from "../src/api/airport-board";
import { buildRouteFlightBoard } from "../src/api/route-flights";
import { logFlightAssignments } from "../src/database/assignment-log";
import { createReaderFactory } from "../src/database/reader";
import { createApp, routeMetaDescription, routeTitle } from "../src/server/app";
import {
  AIRPORT_NAMES,
  airportCity,
  airportCityWithCode,
  airportPlaceName,
  airportSpokenPlace,
  airportWithCode,
  routePairLabel,
  routePlaceNames,
} from "../src/utils/airport-names";
import { addFlight, addPlane, makeFreshDb, req, sectionOf } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);
// Three letters no table holds.
const UNKNOWN = "QQX";
const DESCRIPTION_MAX = 158;

const plain = (s: string) =>
  s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<!-- -->/g, "")
    // The heading ties each code to its city with a no-break space.
    .replace(/\u00a0/g, " ");
const count = (text: string, part: string) => text.split(part).length - 1;

let db: Database;
let app: ReturnType<typeof createApp>;
const page = async (path: string) =>
  plain(
    await (
      await app.dispatch(
        req(path, UA, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
      )
    ).text()
  );
const title = (doc: string) => doc.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
const description = (doc: string) =>
  doc.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
const h1 = (doc: string) => (doc.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "").trim();
const board = (origin: string, destination: string) =>
  buildRouteFlightBoard(AIRLINES.UA, createReaderFactory(db)("UA"), origin, destination, {});

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N1VER", "Starlink");
  addFlight(db, "N1VER", "UA100", "ORD", now + 3 * HOUR, { arrivalAirport: "DEN" });
  addFlight(db, "N1VER", "UA101", "IAH", now + 9 * HOUR, { arrivalAirport: "DCA" });
  addFlight(db, "N1VER", "UA102", "ORD", now + 15 * HOUR, { arrivalAirport: UNKNOWN });
  addFlight(db, "N1VER", "UA103", "MDW", now + 21 * HOUR, { arrivalAirport: "DEN" });
  // Enough Starlink departures flown from ORD that its airport page indexes,
  // so the route page links it (route pages link only indexed airports). The
  // history window is a few days and logs one flight number once a day, so
  // three flight numbers to a city no other test reads. One number's
  // departures are whole days apart: 23 hours apart, two of them shared a UTC
  // date for an hour of most afternoons, were logged as one, and ORD fell
  // under the bar (the test failed 12-15, 16-19 and 20-23 UTC).
  for (let i = 0; i < AIRPORT_INDEX_MIN_DEPARTURES; i++) {
    const departure_time = now - (1 + (i % 4)) * 86400 - (1 + Math.floor(i / 4)) * HOUR;
    logFlightAssignments(
      db,
      "UA",
      "N1VER",
      [
        {
          flight_number: `UA${900 + Math.floor(i / 4)}`,
          departure_airport: "ORD",
          arrival_airport: "SFO",
          departure_time,
          arrival_time: departure_time + 4 * HOUR,
        },
      ],
      now
    );
    db.query(
      "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?, ?, ?, 'UA')"
    ).run("N1VER", "ORD", departure_time);
  }
  app = createApp(db);
});

describe("the labels", () => {
  test("a city stands beside its code, without the airport's own name", () => {
    expect(airportCityWithCode("ORD")).toBe(`${airportCity("ORD")} (ORD)`);
    expect(airportCityWithCode("ord")).toBe(airportCityWithCode("ORD"));
    expect(airportCityWithCode("IAH")).not.toContain("Intercontinental");
    expect(routePairLabel("ORD", "DEN")).toBe(
      `${airportCity("ORD")} (ORD) to ${airportCity("DEN")} (DEN)`
    );
  });

  test("two airports of one city stay tellable apart", () => {
    for (const [a, b] of [
      ["ORD", "MDW"],
      ["JFK", "LGA"],
      ["IAD", "DCA"],
      ["LGA", "EWR"],
    ]) {
      expect(airportCityWithCode(a)).not.toBe(airportCityWithCode(b));
      expect(routeTitle("United", a, "DEN")).not.toBe(routeTitle("United", b, "DEN"));
    }
  });

  test("a code the table lacks comes back alone, and a half-named pair is no pair", () => {
    expect(airportCityWithCode(UNKNOWN)).toBe(UNKNOWN);
    expect(routePairLabel(UNKNOWN, "DEN")).toBe(`${UNKNOWN} to ${airportCityWithCode("DEN")}`);
    expect(routePlaceNames("ORD", UNKNOWN)).toBeNull();
    expect(routePlaceNames(UNKNOWN, "ORD")).toBeNull();
    expect(routePlaceNames("ORD", "DEN")).toBe(
      `${airportPlaceName("ORD")} to ${airportPlaceName("DEN")}`
    );
  });
});

describe("the route page", () => {
  test("names both cities once each in the title, the heading and the description", async () => {
    const body = await page("/route-planner/ORD/DEN");
    const pair = routePairLabel("ORD", "DEN");
    expect(pair).not.toBe("ORD to DEN");
    expect(title(body)).toContain(pair);
    expect(h1(body)).toBe(`Which ${pair} flights have Starlink?`);
    expect(description(body)).toContain(pair);
    for (const text of [title(body), h1(body), description(body)]) {
      for (const code of ["ORD", "DEN"]) {
        expect(count(text, airportCity(code) as string), text).toBe(1);
        expect(count(text, code), text).toBe(1);
      }
    }
    // The address is the codes', unchanged, and the page still indexes.
    expect(body).toContain(`<link rel="canonical" href="https://${UA}/route-planner/ORD/DEN"`);
    expect(body).not.toContain("noindex");
    // The keywords line takes no city words.
    const keywords = body.match(/<meta name="keywords" content="([^"]*)"/)?.[1] ?? "";
    expect(keywords).not.toContain(airportCity("ORD") as string);
  });

  test("the structured list is named for the cities, and its items are unchanged", async () => {
    const body = await page("/route-planner/ORD/DEN");
    const list = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]))
      .flatMap((j) => (Array.isArray(j) ? j : [j]))
      .find((j) => j["@type"] === "ItemList");
    expect(list.name).toBe(
      `United Airlines flights on ${airportCityWithCode("ORD")} → ${airportCityWithCode("DEN")}`
    );
    expect(list.itemListElement[0].url).toBe(`https://${UA}/check-flight/UA100`);
  });

  test("the heading never breaks between a city and its code", async () => {
    const raw = await (
      await app.dispatch(
        req("/route-planner/ORD/DEN", UA, {
          headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" },
        })
      )
    ).text();
    expect(h1(raw)).toContain("Chicago\u00a0(ORD) to Denver\u00a0(DEN)");
  });

  test("the link to each airport's page says which airport it is", async () => {
    const body = await page("/route-planner/ORD/DEN");
    expect(body).toContain(`Starlink flights from ${airportWithCode("ORD")}</a>`);
    expect(airportWithCode("ORD")).toContain(AIRPORT_NAMES.ORD[1] as string);
  });

  test("an end we have no name for keeps its code alone", async () => {
    const body = await page(`/route-planner/ORD/${UNKNOWN}`);
    const pair = `${airportCityWithCode("ORD")} to ${UNKNOWN}`;
    expect(h1(body)).toBe(`Which ${pair} flights have Starlink?`);
    expect(title(body)).toContain(pair);
    expect(description(body)).toContain(pair);
    expect(body).not.toContain(`(${UNKNOWN})`);
    expect(body).not.toContain("()");
    expect(body).not.toMatch(/\bnull\b|\bundefined\b/);
    expect(routeTitle("United", UNKNOWN, "QQY")).toBe(
      `Which United ${UNKNOWN} to QQY Flights Have Starlink?`
    );
  });

  test("every pair's title fits whole, with both codes in it", () => {
    const codes = Object.keys(AIRPORT_NAMES);
    // Every airport against the longest and shortest names and a few hubs.
    const byLength = [...codes].sort(
      (a, b) => airportCityWithCode(b).length - airportCityWithCode(a).length
    );
    const others = [...byLength.slice(0, 5), ...byLength.slice(-3), "ORD", "IAH", "DCA", "SFO"];
    let named = 0;
    let total = 0;
    for (const airline of ["United", "Alaska", "Hawaiian", "Qatar"]) {
      for (const a of codes) {
        for (const b of others) {
          if (a === b) continue;
          for (const [o, d] of [
            [a, b],
            [b, a],
          ]) {
            const t = routeTitle(airline, o, d);
            expect(t.length, t).toBeLessThanOrEqual(TITLE_MAX);
            expect(t, t).toContain(o);
            expect(t, t).toContain(d);
            expect(t).not.toMatch(/…|\.\.\./);
            total++;
            // Named or not at all: never one city and one bare code by cutting.
            if (t.includes(routePairLabel(o, d))) named++;
            else expect(t).toBe(`Which ${airline} ${o} to ${d} Flights Have Starlink?`);
          }
        }
      }
    }
    expect(named).toBeGreaterThan(0);
    expect(named).toBeLessThan(total);
    expect(routeTitle("United", "ORD", "DEN")).toBe(
      "United Chicago (ORD) to Denver (DEN) Flights With Starlink"
    );
  });

  test("a description fits whole: a long pair gives up its codes, then the next flight, then the cities", () => {
    const short = board("ORD", "DEN");
    const d = routeMetaDescription(AIRLINES.UA, short, ["UA100"], 400);
    expect(d).toContain(routePairLabel("ORD", "DEN"));
    expect(d).toContain("The next is UA100 on ");
    let whole = 0;
    let citiesAndNext = 0;
    let withoutNext = 0;
    let codesOnly = 0;
    const codes = Object.keys(AIRPORT_NAMES);
    for (const o of codes) {
      for (const dest of ["DEN", "IAH", "SFO", "DCA", "HDN"]) {
        if (o === dest) continue;
        const b = { ...short, origin: o, destination: dest };
        const text = routeMetaDescription(AIRLINES.UA, b, ["UA100"], DESCRIPTION_MAX);
        expect(text.length, text).toBeLessThanOrEqual(DESCRIPTION_MAX);
        expect(text.endsWith("."), text).toBe(true);
        const cities = `${airportSpokenPlace(o)} to ${airportSpokenPlace(dest)} nonstops`;
        if (text.includes(routePairLabel(o, dest))) {
          if (text.includes("The next is")) whole++;
          else withoutNext++;
        } else if (text.includes(cities)) {
          citiesAndNext++;
          // The codes go only to make room for the next flight.
          expect(text).toContain("The next is UA100 on ");
          expect(text).not.toContain(`(${o})`);
          expect(airportSpokenPlace(o)).not.toBe(airportSpokenPlace(dest));
        } else {
          codesOnly++;
          expect(text).toContain(`${o} to ${dest}`);
        }
      }
    }
    expect(whole).toBeGreaterThan(0);
    expect(citiesAndNext).toBeGreaterThan(0);
    // The next flight is dropped far less often than it is kept without codes.
    expect(withoutNext).toBeLessThan(citiesAndNext);
    // The named sentence alone always fits for these pairs.
    expect(codesOnly).toBe(0);
  });

  test("a long pair keeps the next flight by naming its cities without their codes", () => {
    const long = board("ORD", "DEN");
    const b = { ...long, origin: "SFO", destination: "SBA" };
    const text = routeMetaDescription(AIRLINES.UA, b, ["UA100"], DESCRIPTION_MAX);
    expect(routeMetaDescription(AIRLINES.UA, b, ["UA100"], 400).length).toBeGreaterThan(
      DESCRIPTION_MAX
    );
    expect(text).toContain("San Francisco to Santa Barbara nonstops");
    expect(text).toContain("The next is UA100 on ");
    expect(text).not.toMatch(/\((SFO|SBA)\)/);
  });

  test("without codes, an airport of a city that has several is named", () => {
    expect(airportSpokenPlace("IAD")).toBe("Washington Dulles");
    expect(airportSpokenPlace("DCA")).toBe("Washington Reagan National");
    // Elsewhere the code is the airport's name; here nothing else says it.
    expect(airportSpokenPlace("JFK")).toBe("New York JFK");
    expect(airportSpokenPlace("ord")).toBe("Chicago O'Hare");
    // One airport in the table: the city alone, as before.
    expect(airportSpokenPlace("DEN")).toBe("Denver");
    expect(airportSpokenPlace("IAH")).toBe("Houston");
    expect(airportSpokenPlace(UNKNOWN)).toBeNull();
    const perCity = new Map<string, number>();
    for (const [city] of Object.values(AIRPORT_NAMES)) {
      perCity.set(city, (perCity.get(city) ?? 0) + 1);
    }
    for (const [code, [city, airport]] of Object.entries(AIRPORT_NAMES)) {
      const spoken = airportSpokenPlace(code) as string;
      expect(spoken.startsWith(city), code).toBe(true);
      if ((perCity.get(city) ?? 0) > 1 && airport) expect(spoken, code).toContain(airport);
      else expect(spoken, code).toBe(city);
    }
    // Every Dulles description that drops its codes says "Dulles".
    let withoutCodes = 0;
    for (const dest of Object.keys(AIRPORT_NAMES)) {
      if (dest === "IAD") continue;
      const b = { ...board("ORD", "DEN"), origin: "IAD", destination: dest };
      const text = routeMetaDescription(AIRLINES.UA, b, ["UA100"], DESCRIPTION_MAX);
      if (text.includes("(IAD)") || text.includes(`IAD to ${dest}`)) continue;
      withoutCodes++;
      expect(text, dest).toContain(`Washington Dulles to ${airportSpokenPlace(dest)} nonstops`);
    }
    expect(withoutCodes).toBeGreaterThan(0);
  });

  test("two airports of one city are never named without their codes", () => {
    const b = { ...board("ORD", "DEN"), origin: "IAD", destination: "DCA" };
    for (const max of [DESCRIPTION_MAX, 140, 120]) {
      expect(routeMetaDescription(AIRLINES.UA, b, ["UA100"], max)).not.toContain(
        "Washington to Washington"
      );
    }
  });

  test("the page of a long pair holds the same bounds", async () => {
    const body = await page("/route-planner/IAH/DCA");
    expect(title(body).length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title(body)).toContain(routePairLabel("IAH", "DCA"));
    expect(description(body).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(description(body)).not.toContain("…");
    expect(h1(body)).not.toContain("Intercontinental");
  });
});

describe("the flight page", () => {
  test("a route row names its two places once, under the codes", async () => {
    const body = await page("/check-flight/UA100");
    const routes = sectionOf(body, "Routes UA100 flies");
    const places = routePlaceNames("ORD", "DEN") as string;
    expect(count(routes, places)).toBe(1);
    expect(routes).toContain("ORD → DEN");
    // The title keeps the flight number and the codes: it has no room for more.
    expect(title(body)).not.toContain(airportCity("ORD") as string);
    expect(title(body).length).toBeLessThanOrEqual(TITLE_MAX);
  });

  test("a row with an end we cannot name prints its codes alone", async () => {
    const body = await page("/check-flight/UA102");
    const routes = sectionOf(body, "Routes UA102 flies");
    // The row itself; the link under the list names the departure airport's page.
    const row = routes.match(/<li[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(row).toContain(`ORD → ${UNKNOWN}`);
    expect(row).not.toContain(airportPlaceName("ORD") as string);
    expect(routes).not.toMatch(/\bnull\b|\bundefined\b/);
  });
});

describe("the home page's airport bars", () => {
  test("each bar names its airport once beside the code", async () => {
    const body = await page("/");
    const bars = body.match(/id="airports"[\s\S]*?<\/ol>/)?.[0] ?? "";
    expect(bars).not.toBe("");
    for (const code of ["ORD", "IAH", "MDW"]) {
      expect(count(bars, `>${airportPlaceName(code)}<`), code).toBe(1);
    }
    // Linked only where the airport's page indexes: ORD has the flown history,
    // IAH and MDW are thin and stay plain text.
    expect(bars).toContain('href="/routes/ORD"');
    expect(bars).toContain(">IAH</span>");
    expect(bars).not.toContain('href="/routes/IAH"');
    // O'Hare and Midway are told apart by name as well as by code.
    expect(airportPlaceName("ORD")).not.toBe(airportPlaceName("MDW"));
    expect(bars).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  test("an airport we have no name for is a bare code, with no empty label", async () => {
    const fresh = makeFreshDb();
    addPlane(fresh, "N2VER", "Starlink");
    addFlight(fresh, "N2VER", "UA200", UNKNOWN, now + 3 * HOUR, { arrivalAirport: "DEN" });
    const doc = plain(
      await (
        await createApp(fresh).dispatch(
          req("/", UA, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
        )
      ).text()
    );
    const bars = doc.match(/id="airports"[\s\S]*?<\/ol>/)?.[0] ?? "";
    // Thin here, so plain text rather than a link.
    expect(bars).toContain(`>${UNKNOWN}</span>`);
    expect(bars).not.toMatch(/<span[^>]*text-xs[^>]*><\/span>|\bnull\b|\bundefined\b/);
  });
});
