/**
 * The shared plumbing Air France touches: flight-number helpers, the
 * untracked-demand tag, and the UA host contract. Hermetic.
 */

import { describe, expect, test } from "bun:test";
import {
  buildAirlineFlightNumberVariants,
  detectMarketingCarrier,
} from "../src/airlines/flight-number";
import { AIRLINES, airlineSlug, isOutsideProgramme } from "../src/airlines/registry";
import { normalizeCarrierPrefix } from "../src/observability";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

describe("AF flight numbers and slug", () => {
  test("slug is hyphenated; existing slugs unchanged", () => {
    expect(airlineSlug(AIRLINES.AF)).toBe("air-france");
    expect(["UA", "HA", "AS", "QR"].map((c) => airlineSlug(AIRLINES[c]))).toEqual([
      "united",
      "hawaiian",
      "alaska",
      "qatar",
    ]);
  });

  test.each([
    ["AF10", "AF"],
    ["AFR10", "AF"],
    ["HOP123", null],
  ])("detectMarketingCarrier(%s) → %p", (fn, code) => {
    expect(detectMarketingCarrier(fn)?.code ?? null).toBe(code);
  });

  test("variants carry no duplicates", () => {
    for (const cfg of Object.values(AIRLINES)) {
      const v = buildAirlineFlightNumberVariants(cfg, `${cfg.iata}100`);
      expect(v.length).toBe(new Set(v).size);
    }
  });

  test("programme exclusions and freighters are outside every denominator", () => {
    expect(isOutsideProgramme("AF", "A330")).toBe(true);
    expect(isOutsideProgramme("AF", "B777F")).toBe(true);
    expect(isOutsideProgramme("AF", "A350")).toBe(false);
    expect(isOutsideProgramme("QR", "A330")).toBe(false);
    expect(AIRLINES.AF.rollout.rosterIsProgramScope).toBe(true);
  });
});

describe("untracked demand tag", () => {
  test.each([
    ["DL100", "DL"],
    ["dl 100", "DL"],
    ["ZZ100", "other"],
    ["", "other"],
    ["QR1", "QR"],
  ])("%s → %s", (fn, prefix) => {
    expect(normalizeCarrierPrefix(fn)).toBe(prefix);
  });
});

describe("UA host contract", () => {
  test("an AF number on the United host stays a 404 not_tracked", async () => {
    const app = createApp(openSnapshot());
    const r = await app.dispatch(
      req("/api/check-flight?flight_number=AF10&date=2026-09-20", "unitedstarlinktracker.com")
    );
    expect(r.status).toBe(404);
    expect(typeof (await r.json()).error).toBe("string");
  });
});
