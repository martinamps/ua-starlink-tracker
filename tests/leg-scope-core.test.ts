/**
 * Leg-scoped verdicts. A multi-leg flight number flies different tails on
 * different legs; without a leg, one leg's Starlink tail answered "yes" for a
 * traveller on the other. Synthetic in-memory DB so each leg's tail and time
 * is exact. Every negative tail needs BOTH a starlink_planes row (the INNER
 * JOIN) and a united_fleet 'negative' row (the settle).
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES } from "../src/airlines/registry";
import {
  FR24_OUTAGE_NOTE,
  FR24_SHED_NOTE,
  type FlightVerdict,
  type LegQuery,
  type ResolveDeps,
  answersOtherLeg,
  fr24DegradedNote,
  legField,
  legNote,
  legOffRoute,
  legScopeTelemetry,
  legSubject,
  normalizeAirportCode,
  parseLegQuery,
  resolveFlightVerdict,
  scheduledFlights,
  selectLeg,
  verdictTelemetry,
} from "../src/api/check-flight-core";
import type { FallbackSegment, lookupFlightTailVerdict } from "../src/api/flight-verdict";
import { Fr24UnavailableError } from "../src/api/flightradar24-api";
import { createReaderFactory } from "../src/database/reader";
import type { predictFlight } from "../src/scripts/starlink-predictor";
import { AIRPORT_COORDS } from "../src/utils/airport-geo";
import { AIRPORT_TZ } from "../src/utils/airport-tz";
import {
  addFleet,
  addFlight,
  addPlane,
  addQatarRow,
  makeSyntheticDb,
  stubPredict,
  utc,
} from "./helpers";

const DAY = "2027-06-09";

function negativeTail(db: Database, tail: string): void {
  addPlane(db, tail, "Viasat");
  addFleet(db, tail, "negative", { verifiedWifi: "Viasat" });
}

const seg = (
  origin: string,
  destination: string,
  hasStarlink: boolean | null
): FallbackSegment => ({
  tail_number: hasStarlink ? "N7777" : "N8888",
  aircraft_model: "Boeing 737-900",
  origin,
  destination,
  departure_time: utc("2027-06-09T14:00:00Z"),
  arrival_time: utc("2027-06-09T16:00:00Z"),
  hasStarlink,
  confidence: hasStarlink ? "verified" : hasStarlink === false ? "negative" : "unknown",
  verified_wifi: hasStarlink ? "Starlink" : "Viasat",
});
const lookupReturning = (segments: FallbackSegment[] | null) =>
  (async () => segments) as unknown as typeof lookupFlightTailVerdict;
function countingLookup(segments: FallbackSegment[]) {
  const counter = { calls: 0 };
  const lookup = (async () => {
    counter.calls++;
    return segments;
  }) as unknown as typeof lookupFlightTailVerdict;
  return { counter, lookup };
}

describe("leg-scoped verdicts (synthetic DB)", () => {
  let db: Database;
  let reader: ReturnType<ReturnType<typeof createReaderFactory>>;
  let qrReader: ReturnType<ReturnType<typeof createReaderFactory>>;

  beforeAll(() => {
    db = makeSyntheticDb();
    const factory = createReaderFactory(db);
    reader = factory("UA");
    qrReader = factory("QR");

    addPlane(db, "N3001", "Starlink");
    addFlight(db, "N3001", "UA1217", "ORD", utc("2027-06-09T12:00:00Z"), { arrivalAirport: "DEN" });
    negativeTail(db, "N3002");
    addFlight(db, "N3002", "UA1217", "DEN", utc("2027-06-09T17:19:00Z"), { arrivalAirport: "DRO" });

    addPlane(db, "N3003", "Starlink");
    addFlight(db, "N3003", "UA2769", "ORD", utc("2027-06-09T20:00:00Z"), { arrivalAirport: "DEN" });

    // DEN→SAN at 01:05Z the next UTC day is still 19:05 MDT on DAY.
    addPlane(db, "N2001", "Starlink");
    addFlight(db, "N2001", "UA540", "SFO", utc("2027-06-09T15:00:00Z"), { arrivalAirport: "DEN" });
    negativeTail(db, "N2002");
    addFlight(db, "N2002", "UA540", "DEN", utc("2027-06-10T01:05:00Z"), { arrivalAirport: "SAN" });

    // UA9002: DEN→SAN twice on the day, the later row on a Viasat tail.
    addPlane(db, "N3201", "Starlink");
    addFlight(db, "N3201", "UA9002", "SFO", utc("2027-06-09T14:00:00Z"), { arrivalAirport: "DEN" });
    addPlane(db, "N3202", "Starlink");
    addFlight(db, "N3202", "UA9002", "DEN", utc("2027-06-09T18:00:00Z"), { arrivalAirport: "SAN" });
    negativeTail(db, "N3203");
    addFlight(db, "N3203", "UA9002", "DEN", utc("2027-06-09T22:00:00Z"), { arrivalAirport: "SAN" });

    for (const [tail, from, to, at] of [
      ["N3101", "SFO", "LAX", "2027-06-09T14:00:00Z"],
      ["N3102", "LAX", "SFO", "2027-06-09T17:00:00Z"],
      ["N3103", "SFO", "SEA", "2027-06-09T21:00:00Z"],
    ] as const) {
      addPlane(db, tail, "Starlink");
      addFlight(db, tail, "UA9001", from, utc(at), { arrivalAirport: to });
    }

    // QR702 on local 2027-03-06: DOH→CPH (01:00 AST), CPH→DOH (15:00 CET),
    // JFK→DOH (20:00 EST, next UTC day).
    addQatarRow(db, "QR702", utc("2027-03-05T22:00:00Z"), "Starlink", {
      departureAirport: "DOH",
      arrivalAirport: "CPH",
    });
    addQatarRow(db, "QR702", utc("2027-03-06T14:00:00Z"), "None", {
      departureAirport: "CPH",
      arrivalAirport: "DOH",
      equipmentCode: "388",
    });
    addQatarRow(db, "QR702", utc("2027-03-07T01:00:00Z"), "Starlink", {
      departureAirport: "JFK",
      arrivalAirport: "DOH",
    });
  });

  const opts: ResolveDeps = { lookupTail: null, predict: stubPredict(0) };
  const ua = (fn: string, leg?: LegQuery, deps: ResolveDeps = opts, date = DAY) =>
    resolveFlightVerdict(AIRLINES.UA, reader, fn, date, leg ? { ...deps, leg } : deps);
  const legOf = (v: FlightVerdict) => ("leg" in v ? v.leg : undefined);

  test("no leg: today's answer, no leg key, identical to deps with the keys absent", async () => {
    const v = await ua("UA1217");
    expect(v.kind).toBe("scheduled");
    if (v.kind === "scheduled") {
      expect(scheduledFlights(v).map((r) => r.tail_number)).toEqual(["N3001"]);
    }
    expect("leg" in v).toBe(false);
    expect(await ua("UA1217", undefined, { ...opts, leg: undefined, unscoped: undefined })).toEqual(
      v
    );
  });

  test("ORD→DEN answers from its own row and lists the other leg", async () => {
    const v = await ua("UA1217", { origin: "ORD", destination: "DEN" });
    expect(v.kind).toBe("scheduled");
    if (v.kind !== "scheduled") return;
    expect(scheduledFlights(v).every((r) => r.departure_airport === "ORD")).toBe(true);
    expect(v.leg?.match).toBe("exact");
    expect(v.leg?.otherLegs).toEqual([
      {
        origin: "DEN",
        destination: "DRO",
        departure_time: utc("2027-06-09T17:19:00Z"),
        tail_number: "N3002",
        hasStarlink: false,
      },
    ]);
  });

  test("DEN→DRO is a firm no instead of the sibling leg's yes", async () => {
    const v = await ua("UA1217", { origin: "DEN", destination: "DRO" });
    expect(v.kind).toBe("scheduled_no");
    if (v.kind !== "scheduled_no") return;
    expect(v.flights[0].departure_airport).toBe("DEN");
    expect(v.flights[0].negativeReason).toBe("settled");
    expect(legScopeTelemetry({ ...v, leg: v.leg! }).effect).toBe("yes_to_no");
  });

  test("origin-only and a non-matching destination both pick the origin's leg", async () => {
    const exact = await ua("UA1217", { origin: "DEN", destination: "DRO" });
    const originOnly = await ua("UA1217", { origin: "DEN" });
    expect(originOnly.kind).toBe("scheduled_no");
    expect(legOf(originOnly)?.match).toBe("exact");
    if (originOnly.kind === "scheduled_no" && exact.kind === "scheduled_no") {
      expect(originOnly.flights).toEqual(exact.flights);
    }
    const stale = await ua("UA1217", { origin: "DEN", destination: "XYZ" });
    expect(stale.kind).toBe("scheduled_no");
    expect(legOf(stale)?.match).toBe("origin");
  });

  test("an origin fallback names the leg it answered, not the one asked for", async () => {
    const v = await ua("UA1217", { origin: "DEN", destination: "XYZ" });
    if (v.kind !== "scheduled_no") throw new Error(v.kind);
    expect(legSubject(v)).toBe("UA1217 DEN → DRO");
    expect(answersOtherLeg(v.leg)).toBe(true);
    expect(legNote(v)).toContain("DEN → XYZ");
    const exact = await ua("UA1217", { origin: "DEN", destination: "DRO" });
    if (exact.kind !== "scheduled_no") throw new Error(exact.kind);
    expect(answersOtherLeg(exact.leg)).toBe(false);
    expect(legNote(exact)).toBe("");
  });

  // UA540 is SFO→DEN on Starlink then DEN→SAN on Viasat; UA9002's DEN→SAN
  // leg is Starlink too. Asking for the whole journey must not answer the
  // first hop alone under the journey's label, in either direction.
  test("a whole-journey request across a connection answers unscoped", async () => {
    for (const fn of ["UA540", "UA1217"]) {
      const journey =
        fn === "UA540"
          ? { origin: "SFO", destination: "SAN" }
          : { origin: "ORD", destination: "DRO" };
      const base = await ua(fn);
      const v = await ua(fn, journey);
      const { leg, ...rest } = v as FlightVerdict & { leg?: ReturnType<typeof legOf> };
      expect(rest).toEqual(base);
      expect(leg?.match).toBe("unscoped");
      expect(leg?.reason).toBe("ambiguous_leg");
    }
  });

  test("a leg with no row falls to the prediction, not the sibling's yes", async () => {
    const v = await ua("UA2769", { origin: "DSM", destination: "ORD" });
    expect(v.kind).toBe("prediction");
    expect(legOf(v)?.match).toBe("unmatched");
    expect(legOf(v)?.otherLegs.map((l) => [l.origin, l.destination, l.hasStarlink])).toEqual([
      ["ORD", "DEN", true],
    ]);
  });

  test("FR24 segments are scoped too; match and otherLegs stay DB-only", async () => {
    const deps = {
      predict: stubPredict(0),
      lookupTail: lookupReturning([seg("DSM", "ORD", false), seg("ORD", "DEN", true)]),
    };
    const noFr24 = await ua("UA2769", { origin: "DSM", destination: "ORD" });
    const v = await ua("UA2769", { origin: "DSM", destination: "ORD" }, deps);
    expect(v.kind).toBe("fr24_no");
    if (v.kind !== "fr24_no") return;
    expect(v.segments.map((s) => s.origin)).toEqual(["DSM"]);
    expect(v.leg?.match).toBe("unmatched");
    expect(v.leg?.otherLegs).toEqual(legOf(noFr24)?.otherLegs ?? []);
  });

  test("a sibling leg's Starlink FR24 segment is not a yes for this leg", async () => {
    const v = await ua(
      "UA2769",
      { origin: "DSM", destination: "ORD" },
      { predict: stubPredict(0), lookupTail: lookupReturning([seg("ORD", "DEN", true)]) }
    );
    expect(v.kind).toBe("prediction");
  });

  test("FR24 ICAO codes compare equal to the requested IATA", async () => {
    const v = await ua(
      "UA2769",
      { origin: "DSM", destination: "ORD" },
      { predict: stubPredict(0), lookupTail: lookupReturning([seg("KDSM", "KORD", false)]) }
    );
    expect(v.kind).toBe("fr24_no");
  });

  test("UA540 from DEN stays a firm no when FR24 shows SFO→DEN on Starlink", async () => {
    const deps = {
      predict: stubPredict(0),
      lookupTail: lookupReturning([seg("SFO", "DEN", true), seg("DEN", "SAN", false)]),
    };
    expect((await ua("UA540", undefined, deps)).kind).toBe("scheduled");
    const v = await ua("UA540", { origin: "DEN" }, deps);
    expect(v.kind).toBe("scheduled_no");
  });

  test("FR24 across a connection answers unscoped, from one fetch", async () => {
    const { counter, lookup } = countingLookup([seg("SFO", "DEN", false), seg("DEN", "SAN", true)]);
    const v = await ua(
      "UA7777",
      { origin: "SFO", destination: "SAN" },
      { predict: stubPredict(0), lookupTail: lookup }
    );
    expect(v.kind).toBe("fr24");
    expect(legOf(v)?.match).toBe("unscoped");
    expect(legOf(v)?.reason).toBe("ambiguous_leg");
    expect(counter.calls).toBe(1);
  });

  test("ambiguous FR24 segments never answer under a scoped label", async () => {
    const v = await ua(
      "UA7777",
      { destination: "DEN" },
      {
        predict: stubPredict(0),
        lookupTail: lookupReturning([seg("SFO", "DEN", true), seg("ORD", "DEN", false)]),
      }
    );
    expect(legOf(v)?.match).toBe("unscoped");
    expect(legOf(v)?.reason).toBe("ambiguous_leg");
    expect(legSubject(v as { normalized: string })).toBe("UA7777");
  });

  test("an FR24 origin fallback is labelled with the segment it answered", async () => {
    const v = await ua(
      "UA7777",
      { origin: "SFO", destination: "SAN" },
      { predict: stubPredict(0), lookupTail: lookupReturning([seg("SFO", "DEN", true)]) }
    );
    if (v.kind !== "fr24") throw new Error(v.kind);
    expect(v.leg?.match).toBe("no_data");
    expect(legSubject(v)).toBe("UA7777 SFO → DEN");
    expect(answersOtherLeg(v.leg)).toBe(true);
  });

  test("otherLegs shows a repeated pair's earliest departure", async () => {
    const v = await ua("UA9002", { origin: "SFO" });
    expect(legOf(v)?.otherLegs).toEqual([
      {
        origin: "DEN",
        destination: "SAN",
        departure_time: utc("2027-06-09T18:00:00Z"),
        tail_number: "N3202",
        hasStarlink: true,
      },
    ]);
  });

  test("a number we hold no rows for reports no_data", async () => {
    const v = await ua("UA7777", { origin: "SFO", destination: "DEN" });
    expect(v.kind).toBe("prediction");
    expect(legOf(v)?.match).toBe("no_data");
    expect(legOf(v)?.otherLegs).toEqual([]);
  });

  test("a leg past UTC midnight is found on its local date only", async () => {
    const onDay = await ua("UA540", { origin: "DEN", destination: "SAN" });
    expect(onDay.kind).toBe("scheduled_no");
    const nextDay = await ua("UA540", { origin: "DEN", destination: "SAN" }, opts, "2027-06-10");
    expect(nextDay.kind).toBe("prediction");
    expect(legOf(nextDay)?.match).toBe("no_data");
  });

  test("a triangle never mixes legs: exact when unique, unscoped when ambiguous", async () => {
    const exact = await ua("UA9001", { origin: "SFO", destination: "SEA" });
    expect(exact.kind).toBe("scheduled");
    if (exact.kind === "scheduled") {
      expect(scheduledFlights(exact).map((r) => r.tail_number)).toEqual(["N3103"]);
    }
    const unscopedBase = await ua("UA9001");
    for (const leg of [{ origin: "SFO" }, { origin: "SFO", destination: "XYZ" }]) {
      const v = await ua("UA9001", leg);
      expect(legOf(v)?.match).toBe("unscoped");
      expect(legOf(v)?.reason).toBe("ambiguous_leg");
      const { leg: _leg, ...rest } = v as FlightVerdict & { leg?: unknown };
      expect(rest).toEqual(unscopedBase);
    }
  });

  test("unscoped reasons answer exactly the no-leg verdict plus the echo", async () => {
    const base = await ua("UA1217");
    for (const reason of ["invalid_airport", "same_airport", "no_timezone"] as const) {
      const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA1217", DAY, {
        ...opts,
        unscoped: { reason, origin: "SF", destination: null },
      });
      const { leg, ...rest } = v as FlightVerdict & { leg?: ReturnType<typeof legOf> };
      expect(rest).toEqual(base);
      expect(leg?.match).toBe("unscoped");
      expect(leg?.reason).toBe(reason);
      expect(leg?.otherLegs).toEqual([]);
    }
  });

  test("QR rows are scoped by leg", async () => {
    const qr = (leg: LegQuery) =>
      resolveFlightVerdict(AIRLINES.QR, qrReader, "QR702", "2027-03-06", { ...opts, leg });
    const fromCph = await qr({ origin: "CPH" });
    expect(fromCph.kind).toBe("qatar");
    if (fromCph.kind === "qatar") {
      expect(fromCph.hasStarlink).toBe(false);
      expect(fromCph.rows.map((r) => r.departure_airport)).toEqual(["CPH"]);
    }
    const toCph = await qr({ origin: "DOH", destination: "CPH" });
    expect(toCph.kind === "qatar" && toCph.hasStarlink).toBe(true);
    const none = await qr({ origin: "LHR" });
    expect(none.kind).toBe("qatar_no_data");
    expect(legOf(none)?.match).toBe("unmatched");
    const ambiguous = await qr({ destination: "DOH" });
    expect(legOf(ambiguous)?.match).toBe("unscoped");
    expect(legOf(ambiguous)?.reason).toBe("ambiguous_leg");
  });

  test("legField serializes only the public keys", async () => {
    const v = await ua("UA1217", { origin: "DEN" });
    const wire = legField(v as { leg?: never });
    expect(Object.keys(wire.leg ?? {}).sort()).toEqual([
      "destination",
      "match",
      "origin",
      "otherLegs",
    ]);
    expect(legField(await ua("UA1217"))).toEqual({});
  });

  test("an estimate for a leg the number doesn't fly names the legs it does", async () => {
    const v = await ua("UA540", { origin: "LAX", destination: "JFK" });
    if (v.kind !== "prediction") throw new Error(v.kind);
    expect(legOffRoute(v)).toBe(true);
    expect(legNote(v)).toBe(
      "We have no LAX → JFK leg for UA540 on this date; we see it flying SFO → DEN → SAN. This estimate is for flight UA540 overall."
    );
    const scattered = await ua("UA9001", { origin: "ORD", destination: "JFK" });
    expect(legNote(scattered as never)).toContain("flying SFO → LAX → SFO → SEA.");
  });

  test("FR24 legs feed the note but never the wire's otherLegs", async () => {
    const deps = {
      predict: stubPredict(0),
      lookupTail: lookupReturning([seg("LHR", "EWR", null)]),
    };
    const v = await ua("UA7777", { origin: "SFO", destination: "DEN" }, deps);
    if (v.kind !== "prediction") throw new Error(v.kind);
    expect(v.leg?.match).toBe("no_data");
    expect(legField(v).leg?.otherLegs).toEqual([]);
    expect(legOffRoute(v)).toBe(true);
    expect(legNote(v)).toContain("we see it flying LHR → EWR.");
  });

  test("an FR24-answered leg reports the segment's match in telemetry only", async () => {
    const v = await ua(
      "UA2769",
      { origin: "DSM", destination: "ORD" },
      { predict: stubPredict(0), lookupTail: lookupReturning([seg("DSM", "ORD", false)]) }
    );
    if (v.kind !== "fr24_no" || !v.leg) throw new Error(v.kind);
    expect(v.leg.match).toBe("unmatched");
    expect(legScopeTelemetry({ ...v, leg: v.leg }).match).toBe("exact");
  });

  test("an unfound leg of a through flight drops to low; alternative routings keep their grade", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [fn, o, d] of [
      ["UA7788", "SFO", "DEN"],
      ["UA7788", "DEN", "SAN"],
      ["UA7788", "LAX", "ORD"],
      ["UA7789", "SFO", "EWR"],
      ["UA7789", "SFO", "IAD"],
    ]) {
      db.run(
        `INSERT INTO flight_routes
           (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, 7200, ?, ?, 50)`,
        [fn, o, d, now - 90 * 86400, now - 86400]
      );
    }
    const high = ((_r: unknown, fn: string) => ({
      flight_number: fn,
      probability: 0.82,
      confidence: "high" as const,
      method: "flight_history",
      n_observations: 100,
    })) as unknown as typeof predictFlight;
    const deps = { lookupTail: null, predict: high };
    const unscoped = await ua("UA7788", undefined, deps);
    const scoped = await ua("UA7788", { origin: "DEN", destination: "SAN" }, deps);
    if (unscoped.kind !== "prediction" || scoped.kind !== "prediction") throw new Error();
    expect(unscoped.pred.confidence).toBe("high");
    expect(scoped.pred.confidence).toBe("low");
    expect(legNote(scoped)).toContain("a through flight whose legs can fly different aircraft");
    const grade = async (fn: string, leg: LegQuery) => {
      const v = await ua(fn, leg, deps);
      return v.kind === "prediction" ? v.pred.confidence : v.kind;
    };
    expect(await grade("UA7788", { origin: "PHX", destination: "SEA" })).toBe("low");
    // A route that chains with nothing, on a through-flight number, keeps its grade.
    expect(await grade("UA7788", { origin: "LAX", destination: "ORD" })).toBe("high");
    expect(await grade("UA7789", { origin: "SFO", destination: "IAD" })).toBe("high");
    expect(await grade("UA7789", { origin: "PHX", destination: "SEA" })).toBe("high");
    expect(await grade("UA7799", { origin: "DEN", destination: "SAN" })).toBe("high");
  });

  test("a queue shed is a softer, non-error estimate; an outage stays an error", async () => {
    const failing = (message: string) =>
      (async () => {
        throw new Fr24UnavailableError(message);
      }) as unknown as typeof lookupFlightTailVerdict;
    const shed = await ua("UA7777", undefined, {
      predict: stubPredict(3),
      lookupTail: failing("shed: bucket"),
    });
    const outage = await ua("UA7777", undefined, {
      predict: stubPredict(3),
      lookupTail: failing("FR24 assignments error: 503"),
    });
    if (shed.kind !== "prediction" || outage.kind !== "prediction") throw new Error();
    expect(fr24DegradedNote(shed)).toBe(FR24_SHED_NOTE);
    expect(verdictTelemetry(shed).outcome).toBe("predicted");
    expect(fr24DegradedNote(outage)).toBe(FR24_OUTAGE_NOTE);
    expect(verdictTelemetry(outage).outcome).toBe("error");
  });
});

describe("parseLegQuery / normalizeAirportCode", () => {
  test("normalizes case, whitespace and K/P ICAO codes", () => {
    expect(parseLegQuery(" sfo ", null)).toEqual({ leg: { origin: "SFO" } });
    expect(parseLegQuery("KSFO", "PHNL")).toEqual({ leg: { origin: "SFO", destination: "HNL" } });
    expect(normalizeAirportCode("PANC")).toBe("ANC");
    expect(normalizeAirportCode("PGUM")).toBe("GUM");
  });

  test("absent or empty params are no leg at all", () => {
    for (const [o, d] of [
      [null, null],
      ["", ""],
      ["  ", null],
    ] as const) {
      const parsed = parseLegQuery(o, d);
      expect(parsed.leg).toBeUndefined();
      expect(parsed.unscoped).toBeUndefined();
    }
  });

  test("malformed codes are invalid_airport, echoed bounded", () => {
    for (const raw of ["SF", "SFO1", "1AB", "XXXX", "<script>alert(1)</script>"]) {
      const parsed = parseLegQuery(raw, null);
      expect(parsed.unscoped?.reason).toBe("invalid_airport");
      expect((parsed.unscoped?.origin ?? "").length).toBeLessThanOrEqual(4);
    }
    expect(parseLegQuery("SFO", "D3N").unscoped?.reason).toBe("invalid_airport");
  });

  test("same airport, unknown and zone-less origins are their own reasons", () => {
    expect(parseLegQuery("SFO", "sfo").unscoped?.reason).toBe("same_airport");
    expect(parseLegQuery("QQQ", "SFO").unscoped?.reason).toBe("invalid_airport");
    const zoneless = Object.keys(AIRPORT_COORDS).find((code) => !AIRPORT_TZ[code]);
    if (zoneless) expect(parseLegQuery(zoneless, "SFO").unscoped?.reason).toBe("no_timezone");
    // Only the origin drives the local-date window.
    expect(parseLegQuery("SFO", "QQQ").leg).toEqual({ origin: "SFO", destination: "QQQ" });
  });

  test("a K/P code only maps onto an airport we know", () => {
    expect(normalizeAirportCode("KXYZ")).toBeNull();
    expect(normalizeAirportCode("")).toBeNull();
    expect(normalizeAirportCode(null)).toBeNull();
    expect(normalizeAirportCode("EGLL")).toBeNull();
  });
});

describe("selectLeg", () => {
  type Leg = { dep: string | null; arr: string | null; id: number };
  const items: Leg[] = [
    { dep: "SFO", arr: "DEN", id: 1 },
    { dep: "DEN", arr: "SAN", id: 2 },
    { dep: null, arr: "SFO", id: 3 },
  ];
  const pick = (leg: LegQuery, xs: Leg[] = items) =>
    selectLeg(
      xs,
      (t) => t.dep,
      (t) => t.arr,
      leg
    );

  test("exact on origin, destination, or both", () => {
    expect(pick({ origin: "DEN" })).toEqual({ items: [items[1]], match: "exact" });
    expect(pick({ origin: "SFO", destination: "DEN" })).toEqual({
      items: [items[0]],
      match: "exact",
    });
    expect(pick({ destination: "SAN" })).toEqual({ items: [items[1]], match: "exact" });
  });

  test("origin fallback when nothing arrives at the destination", () => {
    expect(pick({ origin: "SFO", destination: "LAX" })).toEqual({
      items: [items[0]],
      match: "origin",
    });
  });

  test("a destination another item arrives at is a connection, not a fallback", () => {
    expect(pick({ origin: "SFO", destination: "SAN" })).toEqual({ items: [], match: "ambiguous" });
  });

  test("a null departure never matches a requested origin", () => {
    expect(pick({ origin: "LAX" })).toEqual({ items: [], match: null });
    expect(pick({ destination: "SFO" }).items.map((t) => t.id)).toEqual([3]);
  });

  test("several pairs are ambiguous, repeats of one pair are not", () => {
    const tri: Leg[] = [
      { dep: "SFO", arr: "LAX", id: 1 },
      { dep: "SFO", arr: "SEA", id: 2 },
      { dep: "SFO", arr: "SEA", id: 3 },
    ];
    expect(pick({ origin: "SFO" }, tri)).toEqual({ items: [], match: "ambiguous" });
    expect(pick({ origin: "SFO", destination: "ORD" }, tri).match).toBe("ambiguous");
    expect(pick({ origin: "SFO", destination: "SEA" }, tri).items.map((t) => t.id)).toEqual([2, 3]);
  });
});
