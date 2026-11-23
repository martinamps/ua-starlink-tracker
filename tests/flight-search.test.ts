/**
 * The shared flight search: the browser's normalization is the router's own
 * rules, the no-JS submit lands on the same permalink, and the bundle the
 * pages reference is actually served.
 */
import { describe, expect, test } from "bun:test";
import { canonicalFlightFor } from "../src/airlines/flight-input";
import { flightInputRules } from "../src/airlines/flight-number";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { checkPageLink, shapeHint } from "../src/client/flight-search";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

const UA = "unitedstarlinktracker.com";
const app = createApp(openSnapshot());

describe("canonicalFlightFor", () => {
  const rules = flightInputRules(AIRLINES.UA);
  test.each([
    ["ua 544", "UA544"],
    ["UA-0100", "UA100"],
    ["544", "UA544"],
    ["UAL675", "UA675"],
    [" ua.12 ", "UA12"],
  ])("%s → %s", (input, expected) => {
    expect(canonicalFlightFor(rules, input)).toBe(expected);
  });

  test("anything outside this carrier's permalink shape is null", () => {
    for (const bad of ["AA100", "UA12345", "PHX", ""]) {
      expect(canonicalFlightFor(rules, bad)).toBeNull();
    }
  });

  test("every permalink it mints is one the router serves without a redirect", async () => {
    const fn = canonicalFlightFor(rules, "ua 0544") as string;
    const res = await app.dispatch(req(`/check-flight/${fn}`, UA));
    expect(res.status).toBe(200);
  });
});

describe("no-JS form submit", () => {
  const AS = SITES.alaska.canonicalHost;
  const location = async (path: string, host: string) => {
    const res = await app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));
    return { status: res.status, location: res.headers.get("Location") };
  };
  const cases: [host: string, query: string, target: string][] = [
    [UA, "ua%20544&date=2026-10-01", "/check-flight/UA544/2026-10-01"],
    [UA, "UA544&date=nope", "/check-flight/UA544"],
    [UA, "2258", "/check-flight/UA2258"],
    [UA, "UAL2258", "/check-flight/UA2258"],
    [UA, "ua+0544", "/check-flight/UA544"],
    [
      UA,
      "UA2258&date=2027-01-01&origin=sfo&destination=EWR",
      "/check-flight/UA2258/2027-01-01?origin=sfo&destination=EWR",
    ],
    [AS, "850", "/check-flight/AS850"],
    [AS, "ASA0850&origin=SEA", "/check-flight/AS850?origin=SEA"],
    ["localhost:3000", "2258", "/check-flight/UA2258"],
  ];
  for (const [host, query, target] of cases) {
    test(`${host} ?flight_number=${query} lands on ${target} in one relative hop`, async () => {
      expect(await location(`/check-flight?flight_number=${query}`, host)).toEqual({
        status: 302,
        location: target,
      });
      expect(await location(target, host)).toEqual({ status: 200, location: null });
    });
  }

  test("a query that is not a flight number goes to the router's notice", async () => {
    expect(await location("/check-flight?flight_number=SFO", UA)).toEqual({
      status: 302,
      location: "/check-flight/SFO",
    });
    expect((await location("/check-flight/SFO", UA)).status).toBe(404);
  });
});

describe("client bundles", () => {
  test("pages reference fingerprinted bundles that serve as immutable JavaScript", async () => {
    for (const path of ["/check-flight", "/live-tv"]) {
      const html = await (await app.dispatch(req(path, UA))).text();
      const src = html.match(/<script src="(\/static\/[a-z-]+\.[a-z0-9]+\.js)"/)?.[1];
      expect(src, path).toBeDefined();
      const res = await app.dispatch(req(src as string, UA));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("javascript");
      expect(res.headers.get("Cache-Control")).toContain("immutable");
    }
  });
});

