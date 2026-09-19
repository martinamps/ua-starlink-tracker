/**
 * Typed flight numbers ("UA 544", "ua-544", " 544 ", "UA.544") resolve to the
 * canonical number on every flight-number surface; separators never let an
 * over-long number through.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  canonicalFlightInput,
  detectMarketingCarrier,
  ensureAirlinePrefix,
  prefixBelongsTo,
} from "../src/airlines/flight-number";
import { AIRLINES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot } from "./helpers";

const SPELLINGS = ["UA 544", "ua-544", " 544 ", "UA.544", "UA544"];
// Far future: the prediction branch, with no FR24 lookup window to hit.
const DATE = "2099-01-01";

describe("canonicalFlightInput", () => {
  test("strips whitespace, dashes and dots and upper-cases", () => {
    expect(canonicalFlightInput(" ua - 5 4 4 ")).toBe("UA544");
    expect(canonicalFlightInput("UA.544")).toBe("UA544");
    expect(canonicalFlightInput("skw5212")).toBe("SKW5212");
  });

  test("prefix helpers see the canonical form", () => {
    for (const s of SPELLINGS) expect(ensureAirlinePrefix(AIRLINES.UA, s)).toBe("UA544");
    expect(detectMarketingCarrier("ua 544")?.code).toBe("UA");
    expect(prefixBelongsTo(AIRLINES.UA, "UA-544")).toBe(true);
    expect(prefixBelongsTo(AIRLINES.UA, "DL 100")).toBe(false);
  });
});

describe("flight-number surfaces", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    db = openSnapshot();
    app = createApp(db);
  });
  afterAll(() => db.close());

  const url = (path: string, fn: string) =>
    `${path}?flight_number=${encodeURIComponent(fn)}&date=${DATE}`;

  test("/api/check-flight answers every spelling exactly like UA544", async () => {
    const host = "unitedstarlinktracker.com";
    const canonical = await bodyOf(app, url("/api/check-flight", "UA544"), host);
    expect(canonical.status).toBe(200);
    const shape = JSON.parse(canonical.text);
    expect(shape).toHaveProperty("hasStarlink");
    expect(Array.isArray(shape.flights)).toBe(true);
    for (const s of SPELLINGS) {
      const r = await bodyOf(app, url("/api/check-flight", s), host);
      expect(r.status, s).toBe(200);
      expect(JSON.parse(r.text), s).toEqual(shape);
    }
  });

  test("hub /api/check-any-flight resolves every UA spelling to United", async () => {
    const host = "airlinestarlinktracker.com";
    const canonical = await bodyOf(app, url("/api/check-any-flight", "UA544"), host);
    expect(canonical.status).toBe(200);
    const shape = JSON.parse(canonical.text);
    expect(shape.airline).toBe(AIRLINES.UA.name);
    // Bare digits carry no carrier on the hub and fail closed by design.
    for (const s of SPELLINGS.filter((x) => /[A-Za-z]/.test(x))) {
      const r = await bodyOf(app, url("/api/check-any-flight", s), host);
      expect(r.status, s).toBe(200);
      expect(JSON.parse(r.text), s).toEqual(shape);
    }
  });

  test("separators never smuggle extra digits past the 1-4 digit bound", async () => {
    const r = await bodyOf(
      app,
      url("/api/check-flight", "UA 544 2026"),
      "unitedstarlinktracker.com"
    );
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error).toBeDefined();
  });
});
