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

describe("attribute and text extraction fallbacks", () => {
  test("attribute forms: XX-NNNN-YYYYMMDD, XX-NNNN, /XX/NNNN/", () => {
    expect(extLib.parseAttrFlightNumber("foo UA-1234-20260601 bar")).toBe("UA1234");
    expect(extLib.parseAttrFlightNumber("HA-50")).toBe("HA50");
    expect(extLib.parseAttrFlightNumber("/booking/AS/118/details")).toBe("AS118");
    expect(extLib.parseAttrFlightNumber("DL-1234-20260601")).toBeNull();
    expect(extLib.parseAttrFlightNumber("")).toBeNull();
    expect(extLib.parseAttrFlightNumber(null)).toBeNull();
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
    expect(title).toContain("3 recent departures");
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
