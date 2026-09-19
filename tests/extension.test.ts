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
import { dohDateISO } from "../src/api/qatar-status";
import { addDaysISO } from "../src/api/qatar-verdict";
import { upsertQatarEquipmentHistory, upsertQatarSchedule } from "../src/database/database";
import { createApp } from "../src/server/app";
import { airportLocalDate } from "../src/utils/airport-tz";
import { jsonOf, makeSyntheticDb, openSnapshot } from "./helpers";

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
    expect(ours.segments).toEqual([{ flightNumber: "UA123", date: "2026-06-01" }]);

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
// Qatar (v2.1): equipment-type answers from the hub
// ─────────────────────────────────────────────────────────────────────────────

describe("Qatar claims", () => {
  const tim = (itinerary: string) => `https://travelimpactmodel.org/lookup/flight?${itinerary}`;

  test("QR is detected, routed to the hub, and named-gated", () => {
    expect(extLib.detectCarrier("qr7")).toBe("QR");
    expect(extLib.endpointFor("QR7", "2026-06-01")).toStartWith(
      `https://${HUB_HOST}/api/check-any-flight?`
    );
    expect(extLib.carriersNamedIn("Qatar Airways · QR 7")).toEqual(["QR"]);
    expect(extLib.extractFlightNumbersFromText("Qatar Airways QR 701")).toEqual(["QR701"]);
  });

  test("QR+QR itineraries are two legs; QR+BA stays unbadged", () => {
    const qrqr = extLib.timCardSegments([
      tim("itinerary=JFK,DOH,QR,702,20260601,DOH,BKK,QR,830,20260602"),
    ]);
    expect(qrqr.segments.length).toBe(2);
    expect(qrqr.untrackedLegs).toBe(0);
    const qrba = extLib.timCardSegments([
      tim("itinerary=DOH,LHR,QR,7,20260601,LHR,EDI,BA,1440,20260601"),
    ]);
    expect(qrba.untrackedLegs).toBe(1);
  });

  test("schedule yes → installed, titled with the scheduled type", () => {
    const claim = extLib.normalizeClaim({
      hasStarlink: true,
      airline: "Qatar Airways",
      confidence: "type",
      basis: "schedule",
      reason: "x",
      flights: [{ tail_number: null, aircraft_type: "Boeing 777-300ER", starlink: "yes" }],
    });
    expect(claim.status).toBe("installed");
    expect(extLib.shouldBadge(claim)).toBe(true);
    expect(extLib.badgeTitle(claim)).toContain("Scheduled aircraft (Boeing 777-300ER)");
    expect(extLib.badgeTitle(claim)).not.toContain("verified");
  });

  test("schedule no and type-only null never badge", () => {
    const no = extLib.normalizeClaim({ hasStarlink: false, confidence: "type", basis: "schedule" });
    expect(extLib.shouldBadge(no)).toBe(false);
    const rolling = extLib.normalizeClaim({
      hasStarlink: null,
      confidence: "type",
      basis: "schedule",
    });
    expect(rolling.status).toBe("unknown");
    expect(extLib.shouldBadge(rolling)).toBe(false);
  });

  test("history probability → predicted; low grade or zero never badges", () => {
    const history = (probability: number, confidence: string) =>
      extLib.normalizeClaim({
        hasStarlink: null,
        airline: "Qatar Airways",
        probability,
        confidence,
        basis: "history",
        n_recent_observations: 12,
        flights: [],
      });
    const good = history(0.86, "medium");
    expect(good.status).toBe("predicted");
    expect(extLib.shouldBadge(good)).toBe(true);
    expect(extLib.badgeTitle(good)).toContain("12 recent and scheduled operating days");
    expect(extLib.badgeTitle(good)).toContain("At least ~86%");
    expect(extLib.shouldBadge(history(0.94, "low"))).toBe(false);
    expect(extLib.shouldBadge(history(0, "high"))).toBe(false);
  });

  test("a swap-risk probability names the scheduled type, not 'publishes later'", () => {
    const claim = extLib.normalizeClaim({
      hasStarlink: null,
      airline: "Qatar Airways",
      probability: 0.84,
      confidence: "high",
      basis: "schedule",
      n_recent_observations: 20,
      flights: [{ tail_number: null, aircraft_type: "Boeing 777-300ER", starlink: "yes" }],
    });
    expect(claim.status).toBe("predicted");
    const title = extLib.badgeTitle(claim);
    expect(title).toContain("Boeing 777-300ER");
    expect(title).not.toContain("publishes the actual aircraft");
  });

  test("an HA payload with top-level n_recent_observations keeps its pre-2.1 claim", () => {
    const claim = extLib.normalizeClaim({
      hasStarlink: null,
      airline: "Hawaiian Airlines",
      probability: 0.9,
      confidence: "medium",
      n_recent_observations: 7,
      reason: "x",
      flights: [],
    });
    expect(claim).toEqual({
      status: "predicted",
      probability: 0.9,
      predictionConfidence: "medium",
      nObservations: null,
      airline: "Hawaiian Airlines",
    });
    expect(extLib.badgeTitle(claim)).toBe(
      "~90% chance this flight gets a Starlink-equipped aircraft (Hawaiian Airlines). Airlines assign the actual aircraft ~2 days before departure."
    );
  });

  describe("round trip through the hub handler", () => {
    let app: ReturnType<typeof createApp>;
    const nowSec = Math.floor(Date.now() / 1000);
    const day = (offset: number) => addDaysISO(dohDateISO(nowSec), offset);

    beforeAll(() => {
      const db = makeSyntheticDb();
      const leg = (fn: string, date: string, eq: string) => {
        const dep = Date.parse(`${date}T06:40:00Z`) / 1000;
        upsertQatarSchedule(db, {
          flight_number: fn,
          scheduled_date: date,
          departure_airport: "DOH",
          arrival_airport: "LHR",
          departure_time: dep,
          arrival_time: dep + 7 * 3600,
          equipment_code: eq,
          wifi_verdict: null,
          flight_status: "SCHEDULED",
          last_updated: nowSec,
        });
      };
      leg("QR1", day(1), "77W");
      leg("QR3", day(1), "388");
      for (let i = -19; i <= 0; i++) {
        const date = day(i);
        const dep = Date.parse(`${date}T06:40:00Z`) / 1000;
        upsertQatarEquipmentHistory(
          db,
          {
            flight_number: "QR15",
            departure_airport: "DOH",
            service_date: date,
            arrival_airport: "LHR",
            departure_time: dep,
            arrival_time: null,
            equipment_code: "77W",
            flight_status: "ARRIVED",
            fetch_origin: "DOH",
            fetch_destination: "LHR",
            fetch_date: date,
          },
          nowSec
        );
      }
      app = createApp(db);
    });

    const claimFor = async (fn: string, date: string) =>
      extLib.normalizeClaim(
        await jsonOf(app, `/api/check-any-flight?flight_number=${fn}&date=${date}`, HUB_HOST)
      );

    test("in-window 777 → installed; A380 → no_starlink", async () => {
      expect((await claimFor("QR1", day(1))).status).toBe("installed");
      expect((await claimFor("QR3", day(1))).status).toBe("no_starlink");
    });

    test("+20 on 20 all-777 days → predicted and badged", async () => {
      const claim = await claimFor("QR15", day(20));
      expect(claim.status).toBe("predicted");
      expect(extLib.shouldBadge(claim)).toBe(true);
      expect(claim.nObservations).toBe(20);
    });
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
    for (const fn of ["DL123", "EK123"]) {
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

  test("2.1 names Qatar within the store's description limit, same matches", () => {
    expect(manifest.version).toBe("2.1.0");
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    expect(manifest.description).toContain("Qatar");
    expect(manifest.content_scripts[0].matches).toEqual([
      "https://www.google.com/flights/*",
      "https://www.google.com/travel/flights/*",
    ]);
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
});
