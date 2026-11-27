/**
 * The route planner's boxes take a city or an airport name.
 *
 * The search is pure code over the one names table, so it is tested here
 * directly; the browser's picker runs the same functions. The page tests hold
 * what a visitor without the script, a crawler and the page's weight depend
 * on: the form still takes codes as served, the names table is not in the
 * page's own script, and no new address answers.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITES } from "../src/airlines/registry";
import { normalizeAirportCode } from "../src/api/check-flight-core";
import { createApp } from "../src/server/app";
import { AIRPORT_COORDS } from "../src/utils/airport-geo";
import { AIRPORT_NAMES, airportPlaceName } from "../src/utils/airport-names";
import {
  AIRPORT_QUERY_MAX,
  foldPlace,
  resolveAirport,
  searchAirports,
} from "../src/utils/airport-search";
import { AIRPORT_TZ } from "../src/utils/airport-tz";
import { bodyOf, elementAttrs, openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const ROOT = join(import.meta.dir, "..");
const codesOf = (query: string, limit = 50) =>
  searchAirports(query, limit).matches.map((m) => m.code);

describe("searching the names table", () => {
  test("a city with several airports offers each, told apart by name and code", () => {
    for (const [city, airports] of [
      ["New York", ["JFK", "LGA"]],
      ["Chicago", ["ORD", "MDW"]],
      ["Washington", ["IAD", "DCA"]],
      ["Tokyo", ["HND", "NRT"]],
      ["London", ["LHR", "LGW", "STN"]],
    ] as const) {
      const { matches } = searchAirports(city, 50);
      for (const code of airports) expect(codesOf(city), city).toContain(code);
      // The city's own airports lead; a state of the same name comes after.
      expect(
        matches
          .slice(0, airports.length)
          .map((m) => m.code)
          .sort()
      ).toEqual([...airports].sort());
      const labels = matches.map((m) => `${m.name} ${m.code}`);
      expect(new Set(labels).size).toBe(labels.length);
      expect(resolveAirport(city).kind, city).toBe("choose");
    }
  });

  test("every airport is found by the name the site prints for it", () => {
    for (const code of Object.keys(AIRPORT_NAMES)) {
      const name = airportPlaceName(code) as string;
      expect(codesOf(name, 600), name).toContain(code);
      expect(codesOf(name.toUpperCase(), 600), name).toContain(code);
    }
  });

  test("accents, apostrophes and case do not matter", () => {
    expect(codesOf("sao paulo")).toEqual(codesOf("São Paulo"));
    expect(codesOf("sao paulo")).toContain("GRU");
    for (const typed of ["ohare", "o'hare", "O’Hare", "hare", "chicago o"]) {
      expect(codesOf(typed), typed).toContain("ORD");
    }
    expect(codesOf("malaga")).toContain("AGP");
    expect(foldPlace("  São   Paulo/Guarulhos ")).toBe("sao paulo guarulhos");
  });

  test("a later word finds the airport: its own name, or the second city", () => {
    expect(codesOf("dulles")).toEqual(["IAD"]);
    expect(codesOf("heathrow")).toEqual(["LHR"]);
    expect(codesOf("eureka")).toContain("ACV");
    expect(codesOf("fort worth")).toContain("DFW");
  });

  test("the code typed exactly leads, then names that start with the text", () => {
    expect(codesOf("san")[0]).toBe("SAN");
    expect(codesOf("SAN")).toContain("SFO");
    expect(codesOf("den")[0]).toBe("DEN");
    expect(codesOf("kord")).toEqual(["ORD"]);
  });

  test("airports the airline flies most lead within a rank, and only there", () => {
    expect(codesOf("chicago")).toEqual(["MDW", "ORD"]);
    expect(searchAirports("chicago", 8, ["ORD"]).matches.map((m) => m.code)).toEqual([
      "ORD",
      "MDW",
    ]);
    // A preferred airport never jumps ahead of a better match.
    expect(
      searchAirports("san", 8, ["SFO"])
        .matches.map((m) => m.code)
        .slice(0, 2)
    ).toEqual(["SAN", "SFO"]);
  });

  test("the count says how many were left out", () => {
    const { matches, total } = searchAirports("s", 8);
    expect(matches).toHaveLength(8);
    expect(total).toBeGreaterThan(8);
    expect(searchAirports("", 8)).toEqual({ matches: [], total: 0 });
    expect(searchAirports("   ", 8)).toEqual({ matches: [], total: 0 });
  });
});

describe("what a box's text means when the form is sent", () => {
  test("every code the site knows goes through as typed, in any case", () => {
    const known = new Set([...Object.keys(AIRPORT_TZ), ...Object.keys(AIRPORT_COORDS)]);
    expect(known.size).toBeGreaterThan(500);
    for (const code of known) {
      // The rule this rests on: no known airport lacks a name, so a real code
      // can never be mistaken for the start of some city.
      expect(AIRPORT_NAMES[code], code).toBeDefined();
      for (const typed of [code, code.toLowerCase(), ` ${code} `]) {
        const r = resolveAirport(typed);
        expect(r, typed).toEqual({ kind: "code", code, name: airportPlaceName(code) });
      }
    }
  });

  test("a K or P ICAO spelling goes through as typed, as the API reads it", () => {
    for (const typed of ["KORD", "ksfo", "PHNL"]) {
      const r = resolveAirport(typed);
      expect(r.kind).toBe("code");
      if (r.kind !== "code") continue;
      expect(r.code).toBe(typed.toUpperCase());
      expect(normalizeAirportCode(r.code)).toBe(typed.toUpperCase().slice(1));
    }
  });

  test("three letters that nothing matches still go through; the plan address refuses them", () => {
    expect(resolveAirport("qqx")).toEqual({ kind: "code", code: "QQX", name: null });
  });

  test("a name with one airport is that airport", () => {
    expect(resolveAirport("Denver")).toEqual({ kind: "code", code: "DEN", name: "Denver" });
    expect(resolveAirport("san fran")).toMatchObject({ kind: "code", code: "SFO" });
    expect(resolveAirport("Rome")).toMatchObject({ kind: "code", code: "FCO" });
    expect(resolveAirport("rio")).toMatchObject({ kind: "code", code: "GIG" });
  });

  test("text that matches nothing says so, whatever it holds", () => {
    for (const typed of [
      "",
      "Atlantis",
      "<script>alert(1)</script>",
      '"><img src=x onerror=alert(1)>',
      "'; DROP TABLE flights; --",
      "12345",
      "🛫🛫🛫",
      "\u0000\u0007",
      "ZZZZZ".repeat(2000),
      "../../etc/passwd",
      "%3Cscript%3E",
    ]) {
      expect(resolveAirport(typed), typed.slice(0, 30)).toEqual({ kind: "none" });
    }
  });

  test("no answer carries typed text that is not a code or a name from the table", () => {
    const names = new Set(Object.keys(AIRPORT_NAMES).map((c) => airportPlaceName(c)));
    for (const typed of ["chicago<b>", "new york", "s", "<i>den", "KORD", "qqx", "o'h"]) {
      const r = resolveAirport(typed);
      if (r.kind === "none") continue;
      const found = r.kind === "code" ? [{ code: r.code, name: r.name }] : r.matches;
      for (const m of found) {
        expect(m.code, typed).toMatch(/^[A-Z]{3,4}$/);
        if (m.name !== null) expect(names.has(m.name), typed).toBe(true);
      }
    }
  });

  test("long text is cut before it is searched", () => {
    const started = performance.now();
    for (let i = 0; i < 200; i++) searchAirports("chicago ".repeat(5000));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(foldPlace("x".repeat(500)).length).toBeLessThanOrEqual(AIRPORT_QUERY_MAX);
    const longest = Math.max(
      ...Object.keys(AIRPORT_NAMES).map((c) => (airportPlaceName(c) as string).length)
    );
    expect(longest).toBeLessThanOrEqual(AIRPORT_QUERY_MAX);
  });
});

describe("the planner page", () => {
  let app: ReturnType<typeof createApp>;
  let page: string;
  beforeAll(async () => {
    app = createApp(openSnapshot());
    page = (await bodyOf(app, "/route-planner", UA)).text;
  });

  test("as served, each box takes a code and nothing else: it works with no script", () => {
    for (const id of ["origin", "destination"]) {
      const box = elementAttrs(page, id);
      expect(box.maxLength).toBe("4");
      expect(box.name).toBe(id);
      // The combobox role is the script's to add: with no script there is no list to announce.
      expect(box.role).toBeUndefined();
      expect(elementAttrs(page, `${id}-list`).hidden).toBeDefined();
      expect(page).toContain(`<p id="${id}-hint"`);
      expect(page).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    }
    expect(page).toMatch(/<div id="airport-status" role="status" class="sr-only"><\/div>/);
  });

  test("the names table is fetched on demand, never with the page", async () => {
    const form = elementAttrs(page, "route-form");
    const src = form["data-picker-src"];
    expect(src).toMatch(/^\/static\/airport-picker\.[a-z0-9]+\.js$/);
    const scripts = [...page.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).not.toContain(src);
    const own = scripts.find((s) => s.startsWith("/static/route-planner."));
    expect(own).toBeDefined();

    const picker = await app.dispatch(req(src, UA));
    expect(picker.status).toBe(200);
    expect(picker.headers.get("content-type")).toContain("text/javascript");
    expect(picker.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const pickerCode = await picker.text();
    const ownCode = await (await app.dispatch(req(own as string, UA))).text();
    // Any name will do: the table is in one bundle and not the other.
    for (const name of ["Albuquerque", "Reagan National", "Guarulhos"]) {
      expect(pickerCode).toContain(name);
      expect(ownCode).not.toContain(name);
      expect(page).not.toContain(name);
    }
    // The page's own script grew by the loader, the legs' page links and
    // their usual times alone; the names table would add some 17 KB.
    expect(ownCode.length).toBeLessThan(20_500);
  });

  test("the airports the airline flies lead the list: codes only, from the page's own routes", () => {
    const busy = elementAttrs(page, "route-form")["data-busy-airports"];
    if (busy === undefined) return;
    const linked = new Set(
      [...page.matchAll(/href="\/route-planner\/([A-Z]{3})\/([A-Z]{3})"/g)].flatMap((m) => [
        m[1],
        m[2],
      ])
    );
    const codes = busy.split(" ");
    expect(codes.length).toBeLessThanOrEqual(40);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(linked.has(code), code).toBe(true);
    }
  });

  test("no new address answers: names are not a server lookup", async () => {
    for (const path of ["/api/airports?q=chicago", "/api/airport-search?q=chicago"]) {
      expect((await app.dispatch(req(path, UA))).status).toBe(404);
    }
    expect(app.routeTags.filter((t) => /airport/.test(t))).toEqual([]);
  });

  test("typed text in the address never reaches the served page", async () => {
    const hostile = '"><script>alert(1)</script>';
    const { status, text } = await bodyOf(
      app,
      `/route-planner?origin=${encodeURIComponent(hostile)}&destination=${encodeURIComponent("<b>Chicago")}`,
      UA
    );
    expect(status).toBe(200);
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("<b>Chicago");
    expect(text).toBe(page);
  });

  test("the picker writes typed text as text, never as markup", () => {
    const source = readFileSync(join(ROOT, "src/client/airport-picker.ts"), "utf8");
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    // The planner's own innerHTML writes are its results, built from API answers through esc().
    const planner = readFileSync(join(ROOT, "src/client/route-planner.ts"), "utf8");
    const names = planner.slice(
      planner.indexOf("function wireAirportNames"),
      planner.indexOf("export function wireRoutePlanner")
    );
    expect(names.length).toBeGreaterThan(500);
    expect(names).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
});
