/**
 * Chrome extension v2 logic + cross-contract tests.
 *
 * The extension's pure logic (chrome-extension/lib.js) normalizes every API
 * payload into a claim-ladder answer before rendering. Unit tests pin that
 * mapping; the dispatch tests feed the normalizer REAL responses from the
 * frozen /api/check-flight contract and the hub's /api/check-any-flight, so
 * a wire-shape change that would break the shipped extension fails here.
 * Assertions are shape-based — they must survive snapshot data drift.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import extLib from "../chrome-extension/lib.js";
import { createApp } from "../src/server/app";
import { airportLocalDate } from "../src/utils/airport-tz";
import { jsonOf, openSnapshot } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";

const CLAIM_STATUSES = ["verified", "installed", "predicted", "no_starlink", "unknown"];

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint routing
// ─────────────────────────────────────────────────────────────────────────────

describe("extension endpoint routing", () => {
  test("UA stays on the frozen per-airline check-flight contract", () => {
    const url = extLib.endpointFor("UA123", "2026-06-01");
    expect(url).toStartWith(`https://${UA_HOST}/api/check-flight?`);
    expect(url).toContain("flight_number=UA123");
    expect(url).toContain("date=2026-06-01");
  });

  test("non-UA tracked carriers route to the hub's check-any-flight", () => {
    for (const fn of ["HA50", "AS2402"]) {
      const url = extLib.endpointFor(fn, "2026-06-01");
      expect(url).toStartWith(`https://${HUB_HOST}/api/check-any-flight?`);
      expect(url).toContain(`flight_number=${fn}`);
    }
  });

  test("untracked carriers and malformed input never produce a URL", () => {
    expect(extLib.endpointFor("DL123", "2026-06-01")).toBeNull();
    expect(extLib.endpointFor("UA12345", "2026-06-01")).toBeNull();
    expect(extLib.endpointFor("UA123", "06/01/2026")).toBeNull();
    expect(extLib.endpointFor("UA123", "2026-06-01x")).toBeNull();
    expect(extLib.endpointFor(null, "2026-06-01")).toBeNull();
  });

  test("lowercase input is normalized before hitting the wire", () => {
    expect(extLib.endpointFor("ua123", "2026-06-01")).toContain("flight_number=UA123");
    expect(extLib.detectCarrier("ha50")).toBe("HA");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flight extraction
// ─────────────────────────────────────────────────────────────────────────────

describe("Travel Impact Model URL parsing", () => {
  test("parses comma- and dash-separated itinerary segments", () => {
    for (const sep of [",", "-"]) {
      const url = `https://travelimpactmodel.org/lookup/flight?itinerary=${["SFO", "EWR", "UA", "1234", "20260601"].join(sep)}`;
      const segments = extLib.parseTimSegments(url);
      expect(segments).toHaveLength(1);
      expect(segments[0]).toEqual({
        origin: "SFO",
        destination: "EWR",
        carrier: "UA",
        flightNumber: "UA1234",
        date: "2026-06-01",
      });
    }
  });

  test("multi-leg itineraries yield one segment per leg, deduped", () => {
    const url =
      "https://x/flight?itinerary=SFO,DEN,UA,500,20260601,DEN,EWR,UA,1500,20260601,DEN,EWR,UA,1500,20260601";
    const segments = extLib.parseTimSegments(url);
    expect(segments).toHaveLength(2);
    expect(segments.map((s: { flightNumber: string }) => s.flightNumber)).toEqual([
      "UA500",
      "UA1500",
    ]);
  });

  test("carries untracked carriers through (caller filters)", () => {
    const segments = extLib.parseTimSegments("https://x/flight?itinerary=JFK,LAX,B6,623,20260601");
    expect(segments).toHaveLength(1);
    expect(segments[0].carrier).toBe("B6");
    expect(extLib.detectCarrier(segments[0].flightNumber)).toBeNull();
  });

  test("garbage in, empty array out — never throws", () => {
    for (const bad of [null, undefined, 42, "", "no segments here", "UA,123"]) {
      expect(extLib.parseTimSegments(bad)).toEqual([]);
    }
  });
});

describe("per-card itinerary aggregation", () => {
  const tim = (itinerary: string) => `https://travelimpactmodel.org/lookup/flight?${itinerary}`;

  test("decoded segments are authoritative, tracked or not", () => {
    const ours = extLib.timCardSegments([tim("itinerary=SFO,EWR,UA,123,20260601")]);
    expect(ours.parsed).toBe(true);
    expect(ours.segments).toEqual([
      { flightNumber: "UA123", date: "2026-06-01", origin: "SFO", destination: "EWR" },
    ]);

    // Decoded and foreign: parsed stays true so the caller skips the
    // heuristics rather than text-matching a competitor's card.
    const theirs = extLib.timCardSegments([tim("itinerary=JFK,LAX,B6,623,20260601")]);
    expect(theirs.parsed).toBe(true);
    expect(theirs.segments).toEqual([]);
  });

  test("an itinerary encoding that no longer decodes falls back, it does not settle", () => {
    // The attribute is present and the flight IS United; only the separator
    // changed. Reporting parsed:false is what keeps the heuristics available.
    const drifted = extLib.timCardSegments([tim("itinerary=SFO.EWR.UA.123.20260601")]);
    expect(drifted.parsed).toBe(false);
    expect(drifted.segments).toEqual([]);
    expect(extLib.timCardSegments([]).parsed).toBe(false);
    expect(extLib.timCardSegments(null).parsed).toBe(false);
  });

  test("legs repeated across elements are deduped", () => {
    const url = tim("itinerary=SFO,DEN,UA,500,20260601,DEN,EWR,UA,1500,20260601");
    const both = extLib.timCardSegments([url, url]);
    expect(both.segments.map((s: { flightNumber: string }) => s.flightNumber)).toEqual([
      "UA500",
      "UA1500",
    ]);
  });
});

describe("attribute and text extraction fallbacks", () => {
  const ALL = ["UA", "HA", "AS"];

  test("attribute forms: XX-NNNN-YYYYMMDD, XX-NNNN, /XX/NNNN/", () => {
    expect(extLib.parseAttrFlightNumber("foo UA-1234-20260601 bar", ALL)).toBe("UA1234");
    expect(extLib.parseAttrFlightNumber("HA-50", ALL)).toBe("HA50");
    expect(extLib.parseAttrFlightNumber("/booking/AS/118/details", ALL)).toBe("AS118");
    expect(extLib.parseAttrFlightNumber("DL-1234-20260601", ALL)).toBeNull();
    expect(extLib.parseAttrFlightNumber("", ALL)).toBeNull();
    expect(extLib.parseAttrFlightNumber(null, ALL)).toBeNull();
  });

  test("attribute extraction is gated on the carriers named in the card", () => {
    // Google's obfuscated attribute soup is full of two-letter fragments. Only
    // an airline the card actually names may be matched out of it.
    expect(extLib.parseAttrFlightNumber("data-jsdata=deferred;AS-12;x", ["UA"])).toBeNull();
    expect(extLib.parseAttrFlightNumber("/gws/HA/9/img", ["UA"])).toBeNull();
    expect(extLib.parseAttrFlightNumber("data-jsdata=deferred;AS-12;x", ["AS"])).toBe("AS12");
    // Fails closed: no gate supplied, no match, ever.
    expect(extLib.parseAttrFlightNumber("foo UA-1234-20260601 bar")).toBeNull();
    expect(extLib.parseAttrFlightNumber("foo UA-1234-20260601 bar", [])).toBeNull();
    expect(extLib.parseAttrFlightNumber("foo UA-1234-20260601 bar", ["DL"])).toBeNull();
  });

  test("carriersNamedIn is the shared airline-name gate", () => {
    expect(extLib.carriersNamedIn("United · UA 1234 · 5h 30m")).toEqual(["UA"]);
    expect(extLib.carriersNamedIn("Alaska/Hawaiian codeshare")).toEqual(["HA", "AS"]);
    expect(extLib.carriersNamedIn("Delta · DL 456")).toEqual([]);
    expect(extLib.carriersNamedIn(null)).toEqual([]);
  });

  test("text extraction requires the airline-name marker", () => {
    expect(extLib.extractFlightNumbersFromText("United · UA 1234 · 5h 30m")).toEqual(["UA1234"]);
    expect(extLib.extractFlightNumbersFromText("Alaska AS2402 nonstop")).toEqual(["AS2402"]);
    // "AS 123" without "Alaska" in the card is a common-word trap, not a flight.
    expect(extLib.extractFlightNumbersFromText("listed AS 123 options")).toEqual([]);
    expect(extLib.extractFlightNumbersFromText("Delta DL 456 nonstop")).toEqual([]);
    expect(extLib.extractFlightNumbersFromText("")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Claim normalization (unit)
// ─────────────────────────────────────────────────────────────────────────────

describe("claim normalization", () => {
  test("check-flight shapes map onto the ladder", () => {
    expect(
      extLib.normalizeClaim({ hasStarlink: true, confidence: "verified", flights: [] })
    ).toMatchObject({ status: "verified" });
    expect(
      extLib.normalizeClaim({ hasStarlink: true, confidence: "likely", flights: [] })
    ).toMatchObject({ status: "installed" });
    expect(
      extLib.normalizeClaim({ hasStarlink: false, confidence: "verified", flights: [] })
    ).toMatchObject({ status: "no_starlink" });

    const predicted = extLib.normalizeClaim({
      hasStarlink: null,
      confidence: "predicted",
      prediction: { probability: 0.92, confidence: "high", n_observations: 14 },
      flights: [],
    });
    expect(predicted).toEqual({
      status: "predicted",
      probability: 0.92,
      predictionConfidence: "high",
      nObservations: 14,
      airline: null,
    });
  });

  test("check-any-flight shapes map onto the ladder (top-level probability)", () => {
    const predicted = extLib.normalizeClaim({
      hasStarlink: null,
      airline: "Alaska Airlines",
      probability: 0.85,
      confidence: "medium",
      reason: "x",
      flights: [],
    });
    expect(predicted).toMatchObject({
      status: "predicted",
      probability: 0.85,
      predictionConfidence: "medium",
      airline: "Alaska Airlines",
    });

    // Type-level answers carry no probability — honest unknown, not a badge.
    const typeOnly = extLib.normalizeClaim({
      hasStarlink: null,
      airline: "Hawaiian Airlines",
      confidence: "type",
      reason: "determined by aircraft type",
      flights: [],
    });
    expect(typeOnly.status).toBe("unknown");
  });

  test("hostile or drifted payloads land on unknown, never a yes", () => {
    for (const payload of [
      null,
      undefined,
      [],
      "yes",
      { error: "Airline not tracked. Tracked: UA, HA, AS" },
      { hasStarlink: "true" },
      { hasStarlink: null, prediction: { probability: "0.9" } },
      { hasStarlink: null, probability: Number.NaN },
      {},
    ]) {
      expect(extLib.normalizeClaim(payload).status).toBe("unknown");
    }
    // Out-of-range probabilities clamp instead of rendering ~150%.
    expect(extLib.normalizeClaim({ hasStarlink: null, probability: 1.5 }).probability).toBe(1);
  });

  test("transport failures are retryable; parsed answers are settled", () => {
    expect(extLib.claimFromResponse({ success: false, error: "timeout" })).toEqual({
      claim: extLib.unknownClaim(),
      retryable: true,
    });
    expect(extLib.claimFromResponse(undefined).retryable).toBe(true);
    const settled = extLib.claimFromResponse({ success: true, data: { error: "not tracked" } });
    expect(settled.retryable).toBe(false);
    expect(settled.claim.status).toBe("unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Badging policy
// ─────────────────────────────────────────────────────────────────────────────

describe("badging policy", () => {
  const predicted = (probability: number, predictionConfidence = "high") => ({
    ...extLib.unknownClaim(),
    status: "predicted",
    probability,
    predictionConfidence,
  });

  test("verified and installed always badge; negatives and unknowns never do", () => {
    expect(extLib.shouldBadge({ ...extLib.unknownClaim(), status: "verified" })).toBe(true);
    expect(extLib.shouldBadge({ ...extLib.unknownClaim(), status: "installed" })).toBe(true);
    expect(extLib.shouldBadge({ ...extLib.unknownClaim(), status: "no_starlink" })).toBe(false);
    expect(extLib.shouldBadge(extLib.unknownClaim())).toBe(false);
    expect(extLib.shouldBadge(null)).toBe(false);
  });

  test("predictions badge only at ≥ threshold with non-low confidence", () => {
    expect(extLib.shouldBadge(predicted(0.92))).toBe(true);
    expect(extLib.shouldBadge(predicted(extLib.PREDICTION_BADGE_THRESHOLD))).toBe(true);
    expect(extLib.shouldBadge(predicted(0.79))).toBe(false);
    expect(extLib.shouldBadge(predicted(0.95, "low"))).toBe(false);
  });

  test("multi-leg combine: the weakest leg wins", () => {
    const verified = { ...extLib.unknownClaim(), status: "verified" };
    const installed = { ...extLib.unknownClaim(), status: "installed" };
    expect(extLib.combineClaims([verified, installed]).status).toBe("installed");
    expect(extLib.combineClaims([verified, extLib.unknownClaim()]).status).toBe("unknown");
    expect(
      extLib.combineClaims([verified, { ...extLib.unknownClaim(), status: "no_starlink" }]).status
    ).toBe("no_starlink");
    const combined = extLib.combineClaims([predicted(0.95), predicted(0.82)]);
    expect(combined.status).toBe("predicted");
    expect(combined.probability).toBe(0.82);
    expect(extLib.combineClaims([]).status).toBe("unknown");
  });

  test("multi-leg combine: probability and confidence grade are both worst-case", () => {
    // The least-likely leg is not necessarily the least-trusted one. Inheriting
    // the min-probability leg's grade laundered a low-confidence leg — which
    // shouldBadge suppresses on its own — into a badge via its sibling.
    const mixed = extLib.combineClaims([predicted(0.95, "low"), predicted(0.88, "high")]);
    expect(mixed.probability).toBe(0.88);
    expect(mixed.predictionConfidence).toBe("low");
    expect(extLib.shouldBadge(mixed)).toBe(false);
    expect(extLib.shouldBadge(predicted(0.95, "low"))).toBe(false);

    expect(extLib.combineClaims([predicted(0.9, "high"), predicted(0.95, "medium")])).toMatchObject(
      {
        probability: 0.9,
        predictionConfidence: "medium",
      }
    );
    // An ungraded prediction (registry/subfleet answer) neither weakens a
    // graded sibling nor invents a grade of its own.
    expect(
      extLib.combineClaims([predicted(0.99, null), predicted(0.9, "high")]).predictionConfidence
    ).toBe("high");
    expect(
      extLib.combineClaims([predicted(0.99, null), predicted(0.9, null)]).predictionConfidence
    ).toBeNull();
  });

  test("badge copy states the rung, never a bare boolean", () => {
    expect(extLib.badgeLabel({ ...extLib.unknownClaim(), status: "verified" })).toBe("Starlink");
    expect(extLib.badgeLabel({ ...extLib.unknownClaim(), status: "installed" })).toBe(
      "Starlink (installed)"
    );
    expect(extLib.badgeLabel(predicted(0.876))).toBe("Starlink ~88%");
    expect(extLib.badgeTitle({ ...extLib.unknownClaim(), status: "installed" })).toContain(
      "not yet verified"
    );
    const title = extLib.badgeTitle({ ...predicted(0.876), nObservations: 3 });
    expect(title).toContain("~88%");
    expect(title).toContain("3 observed departures");
    expect(extLib.badgeClass(predicted(0.9))).toContain("starlink-wifi-badge--predicted");
  });

  test("localTodayIso yields a YYYY-MM-DD in local time", () => {
    expect(extLib.localTodayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(extLib.localTodayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-contract: normalizer × real API responses
// ─────────────────────────────────────────────────────────────────────────────

describe("extension normalizer against live handler responses", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = openSnapshot();
    app = createApp(db);
  });

  // Past date sits outside FR24's lookup window, so no network is attempted.
  test("UA frozen endpoint: prediction branch normalizes to a predicted claim", async () => {
    const body = await jsonOf(
      app,
      "/api/check-flight?flight_number=UA1234&date=2024-01-15",
      UA_HOST
    );
    const claim = extLib.normalizeClaim(body);
    expect(claim.status).toBe("predicted");
    expect(claim.probability).toBeGreaterThanOrEqual(0);
    expect(claim.probability).toBeLessThanOrEqual(1);
    expect(["high", "medium", "low"]).toContain(claim.predictionConfidence);
    expect(typeof claim.nObservations).toBe("number");
  });

  test.each([
    ["HA9999", "HNL", 1774200000],
    ["AS118", "SEA", 1774200000],
  ])(
    "hub check-any-flight: %s canary normalizes to a firm-yes rung",
    async (flightNumber, airport, departureTime) => {
      const date =
        airportLocalDate(airport, departureTime) ??
        new Date(departureTime * 1000).toISOString().slice(0, 10);
      const body = await jsonOf(
        app,
        `/api/check-any-flight?flight_number=${flightNumber}&date=${date}`,
        HUB_HOST
      );
      const claim = extLib.normalizeClaim(body);
      expect(["verified", "installed"]).toContain(claim.status);
      expect(typeof claim.airline).toBe("string");
      expect(extLib.shouldBadge(claim)).toBe(true);
    }
  );

  // Carriers with no flight-history model answer from the registry instead. A
  // single-subfleet answer carries a probability the ladder can read; a
  // per-type split carries none, and must stay off the badge rather than blend
  // "always yes" types with "never" ones.
  test("hub registry answers: a probability badges, its absence abstains", async () => {
    for (const fn of ["AS850", "AS2402", "HA50"]) {
      const body = await jsonOf(
        app,
        `/api/check-any-flight?flight_number=${fn}&date=2024-06-01`,
        HUB_HOST
      );
      const claim = extLib.normalizeClaim(body);
      if (body.probability === undefined) {
        expect(claim.status, fn).toBe("unknown");
        expect(extLib.shouldBadge(claim), fn).toBe(false);
        continue;
      }
      expect(claim.status, fn).toBe("predicted");
      expect(claim.probability, fn).toBeGreaterThanOrEqual(0);
      expect(claim.probability, fn).toBeLessThanOrEqual(1);
      // "type" is not a history grade and must never be dressed up as one.
      expect(claim.predictionConfidence, fn).toBeNull();
    }
  });

  test("hub check-any-flight: untracked carrier settles as unknown (no badge)", async () => {
    for (const fn of ["DL123", "QR9999"]) {
      const body = await jsonOf(
        app,
        `/api/check-any-flight?flight_number=${fn}&date=2026-06-01`,
        HUB_HOST
      );
      const claim = extLib.normalizeClaim(body);
      expect(claim.status).toBe("unknown");
      expect(extLib.shouldBadge(claim)).toBe(false);
    }
  });

  test("every normalized status stays inside the ladder vocabulary", async () => {
    const bodies = await Promise.all([
      jsonOf(app, "/api/check-flight?flight_number=UA1&date=2024-06-01", UA_HOST),
      jsonOf(app, "/api/check-any-flight?flight_number=HA50&date=2024-06-01", HUB_HOST),
      jsonOf(app, "/api/check-any-flight?flight_number=AS2402&date=2024-06-01", HUB_HOST),
    ]);
    for (const body of bodies) {
      expect(CLAIM_STATUSES).toContain(extLib.normalizeClaim(body).status);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v2.0.1: mixed carriers, pass scheduling, client tag, release guardrails
// ─────────────────────────────────────────────────────────────────────────────

describe("mixed-carrier itineraries fail closed", () => {
  const tim = (itinerary: string) => `https://travelimpactmodel.org/lookup/flight?${itinerary}`;

  test("an untracked leg is counted, so the card can refuse to badge", () => {
    const card = extLib.timCardSegments([
      tim("itinerary=SFO-SEA-AS-3490-20260920,SEA-ORD-AS-1478-20260920,ORD-MSN-AA-4217-20260920"),
    ]);
    expect(card.parsed).toBe(true);
    expect(card.segments).toHaveLength(2);
    expect(card.untrackedLegs).toBe(1);
  });

  test("an all-tracked itinerary reports zero untracked legs", () => {
    const card = extLib.timCardSegments([
      tim("itinerary=SFO,DEN,UA,500,20260601,DEN,EWR,UA,1500,20260601"),
    ]);
    expect(card.untrackedLegs).toBe(0);
    expect(card.segments).toHaveLength(2);
  });

  test("a foreign leg repeated across TIM URLs is counted once", () => {
    const url = tim("itinerary=SFO,ORD,UA,1,20260601,ORD,FRA,LH,431,20260601");
    const card = extLib.timCardSegments([url, url, tim("itinerary=ORD,FRA,LH,431,20260601")]);
    expect(card.untrackedLegs).toBe(1);
  });

  test("the claim a dropped leg stands in for never badges", () => {
    const verified = { ...extLib.unknownClaim(), status: "verified" };
    expect(
      extLib.shouldBadge(extLib.combineClaims([verified, verified, extLib.unknownClaim()]))
    ).toBe(false);
  });
});

describe("claim lookup and pass scheduling", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  type Runner = {
    trigger: () => Promise<void>;
    isRunning: () => boolean;
    requestRerun: () => void;
  };

  function manualRunner(pass: () => Promise<unknown>) {
    const queued: Array<() => Promise<void>> = [];
    const runner: Runner = extLib.createPassRunner(pass, {
      schedule: (fn: () => Promise<void>) => queued.push(fn),
    });
    const drain = async () => {
      while (queued.length) await (queued.shift() as () => Promise<void>)();
    };
    return { runner, drain };
  }

  test("two cards with the same flight in one pooled pass send one message", async () => {
    const sent: unknown[] = [];
    const lookup = extLib.createClaimLookup(async (message: unknown) => {
      sent.push(message);
      await tick();
      return { success: true, data: { hasStarlink: true, confidence: "verified", flights: [] } };
    });
    const results: string[] = [];
    await extLib.runPool(["card-a", "card-b"], 3, async () => {
      const outcome = await lookup.get("UA123", "2026-06-01");
      results.push(outcome.claim.status);
    });
    expect(sent).toHaveLength(1);
    expect(results).toHaveLength(2);
    expect(new Set(results).size).toBe(1);
    expect(lookup.isKnown(extLib.claimKey("UA123", "2026-06-01"))).toBe(true);
  });

  test("a send that throws synchronously is retryable and does not wedge the key", async () => {
    let calls = 0;
    let now = 0;
    const lookup = extLib.createClaimLookup(
      () => {
        calls++;
        throw new Error("Extension context invalidated");
      },
      () => now
    );
    const first = await lookup.get("UA1", "2026-06-01");
    expect(first.retryable).toBe(true);
    now += extLib.CACHE_TTL.error + 1;
    expect(lookup.isKnown(extLib.claimKey("UA1", "2026-06-01"))).toBe(false);
    await lookup.get("UA1", "2026-06-01");
    expect(calls).toBe(2);
  });

  test("the pool starts items in order and caps concurrency", async () => {
    const started: number[] = [];
    let inFlight = 0;
    let peak = 0;
    await extLib.runPool([0, 1, 2, 3, 4, 5, 6], 3, async (i: number) => {
      started.push(i);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("a trigger that lands mid-pass runs a second pass instead of being dropped", async () => {
    let passes = 0;
    let release: () => void = () => {};
    const { runner, drain } = manualRunner(async () => {
      passes++;
      if (passes === 1) {
        await new Promise<void>((r) => {
          release = r;
        });
      }
      return { newCards: 1 };
    });
    const first = runner.trigger();
    expect(runner.isRunning()).toBe(true);
    await runner.trigger();
    release();
    await first;
    await drain();
    expect(passes).toBe(2);
  });

  test("a trigger with no overlap runs exactly once", async () => {
    let passes = 0;
    const { runner, drain } = manualRunner(async () => {
      passes++;
      return { newCards: 1 };
    });
    await runner.trigger();
    await drain();
    expect(passes).toBe(1);
  });

  test("reruns are capped while every pass keeps finding cards", async () => {
    let passes = 0;
    let runner: Runner | null = null;
    const made = manualRunner(async () => {
      passes++;
      runner?.requestRerun();
      return { newCards: 1 };
    });
    runner = made.runner;
    await runner.trigger();
    await made.drain();
    expect(passes).toBe(6);
  });
});

describe("extension client tag", () => {
  test("endpointFor appends client=ext-<version> without disturbing the lookup params", () => {
    for (const fn of ["UA123", "HA50", "AS2402"]) {
      const url = new URL(extLib.endpointFor(fn, "2026-06-01", "2.0.1"));
      expect(url.searchParams.get("client")).toBe("ext-2.0.1");
      expect(url.searchParams.get("flight_number")).toBe(fn);
      expect(url.searchParams.get("date")).toBe("2026-06-01");
    }
    expect(extLib.endpointFor("UA123", "2026-06-01")).not.toContain("client=");
  });
});

describe("extension release guardrails", () => {
  const manifest = require("../chrome-extension/manifest.json");

  // Any new permission disables the extension for every installed user until
  // they re-approve it.
  test("the manifest asks for no permission beyond the v1 host", () => {
    expect(manifest.host_permissions).toEqual(["https://unitedstarlinktracker.com/*"]);
    expect(manifest.permissions).toBeUndefined();
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.version).toMatch(/^\d{1,2}\.\d{1,3}\.\d{1,3}$/);
  });

  test("the package ships the runtime files and no docs", async () => {
    const { runtimeFiles } = await import("../scripts/package-extension");
    const files = runtimeFiles(manifest);
    for (const f of ["manifest.json", "background.js", "content.js", "lib.js", "styles.css"]) {
      expect(files).toContain(f);
    }
    expect(files.some((f: string) => f.endsWith(".md"))).toBe(false);
  });

  test("the store-version check reads the listing's version cell", async () => {
    const { parseListingVersion } = await import("../scripts/check-cws-version");
    expect(parseListingVersion('<div>Version</div><div class="nBZElf">1.2.0</div>')).toBe("1.2.0");
    expect(parseListingVersion("<html>no version here</html>")).toBeNull();
  });

  test("2.1.0 is the leg-scoped build", () => {
    expect(manifest.version).toBe("2.1.0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v2.1: every TIM leg is its own lookup
// ─────────────────────────────────────────────────────────────────────────────

describe("leg-scoped lookups", () => {
  const tim = (itinerary: string) => `https://travelimpactmodel.org/lookup/flight?${itinerary}`;
  const legsOf = (segments: { origin?: string; destination?: string }[]) =>
    segments.map((s) => `${s.origin}-${s.destination}`);

  test("a through flight keeps both legs of one number", () => {
    const segments = extLib.parseTimSegments(
      tim("itinerary=ORD-DEN-UA-1217-20261006,DEN-DRO-UA-1217-20261006")
    );
    expect(segments).toHaveLength(2);
    expect(segments.map((s: { origin: string }) => s.origin)).toEqual(["ORD", "DEN"]);
  });

  test("card segments carry airports, keep same-number legs, collapse repeats", () => {
    const url = tim("itinerary=ORD,DEN,UA,1217,20261006,DEN,DRO,UA,1217,20261006");
    const card = extLib.timCardSegments([url, url, url]);
    expect(legsOf(card.segments)).toEqual(["ORD-DEN", "DEN-DRO"]);
    expect(card.segments[1]).toEqual({
      flightNumber: "UA1217",
      date: "2026-10-06",
      origin: "DEN",
      destination: "DRO",
    });
    const foreign = extLib.timCardSegments([
      tim("itinerary=SFO,ORD,UA,1,20260601,ORD,FRA,LH,431,20260601"),
      tim("itinerary=ORD,FRA,LH,431,20260601"),
    ]);
    expect(foreign.untrackedLegs).toBe(1);
  });

  test("legOf sends only IATA-shaped, distinct airports", () => {
    expect(extLib.legOf({ origin: "DEN", destination: "DRO" })).toEqual({
      origin: "DEN",
      destination: "DRO",
    });
    expect(extLib.legOf({ origin: "DEN", destination: "de" })).toEqual({ origin: "DEN" });
    expect(extLib.legOf({ origin: "XXX", destination: "XXX" })).toBeUndefined();
    expect(extLib.legOf({ origin: "De", destination: "DRO" })).toBeUndefined();
    expect(extLib.legOf({ flightNumber: "UA1", date: null })).toBeUndefined();
    expect(extLib.legOf(undefined)).toBeUndefined();
  });

  test("claimKey: unscoped keeps its old key, legs get distinct keys", () => {
    expect(extLib.claimKey("UA1217", "2026-10-06")).toBe("UA1217-2026-10-06");
    const a = extLib.claimKey("UA1217", "2026-10-06", { origin: "ORD", destination: "DEN" });
    const b = extLib.claimKey("UA1217", "2026-10-06", { origin: "DEN", destination: "DRO" });
    expect(a).not.toBe(b);
    expect(extLib.claimKey("UA1217", "2026-10-06", { origin: "DEN" })).not.toBe(b);
  });

  test("endpointFor: no leg is the pre-2.1 URL; a leg rides before client", () => {
    expect(extLib.endpointFor("UA123", "2026-06-01", "2.1.0")).toBe(
      "https://unitedstarlinktracker.com/api/check-flight?flight_number=UA123&date=2026-06-01&client=ext-2.1.0"
    );
    expect(extLib.endpointFor("UA123", "2026-06-01")).toBe(
      "https://unitedstarlinktracker.com/api/check-flight?flight_number=UA123&date=2026-06-01"
    );
    const scoped = extLib.endpointFor("UA1217", "2026-10-06", "2.1.0", {
      origin: "DEN",
      destination: "DRO",
    });
    const url = new URL(scoped);
    expect(url.searchParams.get("origin")).toBe("DEN");
    expect(url.searchParams.get("destination")).toBe("DRO");
    expect([...url.searchParams.keys()].at(-1)).toBe("client");
    for (const bad of [{ origin: "den" }, { origin: "D3N", destination: "DRO" }, {}, null]) {
      expect(extLib.endpointFor("UA1217", "2026-10-06", "2.1.0", bad)).not.toContain("origin=");
    }
    const hub = new URL(extLib.endpointFor("AS2402", "2026-10-06", "2.1.0", { origin: "SEA" }));
    expect(hub.hostname).toBe(HUB_HOST);
    expect(hub.searchParams.get("origin")).toBe("SEA");
    expect(hub.searchParams.has("destination")).toBe(false);
  });

  test("createClaimLookup: one send per leg, one for a repeated leg", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const lookup = extLib.createClaimLookup(async (message: Record<string, unknown>) => {
      sent.push(message);
      return { success: true, data: { hasStarlink: true, confidence: "verified", flights: [] } };
    });
    const ordDen = { origin: "ORD", destination: "DEN" };
    const denDro = { origin: "DEN", destination: "DRO" };
    await Promise.all([
      lookup.get("UA1217", "2026-10-06", ordDen),
      lookup.get("UA1217", "2026-10-06", denDro),
      lookup.get("UA1217", "2026-10-06", denDro),
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ flightNumber: "UA1217", origin: "DEN", destination: "DRO" });
    await lookup.get("UA9", "2026-10-06");
    expect(sent[2]).toEqual({ action: "checkFlight", flightNumber: "UA9", date: "2026-10-06" });
  });

  test("normalizeClaim grades identically with a leg echo and carries it", () => {
    const predicted = {
      hasStarlink: null,
      confidence: "predicted",
      prediction: { probability: 0.9, confidence: "high", n_observations: 40 },
      flights: [],
    };
    const leg = { origin: "DEN", destination: "DRO", match: "unmatched", otherLegs: [] };
    const plain = extLib.normalizeClaim(predicted);
    const scoped = extLib.normalizeClaim({ ...predicted, leg });
    const { leg: echoed, ...rest } = scoped;
    expect(rest).toEqual(plain);
    expect(extLib.shouldBadge(plain)).toBe(true);
    expect(extLib.shouldBadge(scoped)).toBe(true);
    expect(echoed).toEqual({ origin: "DEN", destination: "DRO" });
    const unscoped = extLib.normalizeClaim({
      ...predicted,
      leg: { ...leg, match: "unscoped", reason: "invalid_airport" },
    });
    expect("leg" in unscoped).toBe(false);
  });

  test("the tooltip names the leg that set a multi-leg badge", () => {
    const strong = {
      ...extLib.normalizeClaim({ hasStarlink: true, confidence: "verified", flights: [] }),
      flightNumber: "UA318",
      leg: { origin: "ORD", destination: "DEN" },
    };
    const weak = {
      ...extLib.normalizeClaim({ hasStarlink: true, confidence: "likely", flights: [] }),
      flightNumber: "UA1217",
      leg: { origin: "DEN", destination: "DRO" },
    };
    const combined = extLib.combineClaims([strong, weak]);
    expect(extLib.cardBadgeTitle(combined, [strong, weak])).toStartWith("UA1217 DEN→DRO: ");
    expect(extLib.cardBadgeTitle(strong, [strong])).toBe(extLib.badgeTitle(strong));
    // Legs that agree name none: no single leg set the badge.
    const twin = { ...strong, flightNumber: "UA1217", leg: { origin: "DEN", destination: "DRO" } };
    const agreed = extLib.combineClaims([strong, twin]);
    expect(extLib.cardBadgeTitle(agreed, [strong, twin])).toBe(extLib.badgeTitle(agreed));
  });

  test("a scoped UA response normalizes inside the ladder", async () => {
    const app = createApp(openSnapshot());
    const body = await jsonOf(
      app,
      "/api/check-flight?flight_number=UA1234&date=2024-01-15&origin=SFO&destination=EWR",
      UA_HOST
    );
    expect(body.leg.origin).toBe("SFO");
    expect(CLAIM_STATUSES).toContain(extLib.normalizeClaim(body).status);
  });
});
