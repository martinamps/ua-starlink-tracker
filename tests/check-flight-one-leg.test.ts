/**
 * An undated flight page for a number that flies two legs: the title, the
 * description, the share picture and the opening answer all name one leg.
 * The route history ranks IAH → SFO first, while the next departure is
 * SFO → IAH; the page used to title the one and answer for the other.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { updateFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import { addPlane, bodyOf, makeSyntheticDb } from "./helpers";

const UA_HOST = "unitedstarlinktracker.com";
const FN = "UA1777";

const title = (html: string) => html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
const meta = (html: string, name: string) =>
  html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`))?.[1] ?? "";
/** The opening answer's airports: "from X to Y" in the lead. */
const leadLeg = (html: string) => html.match(/flight UA\d+ from ([A-Z]{3}) to ([A-Z]{3}) on /);
const titleLeg = (s: string) => s.match(/\(([A-Z]{3}) → ([A-Z]{3})\)/);
const descriptionLeg = (s: string) => s.match(/UA\d+ ([A-Z]{3})–([A-Z]{3}) on /);

describe("undated flight page names one leg (synthetic)", () => {
  const now = Math.floor(Date.now() / 1000);
  const leg = (from: string, to: string, departure_time: number) => ({
    flight_number: FN,
    departure_airport: from,
    arrival_airport: to,
    departure_time,
    arrival_time: departure_time + 4 * 3600,
  });

  function seed(firstLegNext: boolean) {
    const db = makeSyntheticDb();
    addPlane(db, "N11111", "Starlink");
    addPlane(db, "N22222", "Thales");
    const soon = now + 3 * 3600;
    const later = now + 9 * 3600;
    // SFO → IAH leaves first on N11111; IAH → SFO later on N22222.
    updateFlights(db, "N11111", [leg("SFO", "IAH", firstLegNext ? soon : later)]);
    updateFlights(db, "N22222", [leg("IAH", "SFO", firstLegNext ? later : soon)]);
    // The history has seen IAH → SFO far more, so it ranks first among routes.
    db.query(
      `INSERT OR REPLACE INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
       VALUES (?, 'IAH', 'SFO', 14400, ?, ?, 40), (?, 'SFO', 'IAH', 14400, ?, ?, 2)`
    ).run(FN, now - 90 * 86400, now - 3600, FN, now - 90 * 86400, now - 3600);
    return createApp(db);
  }

  let nextIsMinor: ReturnType<typeof createApp>;
  let nextIsMajor: ReturnType<typeof createApp>;
  beforeAll(() => {
    setAssignmentFetcher(async () => []);
    nextIsMinor = seed(true);
    nextIsMajor = seed(false);
  });
  afterAll(() => setAssignmentFetcher(null));

  const lines = async (app: ReturnType<typeof createApp>, path = `/check-flight/${FN}`) => {
    const { status, text } = await bodyOf(app, path, UA_HOST);
    expect(status).toBe(200);
    return {
      text,
      title: title(text),
      ogTitle: meta(text, "og:title"),
      description: meta(text, "description"),
      ogDescription: meta(text, "og:description"),
      ogImage: meta(text, "og:image"),
    };
  };

  for (const [name, app] of [
    ["the next departure flies the less-seen leg", () => nextIsMinor],
    ["the next departure flies the most-seen leg", () => nextIsMajor],
  ] as const) {
    test(`${name}: title, description and answer agree`, async () => {
      const page = await lines(app());
      const fromTitle = titleLeg(page.title);
      const fromLead = leadLeg(page.text);
      const fromDescription = descriptionLeg(page.description);
      expect(fromTitle).not.toBeNull();
      expect(fromLead).not.toBeNull();
      expect(fromDescription).not.toBeNull();
      const pair = (m: RegExpMatchArray | null) => `${m?.[1]}-${m?.[2]}`;
      expect(pair(fromLead)).toBe(pair(fromTitle));
      expect(pair(fromDescription)).toBe(pair(fromTitle));
      expect(page.ogTitle).toBe(page.title);
      expect(page.ogDescription).toBe(page.description);
      // The Flight JSON-LD names the same airports.
      const ld = page.text.match(
        /"departureAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\},"arrivalAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\}/
      );
      expect(pair(ld)).toBe(pair(fromTitle));
    });
  }

  test("the page opens on the soonest departure, and its title follows", async () => {
    expect(titleLeg((await lines(nextIsMinor)).title)?.slice(1)).toEqual(["SFO", "IAH"]);
    expect(titleLeg((await lines(nextIsMajor)).title)?.slice(1)).toEqual(["IAH", "SFO"]);
  });

  test("a leg-scoped page keeps its asked leg", async () => {
    for (const app of [nextIsMinor, nextIsMajor]) {
      const page = await lines(app, `/check-flight/${FN}?origin=SFO&destination=IAH`);
      expect(titleLeg(page.title)?.slice(1)).toEqual(["SFO", "IAH"]);
      expect(leadLeg(page.text)?.slice(1)).toEqual(["SFO", "IAH"]);
    }
  });
});
