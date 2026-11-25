/**
 * Starlink Watch: the per-flight calendar feed (/cal/{fn}/{date}.ics), the
 * assignment log behind its swap detection, and the same-day alternatives on
 * firm-no check-flight answers. Snapshot tests assert shapes only; the
 * synthetic-DB tests own their data and may assert values.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { renderFlightAnswer } from "../src/client/flight-answer";
import { departureLocalDate } from "../src/database/assignment-log";
import { archivePastDepartures, updateFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import {
  type WatchIcsInput,
  buildFlownWatchIcs,
  buildWatchIcs,
  escapeIcsText,
  flownConfirmed,
  flownDescription,
  flownSummary,
  foldIcsLine,
  watchSummary,
} from "../src/utils/ics";
import {
  addFleet,
  addPlane,
  bodyOf,
  jsonIsland,
  jsonOf,
  makeSyntheticDb,
  openSnapshot,
  req,
} from "./helpers";

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
    expect(prop(ics, "SUMMARY")).toMatch(/^UA123 · [<>]?\d+% chance of Starlink$/);
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
    ["too far past", `/cal/UA100/${isoDaysFromNow(-400)}.ics`],
    ["past date, flight number we have never seen", `/cal/UA4242/${isoDaysFromNow(-5)}.ics`],
    ["past impossible date", "/cal/UA100/2026-02-30.ics"],
    ["extra segment", `/cal/UA100/${isoDaysFromNow(5)}/x`],
  ])("404 on %s", async (_label, path) => {
    const res = await app.dispatch(req(path, UA_HOST));
    expect(res.status).toBe(404);
  });

  test("a known flight on a past date: 200 final calendar that says we hold no record", async () => {
    const date = isoDaysFromNow(-40);
    const res = await app.dispatch(req(`/cal/UA100/${date}.ics`, UA_HOST));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/calendar");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    const body = await res.text();
    expectWellFormedIcs(body);
    const live = await bodyOf(app, `/cal/UA100/${isoDaysFromNow(20)}.ics`, UA_HOST);
    expect(prop(body, "UID")).toBe(prop(live.text, "UID")?.replace(isoDaysFromNow(20), date));
    expect(prop(body, "SUMMARY")).toBe("Date passed: UA100 · no aircraft record");
    expect(icsLines(body).join("")).toContain("We hold no record of the aircraft");
    expect(icsLines(body)).toContain("REFRESH-INTERVAL;VALUE=DURATION:P7D");
    expect(icsLines(body)).toContain(`DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`);
  });

  test("the final calendar's link resolves", async () => {
    const body = (await bodyOf(app, `/cal/UA100/${isoDaysFromNow(-40)}.ics`, UA_HOST)).text;
    const url = new URL(prop(body, "URL") ?? "");
    expect(url.host).toBe(UA_HOST);
    expect((await app.dispatch(req(url.pathname + url.search, UA_HOST))).status).toBe(200);
  });

  test("hub and Qatar hosts 404 on past dates too", async () => {
    const date = isoDaysFromNow(-40);
    expect((await app.dispatch(req(`/cal/UA100/${date}.ics`, HUB_HOST))).status).toBe(404);
    expect((await app.dispatch(req(`/cal/QR1/${date}.ics`, QR_HOST))).status).toBe(404);
  });

  test("hub and Qatar hosts 404", async () => {
    const date = isoDaysFromNow(5);
    expect((await app.dispatch(req(`/cal/UA100/${date}.ics`, HUB_HOST))).status).toBe(404);
    expect((await app.dispatch(req(`/cal/QR1/${date}.ics`, QR_HOST))).status).toBe(404);
  });

  const answerCtx = (date: string, watchEnabled: boolean) => ({
    flightNumber: "UA100",
    date,
    daysOut: 5,
    nowSec: Math.floor(Date.now() / 1000),
    airlineName: "United Airlines",
    zoneFor: () => undefined,
    liveTv: null,
    watchEnabled,
    routePlannerEnabled: false,
    host: UA_HOST,
  });

  test("the answer card carries the Watch row only where the feed serves", async () => {
    const date = isoDaysFromNow(5);
    const body = { hasStarlink: null, prediction: { probability: 0.5 }, flights: [] };
    const on = renderFlightAnswer(body, answerCtx(date, true)).html;
    expect(on).toContain("Watch this flight");
    expect(on).toContain(`webcal://${UA_HOST}/cal/UA100/${date}.ics`);
    expect(renderFlightAnswer(body, answerCtx(date, false)).html).not.toContain("webcal://");
    const { text } = await bodyOf(app, `/check-flight/UA100/${date}`, UA_HOST);
    expect(jsonIsland(text, "check-flight-config").watchEnabled).toBe(true);
  });

  test("firm answers put the Watch row right under the swap caveat", () => {
    const date = isoDaysFromNow(1);
    const no = renderFlightAnswer(
      {
        hasStarlink: false,
        confidence: "verified",
        message: "UA100 is assigned to tail N1, verified as Viasat WiFi — not Starlink.",
        flights: [],
        sameDayAlternatives: [
          { flight_number: "UA200", departure_time: Date.now() / 1000, tail_number: "N2" },
        ],
      },
      answerCtx(date, true)
    ).html;
    const yes = renderFlightAnswer(
      { hasStarlink: true, confidence: "verified", flights: [{ tail_number: "N1" }] },
      answerCtx(date, true)
    ).html;
    for (const html of [no, yes]) {
      const caveat = html.indexOf("Aircraft can be swapped before departure.");
      expect(caveat).toBeGreaterThan(-1);
      expect(html.indexOf("Watch this flight")).toBeGreaterThan(caveat);
    }
    expect(no.indexOf("Watch this flight")).toBeLessThan(
      no.indexOf("Starlink flights on this route")
    );
  });

  test("alternative links carry the asked-about date and never say 'today'", () => {
    const date = isoDaysFromNow(1);
    const html = renderFlightAnswer(
      {
        hasStarlink: false,
        confidence: "verified",
        message: "UA100 is assigned to tail N1, verified as Viasat WiFi — not Starlink.",
        flights: [],
        sameDayAlternatives: [
          { flight_number: "UA200", departure_time: Date.now() / 1000, tail_number: "N2" },
        ],
      },
      answerCtx(date, false)
    ).html;
    expect(html).toContain(`href="/check-flight/UA200/${date}"`);
    expect(html).not.toMatch(/on this route today/);
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

  test("pruned rows move to the flown record, which trims at a year", () => {
    const db = makeSyntheticDb();
    const day = (n: number) => isoDaysFromNow(n);
    const ins = db.query(
      `INSERT INTO flight_assignment_log (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number, starlink, departure_time, arrival_time, first_seen, last_seen)
       VALUES ('UA', ?, ?, 'SFO', 'EWR', 'N44444', 1, 100, 200, 1, 2)`
    );
    ins.run("UA1", day(-3));
    ins.run("UA1", day(-30));
    ins.run("UA1", day(-500));
    archivePastDepartures(db);
    const live = db.query("SELECT dep_date FROM flight_assignment_log").all();
    expect(live).toEqual([{ dep_date: day(-3) }]);
    const flown = db.query("SELECT * FROM flown_assignments").all();
    expect(flown).toEqual([
      {
        airline: "UA",
        flight_number: "UA1",
        dep_date: day(-30),
        departure_airport: "SFO",
        arrival_airport: "EWR",
        tail_number: "N44444",
        starlink: 1,
        departure_time: 100,
        arrival_time: 200,
        first_seen: 1,
        last_seen: 2,
      },
    ]);
    // A second pass neither duplicates nor drops it.
    archivePastDepartures(db);
    expect(db.query("SELECT COUNT(*) AS n FROM flown_assignments").get()).toEqual({ n: 1 });
  });

  test("rows older than the retention window are pruned by the archive pass", () => {
    const db = makeSyntheticDb();
    addPlane(db, "N44444", "Starlink");
    db.query(
      `INSERT INTO flight_assignment_log (airline, flight_number, dep_date, departure_airport, tail_number, first_seen, last_seen)
       VALUES ('UA', 'UA1', '2020-01-01', 'SFO', 'N44444', 1, 1)`
    ).run();
    updateFlights(db, "N44444", [leg("UA2", at("19:00"))]);
    // A refresh only archives; the trim rides the 5-minute global pass.
    expect(db.query("SELECT COUNT(*) AS n FROM flight_assignment_log").get()).toEqual({ n: 2 });
    archivePastDepartures(db);
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

describe("feed agrees with check-flight without its own FR24 call (synthetic)", () => {
  // UA675 on 2026-09-20: DEN→ORD then ORD→MSP, both on untracked Viasat tails
  // that only FR24 names, after a tracked Starlink tail left the second leg.
  const date = departureLocalDate("DEN", Math.floor(Date.now() / 1000) + 86400);
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const denDep = at(`${date}T20:50:00Z`);
  const ordDep = denDep + 4 * 3600 + 24 * 60;
  const fr24Legs = [
    {
      origin: "DEN",
      destination: "ORD",
      departure_time: denDep,
      arrival_time: denDep + 9720,
      tail_number: "N14502",
      aircraft_model: "Airbus A321-271NX",
    },
    {
      origin: "ORD",
      destination: "MSP",
      departure_time: ordDep,
      arrival_time: ordDep + 5880,
      tail_number: "N36476",
      aircraft_model: "Boeing 737-924(ER)",
    },
  ];
  const leg = (
    flight_number: string,
    departure_airport: string,
    arrival_airport: string,
    departure_time: number
  ) => ({
    flight_number,
    departure_airport,
    arrival_airport,
    departure_time,
    arrival_time: departure_time + 3 * 3600,
  });
  let fr24Calls = 0;

  function seed() {
    const db = makeSyntheticDb();
    const now = Math.floor(Date.now() / 1000);
    addPlane(db, "N64809", "Starlink");
    addPlane(db, "N64572", "Starlink");
    addFleet(db, "N14502", "negative", { verifiedWifi: "Viasat", verifiedAt: now });
    addFleet(db, "N36476", "negative", { verifiedWifi: "Viasat", verifiedAt: now });
    updateFlights(db, "N64809", [leg("UA675", "ORD", "MSP", ordDep)]);
    updateFlights(db, "N64809", []);
    updateFlights(db, "N64572", [leg("UA1050", "DEN", "ORD", denDep + 3 * 3600)]);
    return db;
  }

  beforeAll(() =>
    setAssignmentFetcher(async () => {
      fr24Calls++;
      return fr24Legs;
    })
  );
  afterAll(() => setAssignmentFetcher(null));

  test("a firm no on the page is a firm no in the feed, on the first leg, with alternatives", async () => {
    const app = createApp(seed());
    const api = await jsonOf(app, `/api/check-flight?flight_number=UA675&date=${date}`, UA_HOST);
    expect(api.hasStarlink).toBe(false);
    expect(api.sameDayAlternatives.length).toBeGreaterThan(0);

    const callsBefore = fr24Calls;
    const ics = await bodyOf(app, `/cal/UA675/${date}.ics`, UA_HOST);
    expect(fr24Calls).toBe(callsBefore);
    expectWellFormedIcs(ics.text);
    const text = icsLines(ics.text).join("");
    expect(prop(ics.text, "SUMMARY")).toBe("UA675 · No Starlink (N14502\\, Viasat)");
    expect(prop(ics.text, "DTSTART")).toBe(
      `${new Date(denDep * 1000).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`
    );
    expect(text).not.toContain("odds");
    expect(text).not.toContain("No aircraft assigned yet");
    expect(text).toContain("UA1050");
  });

  test("with nothing resolved yet: first leg, and a tail that moved off is not 'no aircraft assigned'", async () => {
    setAssignmentFetcher(async () => {
      throw new Error("the feed must not call FR24");
    });
    const db = seed();
    addPlane(db, "N11111", "Starlink");
    updateFlights(db, "N11111", [leg("UA675", "DEN", "ORD", denDep)]);
    updateFlights(db, "N11111", []);
    db.query(
      "UPDATE flight_assignment_log SET last_seen = last_seen - 600 WHERE departure_airport = 'DEN'"
    ).run();
    const ics = await bodyOf(createApp(db), `/cal/UA675/${date}.ics`, UA_HOST);
    expectWellFormedIcs(ics.text);
    expect(prop(ics.text, "SUMMARY")).not.toContain("N64809");
    expect(prop(ics.text, "DTSTART")).toBe(
      `${new Date(denDep * 1000).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`
    );
    expect(icsLines(ics.text).join("")).not.toContain("No aircraft assigned yet");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flown flights: the final calendar (synthetic)
// ─────────────────────────────────────────────────────────────────────────────

describe("a past-dated feed answers from the stored record alone (synthetic)", () => {
  const dep = (date: string) => Math.floor(Date.parse(`${date}T19:00:00Z`) / 1000);
  const logRow = (
    db: ReturnType<typeof makeSyntheticDb>,
    table: "flight_assignment_log" | "flown_assignments",
    date: string,
    tail: string,
    starlink: number | null,
    seen: { first: number; last: number },
    fn = "UA123"
  ) =>
    db
      .query(
        `INSERT INTO ${table} (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number, starlink, departure_time, arrival_time, first_seen, last_seen)
         VALUES ('UA', ?, ?, 'SFO', 'EWR', ?, ?, ?, ?, ?, ?)`
      )
      .run(fn, date, tail, starlink, dep(date), dep(date) + 5 * 3600, seen.first, seen.last);

  // No fetcher is installed: a live lookup on this path would throw the test.
  beforeAll(() =>
    setAssignmentFetcher(async () => {
      throw new Error("a past-dated feed must not look anything up");
    })
  );
  afterAll(() => setAssignmentFetcher(null));

  test("three days past, still in the log: flown, with the aircraft and its stored flag", async () => {
    const db = makeSyntheticDb();
    const date = isoDaysFromNow(-3);
    logRow(db, "flight_assignment_log", date, "N11111", 1, {
      first: dep(date) - 90000,
      last: dep(date),
    });
    const { status, text: body } = await bodyOf(createApp(db), `/cal/UA123/${date}.ics`, UA_HOST);
    expect(status).toBe(200);
    expectWellFormedIcs(body);
    expect(prop(body, "UID")).toBe(`UA123-${date}@${UA_HOST}`);
    expect(prop(body, "SUMMARY")).toBe("Flown: UA123 SFO→EWR · Starlink ✅ N11111");
    expect(prop(body, "DTSTART")).toMatch(/^\d{8}T190000Z$/);
    expect(icsLines(body).join("")).toContain("Last aircraft we saw assigned: N11111");
    expect(icsLines(body)).toContain("X-PUBLISHED-TTL:P7D");
  });

  test("the stored flag is what counts, not today's fleet listing", async () => {
    const db = makeSyntheticDb();
    const date = isoDaysFromNow(-60);
    // Listed with Starlink today; the row stored at the time says it had none.
    addPlane(db, "N22222", "Starlink");
    logRow(db, "flown_assignments", date, "N22222", 0, {
      first: dep(date) - 90000,
      last: dep(date) - 3600,
    });
    const { status, text: body } = await bodyOf(createApp(db), `/cal/UA123/${date}.ics`, UA_HOST);
    expect(status).toBe(200);
    expect(prop(body, "SUMMARY")).toBe("Flown: UA123 · No Starlink (N22222)");
    expect(icsLines(body).join("")).toContain("it was not a Starlink aircraft at the time");
  });

  test("after a swap the last aircraft seen is the one named, and the history lists both", async () => {
    const db = makeSyntheticDb();
    const date = isoDaysFromNow(-60);
    logRow(db, "flown_assignments", date, "N11111", 1, {
      first: dep(date) - 90000,
      last: dep(date) - 40000,
    });
    logRow(db, "flown_assignments", date, "N33333", null, {
      first: dep(date) - 30000,
      last: dep(date) - 1800,
    });
    const body = (await bodyOf(createApp(db), `/cal/UA123/${date}.ics`, UA_HOST)).text;
    expect(prop(body, "SUMMARY")).toBe("Flown: UA123 · N33333\\, Starlink not recorded");
    const flat = icsLines(body).join("");
    expect(flat).toContain("N11111 first seen assigned");
    expect(flat).toContain("N33333 first seen assigned");
    expect(flat).toContain("we stored no Starlink status for it");
  });

  // The reviewer's rows: a Starlink tail seen assigned from 60 to 30 hours
  // before departure, then no more. The live feed says "Current aircraft not
  // confirmed" for them; the final one may not turn that into a flown aircraft.
  test("a tail that went quiet 30 hours before departure is named, never as flown", async () => {
    const date = isoDaysFromNow(-3);
    for (const [table, starlink] of [
      ["flight_assignment_log", 1],
      ["flown_assignments", 0],
    ] as const) {
      const db = makeSyntheticDb();
      logRow(db, table, date, "N24508", starlink, {
        first: dep(date) - 60 * 3600,
        last: dep(date) - 30 * 3600,
      });
      const { status, text: body } = await bodyOf(createApp(db), `/cal/UA123/${date}.ics`, UA_HOST);
      expect(status).toBe(200);
      expectWellFormedIcs(body);
      const summary = prop(body, "SUMMARY")!;
      expect(summary).toBe(
        "Date passed: UA123 · aircraft not confirmed (last seen assigned: N24508)"
      );
      expect(summary).not.toMatch(/Flown|Starlink|✅/);
      const flat = icsLines(body).join("");
      expect(flat).toContain("We could not confirm which aircraft flew it");
      expect(flat).toContain(
        "Last aircraft we saw assigned: N24508\\, about 30 hours before departure"
      );
      expect(flat).toContain("Another aircraft may have flown the flight.");
    }
  });

  test("confirmed is the six hours before departure, and needs a departure time", () => {
    const row = {
      airline: "UA",
      flight_number: "UA123",
      dep_date: "2026-10-01",
      departure_airport: "SFO",
      arrival_airport: "EWR",
      tail_number: "N24508",
      starlink: 1,
      departure_time: 1_790_870_400 as number | null,
      arrival_time: 1_790_890_000,
      first_seen: 1_790_700_000,
      last_seen: 1_790_870_400 - 6 * 3600,
    };
    expect(flownConfirmed(row)).toBe(true);
    expect(flownSummary("UA123", row)).toBe("Flown: UA123 SFO→EWR · Starlink ✅ N24508");
    const quiet = { ...row, last_seen: row.last_seen - 1 };
    expect(flownConfirmed(quiet)).toBe(false);
    expect(flownSummary("UA123", quiet)).toContain("aircraft not confirmed");
    expect(flownConfirmed({ ...row, departure_time: null })).toBe(false);
    // Five days quiet reads in days, and the swap line holds for a no as well.
    const lines = flownDescription({
      canonicalHost: UA_HOST,
      fn: "UA123",
      date: "2026-10-01",
      history: [{ ...row, starlink: 0, last_seen: 1_790_870_400 - 5 * 86400 }],
      now: 1_791_200_000,
    });
    expect(lines.join(" ")).toContain(
      "N24508, about 5 days before departure; it was not a Starlink"
    );
  });

  test("a known number with no row for the date: 200 and no claim; an unknown number: 404", async () => {
    const db = makeSyntheticDb();
    const date = isoDaysFromNow(-60);
    logRow(db, "flown_assignments", isoDaysFromNow(-90), "N11111", 1, { first: 10, last: 20 });
    const app = createApp(db);
    const known = await bodyOf(app, `/cal/UA123/${date}.ics`, UA_HOST);
    expect(known.status).toBe(200);
    expect(prop(known.text, "SUMMARY")).toBe("Date passed: UA123 · no aircraft record");
    expect(known.text).not.toContain("N11111");
    expect((await app.dispatch(req(`/cal/UA124/${date}.ics`, UA_HOST))).status).toBe(404);
    // Another airline's row for the same digits does not make the number known here.
    expect(
      (await app.dispatch(req(`/cal/AS123/${date}.ics`, "alaskastarlinktracker.com"))).status
    ).toBe(404);
  });

  test("the final SEQUENCE and LAST-MODIFIED outrank anything the live feed sent", () => {
    const row = {
      airline: "UA",
      flight_number: "UA123",
      dep_date: "2026-10-01",
      departure_airport: "SFO",
      arrival_airport: "EWR",
      tail_number: "N37502",
      starlink: 1,
      departure_time: 1_790_870_400,
      arrival_time: 1_790_890_000,
      first_seen: 1_790_700_000,
      last_seen: 1_790_870_000,
    };
    const input = { canonicalHost: UA_HOST, fn: "UA123", date: "2026-10-01" };
    const live = buildWatchIcs({
      ...input,
      verdict: { state: "yes", tail: "N37502", aircraft: null, confidence: "verified" },
      history: [row],
      alternatives: [],
      dep: "SFO",
      arr: "EWR",
      depUnix: row.departure_time,
      arrUnix: row.arrival_time,
      now: 1_790_950_000,
    });
    const flownA = buildFlownWatchIcs({ ...input, history: [row], now: 1_791_200_000 });
    const flownB = buildFlownWatchIcs({ ...input, history: [row], now: 1_795_000_000 });
    expectWellFormedIcs(flownA);
    expect(prop(flownA, "UID")).toBe(prop(live, "UID"));
    expect(prop(flownA, "DTSTART")).toBe(prop(live, "DTSTART"));
    expect(Number(prop(flownA, "SEQUENCE"))).toBeGreaterThan(Number(prop(live, "SEQUENCE")));
    expect(prop(flownA, "LAST-MODIFIED")! > prop(live, "LAST-MODIFIED")!).toBe(true);
    // Only DTSTAMP moves between polls of a final calendar.
    const stable = (ics: string) => icsLines(ics).filter((l) => !l.startsWith("DTSTAMP:"));
    expect(stable(flownB)).toEqual(stable(flownA));
  });
});
