/**
 * The undated flight page opens with the next assigned departure's settled
 * answer when our rows hold one, and with odds when they don't. Assistants
 * quote the opening sentence alone, so each case reads the first paragraph
 * under the H1 and nothing else.
 */

import { describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { Fr24UnavailableError } from "../src/api/flightradar24-api";
import { firmDescription } from "../src/components/check-flight/firm-lead";
import type { AssignedDeparture, FlightFacts } from "../src/components/check-flight/types";
import { clampMetaDescription, createApp } from "../src/server/app";
import { airportLocalDate } from "../src/utils/airport-tz";
import { addFleet, addFlight, addPlane, makeSyntheticDb, req } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const NOW = Math.floor(Date.now() / 1000);
const T = NOW + 6 * 3600;
const SEEN = NOW - 1800;
const FN = "UA5763";

type Db = ReturnType<typeof makeSyntheticDb>;

function verifiedTail(db: Db, tail: string) {
  addPlane(db, tail, "Starlink", { aircraft: "ERJ-175" });
  addFleet(db, tail, "confirmed", { aircraftType: "ERJ-175", verifiedWifi: "Starlink" });
}

function settledNoTail(db: Db, tail: string, wifi: string) {
  addPlane(db, tail, null, { aircraft: "ERJ-175" });
  addFleet(db, tail, "negative", { aircraftType: "ERJ-175", verifiedWifi: wifi });
}

async function page(db: Db, path = `/check-flight/${FN}`) {
  const res = await createApp(db).dispatch(req(path, UA_HOST));
  const html = (await res.text()).replace(/<!-- -->/g, "");
  const header = html.match(/<h1[^>]*>.*?<\/h1>(.*?)<\/header>/s)?.[1] ?? "";
  const paragraphs = [...header.matchAll(/<p[^>]*>(.*?)<\/p>/gs)].map((m) =>
    m[1].replace(/<[^>]+>/g, "")
  );
  const meta = (name: string) =>
    (html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`))?.[1] ?? "")
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&");
  return {
    status: res.status,
    html,
    opening: paragraphs[0] ?? "",
    rest: paragraphs.slice(1),
    description: meta("description"),
    ogDescription: meta("og:description"),
    keywords: meta("keywords"),
  };
}

const localYear = (airport: string, sec: number) =>
  (airportLocalDate(airport, sec) ?? "").slice(0, 4);

describe("flight page opening", () => {
  test("an assigned, verified Starlink aircraft opens the page with a yes that stands alone", async () => {
    const db = makeSyntheticDb();
    verifiedTail(db, "N601UX");
    addFlight(db, "N601UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const { status, opening, rest } = await page(db);
    expect(status).toBe(200);
    expect(opening).toMatch(/^Yes: as of [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} UTC, /);
    expect(opening).toContain(`United Airlines flight ${FN} from DEN to EWR on `);
    expect(opening).toContain(localYear("DEN", T));
    expect(opening).toMatch(/is assigned N601UX, an? .+ with Starlink Wi-Fi\.$/);
    expect(opening).not.toMatch(/odds|%/);
    expect(rest.join(" ")).toContain("Aircraft can be swapped before departure");
    db.close();
  });

  test("the caveat links the assigned departure's calendar offer, on the date its airport reads", async () => {
    const db = makeSyntheticDb();
    verifiedTail(db, "N601UX");
    addFlight(db, "N601UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const app = createApp(db);
    const { html, rest } = await page(db);
    const href = `/check-flight/${FN}/${airportLocalDate("DEN", T)}#flight-calendar`;
    expect(html).toContain(`href="${href}"`);
    expect(rest.join(" ")).toContain("Add this departure to your calendar");
    const target = await (await app.dispatch(req(href.split("#")[0], UA_HOST))).text();
    expect(target).toContain('id="flight-calendar"');
    db.close();
  });

  test("an assigned aircraft settled on another provider opens with a no that names it", async () => {
    const db = makeSyntheticDb();
    settledNoTail(db, "N602UX", "Panasonic");
    addFlight(db, "N602UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const { opening } = await page(db);
    expect(opening).toMatch(/^No: as of /);
    expect(opening).toMatch(/is assigned N602UX, an? .+ with Panasonic Wi-Fi, not Starlink\.$/);
    db.close();
  });

  test("a listed aircraft nobody has verified is a likely yes, and says so", async () => {
    const db = makeSyntheticDb();
    addPlane(db, "N603UX", null, { aircraft: "ERJ-175" });
    addFlight(db, "N603UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const { opening } = await page(db);
    expect(opening).toMatch(/^Likely yes: as of /);
    expect(opening).toContain("that we have not verified yet.");
    db.close();
  });

  test("with nothing assigned in the window the page opens with odds, naming the flight", async () => {
    const db = makeSyntheticDb();
    verifiedTail(db, "N601UX");
    addFlight(db, "N601UX", FN, "DEN", NOW + 96 * 3600, { arrivalAirport: "EWR" });
    const { status, opening, rest, html } = await page(db);
    expect(status).toBe(200);
    expect(opening).not.toMatch(/^(Yes|No|Likely yes): as of/);
    expect(opening).not.toContain("is assigned N");
    expect(opening).toContain(FN);
    expect(opening).toContain("A firm answer comes about 2 days before departure");
    expect(rest).toEqual([]);
    expect(html).not.toContain('id="assignment-caveat"');
    db.close();
  });

  test("a swap onto an aircraft we hold no status for falls back to odds", async () => {
    const db = makeSyntheticDb();
    verifiedTail(db, "N601UX");
    addFlight(db, "N601UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN - 3600 });
    addFlight(db, "N999ZZ", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const { opening } = await page(db);
    expect(opening).not.toContain("is assigned N");
    expect(opening).not.toContain("N601UX");
    db.close();
  });

  test("a swap onto a settled non-Starlink aircraft leads with the new aircraft's no", async () => {
    const db = makeSyntheticDb();
    verifiedTail(db, "N601UX");
    settledNoTail(db, "N602UX", "Viasat");
    addFlight(db, "N601UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN - 3600 });
    addFlight(db, "N602UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const { opening } = await page(db);
    expect(opening).toMatch(/^No: as of /);
    expect(opening).toContain("N602UX");
    expect(opening).not.toContain("N601UX");
    db.close();
  });

  test("several legs: the opening is the next departure's alone", async () => {
    const db = makeSyntheticDb();
    settledNoTail(db, "N602UX", "Panasonic");
    verifiedTail(db, "N601UX");
    addFlight(db, "N602UX", FN, "DEN", T, { arrivalAirport: "ORD", lastUpdated: SEEN });
    addFlight(db, "N601UX", FN, "ORD", T + 5 * 3600, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const { opening } = await page(db);
    expect(opening).toMatch(/^No: as of /);
    expect(opening).toContain("from DEN to ORD");
    expect(opening).not.toContain("EWR");
    expect(opening).not.toContain("N601UX");
    db.close();
  });

  test("the opening agrees with the dated lookup for the same departure", async () => {
    // The API's swap re-check would go to the network; the page never does.
    setAssignmentFetcher(async () => {
      throw new Fr24UnavailableError("stubbed");
    });
    const db = makeSyntheticDb();
    try {
      settledNoTail(db, "N602UX", "Panasonic");
      addFlight(db, "N602UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
      const date = airportLocalDate("DEN", T);
      const api = (await (
        await createApp(db).dispatch(
          req(`/api/check-flight?flight_number=${FN}&date=${date}`, UA_HOST, {
            headers: { "x-forwarded-for": "127.0.0.1" },
          })
        )
      ).json()) as { hasStarlink: boolean };
      const { opening } = await page(db);
      expect(api.hasStarlink).toBe(false);
      expect(opening).toMatch(/^No: /);
    } finally {
      setAssignmentFetcher(null);
      db.close();
    }
  });

  test("a dated page keeps its answer card and carries no second opening", async () => {
    const db = makeSyntheticDb();
    verifiedTail(db, "N601UX");
    addFlight(db, "N601UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const { html, opening } = await page(db, `/check-flight/${FN}/${airportLocalDate("DEN", T)}`);
    expect(html).toContain('id="flight-answer"');
    expect(opening).toBe("");
    db.close();
  });
});

// The search description is what a searcher reads before the page. Where the
// page opens with a firm answer it says that answer, in the opening's own
// words for the answer, the tail and the aircraft; where the page opens with
// odds it keeps them.
describe("flight page search description", () => {
  /** "is assigned N601UX, an E175 with Starlink Wi-Fi." */
  const assignedClause = (sentence: string) => sentence.match(/is assigned .*?\.(?= |$)/)?.[0];
  const answerWord = (sentence: string) => sentence.match(/^(Yes|No|Likely yes): /)?.[1];

  const cases: Array<[string, (db: Db) => void, string]> = [
    ["yes", (db) => verifiedTail(db, "N601UX"), "N601UX"],
    ["no", (db) => settledNoTail(db, "N602UX", "Panasonic"), "N602UX"],
    ["likely yes", (db) => addPlane(db, "N603UX", null, { aircraft: "ERJ-175" }), "N603UX"],
  ];

  test.each(cases)(
    "a firm %s opening is the description's answer too",
    async (_name, seed, tail) => {
      const db = makeSyntheticDb();
      seed(db);
      addFlight(db, tail, FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
      const { opening, description, ogDescription } = await page(db);
      expect(answerWord(opening)).toBeDefined();
      for (const said of [description, ogDescription]) {
        expect(answerWord(said)).toBe(answerWord(opening) as string);
        expect(assignedClause(said)).toBe(assignedClause(opening) as string);
        expect(said).toContain(` ${FN} DEN–EWR on `);
        expect(said).toMatch(/: as of [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} UTC, /);
        expect(said).toContain(localYear("DEN", T));
        expect(said).not.toMatch(/odds|%/);
        expect(said).not.toContain("…");
      }
      db.close();
    }
  );

  test("with nothing assigned the description keeps the odds the page opens with", async () => {
    const db = makeSyntheticDb();
    verifiedTail(db, "N601UX");
    addFlight(db, "N601UX", FN, "DEN", NOW + 96 * 3600, { arrivalAirport: "EWR" });
    const { opening, description } = await page(db);
    expect(opening).not.toMatch(/^(Yes|No|Likely yes): as of/);
    expect(description).toStartWith(`Does United Airlines ${FN}`);
    expect(description).not.toContain("is assigned");
    db.close();
  });

  test("a firm description stays inside the length odds descriptions are cut to, and adds no keyword", async () => {
    const firmDb = makeSyntheticDb();
    verifiedTail(firmDb, "N601UX");
    addFlight(firmDb, "N601UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const firm = await page(firmDb);
    firmDb.close();
    const oddsDb = makeSyntheticDb();
    verifiedTail(oddsDb, "N601UX");
    addFlight(oddsDb, "N601UX", FN, "DEN", NOW + 96 * 3600, { arrivalAirport: "EWR" });
    const odds = await page(oddsDb);
    oddsDb.close();
    // An odds description with a figure in it runs past 158 and is cut there.
    expect(firm.description.length).toBeLessThanOrEqual(158);
    expect(firm.keywords).toBe(odds.keywords);
    expect(firm.html.match(/<title>[^<]*<\/title>/)?.[0]).toBe(
      odds.html.match(/<title>[^<]*<\/title>/)?.[0] as string
    );
  });

  test("the longest wording still ends on its own full stop inside the limit", () => {
    const MAX = 158;
    const flight = { flightNumber: "UA5763", airlineName: "United Airlines" } as FlightFacts;
    const a: AssignedDeparture = {
      hasStarlink: true,
      verified: false,
      tail: "N37560",
      aircraft: "Boeing 737 MAX 10",
      wifi: null,
      origin: "DEN",
      destination: "EWR",
      departure: T,
      departureZone: "America/Denver",
      seenAt: SEEN,
    };
    const said = firmDescription(flight, a, MAX);
    expect(said.length).toBeLessThanOrEqual(MAX);
    expect(clampMetaDescription(said)).toBe(said);
    expect(said).toEndWith("that we have not verified yet.");
    expect(said).toMatch(/^Likely yes: as of [A-Z][a-z]{2} \d{1,2}, /);
    const short = firmDescription(flight, { ...a, verified: true, aircraft: "ERJ-175" }, MAX);
    expect(short).toEndWith("Aircraft can be swapped before departure.");
    expect(short.length).toBeLessThanOrEqual(MAX);
  });

  // Search keeps the undated page this canonicalizes to; a link shared in a
  // message, or fetched by an assistant for that day, shows the dated page's
  // own description, which gives that date's answer (dated-page-meta.test.ts).
  test("a dated page describes its own date, and still canonicalizes to the undated page", async () => {
    const db = makeSyntheticDb();
    verifiedTail(db, "N601UX");
    addFlight(db, "N601UX", FN, "DEN", T, { arrivalAirport: "EWR", lastUpdated: SEEN });
    const { html, description } = await page(
      db,
      `/check-flight/${FN}/${airportLocalDate("DEN", T)}`
    );
    expect(html).toContain(`rel="canonical" href="https://${UA_HOST}/check-flight/${FN}"`);
    expect(description).toStartWith(`Yes — ${FN} on `);
    expect(description).not.toContain("Pick a date");
    db.close();
  });
});
