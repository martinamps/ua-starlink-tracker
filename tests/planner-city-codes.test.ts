/**
 * Five mends after the second look at the planner's alias list.
 *
 * A city code met without the names table (typed before the page's names file
 * loaded, or arriving in an address) offers that city's airports, on the page
 * and in the plan address's own words. The page's side runs here against a
 * stand-in for the few DOM calls it makes; a browser walk holds the real one.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { wireAirportNames } from "../src/client/route-planner";
import { createApp } from "../src/server/app";
import { PLACE_ALIASES, orList, placeCodeAirports } from "../src/utils/airport-aliases";
import { AIRPORT_COORDS } from "../src/utils/airport-geo";
import { AIRPORT_NAMES, airportSpokenPlace } from "../src/utils/airport-names";
import { resolveAirport, searchAirports } from "../src/utils/airport-search";
import { AIRPORT_TZ } from "../src/utils/airport-tz";
import { bodyOf, openSnapshot } from "./helpers";

const UA = SITES.united.canonicalHost;
const codesOf = (query: string) => searchAirports(query, 50).matches.map((m) => m.code);
const FAILED = "The airport list did not load. Enter a 3-letter airport code, or try again.";

/** Aliases a visitor can type in the shape of a code: the city codes, and "nola". */
const CODE_SHAPED_ALIASES = PLACE_ALIASES.flatMap(({ names, airports }) =>
  names.filter((n) => /^[a-z]{3,4}$/.test(n)).map((name) => ({ name, airports }))
);

describe("a city code without the names table", () => {
  test("every alias shaped like a code is read as its airports, in any case", () => {
    expect(CODE_SHAPED_ALIASES.map((a) => a.name).sort()).toEqual(
      ["bjs", "chi", "lon", "mil", "nola", "nyc", "par", "rom", "tyo", "was"].sort()
    );
    for (const { name, airports } of CODE_SHAPED_ALIASES) {
      expect(placeCodeAirports(name), name).toEqual(airports);
      expect(placeCodeAirports(` ${name.toUpperCase()} `), name).toEqual(airports);
    }
  });

  test("no airport code, name or longer text is read as a city code", () => {
    for (const code of Object.keys(AIRPORT_NAMES)) {
      expect(placeCodeAirports(code), code).toBeNull();
      expect(placeCodeAirports(`K${code}`), code).toBeNull();
    }
    for (const text of ["", "ny", "dc", "la", "new york", "philly", "ZZZ", "nyc1", "<b>"]) {
      expect(placeCodeAirports(text), text).toBeNull();
    }
    expect(orList(["JFK", "LGA", "EWR"])).toBe("JFK, LGA or EWR");
    expect(orList(["IAD", "DCA"])).toBe("IAD or DCA");
    expect(orList(["FCO"])).toBe("FCO");
  });

  describe("the plan address", () => {
    let app: ReturnType<typeof createApp>;
    beforeAll(() => {
      app = createApp(openSnapshot());
    });
    const plan = async (query: string, host = UA) => {
      const { status, text } = await bodyOf(app, `/api/plan-route?${query}`, host);
      return { status, json: JSON.parse(text) as Record<string, unknown> };
    };

    test("offers the city's airports at either end, in the same five keys", async () => {
      for (const host of [UA, SITES.hawaiian.canonicalHost, SITES.alaska.canonicalHost]) {
        for (const { name, airports } of CODE_SHAPED_ALIASES) {
          const code = name.toUpperCase();
          for (const query of [
            `origin=${code}&destination=DEN`,
            `origin=DEN&destination=${name}`,
          ]) {
            const { status, json } = await plan(query, host);
            expect(status, query).toBe(200);
            expect(Object.keys(json), query).toEqual([
              "origin",
              "destination",
              "itineraries",
              "baseline",
              "message",
            ]);
            expect(json.itineraries, query).toEqual([]);
            expect(json.baseline, query).toBeNull();
            expect(json.message, query).toBe(
              `No airport on record with the code ${code}. For ${code}, try ${orList(airports)}. Enter a city or a 3-letter airport code.`
            );
          }
        }
      }
    });

    test("both ends a city code: each is offered its own airports", async () => {
      const { json } = await plan("origin=NYC&destination=WAS");
      expect(json.message).toBe(
        "No airport on record with the code NYC or WAS. For NYC, try JFK, LGA or EWR. For WAS, try IAD or DCA. Enter a city or a 3-letter airport code."
      );
    });

    test("a code that is neither an airport nor a city code is refused as before", async () => {
      for (const code of ["ZZZ", "QQQ", "ROMA", "NOL", "NYCX"]) {
        const { status, json } = await plan(`origin=${code}&destination=DEN`);
        expect(status, code).toBe(200);
        expect(json.itineraries, code).toEqual([]);
        expect(json.message, code).toBe(
          `No airport on record with the code ${code}. Enter a city or a 3-letter airport code.`
        );
      }
      const hostile = encodeURIComponent("NYC<script>alert(1)</script>");
      const { json } = await plan(`origin=${hostile}&destination=DEN`);
      expect(json.message).toBe("Enter a 3-letter airport code for both airports.");
    });
  });
});

