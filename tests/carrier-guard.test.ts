/**
 * Carrier and flight-number gating on the public prediction surfaces.
 *
 * Three defects this pins:
 *  - decideCarrier only refused *registered* carriers, so DL100/AA100/B6100 were
 *    answered from the pinned airline's model. B6100 came back 70% Starlink
 *    because inferSubfleet read "6100" as a United Express number.
 *  - ensureAirlinePrefix did not strip zero-padding, so UA0100 (the spelling on
 *    boarding passes and GDS itineraries) matched no log row and fell through to
 *    the fleet prior while UA100 answered from 7 observations.
 *  - /api/predict-flight had no shape gate, so UA4680A and UA00004680 returned a
 *    fleet prior for strings that are not flight numbers.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { ensureAirlinePrefix, prefixBelongsTo } from "../src/airlines/flight-number";
import { AIRLINES } from "../src/airlines/registry";
import { decideCarrier, isPlausibleFlightNumber } from "../src/api/check-flight-core";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

const UA = AIRLINES.UA;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

const predict = async (fn: string) => {
  const res = await app.dispatch(
    req(`/api/predict-flight?flight_number=${encodeURIComponent(fn)}`, "unitedstarlinktracker.com")
  );
  return { status: res.status, body: await res.json() };
};

describe("prefixBelongsTo", () => {
  test("accepts the carrier's own marketing, ICAO and operating prefixes", () => {
    for (const fn of ["UA100", "UAL100", "SKW4680", "OO4680"]) {
      expect(prefixBelongsTo(UA, fn), fn).toBe(true);
    }
  });

  test("accepts bare digits — they carry no carrier claim", () => {
    expect(prefixBelongsTo(UA, "100")).toBe(true);
  });

  test("rejects other carriers, tracked or not", () => {
    for (const fn of ["DL100", "AA100", "B6100", "AS100", "WN2100"]) {
      expect(prefixBelongsTo(UA, fn), fn).toBe(false);
    }
  });
});

describe("decideCarrier refuses foreign flight numbers on a pinned host", () => {
  test("untracked carriers are not answered from the pinned airline's model", () => {
    for (const fn of ["DL100", "AA100", "B6100"]) {
      expect(decideCarrier(UA, fn).outcome, fn).toBe("not_tracked");
    }
  });

  test("the pinned carrier's own numbers still resolve", () => {
    for (const fn of ["UA100", "SKW4680", "100"]) {
      const d = decideCarrier(UA, fn);
      expect(d.outcome, fn).toBe("resolved");
    }
  });
});

describe("zero-padding canonicalizes to one spelling", () => {
  test("ensureAirlinePrefix strips padding on prefixed and bare forms", () => {
    expect(ensureAirlinePrefix(UA, "UA0100")).toBe("UA100");
    expect(ensureAirlinePrefix(UA, "UA00004680")).toBe("UA4680");
    expect(ensureAirlinePrefix(UA, "0100")).toBe("UA100");
    expect(ensureAirlinePrefix(UA, "UA100")).toBe("UA100");
  });

  test("a padded number gets the same answer as its canonical spelling", async () => {
    const padded = await predict("UA0100");
    const plain = await predict("UA100");
    expect(padded.status).toBe(200);
    expect(plain.status).toBe(200);
    // Same flight → same everything. Before the fix these diverged: the padded
    // form matched nothing and returned the fleet prior.
    expect(padded.body).toEqual(plain.body);
  });
});

describe("isPlausibleFlightNumber", () => {
  test("accepts 1-4 digits with the carrier's own prefix", () => {
    for (const fn of ["UA1", "UA100", "UA4680"]) {
      expect(isPlausibleFlightNumber(UA, fn), fn).toBe(true);
    }
  });

  test("rejects trailing letters, over-long numbers and foreign prefixes", () => {
    for (const fn of ["UA4680A", "UA00004680", "UA", "B6100", "UA12345"]) {
      expect(isPlausibleFlightNumber(UA, fn), fn).toBe(false);
    }
  });
});

describe("/api/predict-flight gating", () => {
  test("foreign carriers are refused, not priced with United's priors", async () => {
    for (const fn of ["DL100", "AA100", "B6100"]) {
      const { body } = await predict(fn);
      expect(body, fn).toHaveProperty("error");
      expect(JSON.stringify(body), fn).not.toContain("fleet_prior");
    }
  });

  test("non-flight-number shapes 400 instead of returning a prior", async () => {
    for (const fn of ["UA4680A", "UA"]) {
      const { status, body } = await predict(fn);
      expect(status, fn).toBe(400);
      expect(body, fn).toHaveProperty("error");
    }
  });

  test("a real flight number still answers", async () => {
    const { status, body } = await predict("UA100");
    expect(status).toBe(200);
    expect(body).toHaveProperty("probability");
    expect(body).toHaveProperty("method");
  });
});
