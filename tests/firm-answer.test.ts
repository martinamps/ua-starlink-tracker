/**
 * The undated flight page opens with the next assigned departure's settled
 * answer when our rows hold one, and with odds when they don't. Assistants
 * quote the opening sentence alone, so each case reads the first paragraph
 * under the H1 and nothing else.
 */

import { describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { Fr24UnavailableError } from "../src/api/flightradar24-api";
import { createApp } from "../src/server/app";
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
  return { status: res.status, html, opening: paragraphs[0] ?? "", rest: paragraphs.slice(1) };
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