/**
 * The page's own reading of a box (wireAirportNames), with the handful of DOM
 * calls it makes stood in for. `picker` says how the names file's fetch ends.
 */
function pageWith(picker: "fails" | "never asked") {
  type El = Record<string, unknown> & { textContent: string; className: string };
  const el = (id: string): El => ({ id, textContent: "", className: "", dataset: {} });
  const els = new Map<string, El>();
  const attrs = new Map<string, Map<string, string>>();
  const box = (id: string) => {
    const a = new Map<string, string>();
    attrs.set(id, a);
    for (const part of ["list", "hint"]) {
      const e = el(`${id}-${part}`);
      e.setAttribute = () => {};
      els.set(`${id}-${part}`, e);
    }
    return {
      id,
      value: "",
      focused: 0,
      setAttribute: (k: string, v: string) => a.set(k, v),
      removeAttribute: (k: string) => a.delete(k),
      focus() {
        this.focused++;
      },
    };
  };
  const origin = box("origin");
  const destination = box("destination");
  els.set("airport-status", el("airport-status"));
  const fetched: string[] = [];
  const doc = {
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: () => ({ remove() {} }) as Record<string, unknown>,
    head: {
      append(script: { src: string; onerror?: () => void }) {
        fetched.push(script.src);
        if (picker === "fails") queueMicrotask(() => script.onerror?.());
      },
    },
  };
  const g = globalThis as Record<string, unknown>;
  const before = { document: g.document, window: g.window };
  g.document = doc;
  g.window = {};
  const form = {
    dataset: { pickerSrc: "/static/airport-picker.js", busyAirports: "" },
    addEventListener() {},
  };
  const codeOf = wireAirportNames(
    form as unknown as HTMLFormElement,
    [origin, destination] as unknown as HTMLInputElement[]
  );
  return {
    origin,
    destination,
    fetched,
    send: (b: typeof origin, text: string) => {
      b.value = text;
      return codeOf(b as unknown as HTMLInputElement);
    },
    hint: (id: string) => els.get(`${id}-hint`)?.textContent,
    status: () => els.get("airport-status")?.textContent,
    invalid: (id: string) => attrs.get(id)?.get("aria-invalid"),
    restore() {
      g.document = before.document;
      g.window = before.window;
    },
  };
}

describe("the page before its names file has loaded", () => {
  test("a city code is not sent as a code: it asks for the names file like a name", async () => {
    for (const { name, airports } of CODE_SHAPED_ALIASES) {
      const page = pageWith("fails");
      try {
        const sent = await page.send(page.origin, name);
        expect(page.fetched.length, name).toBe(1);
        if (airports.length === 1) {
          // One airport: searched by it even with the names file blocked.
          expect(sent, name).toBe(airports[0]);
          expect(page.origin.value).toBe(airports[0]);
          expect(page.hint("origin")).toBe("");
          continue;
        }
        expect(sent, name).toBeNull();
        const offer = `${name.toUpperCase()} covers several airports. Enter ${orList(airports)}.`;
        expect(page.hint("origin"), name).toBe(offer);
        expect(page.status(), name).toBe(offer);
        expect(page.invalid("origin"), name).toBe("true");
        expect(page.origin.focused, name).toBe(1);
      } finally {
        page.restore();
      }
    }
  });

  test("a real code, and three letters that are nothing, still go at once and fetch nothing", async () => {
    const page = pageWith("never asked");
    try {
      expect(await page.send(page.origin, "ord")).toBe("ORD");
      expect(await page.send(page.origin, "kden")).toBe("KDEN");
      expect(await page.send(page.origin, "nol")).toBe("NOL");
      expect(await page.send(page.origin, "zzz")).toBe("ZZZ");
      expect(page.fetched).toEqual([]);
    } finally {
      page.restore();
    }
  });

  test("the status line's 'did not load' words clear after a code search, as the line under the box does", async () => {
    const page = pageWith("fails");
    try {
      expect(await page.send(page.origin, "chicago")).toBeNull();
      expect(page.hint("origin")).toBe(FAILED);
      expect(page.status()).toBe(FAILED);
      expect(page.invalid("origin")).toBe("true");
      expect(await page.send(page.origin, "ord")).toBe("ORD");
      expect(page.hint("origin")).toBe("");
      expect(page.status()).toBe("");
      expect(page.invalid("origin")).toBeUndefined();
    } finally {
      page.restore();
    }
  });
});

