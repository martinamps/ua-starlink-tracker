/**
 * The shared flight search: the browser's normalization is the router's own
 * rules, the no-JS submit lands on the same permalink, and the bundle the
 * pages reference is actually served.
 */
import { describe, expect, test } from "bun:test";
import { canonicalFlightFor } from "../src/airlines/flight-input";
import { flightInputRules } from "../src/airlines/flight-number";
import { AIRLINES } from "../src/airlines/registry";
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
  test("GET /check-flight?flight_number=&date= redirects to the dated permalink", async () => {
    const res = await app.dispatch(req("/check-flight?flight_number=ua%20544&date=2026-10-01", UA));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location") ?? "").pathname).toBe(
      "/check-flight/UA544/2026-10-01"
    );
  });

  test("a junk date is dropped rather than carried into the URL", async () => {
    const res = await app.dispatch(req("/check-flight?flight_number=UA544&date=nope", UA));
    expect(new URL(res.headers.get("Location") ?? "").pathname).toBe("/check-flight/UA544");
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
