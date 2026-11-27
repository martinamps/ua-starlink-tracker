/**
 * The planner's boxes after a second look: the list stays out of the Tab
 * order, an airport nobody holds gets no itinerary, and a short alias list
 * lets "New York" offer Newark and "DC" offer Dulles.
 *
 * The keyboard itself (Tab from a list long enough to scroll, a retry of the
 * names file) needs a browser; what is held here is what the page serves,
 * what the search answers and what the plan address refuses.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { PLACE_ALIASES } from "../src/utils/airport-aliases";
import { AIRPORT_NAMES, airportCity } from "../src/utils/airport-names";
import { foldPlace, resolveAirport, searchAirports } from "../src/utils/airport-search";
import { bodyOf, elementAttrs, openSnapshot } from "./helpers";

const UA = SITES.united.canonicalHost;
const codesOf = (query: string, prefer: readonly string[] = []) =>
  searchAirports(query, 50, prefer).matches.map((m) => m.code);

interface PlanAnswer {
  origin: string;
  destination: string;
  itineraries: Array<{ legs: Array<{ route: string }> }>;
  baseline: unknown;
  message?: string;
}

describe("the alias list", () => {
  test("names only airports the table holds, and never a code the table holds", () => {
    expect(PLACE_ALIASES.length).toBeLessThanOrEqual(15);
    for (const { names, airports } of PLACE_ALIASES) {
      expect(airports.length).toBeGreaterThan(0);
      for (const code of airports) expect(AIRPORT_NAMES[code], code).toBeDefined();
      for (const name of names) {
        expect(foldPlace(name), name).toBe(name);
        const asCode = name.replace(/ /g, "").toUpperCase();
        // A typed code always wins: an alias may not shadow one, nor its ICAO spelling.
        expect(AIRPORT_NAMES[asCode], name).toBeUndefined();
        if (/^[KP][A-Z]{3}$/.test(asCode)) expect(AIRPORT_NAMES[asCode.slice(1)]).toBeUndefined();
      }
    }
  });

  test("no neighbouring city under a city's name: a row is one city's airports", () => {
    for (const { names, airports } of PLACE_ALIASES) {
      const cities = new Set(airports.map((code) => airportCity(code)));
      // Newark is the one exception, by IATA's city code NYC: United's New York hub.
      if (airports.includes("EWR")) {
        expect([...cities].sort()).toEqual(["New York", "Newark"]);
        continue;
      }
      expect(cities.size, names[0]).toBe(1);
    }
    const named = new Set(PLACE_ALIASES.flatMap((a) => a.airports));
    for (const neighbour of ["BWI", "SWF", "OAK", "SJC", "BUR", "LGB", "SNA", "ONT", "FLL"]) {
      expect(named.has(neighbour), neighbour).toBe(false);
    }
  });

  test("New York offers Newark, and leads with it where the airline flies it most", () => {
    for (const typed of ["new york", "New York", "NYC", "nyc", "ny", "new york city", "newyork"]) {
      expect(codesOf(typed).sort(), typed).toEqual(["EWR", "JFK", "LGA"]);
      const r = resolveAirport(typed);
      expect(r.kind, typed).toBe("choose");
    }
    expect(codesOf("new york", ["ORD", "EWR", "DEN"])[0]).toBe("EWR");
    // The row reads "Newark": nobody is told it is in the city.
    const newark = searchAirports("new york").matches.find((m) => m.code === "EWR");
    expect(newark?.name).toBe("Newark");
    // The state's other airports are not the city's.
    expect(codesOf("new york")).not.toContain("ALB");
    expect(codesOf("new york")).not.toContain("SWF");
  });

  test("DC offers Dulles and Reagan National, not Reagan alone by its code's start", () => {
    for (const typed of ["dc", "DC", "d.c.", "D.C.", "washington dc", "Washington, D.C.", "was"]) {
      expect(codesOf(typed).sort(), typed).toEqual(["DCA", "IAD"]);
      expect(resolveAirport(typed).kind, typed).toBe("choose");
    }
    expect(codesOf("dc", ["IAD"])[0]).toBe("IAD");
    expect(codesOf("dc")).not.toContain("BWI");
  });

  test("a city code is read before the code pass-through and never sent on as a code", () => {
    for (const [code, airports] of [
      ["NYC", ["EWR", "JFK", "LGA"]],
      ["WAS", ["DCA", "IAD"]],
      ["CHI", ["MDW", "ORD"]],
      ["LON", ["LGW", "LHR", "STN"]],
      ["PAR", ["CDG", "ORY"]],
      ["TYO", ["HND", "NRT"]],
      ["MIL", ["LIN", "MXP"]],
      ["ROM", ["FCO"]],
      ["BJS", ["PEK", "PKX"]],
    ] as const) {
      expect(AIRPORT_NAMES[code], code).toBeUndefined();
      const found = codesOf(code);
      expect(found.slice(0, airports.length).sort(), code).toEqual([...airports]);
      const r = resolveAirport(code.toLowerCase());
      if (r.kind === "code") {
        // Only a city with one airport searches at once, and by that airport.
        expect(airports).toEqual([r.code] as never);
        expect(r.name).not.toBeNull();
      } else {
        expect(r.kind, code).toBe("choose");
      }
    }
  });

  test("an alias that covers several airports always asks; one airport searches at once", () => {
    for (const { names, airports } of PLACE_ALIASES) {
      for (const name of names) {
        const r = resolveAirport(name);
        if (airports.length > 1) expect(r.kind, name).toBe("choose");
        else if (r.kind === "code") expect(r.code, name).toBe(airports[0]);
        const lead = r.kind === "choose" ? r.matches.slice(0, airports.length) : [];
        if (r.kind === "choose") {
          expect(lead.map((m) => m.code).sort(), name).toEqual([...airports].sort());
        }
      }
    }
    expect(resolveAirport("philly")).toMatchObject({ kind: "code", code: "PHL" });
    expect(resolveAirport("nola")).toMatchObject({ kind: "code", code: "MSY" });
    expect(resolveAirport("L.A.")).toMatchObject({ kind: "code", code: "LAX" });
    expect(codesOf("la")[0]).toBe("LAX");
  });

  test("a whole code still wins over every alias, and a short start lists no alias", () => {
    expect(resolveAirport("lax")).toMatchObject({ kind: "code", code: "LAX" });
    expect(resolveAirport("dca")).toMatchObject({ kind: "code", code: "DCA" });
    expect(resolveAirport("ewr")).toMatchObject({ kind: "code", code: "EWR" });
    // "d" is not yet "dc": Dulles is not pushed ahead of Denver.
    expect(codesOf("d", ["DEN"])[0]).toBe("DEN");
    // From three letters a started alias joins the names that start the same.
    expect(codesOf("new")).toContain("EWR");
  });
});

describe("other spellings", () => {
  test("St and Saint, Ft and Fort fold alike", () => {
    for (const typed of ["saint louis", "st louis", "St. Louis", "SAINT LOUIS"]) {
      expect(resolveAirport(typed), typed).toMatchObject({ kind: "code", code: "STL" });
    }
    for (const typed of ["ft lauderdale", "Ft. Lauderdale", "fort lauderdale"]) {
      expect(resolveAirport(typed), typed).toMatchObject({ kind: "code", code: "FLL" });
    }
    expect(codesOf("ft worth").sort()).toEqual(["DFW", "FTW"]);
    expect(codesOf("st denis")).toEqual(["RUN"]);
    expect(codesOf("minneapolis saint paul")).toEqual(["MSP"]);
    // Part-way through the long spelling the list does not go empty.
    expect(codesOf("sain")).toContain("STL");
    for (const m of searchAirports("saint", 50).matches) expect(m.name).toMatch(/St\.|Saint/);
    for (const m of searchAirports("fort", 50).matches) expect(m.name).toMatch(/Fort/);
  });

  test("a name typed with its spaces moved still finds the airport", () => {
    expect(resolveAirport("la guardia")).toMatchObject({ kind: "code", code: "LGA" });
    expect(codesOf("sanfrancisco")).toEqual(["SFO"]);
    // Short text is not closed up: "san d" is San Diego, not Sandusky.
    for (const m of searchAirports("san d", 50).matches) expect(m.name).not.toMatch(/^Sand/);
  });

  test("one field under two codes is two rows that tell each other apart", () => {
    const rows = searchAirports("west palm beach").matches;
    expect(rows.map((m) => m.code).sort()).toEqual(["DJT", "PBI"]);
    expect(rows.find((m) => m.code === "DJT")?.name).toBe("West Palm Beach (also PBI)");
    expect(rows.find((m) => m.code === "PBI")?.name).toBe("West Palm Beach (also DJT)");
    const labels = searchAirports("s", 600).matches.map((m) => m.name);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("four letters that are no code and no name are refused in the box", () => {
    for (const typed of ["roma", "bern", "oahu", "zzzz", "QQQQ"]) {
      expect(resolveAirport(typed), typed).toEqual({ kind: "none" });
    }
    expect(resolveAirport("kord")).toMatchObject({ kind: "code", code: "KORD" });
  });
});

describe("the planner page and the plan address", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp(openSnapshot());
  });
  const plan = async (query: string, host = UA) => {
    const { status, text } = await bodyOf(app, `/api/plan-route?${query}`, host);
    return { status, json: JSON.parse(text) as PlanAnswer };
  };

  test("both airport lists are out of the Tab order as served", async () => {
    const page = (await bodyOf(app, "/route-planner", UA)).text;
    for (const id of ["origin", "destination"]) {
      const list = elementAttrs(page, `${id}-list`);
      // A list long enough to scroll is otherwise a Tab stop that hides as it is reached.
      expect(list.tabindex ?? list.tabIndex, id).toBe("-1");
      expect(elementAttrs(page, id).tabindex).toBeUndefined();
    }
  });

  test("a made-up code gets no itinerary, at either end, on every site with a planner", async () => {
    for (const host of [UA, SITES.hawaiian.canonicalHost, SITES.alaska.canonicalHost]) {
      for (const [o, d] of [
        ["NYC", "DEN"],
        ["DEN", "NYC"],
        ["ROMA", "DEN"],
        ["CORK", "DEN"],
        ["OAHU", "DEN"],
        ["QQQQ", "DEN"],
        ["ZZZ", "QQQ"],
      ]) {
        const { status, json } = await plan(`origin=${o}&destination=${d}`, host);
        expect(status, `${host} ${o}-${d}`).toBe(200);
        expect(json.itineraries, `${host} ${o}-${d}`).toEqual([]);
        expect(json.baseline).toBeNull();
        expect(json.message).toContain("No airport on record");
        expect(json.origin).toBe(o);
      }
    }
  });

  test("the refusal says back only letters shaped like a code", async () => {
    const hostile = encodeURIComponent('"><script>alert(1)</script>');
    const { status, json } = await plan(`origin=${hostile}&destination=DEN`);
    expect(status).toBe(200);
    expect(json.itineraries).toEqual([]);
    expect(json.message).toBe("Enter a 3-letter airport code for both airports.");
  });

  test("known airports plan as before, and an ICAO spelling is read as its airport", async () => {
    const known = await plan("origin=ORD&destination=DEN");
    expect(known.status).toBe(200);
    expect(Array.isArray(known.json.itineraries)).toBe(true);
    expect(known.json.message).toBeUndefined();
    const icao = await plan("origin=KORD&destination=KDEN");
    expect(icao.json.itineraries).toEqual(known.json.itineraries);
    for (const it of icao.json.itineraries) {
      for (const leg of it.legs) expect(leg.route).toMatch(/^[A-Z]{3}-[A-Z]{3}$/);
    }
    expect((await plan("origin=KORD&destination=ORD")).status).toBe(400);
  });
});
