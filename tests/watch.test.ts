/**
 * Starlink Watch: the per-flight calendar feed (/cal/{fn}/{date}.ics), the
 * assignment log behind its swap detection, and the same-day alternatives on
 * firm-no check-flight answers. Snapshot tests assert shapes only; the
 * synthetic-DB tests own their data and may assert values.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { departureLocalDate } from "../src/database/assignment-log";
import { updateFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import {
  type WatchIcsInput,
  buildWatchIcs,
  escapeIcsText,
  foldIcsLine,
  watchSummary,
} from "../src/utils/ics";
import { addFleet, addPlane, bodyOf, jsonOf, makeSyntheticDb, openSnapshot, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";
const QR_HOST = "qatarstarlinktracker.com";

const isoDaysFromNow = (days: number) =>
  new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

/** Unfolded content lines of an .ics body. */
function icsLines(body: string): string[] {
  return body.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
}

function prop(body: string, name: string): string | undefined {
  return icsLines(body)
    .find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`))
    ?.replace(/^[^:]*:/, "");
}

function expectWellFormedIcs(body: string) {
  expect(body.endsWith("\r\n")).toBe(true);
  expect(body.replace(/\r\n/g, "").includes("\n")).toBe(false);
  for (const line of body.split("\r\n")) {
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
  }
  expect(body.match(/^BEGIN:VEVENT$/gm)?.length).toBe(1);
  expect(body.match(/^END:VEVENT$/gm)?.length).toBe(1);
  expect(prop(body, "UID")).toMatch(/@/);
  expect(prop(body, "SUMMARY")).toBeTruthy();
  expect(prop(body, "DTSTART")).toBeTruthy();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure builder
// ─────────────────────────────────────────────────────────────────────────────

describe("buildWatchIcs", () => {
  const base: WatchIcsInput = {
    canonicalHost: UA_HOST,
    fn: "UA123",
    date: "2026-10-01",
    verdict: { state: "prediction", probability: 0.27, observations: 12 },
    history: [],
    alternatives: [],
    dep: null,
    arr: null,
    depUnix: null,
    arrUnix: null,
    now: 1_790_000_000,
  };
  const row = (tail: string, firstSeen: number) => ({
    airline: "UA",
    flight_number: "UA123",
    dep_date: "2026-10-01",
    departure_airport: "SFO",
    arrival_airport: "EWR",
    tail_number: tail,
    starlink: 1,
    departure_time: 1_790_870_400,
    arrival_time: 1_790_890_000,
    first_seen: firstSeen,
    last_seen: firstSeen + 600,
  });
  const leg = { dep: "SFO", arr: "EWR", depUnix: 1_790_870_400, arrUnix: 1_790_890_000 };

  test("prediction: odds summary, all-day event, no invented time", () => {
    const ics = buildWatchIcs(base);
    expectWellFormedIcs(ics);
    expect(prop(ics, "SUMMARY")).toStartWith("UA123 · Starlink odds ~");
    expect(icsLines(ics)).toContain("DTSTART;VALUE=DATE:20261001");
    expect(prop(ics, "SEQUENCE")).toBe("0");
  });

  test("yes: route, tick and tail; timed event in UTC", () => {
    const ics = buildWatchIcs({
      ...base,
      ...leg,
      verdict: { state: "yes", tail: "N37502", aircraft: "737-800", confidence: "verified" },
      history: [row("N37502", 1_789_900_000)],
    });
    expectWellFormedIcs(ics);
    expect(prop(ics, "SUMMARY")).toStartWith("UA123 SFO→EWR · Starlink ✅ N37502");
    expect(prop(ics, "DTSTART")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(prop(ics, "DTEND")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(prop(ics, "SEQUENCE")).toBe("1");
  });

  test("no: provider named, 'None' rendered as no WiFi, alternatives listed", () => {
    const thales = buildWatchIcs({
      ...base,
      ...leg,
      verdict: { state: "no", tail: "N16709", aircraft: "737-724", wifi: "Thales" },
    });
    expect(prop(thales, "SUMMARY")).toBe("UA123 · No Starlink (N16709\\, Thales)");
    const none = buildWatchIcs({
      ...base,
      ...leg,
      verdict: { state: "no", tail: "N979SW", aircraft: null, wifi: "None" },
      alternatives: [
        {
          flight_number: "UA2806",
          departure_time: 1_790_880_000,
          tail_number: "N37502",
          aircraft_type: "737-800",
        },
      ],
    });
    expectWellFormedIcs(none);
    expect(prop(none, "SUMMARY")).toBe("UA123 · No Starlink (N979SW\\, no WiFi)");
    expect(none).not.toMatch(/None WiFi/);
    expect(icsLines(none).join("")).toContain("UA2806");
    // Alternatives are served up to a day out, so the feed must not claim "today".
    expect(icsLines(none).join("")).toContain("on this route that day");
    expect(icsLines(none).join("")).not.toContain("on this route today");
  });

  test("swap: 'Swapped:' prefix and SEQUENCE bumps with each new tail", () => {
    const one = buildWatchIcs({
      ...base,
      ...leg,
      verdict: { state: "yes", tail: "N37502", aircraft: null, confidence: "verified" },
      history: [row("N37502", 1_789_900_000)],
    });
    const swapped = buildWatchIcs({
      ...base,
      ...leg,
      verdict: { state: "no", tail: "N16709", aircraft: null, wifi: "Thales" },
      history: [row("N37502", 1_789_900_000), row("N16709", 1_789_950_000)],
    });
    expectWellFormedIcs(swapped);
    expect(prop(one, "SUMMARY")).not.toStartWith("Swapped: ");
    expect(prop(swapped, "SUMMARY")).toStartWith("Swapped: UA123 · No Starlink");
    expect(Number(prop(swapped, "SEQUENCE"))).toBeGreaterThan(Number(prop(one, "SEQUENCE")));
    expect(prop(swapped, "UID")).toBe(prop(one, "UID"));
  });

  test("tails on another leg of the same flight number are not a swap", () => {
    const summary = watchSummary({
      ...base,
      ...leg,
      verdict: { state: "yes", tail: "N37502", aircraft: null, confidence: "verified" },
      history: [row("N37502", 1), { ...row("N11111", 2), departure_airport: "EWR" }],
    });
    expect(summary).not.toStartWith("Swapped: ");
  });

  test("escaping and folding", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    const folded = foldIcsLine(`SUMMARY:${"✅".repeat(60)}`);
    for (const l of folded.split("\r\n"))
      expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"✅".repeat(60)}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route against the snapshot (shape only)
// ─────────────────────────────────────────────────────────────────────────────

describe("/cal/{fn}/{date}.ics", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp(openSnapshot());
  });

  test("snapshot flight: 200 text/calendar, one well-formed event", async () => {
    const res = await app.dispatch(req(`/cal/UA100/${isoDaysFromNow(20)}.ics`, UA_HOST));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/calendar");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("max-age=900");
    expectWellFormedIcs(await res.text());
  });

  test("extensionless path and a spaced/dashed flight number resolve to the same UID", async () => {
    const date = isoDaysFromNow(20);
    const a = await bodyOf(app, `/cal/UA100/${date}`, UA_HOST);
    const b = await bodyOf(app, `/cal/ua%20100/${date}.ics`, UA_HOST);
    const c = await bodyOf(app, `/cal/UA-100/${date}.ics`, UA_HOST);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(prop(b.text, "UID")).toBe(prop(a.text, "UID"));
    expect(prop(c.text, "UID")).toBe(prop(a.text, "UID"));
  });

  test.each([
    ["other carrier", `/cal/DL123/${isoDaysFromNow(5)}.ics`],
    ["5-digit number", `/cal/UA12345/${isoDaysFromNow(5)}.ics`],
    ["not a date", "/cal/UA100/tomorrow.ics"],
    ["impossible date", "/cal/UA100/2026-02-30.ics"],
    ["too far out", `/cal/UA100/${isoDaysFromNow(400)}.ics`],
    ["too far past", `/cal/UA100/${isoDaysFromNow(-5)}.ics`],
    ["extra segment", `/cal/UA100/${isoDaysFromNow(5)}/x`],
  ])("404 on %s", async (_label, path) => {
    const res = await app.dispatch(req(path, UA_HOST));
    expect(res.status).toBe(404);
  });

  test("hub and Qatar hosts 404", async () => {
    const date = isoDaysFromNow(5);
    expect((await app.dispatch(req(`/cal/UA100/${date}.ics`, HUB_HOST))).status).toBe(404);
    expect((await app.dispatch(req(`/cal/QR1/${date}.ics`, QR_HOST))).status).toBe(404);
  });

  test("check-flight page ships the Watch row with compiled-class literals only", async () => {
    const { status, text } = await bodyOf(app, "/check-flight", UA_HOST);
    expect(status).toBe(200);
    expect(text).toContain("Watch this flight");
    expect(text).toContain("webcal://");
    expect(text).toContain("var WATCH_ENABLED = true");
    expect(text).not.toContain("Last verified");
  });

  test("check-flight page dates alternative links and never labels them 'today'", async () => {
    const { text } = await bodyOf(app, "/check-flight", UA_HOST);
    // A dateless permalink pre-fills the viewer's today, answering a different departure.
    expect(text).toContain("encodeURIComponent(a.flight_number) + '/' + encodeURIComponent(date)");
    expect(text).toContain("alternativesHtml(data.sameDayAlternatives, date,");
    expect(text).not.toMatch(/on this route today/);
  });
});

describe("/api/check-flight stays additive", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp(openSnapshot());
    setAssignmentFetcher(async () => []);
  });
  afterAll(() => setAssignmentFetcher(null));

  test.each([["UA544"], ["UA5212"], ["UA1234"]])("%s: contract shape", async (fn) => {
    const body = await jsonOf(
      app,
      `/api/check-flight?flight_number=${fn}&date=${isoDaysFromNow(0)}`,
      UA_HOST
    );
    expect(body.hasStarlink === null || typeof body.hasStarlink === "boolean").toBe(true);
    expect(Array.isArray(body.flights)).toBe(true);
    expect(body.sameDayAlternatives === undefined || Array.isArray(body.sameDayAlternatives)).toBe(
      true
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write path + alternatives on a synthetic DB
// ─────────────────────────────────────────────────────────────────────────────

describe("assignment log and same-day alternatives (synthetic)", () => {
  // A local date at SFO whose 19:00Z/21:00Z departures are always in the future
  // and at most one UTC day out (so alternatives are in scope).
  const date = departureLocalDate("SFO", Math.floor(Date.now() / 1000) + 86400);
  const at = (hhmmZ: string) => Math.floor(Date.parse(`${date}T${hhmmZ}:00Z`) / 1000);
  const leg = (flight_number: string, departure_time: number, arrival_airport = "EWR") => ({
    flight_number,
    departure_airport: "SFO",
    arrival_airport,
    departure_time,
    arrival_time: departure_time + 5 * 3600,
  });

  beforeAll(() => setAssignmentFetcher(async () => []));
  afterAll(() => setAssignmentFetcher(null));

  test("a second tail on the leg makes the feed say Swapped and bumps SEQUENCE", async () => {
    const db = makeSyntheticDb();
    addPlane(db, "N11111", "Starlink");
    addPlane(db, "N22222", "Thales");
    updateFlights(db, "N11111", [leg("UA123", at("19:00"))]);
    db.query("UPDATE flight_assignment_log SET first_seen = first_seen - 3600").run();
    const app = createApp(db);

    const before = await bodyOf(app, `/cal/UA123/${date}.ics`, UA_HOST);
    expect(prop(before.text, "SUMMARY")).toStartWith("UA123 SFO→EWR · Starlink ✅ N11111");

    updateFlights(db, "N22222", [leg("UA123", at("19:00"))]);
    updateFlights(db, "N11111", []);
    const after = await bodyOf(app, `/cal/UA123/${date}.ics`, UA_HOST);
    expectWellFormedIcs(after.text);
    expect(prop(after.text, "SUMMARY")).toBe("Swapped: UA123 · No Starlink (N22222\\, Thales)");
    expect(Number(prop(after.text, "SEQUENCE"))).toBe(2);

    const rows = db.query("SELECT tail_number, starlink FROM flight_assignment_log").all();
    expect(rows).toEqual(
      expect.arrayContaining([
        { tail_number: "N11111", starlink: 1 },
        { tail_number: "N22222", starlink: 0 },
      ])
    );
  });

  test("settled negative outranks the sheet in the log's starlink flag", () => {
    const db = makeSyntheticDb();
    addPlane(db, "N33333", null);
    addFleet(db, "N33333", "negative", { verifiedWifi: "None" });
    updateFlights(db, "N33333", [leg("UA9", at("19:00"))]);
    expect(db.query("SELECT starlink FROM flight_assignment_log").get()).toEqual({ starlink: 0 });
  });

  test("rows older than the retention window are pruned on the next refresh", () => {
    const db = makeSyntheticDb();
    addPlane(db, "N44444", "Starlink");
    db.query(
      `INSERT INTO flight_assignment_log (airline, flight_number, dep_date, departure_airport, tail_number, first_seen, last_seen)
       VALUES ('UA', 'UA1', '2020-01-01', 'SFO', 'N44444', 1, 1)`
    ).run();
    updateFlights(db, "N44444", [leg("UA2", at("19:00"))]);
    const dates = db.query("SELECT dep_date FROM flight_assignment_log").all() as {
      dep_date: string;
    }[];
    expect(dates.map((d) => d.dep_date)).toEqual([date]);
  });

  test("firm no carries same-day Starlink alternatives, tenant-scoped and callsign-free", async () => {
    const db = makeSyntheticDb();
    addPlane(db, "N50000", "Thales");
    addPlane(db, "N50001", "Starlink");
    addPlane(db, "N50002", "Starlink");
    addPlane(db, "N50003", "Starlink", { airline: "AS" });
    addPlane(db, "N50004", "Viasat");
    updateFlights(db, "N50000", [leg("UA200", at("19:00"))]);
    updateFlights(db, "N50001", [leg("SKW5300", at("21:00"))]);
    updateFlights(db, "N50002", [leg("SKW485Y", at("22:00")), leg("UA400", at("19:30"), "ORD")]);
    updateFlights(db, "N50003", [leg("OO5301", at("20:00"))]);
    updateFlights(db, "N50004", [leg("UA600", at("20:30"))]);
    const app = createApp(db);

    const body = await jsonOf(app, `/api/check-flight?flight_number=UA200&date=${date}`, UA_HOST);
    expect(body.hasStarlink).toBe(false);
    expect(body.flights).toEqual([]);
    expect(body.sameDayAlternatives.map((a: { flight_number: string }) => a.flight_number)).toEqual(
      ["UA5300"]
    );

    const far = await jsonOf(
      app,
      `/api/check-flight?flight_number=UA200&date=${isoDaysFromNow(30)}`,
      UA_HOST
    );
    expect(far.sameDayAlternatives).toBeUndefined();

    const ics = await bodyOf(app, `/cal/UA200/${date}.ics`, UA_HOST);
    expect(icsLines(ics.text).join("")).toContain("UA5300");
  });
});