describe("three letters that are a city code or the start of a short name", () => {
  test("'chi' leads with Chicago and still offers the names that hold the word", () => {
    const found = codesOf("chi");
    expect(found.slice(0, 2).sort()).toEqual(["MDW", "ORD"]);
    expect(found).toContain("SGN");
    expect(found).toContain("SCL");
    expect(resolveAirport("chi").kind).toBe("choose");
  });

  test("every three-letter city code offers at least what a name search would without the alias", () => {
    for (const { name, airports } of CODE_SHAPED_ALIASES.filter((a) => a.name.length === 3)) {
      const found = codesOf(name);
      expect(found.slice(0, airports.length).sort(), name).toEqual([...airports].sort());
      const words = Object.keys(AIRPORT_NAMES).filter((code) =>
        (
          AIRPORT_NAMES[code]
            .join(" ")
            .toLowerCase()
            .match(/[a-z]+/g) ?? []
        ).some((w) => w.startsWith(name))
      );
      for (const code of words) expect(found, `${name} ${code}`).toContain(code);
    }
  });

  test("a longer alias still narrows to its place", () => {
    expect(codesOf("new york").sort()).toEqual(["EWR", "JFK", "LGA"]);
    expect(codesOf("dc").sort()).toEqual(["DCA", "IAD"]);
    expect(codesOf("ny").sort()).toEqual(["EWR", "JFK", "LGA"]);
  });

  test("'nol' is not yet 'nola': it goes on as a code for the plan address to refuse", () => {
    expect(codesOf("nol")).toEqual([]);
    expect(resolveAirport("nol")).toEqual({ kind: "code", code: "NOL", name: null });
    expect(resolveAirport("nola")).toMatchObject({ kind: "code", code: "MSY" });
    // A longer alias is still offered from its third letter.
    expect(codesOf("new")).toContain("EWR");
    expect(codesOf("phi")).toContain("PHL");
  });
});

describe("West Palm Beach in a description without codes", () => {
  test("its two codes are one field, so the city alone names the airport", () => {
    expect(AIRPORT_COORDS.DJT).toEqual(AIRPORT_COORDS.PBI);
    expect(AIRPORT_NAMES.DJT).toEqual(AIRPORT_NAMES.PBI);
    expect(airportSpokenPlace("DJT")).toBe("West Palm Beach");
    expect(airportSpokenPlace("PBI")).toBe("West Palm Beach");
  });

  test("it is the only city whose several codes go by the city alone; any other names each field", () => {
    const bare = new Map<string, string[]>();
    for (const code of Object.keys(AIRPORT_NAMES)) {
      const place = airportSpokenPlace(code) as string;
      bare.set(place, [...(bare.get(place) ?? []), code]);
    }
    // Two codes under one spoken place must be one field: the same spot on the map.
    for (const [place, codes] of bare) {
      if (codes.length < 2) continue;
      expect(codes.join(), place).toBe("DJT,PBI");
      for (const code of codes)
        expect(AIRPORT_COORDS[code], code).toEqual(AIRPORT_COORDS[codes[0]]);
    }
  });
});

describe("a K or P spelling of an airport the names table lacks", () => {
  test("the box passes it on as typed, for the plan address to read", () => {
    for (const typed of ["kxyz", "KQQQ", "pzzz"]) {
      expect(AIRPORT_NAMES[typed.slice(1).toUpperCase()]).toBeUndefined();
      expect(resolveAirport(typed), typed).toEqual({
        kind: "code",
        code: typed.toUpperCase(),
        name: null,
      });
    }
    // Still read as its airport where the table holds it, and a name still wins.
    expect(resolveAirport("kord")).toMatchObject({ kind: "code", code: "KORD" });
    expect(resolveAirport("pari").kind).toBe("choose");
    // Other four letters that match nothing stay no code at all.
    for (const typed of ["roma", "bern", "oahu", "zzzz", "QQQQ"]) {
      expect(resolveAirport(typed), typed).toEqual({ kind: "none" });
    }
  });

  test("the plan address reads such a spelling by its own table, and refuses one it lacks", async () => {
    const app = createApp(openSnapshot());
    const plan = async (query: string) =>
      JSON.parse((await bodyOf(app, `/api/plan-route?${query}`, UA)).text) as {
        itineraries: unknown[];
        message?: string;
      };
    expect(AIRPORT_TZ.QQQ).toBeUndefined();
    expect((await plan("origin=KQQQ&destination=DEN")).message).toBe(
      "No airport on record with the code KQQQ. Enter a city or a 3-letter airport code."
    );
    expect((await plan("origin=KORD&destination=DEN")).itineraries).toEqual(
      (await plan("origin=ORD&destination=DEN")).itineraries
    );
  });
});
