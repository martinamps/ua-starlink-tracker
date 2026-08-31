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
import {
  CANONICAL_FLIGHT_PERMALINK,
  canonicalPermalinkFor,
  ensureAirlinePrefix,
  prefixBelongsTo,
} from "../src/airlines/flight-number";
import { AIRLINES, enabledAirlines } from "../src/airlines/registry";
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

/**
 * The permalink predicate is spelled once.
 *
 * CANONICAL_FLIGHT_PERMALINK (what the router accepts) and canonicalPermalinkFor
 * (what each producer advertises) must describe the same language with the
 * carrier code substituted. They used to be independent literals that agreed
 * only because every IATA code we happen to carry is two LETTERS — a carrier
 * with an alphanumeric designator (B6, 9E, G7) would have made the producer
 * accept what the router rejects, which is precisely how /check-flight/UA63986
 * came to be advertised and 404'd.
 */
describe("permalink predicate agreement", () => {
  const digits = ["1", "42", "638", "4680"];

  test.each(enabledAirlines().map((cfg) => [cfg.code, cfg] as const))(
    "%s: every permalink the producer accepts, the router accepts",
    (_code, cfg) => {
      const producer = canonicalPermalinkFor(cfg);
      for (const d of digits) {
        const fn = `${cfg.iata}${d}`;
        expect(producer.test(fn), `${fn} rejected by its own producer`).toBe(true);
        expect(
          CANONICAL_FLIGHT_PERMALINK.test(fn),
          `${cfg.code} advertises ${fn} but the router rejects it`
        ).toBe(true);
      }
      // Both ends must agree on the router's 4-digit cap, not just on shape.
      expect(producer.test(`${cfg.iata}63986`)).toBe(false);
      expect(CANONICAL_FLIGHT_PERMALINK.test(`${cfg.iata}63986`)).toBe(false);
    }
  );

  // Hypothetical alphanumeric designators: the generic shape must already
  // admit them, or adding such a carrier silently reintroduces the drift.
  test.each(["B6100", "9E42", "G74460"])("%s is a router-acceptable permalink", (fn) => {
    expect(CANONICAL_FLIGHT_PERMALINK.test(fn)).toBe(true);
  });

  test("a bare number is not a permalink", () => {
    for (const fn of ["12345", "1234", "UA", ""]) {
      expect(CANONICAL_FLIGHT_PERMALINK.test(fn), fn).toBe(false);
    }
  });
});
