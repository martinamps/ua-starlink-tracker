/**
 * The shared flight search: the browser's normalization is the router's own
 * rules, the no-JS submit lands on the same permalink, and the bundle the
 * pages reference is actually served.
 */
import { describe, expect, test } from "bun:test";
import { canonicalFlightFor } from "../src/airlines/flight-input";
import { flightInputRules } from "../src/airlines/flight-number";
import { AIRLINES, SITES } from "../src/airlines/registry";
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