describe("the date starts on today wherever a visitor types a flight", () => {
  const AS = SITES.alaska.canonicalHost;
  const HUB = SITES.airline.canonicalHost;
  const formTag = (html: string, id: string) =>
    html.match(new RegExp(`<form[^>]*id="${id}"[^>]*>`))?.[0] ?? "";

  test.each([
    [UA, "/", "home-flight-search"],
    [AS, "/", "home-flight-search"],
    [UA, "/check-flight", "check-flight-form"],
    [HUB, "/", "hub-check-flight"],
  ])("%s%s #%s asks the browser to prefill the date", async (host, path, id) => {
    const html = await (await app.dispatch(req(path, host))).text();
    expect(formTag(html, id)).toContain("data-prefill-date");
  });

  test("the flight field turns phone autocorrect off and offers a search key", async () => {
    const html = await (await app.dispatch(req("/check-flight", UA))).text();
    const input = html.match(/<input[^>]*id="check-flight-form-number"[^>]*>/)?.[0] ?? "";
    expect(input.toLowerCase()).toContain('autocorrect="off"');
    expect(input.toLowerCase()).toContain('enterkeyhint="search"');
  });
});

describe("a flight number we hold no rows for", () => {
  // Outside every carrier's real numbering, so no snapshot can hold it.
  const cases: [host: string, fn: string][] = [
    [UA, "UA9998"],
    [SITES.alaska.canonicalHost, "AS9998"],
  ];
  for (const [host, fn] of cases) {
    test(`${host} /check-flight/${fn} keeps the number instead of an empty form`, async () => {
      const res = await app.dispatch(req(`/check-flight/${fn}`, host));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`Does ${fn} have Starlink Wi-Fi?</h1>`);
      const input = html.match(/<input[^>]*id="check-flight-form-number"[^>]*>/)?.[0] ?? "";
      expect(input).toContain(`value="${fn}"`);
      expect(html).toContain("noindex, follow");
    });
  }
});

describe("the hub's check hands off to the airline's own page", () => {
  const HUB = SITES.airline.canonicalHost;
  const pages = async () => {
    const html = await (await app.dispatch(req("/", HUB))).text();
    const raw = html.match(/data-check-pages="([^"]*)"/)?.[1] ?? "";
    return JSON.parse(raw.replaceAll("&quot;", '"')) as Record<
      string,
      { url: string; site: string }
    >;
  };

  test("the form carries one check page per live airline site that has one", async () => {
    const map = await pages();
    for (const site of Object.values(SITES)) {
      if (site.scope === "ALL") continue;
      const entry = map[AIRLINES[site.scope].name];
      if (site.live && site.features.checkFlightPage) {
        expect(entry?.url).toBe(`https://${site.canonicalHost}/check-flight`);
      } else {
        expect(entry).toBeUndefined();
      }
    }
  });

  test("an answer links the dated permalink, and that permalink is served", async () => {
    const map = await pages();
    const link = checkPageLink({ airline: AIRLINES.UA.name }, map, "ua 544", "2027-01-05");
    const href = link.match(/href="([^"]+)"/)?.[1];
    expect(href).toBe(`https://${UA}/check-flight/UA544/2027-01-05`);
    const res = await app.dispatch(req(new URL(href as string).pathname, UA));
    expect(res.status).toBe(200);
  });

  test("no link for an error, an airline without a site, or an entry that is not a number", async () => {
    const map = await pages();
    const ua = AIRLINES.UA.name;
    expect(checkPageLink({ error: "x", airline: ua }, map, "UA1", "2027-01-05")).toBe("");
    expect(checkPageLink({ airline: AIRLINES.HA.name }, map, "HA51", "2027-01-05")).toBe("");
    expect(checkPageLink({ airline: ua }, map, "<b>", "2027-01-05")).toBe("");
  });

  test("an error explains the shape only when the entry is not code plus number", () => {
    expect(shapeHint("hello", "UA1736")).toContain("UA1736");
    expect(shapeHint("1736", "UA1736")).toContain("UA1736");
    expect(shapeHint("dl 1", "UA1736")).toBe("");
    expect(shapeHint("hello", "")).toBe("");
  });
});
