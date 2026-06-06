/**
 * Check-flight verdict engine — local-date matching, the decision ladder, and
 * the tail-verdict negative fold-in. Synthetic fixtures use an in-memory DB
 * (schema cloned from the snapshot) so boundary times are exact; snapshot
 * tests assert shapes only.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES } from "../src/airlines/registry";
import {
  flightDateWindow,
  negativeWifi,
  resolveFlightVerdict,
  verdictConfidence,
} from "../src/api/check-flight-core";
import {
  ASSIGNMENT_FAILURE_TTL,
  type FallbackSegment,
  cachedFlightAssignments,
  type lookupFlightTailVerdict,
  resolveTailVerdict,
  setAssignmentFetcher,
} from "../src/api/flight-verdict";
import { Fr24UnavailableError } from "../src/api/flightradar24-api";
import { createReaderFactory } from "../src/database/reader";
import { planItinerary } from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { airportLocalDate, matchesLocalDate } from "../src/utils/airport-tz";
import {
  addFleet,
  addFlight,
  addPlane,
  addQatarRow,
  makeSyntheticDb,
  openSnapshot,
  stubPredict,
  utc,
} from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";

describe("flightDateWindow", () => {
  test("strict UTC bounds plus widened query bounds", () => {
    const w = flightDateWindow("2027-06-09", utc("2027-06-09T00:00:00Z"));
    expect(w).not.toBeNull();
    expect(w!.start).toBe(utc("2027-06-09T00:00:00Z"));
    expect(w!.end).toBe(w!.start + 86400);
    expect(w!.queryStart).toBe(w!.start - 14 * 3600);
    expect(w!.queryEnd).toBe(w!.end + 12 * 3600);
    expect(w!.daysOut).toBe(0);
  });

  test("daysOut counts UTC calendar days", () => {
    const w = flightDateWindow("2027-06-09", utc("2027-06-07T23:59:00Z"));
    expect(w!.daysOut).toBe(2);
  });

  test("invalid dates return null", () => {
    expect(flightDateWindow("garbage")).toBeNull();
    expect(flightDateWindow("2027-6-9")).toBeNull();
    expect(flightDateWindow("")).toBeNull();
  });
});

describe("airport local dates", () => {
  // 2027-06-10 05:35Z is 2027-06-09 22:35 PDT — the printed date is the 9th.
  const eveningPdt = utc("2027-06-10T05:35:00Z");

  test("airportLocalDate converts through the airport zone", () => {
    expect(airportLocalDate("SFO", eveningPdt)).toBe("2027-06-09");
    expect(airportLocalDate("DOH", utc("2027-03-05T21:30:00Z"))).toBe("2027-03-06");
    expect(airportLocalDate("ZZZ", eveningPdt)).toBeNull();
  });

  test("matchesLocalDate matches the printed local date, not the UTC date", () => {
    const w9 = flightDateWindow("2027-06-09")!;
    const w10 = flightDateWindow("2027-06-10")!;
    expect(matchesLocalDate("2027-06-09", "SFO", eveningPdt, w9.start, w9.end)).toBe(true);
    expect(matchesLocalDate("2027-06-10", "SFO", eveningPdt, w10.start, w10.end)).toBe(false);
  });

  test("unmapped airport falls back to the strict UTC window", () => {
    const w10 = flightDateWindow("2027-06-10")!;
    const w9 = flightDateWindow("2027-06-09")!;
    expect(matchesLocalDate("2027-06-10", "ZZZ", eveningPdt, w10.start, w10.end)).toBe(true);
    expect(matchesLocalDate("2027-06-09", "ZZZ", eveningPdt, w9.start, w9.end)).toBe(false);
  });
});

describe("resolveFlightVerdict ladder (synthetic DB)", () => {
  let db: Database;
  let reader: ReturnType<ReturnType<typeof createReaderFactory>>;
  let qrReader: ReturnType<ReturnType<typeof createReaderFactory>>;

  beforeAll(() => {
    db = makeSyntheticDb();
    const factory = createReaderFactory(db);
    reader = factory("UA");
    qrReader = factory("QR");

    // Verified-Starlink tail departing SFO 22:35 PDT (05:35Z next UTC day).
    addPlane(db, "N1001", "Starlink");
    addFlight(db, "N1001", "UA111", "SFO", utc("2027-06-10T05:35:00Z"));
    // Spreadsheet tail with a settled united_fleet negative.
    addPlane(db, "N1002", null);
    addFleet(db, "N1002", "negative", { verifiedWifi: "Viasat" });
    addFlight(db, "N1002", "UA222", "SFO", utc("2027-06-10T05:35:00Z"));
    // Unmapped airport: 23:00Z stays on the UTC date.
    addPlane(db, "N1003", "Starlink");
    addFlight(db, "N1003", "UA333", "ZZZ", utc("2027-06-10T23:00:00Z"));
    // QR: 00:30 DOH-local departure (21:30Z the previous UTC day).
    addQatarRow(db, "QR701", utc("2027-03-05T21:30:00Z"), "Starlink");
  });

  const opts = { lookupTail: null, predict: stubPredict(0) };

  test("evening US departure found by its printed local date", async () => {
    const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA111", "2027-06-09", opts);
    expect(v.kind).toBe("scheduled");
    if (v.kind === "scheduled") {
      expect(verdictConfidence(v)).toBe("verified");
      expect(v.verified[0].tail_number).toBe("N1001");
    }
  });

  test("same departure NOT matched to the UTC date (wrong-day repeat guard)", async () => {
    const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA111", "2027-06-10", opts);
    expect(v.kind).toBe("prediction");
  });

  test("united_fleet negative settle produces a firm no, not a spreadsheet yes", async () => {
    const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA222", "2027-06-09", opts);
    expect(v.kind).toBe("scheduled_no");
    if (v.kind === "scheduled_no") {
      expect(v.flights[0].negativeReason).toBe("settled");
      expect(negativeWifi(v.flights[0])).toBe("Viasat");
    }
  });

  test("flight numbers over 4 digits are rejected before any lookup", async () => {
    const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA99999", "2027-06-09", opts);
    expect(v.kind).toBe("invalid_flight_number");
    const qr = await resolveFlightVerdict(AIRLINES.QR, qrReader, "QR99999", "2027-03-06", opts);
    expect(qr.kind).toBe("invalid_flight_number");
  });

  test("unmapped airport keeps the strict UTC window", async () => {
    const onUtcDate = await resolveFlightVerdict(AIRLINES.UA, reader, "UA333", "2027-06-10", opts);
    expect(onUtcDate.kind).toBe("scheduled");
    const dayBefore = await resolveFlightVerdict(AIRLINES.UA, reader, "UA333", "2027-06-09", opts);
    expect(dayBefore.kind).toBe("prediction");
  });

  test("invalid date short-circuits", async () => {
    const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA111", "junk", opts);
    expect(v.kind).toBe("invalid_date");
  });

  test("QR 00:30-local departure found by its printed local date", async () => {
    const v = await resolveFlightVerdict(AIRLINES.QR, qrReader, "QR701", "2027-03-06", opts);
    expect(v.kind).toBe("qatar");
    if (v.kind === "qatar") {
      expect(v.hasStarlink).toBe(true);
      expect(v.confidence).toBe("verified");
    }
    const prev = await resolveFlightVerdict(AIRLINES.QR, qrReader, "QR701", "2027-03-05", opts);
    expect(prev.kind).toBe("qatar_no_data");
  });

  const seg = (overrides: Partial<FallbackSegment>): FallbackSegment => ({
    tail_number: "N9999",
    aircraft_model: "Boeing 737-900",
    origin: "SFO",
    destination: "EWR",
    departure_time: utc("2027-06-10T05:35:00Z"),
    arrival_time: utc("2027-06-10T08:35:00Z"),
    hasStarlink: null,
    confidence: "unknown",
    ...overrides,
  });
  const lookupReturning = (segments: FallbackSegment[] | null) =>
    (async () => segments) as unknown as typeof lookupFlightTailVerdict;

  test("FR24 fallback: starlink segment → fr24, negative-only → fr24_no, null → prediction", async () => {
    const yes = await resolveFlightVerdict(AIRLINES.UA, reader, "UA999", "2027-06-09", {
      predict: stubPredict(0),
      lookupTail: lookupReturning([seg({ hasStarlink: true, confidence: "verified" })]),
    });
    expect(yes.kind).toBe("fr24");
    if (yes.kind === "fr24") expect(verdictConfidence(yes)).toBe("verified");

    const no = await resolveFlightVerdict(AIRLINES.UA, reader, "UA999", "2027-06-09", {
      predict: stubPredict(0),
      lookupTail: lookupReturning([seg({ hasStarlink: false, confidence: "negative" })]),
    });
    expect(no.kind).toBe("fr24_no");

    const none = await resolveFlightVerdict(AIRLINES.UA, reader, "UA999", "2027-06-09", {
      predict: stubPredict(0),
      lookupTail: lookupReturning(null),
    });
    expect(none.kind).toBe("prediction");

    // Unknown-tail segments are not a "no" — fall through to probability.
    const unknown = await resolveFlightVerdict(AIRLINES.UA, reader, "UA999", "2027-06-09", {
      predict: stubPredict(0),
      lookupTail: lookupReturning([seg({})]),
    });
    expect(unknown.kind).toBe("prediction");
  });

  test("FR24 swap discovery overrides a settled-negative scheduled row", async () => {
    // UA222's only assignment is a settled-negative tail; FR24 reports the
    // flight actually swapped onto a Starlink tail → firm yes wins.
    const swapped = await resolveFlightVerdict(AIRLINES.UA, reader, "UA222", "2027-06-09", {
      predict: stubPredict(0),
      lookupTail: lookupReturning([seg({ hasStarlink: true, confidence: "verified" })]),
    });
    expect(swapped.kind).toBe("fr24");
    if (swapped.kind === "fr24") expect(swapped.starlink[0].hasStarlink).toBe(true);

    // FR24 agreeing (negative-only segments) keeps our own firm no.
    const agreed = await resolveFlightVerdict(AIRLINES.UA, reader, "UA222", "2027-06-09", {
      predict: stubPredict(0),
      lookupTail: lookupReturning([seg({ hasStarlink: false, confidence: "negative" })]),
    });
    expect(agreed.kind).toBe("scheduled_no");
    if (agreed.kind === "scheduled_no") expect(agreed.fr24Error).toBe(false);
  });

  test("FR24 outage with firm-no rows: the no stands, swap-degradation flagged", async () => {
    const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA222", "2027-06-09", {
      predict: stubPredict(0),
      lookupTail: () => Promise.reject(new Fr24UnavailableError("FR24 down")),
    });
    expect(v.kind).toBe("scheduled_no");
    if (v.kind === "scheduled_no") expect(v.fr24Error).toBe(true);
  });
});

describe("resolveTailVerdict negative fold-in (synthetic DB)", () => {
  let db: Database;
  let reader: ReturnType<ReturnType<typeof createReaderFactory>>;

  beforeAll(() => {
    db = makeSyntheticDb();
    reader = createReaderFactory(db)("UA");
    const now = Math.floor(Date.now() / 1000);

    addPlane(db, "N2001"); // sp row only
    addPlane(db, "N2002"); // sp row + uf negative, consensus unsettled
    addFleet(db, "N2002", "negative", { verifiedWifi: "Viasat" });
    addPlane(db, "N2003"); // sp row + uf negative, but consensus says Starlink
    addFleet(db, "N2003", "negative", { verifiedWifi: "Viasat" });
    for (let i = 0; i < 3; i++) {
      db.query(
        `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
         VALUES ('N2003', 'united', ?, 1, 'Starlink', 1, 'UA')`
      ).run(now - 100 - i);
    }
    addFleet(db, "N2004", "confirmed"); // fleet-confirmed, no sp row, no observed evidence
    addFleet(db, "N2005", "negative", { verifiedWifi: "Viasat" }); // fleet-negative, no sp row
    addFleet(db, "N2006", "confirmed"); // fleet-confirmed + united-observed consensus
    for (let i = 0; i < 3; i++) {
      db.query(
        `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
         VALUES ('N2006', 'united', ?, 1, 'Starlink', 1, 'UA')`
      ).run(now - 100 - i);
    }
  });

  const cases: [string, boolean | null, string][] = [
    ["N2001", true, "spreadsheet"],
    ["N2002", false, "disputed"], // sp row + uf negative + null consensus
    ["N2003", true, "verified"], // consensus 'Starlink' is NOT overridden by uf negative
    // uf-only 'confirmed' without observed-wifi evidence is a type rule
    // (alaska-json writes it) — same tier gate as the sp branch.
    ["N2004", true, "spreadsheet"],
    ["N2005", false, "negative"],
    ["N2006", true, "verified"], // uf-only confirmed + united-observed → still 'verified'
    ["NXXXX", null, "unknown"],
  ];

  test.each(cases)("%s → hasStarlink=%p, %s", (tail, hasStarlink, confidence) => {
    const v = resolveTailVerdict(reader, tail);
    expect(v.hasStarlink).toBe(hasStarlink);
    expect(v.confidence).toBe(confidence);
  });
});

describe("confirmed-edge seeding matches the traveler's local date (synthetic DB)", () => {
  // UA1111 departs SFO 18:00 PDT on 2026-07-10 = 01:00Z on the 11th — the
  // strict UTC day window seeded this verified leg for the WRONG date.
  test("evening departure seeds the traveler's date, not the UTC day", () => {
    const db = makeSyntheticDb();
    const reader = createReaderFactory(db)("UA");
    addPlane(db, "N7777", "Starlink");
    addFlight(db, "N7777", "UA1111", "SFO", utc("2026-07-11T01:00:00Z"), {
      arrivalAirport: "GEG",
    });

    const legFor = (date: string) =>
      planItinerary(reader, "SFO", "GEG", { targetDateUnix: utc(`${date}T12:00:00Z`) })[0]?.legs[0];

    // Traveler's printed date: confirmed (0.65 mainline swap-adjusted ≥ minLegProb).
    expect(legFor("2026-07-10")?.confirmed).toBe(true);
    // The UTC day: no confirmed seed — the 2% mainline prior drops the edge.
    expect(legFor("2026-07-11")?.confirmed ?? false).toBe(false);
    db.close();
  });
});

describe("resolveTailVerdict evidence tiers + tenant scoping (synthetic DB)", () => {
  let db: Database;
  let readerUA: ReturnType<ReturnType<typeof createReaderFactory>>;
  let readerAS: ReturnType<ReturnType<typeof createReaderFactory>>;

  beforeAll(() => {
    db = makeSyntheticDb();
    const factory = createReaderFactory(db);
    readerUA = factory("UA");
    readerAS = factory("AS");
    const now = Math.floor(Date.now() / 1000);

    addPlane(db, "N2101"); // UA tail, united.com-observed consensus
    addPlane(db, "N2102", null, { airline: "AS", aircraft: "Embraer E175" }); // AS tail, type-derived rows only
    const ins = db.query(
      `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
       VALUES (?, ?, ?, 1, 'Starlink', 1, ?)`
    );
    for (let i = 0; i < 3; i++) {
      ins.run("N2101", "united", now - 100 - i, "UA");
      ins.run("N2102", "alaska", now - 100 - i, "AS");
    }
  });

  test("united-observed consensus → 'verified' (unchanged)", () => {
    const v = resolveTailVerdict(readerUA, "N2101");
    expect(v.hasStarlink).toBe(true);
    expect(v.confidence).toBe("verified");
  });

  test("type-derived (alaska) rows only → yes, but never 'verified'", () => {
    const v = resolveTailVerdict(readerAS, "N2102");
    expect(v.hasStarlink).toBe(true);
    expect(v.confidence).toBe("spreadsheet"); // surfaces as 'likely'
  });

  test("cross-tenant scope: an AS reader cannot resolve a UA tail (and vice versa)", () => {
    const asViewOfUaTail = resolveTailVerdict(readerAS, "N2101");
    expect(asViewOfUaTail.hasStarlink).toBeNull();
    expect(asViewOfUaTail.confidence).toBe("unknown");
    const uaViewOfAsTail = resolveTailVerdict(readerUA, "N2102");
    expect(uaViewOfAsTail.hasStarlink).toBeNull();
    expect(uaViewOfAsTail.confidence).toBe("unknown");
  });
});

describe("FR24 outage caveats through dispatch (synthetic DB)", () => {
  const AS_HOST = "alaskastarlinktracker.com";
  let app: ReturnType<typeof createApp>;
  // Anchor everything on one instant so the flight row, the queried date, and
  // FR24's lookup window agree regardless of when the suite runs.
  const nowSec = Math.floor(Date.now() / 1000);
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);

  beforeAll(() => {
    const db = makeSyntheticDb();
    // Firm-no row: tracked tail verified as non-Starlink, departing today on
    // an unmapped airport (ZZZ) so the strict UTC window applies.
    addPlane(db, "N3001", "Viasat");
    addFlight(db, "N3001", "UA333", "ZZZ", nowSec);
    app = createApp(db);
    setAssignmentFetcher(() => Promise.reject(new Fr24UnavailableError("FR24 down")));
  });

  afterAll(() => setAssignmentFetcher(null));

  const rest = async (path: string, host: string) => {
    const res = await app.dispatch(new Request(`http://x${path}`, { headers: { Host: host } }));
    expect(res.status).toBe(200);
    return (await res.json()) as { message?: string };
  };

  const mcpCheck = async (host: string, flightNumber: string) => {
    const res = await app.dispatch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { Host: host, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "check_flight", arguments: { flight_number: flightNumber, date: today } },
        }),
      })
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { content: Array<{ text: string }> } };
    return j.result.content[0].text;
  };

  test("REST scheduled_no + outage: firm no stands, swap-degradation caveat present", async () => {
    const d = await rest(`/api/check-flight?flight_number=UA333&date=${today}`, UA_HOST);
    expect(d.message).toContain("not Starlink");
    expect(d.message).toContain("swap detection is degraded");
  });

  test("MCP scheduled_no + outage: same caveat on the MCP surface", async () => {
    const text = await mcpCheck(UA_HOST, "UA333");
    expect(text).toContain("NOT Starlink");
    expect(text).toContain("swap detection is degraded");
  });

  test("REST no_model + outage: couldn't-confirm caveat, not 'no assignment data'", async () => {
    const d = await rest(`/api/check-flight?flight_number=AS9998&date=${today}`, AS_HOST);
    expect(d.message).toContain("couldn't confirm the aircraft assignment");
  });

  test("MCP no_model + outage: couldn't-confirm caveat, not 'no assignment data'", async () => {
    const text = await mcpCheck(AS_HOST, "AS9998");
    expect(text).toContain("couldn't confirm the aircraft assignment");
    expect(text).not.toContain("no assignment data");
  });
});

describe("/api/check-flight boundary + contract through dispatch (synthetic DB)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const db = makeSyntheticDb();
    addPlane(db, "N1001", "Starlink");
    addFlight(db, "N1001", "UA111", "SFO", utc("2027-06-10T05:35:00Z"));
    app = createApp(db);
  });

  const get = (path: string) =>
    app.dispatch(new Request(`http://x${path}`, { headers: { Host: UA_HOST } }));

  test("printed local date hits the verified assignment", async () => {
    const res = await get("/api/check-flight?flight_number=UA111&date=2027-06-09");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasStarlink: boolean;
      confidence: string;
      flights: unknown[];
    };
    expect(body.hasStarlink).toBe(true);
    expect(body.confidence).toBe("verified");
    expect(body.flights.length).toBe(1);
  });

  test("UTC date does NOT match the wrong day's flight; contract fields intact", async () => {
    // Far-future date keeps FR24 out of its lookup window — no network.
    const res = await get("/api/check-flight?flight_number=UA111&date=2027-06-10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasStarlink: boolean; flights: unknown[] };
    expect(body.hasStarlink).toBe(false);
    expect(Array.isArray(body.flights)).toBe(true);
    expect(body.flights.length).toBe(0);
  });

  test("invalid date → 400", async () => {
    const res = await get("/api/check-flight?flight_number=UA111&date=junk");
    expect(res.status).toBe(400);
  });

  test("5-digit flight number → 400 (REST rejects, parity with MCP)", async () => {
    const res = await get("/api/check-flight?flight_number=UA99999&date=2027-06-09");
    expect(res.status).toBe(400);
  });

  test("MCP check_flight agrees with REST on the boundary date (REST==MCP)", async () => {
    const mcp = await app.dispatch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { Host: UA_HOST, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "check_flight",
            arguments: { flight_number: "UA111", date: "2027-06-09" },
          },
        }),
      })
    );
    expect(mcp.status).toBe(200);
    const json = (await mcp.json()) as { result: { content: { text: string }[] } };
    expect(json.result.content[0].text).toMatch(/Yes!/);
  });
});

describe("REST==MCP equivalence on snapshot data", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = openSnapshot();
    app = createApp(db);
  });

  test("verified assignment: REST hasStarlink matches MCP text", async () => {
    const sample = db
      .query(
        `SELECT uf.flight_number, uf.departure_airport, uf.departure_time
         FROM upcoming_flights uf
         JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
         WHERE uf.airline = 'UA' AND sp.verified_wifi = 'Starlink'
           AND NOT EXISTS (SELECT 1 FROM united_fleet n
                           WHERE n.tail_number = uf.tail_number AND n.starlink_status = 'negative')
           AND uf.flight_number NOT GLOB '*[0-9][0-9][0-9][0-9][0-9]'
         LIMIT 1`
      )
      .get() as { flight_number: string; departure_airport: string; departure_time: number } | null;
    if (!sample) return; // shape test only — survive data drift

    const date =
      airportLocalDate(sample.departure_airport, sample.departure_time) ??
      new Date(sample.departure_time * 1000).toISOString().slice(0, 10);

    const rest = await app.dispatch(
      new Request(`http://x/api/check-flight?flight_number=${sample.flight_number}&date=${date}`, {
        headers: { Host: UA_HOST },
      })
    );
    expect(rest.status).toBe(200);
    const restBody = (await rest.json()) as { hasStarlink: boolean; flights: unknown[] };
    expect(restBody.hasStarlink).toBe(true);
    expect(restBody.flights.length).toBeGreaterThan(0);

    const mcp = await app.dispatch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { Host: UA_HOST, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "check_flight",
            arguments: { flight_number: sample.flight_number, date },
          },
        }),
      })
    );
    const mcpJson = (await mcp.json()) as { result: { content: { text: string }[] } };
    expect(mcpJson.result.content[0].text).toMatch(/yes/i);
  });

  test("HA host no-data → tri-state type verdict (deliberate wire change, pinned)", async () => {
    const res = await app.dispatch(
      new Request("http://x/api/check-flight?flight_number=HA9999&date=2026-01-15", {
        headers: { Host: "hawaiianstarlinktracker.com" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasStarlink: boolean | null;
      confidence: string;
      flights: unknown[];
    };
    expect(body.hasStarlink).toBeNull();
    expect(body.confidence).toBe("type");
    expect(body.flights).toEqual([]);
  });

  test("hub /api/check-any-flight no-data paths include flights[]", async () => {
    const res = await app.dispatch(
      new Request("http://x/api/check-any-flight?flight_number=UA8765&date=2026-01-15", {
        headers: { Host: "airlinestarlinktracker.com" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasStarlink: boolean | null; flights?: unknown[] };
    expect(body.hasStarlink).toBeNull();
    expect(Array.isArray(body.flights)).toBe(true);
  });

  test("hub untracked airline stays a 200 error with no new fields", async () => {
    const res = await app.dispatch(
      new Request("http://x/api/check-any-flight?flight_number=ZZ123&date=2026-01-15", {
        headers: { Host: "airlinestarlinktracker.com" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(Object.keys(body)).toEqual(["error"]);
  });
});

describe("cachedFlightAssignments negative cache", () => {
  test("rejection replays within the failure TTL, refetches after expiry", async () => {
    let calls = 0;
    setAssignmentFetcher(() => {
      calls++;
      return Promise.reject(new Fr24UnavailableError("FR24 down"));
    });
    try {
      // Fixed epoch, nowhere near wall-clock: proves the failure stamp and
      // the TTL compare share the injected timebase end to end.
      const t0 = utc("2030-01-01T00:00:00Z");
      const target = utc("2030-01-01T12:00:00Z");

      await expect(cachedFlightAssignments("UA9999", target, t0)).rejects.toThrow("FR24 down");
      expect(calls).toBe(1);

      // Inside the TTL the failure marker replays — no second fetch.
      await expect(
        cachedFlightAssignments("UA9999", target, t0 + ASSIGNMENT_FAILURE_TTL - 10)
      ).rejects.toThrow("FR24 down");
      expect(calls).toBe(1);

      // Past the TTL the marker expires and the fetch retries.
      await expect(
        cachedFlightAssignments("UA9999", target, t0 + ASSIGNMENT_FAILURE_TTL + 10)
      ).rejects.toThrow("FR24 down");
      expect(calls).toBe(2);
    } finally {
      setAssignmentFetcher(null);
    }
  });

  test("success is cached for the day key; empty results are not cached", async () => {
    const responses: string[][] = [[], ["N100UA"]];
    let calls = 0;
    setAssignmentFetcher(() => {
      const tails = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return Promise.resolve(
        tails.map((tail_number) => ({
          tail_number,
          aircraft_model: "B739",
          origin: "SFO",
          destination: "EWR",
          departure_time: utc("2027-06-09T15:00:00Z"),
          arrival_time: utc("2027-06-09T20:00:00Z"),
        }))
      );
    });
    try {
      const t0 = utc("2030-01-01T00:00:00Z");
      const target = utc("2030-01-01T12:00:00Z");

      // Empty result: deleted from cache so the next call re-polls.
      expect(await cachedFlightAssignments("UA9998", target, t0)).toEqual([]);
      expect((await cachedFlightAssignments("UA9998", target, t0 + 1)).length).toBe(1);
      expect(calls).toBe(2);

      // Non-empty result stays cached.
      await cachedFlightAssignments("UA9998", target, t0 + 2);
      expect(calls).toBe(2);
    } finally {
      setAssignmentFetcher(null);
    }
  });
});
