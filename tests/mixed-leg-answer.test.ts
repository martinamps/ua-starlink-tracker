/**
 * A dated flight page with no leg chosen, on a day its yes holds for only
 * some of the number's legs: the other leg flies a plane without Starlink, or
 * we hold no plane for it. The page answered a bare "Yes" with one plane and
 * no leg, so a traveller on the other leg read a yes that wasn't theirs. It
 * now names the legs its answer is for and says what we hold of the others.
 *
 * Seeded on a fresh database: no outside request is made.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import {
  type AnswerContext,
  type DayLeg,
  inTravelOrder,
  renderFlightAnswer,
  unansweredLegs,
} from "../src/client/flight-answer";
import { logFlightAssignments } from "../src/database/assignment-log";
import { createApp } from "../src/server/app";
import {
  addFleet,
  addFlight,
  addPlane,
  jsonIsland,
  jsonOf,
  makeFreshDb,
  readableText,
  req,
} from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
// Tomorrow by UTC; 15:00Z to 23:00Z fall on that same date at every US airport.
const DATE = isoDay(now + DAY);
const at = (hourUtc: number) => Math.floor(Date.parse(`${DATE}T00:00:00Z`) / 1000) + hourUtc * HOUR;

let db: Database;
let app: ReturnType<typeof createApp>;

function addStarlink(tail: string) {
  addPlane(db, tail, "Starlink", { aircraft: "Boeing 737-900" });
  addFleet(db, tail, "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
}

function addRoute(fn: string, origin: string, destination: string, seen: number, lastSeen: number) {
  db.query(
    `INSERT OR REPLACE INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, ?, ?, 10800, ?, ?, ?)`
  ).run(fn, origin, destination, now - 200 * DAY, lastSeen, seen);
}

/** A leg an earlier lookup found on a plane we hold no schedule for. */
function addLogged(tail: string, fn: string, origin: string, destination: string, hour: number) {
  logFlightAssignments(
    db,
    "UA",
    tail,
    [
      {
        flight_number: fn,
        departure_airport: origin,
        arrival_airport: destination,
        departure_time: at(hour),
        arrival_time: at(hour) + 3 * HOUR,
      },
    ],
    now - HOUR
  );
}

beforeAll(() => {
  setAssignmentFetcher(async () => []);
  db = makeFreshDb();
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  for (const tail of ["N1YES", "N2YES", "N3YES", "N4YES", "N5YES", "N6YES", "N7YES", "N8YES"]) {
    addStarlink(tail);
  }
  addStarlink("N8TWO");
  addFleet(db, "N1NO", "negative", { verifiedWifi: "Viasat", verifiedAt: now - DAY });

  // UA403, as live on 27 Nov: FLL → ORD on a Starlink plane, and the number
  // also flies DEN → FLL, for which we hold no plane.
  addFlight(db, "N1YES", "UA403", "FLL", at(21), { arrivalAirport: "ORD" });
  addRoute("UA403", "FLL", "ORD", 1051, now - HOUR);
  addRoute("UA403", "DEN", "FLL", 77, now - DAY);
  // Old routings of the number, one of which would connect (ORD → TUL).
  addRoute("UA403", "ORD", "TUL", 176, now - 150 * DAY);
  addRoute("UA403", "MCI", "ORD", 14, now - 60 * DAY);

  // UA1700: the second leg is logged on a plane checked and found without Starlink.
  addFlight(db, "N2YES", "UA1700", "ORD", at(15), { arrivalAirport: "FLL" });
  addLogged("N1NO", "UA1700", "FLL", "IAD", 19);
  addRoute("UA1700", "ORD", "FLL", 40, now - HOUR);
  addRoute("UA1700", "FLL", "IAD", 38, now - HOUR);

  // UA1710: the second leg is logged on a plane we have never checked.
  addFlight(db, "N3YES", "UA1710", "ORD", at(15), { arrivalAirport: "FLL" });
  addLogged("N77UNK", "UA1710", "FLL", "IAD", 19);
  addRoute("UA1710", "ORD", "FLL", 40, now - HOUR);

  // UA1720: one leg, with a recent route that does not connect (another day's routing).
  addFlight(db, "N4YES", "UA1720", "DEN", at(15), { arrivalAirport: "ORD" });
  addRoute("UA1720", "DEN", "ORD", 40, now - HOUR);
  addRoute("UA1720", "SFO", "EWR", 12, now - 2 * DAY);

  // UA1730: both legs on Starlink planes; the yes covers the day.
  addFlight(db, "N5YES", "UA1730", "ORD", at(15), { arrivalAirport: "FLL" });
  addFlight(db, "N6YES", "UA1730", "FLL", at(19), { arrivalAirport: "IAD" });
  addRoute("UA1730", "ORD", "FLL", 40, now - HOUR);
  addRoute("UA1730", "FLL", "IAD", 38, now - HOUR);

  // UA1740: some days it arrives from DEN, others from IAD. One place, one leg.
  addFlight(db, "N7YES", "UA1740", "FLL", at(21), { arrivalAirport: "ORD" });
  addRoute("UA1740", "FLL", "ORD", 90, now - HOUR);
  addRoute("UA1740", "DEN", "FLL", 60, now - DAY);
  addRoute("UA1740", "IAD", "FLL", 20, now - 2 * DAY);

  // UA2000: one leg held twice that date, on two planes.
  addFlight(db, "N8YES", "UA2000", "ORD", at(15), { arrivalAirport: "FLL" });
  addFlight(db, "N8TWO", "UA2000", "ORD", at(21), { arrivalAirport: "FLL" });
  addRoute("UA2000", "ORD", "FLL", 40, now - HOUR);

  // AS1900 on Alaska's own site: the same card, from the same rule.
  addPlane(db, "N1ASYES", "Starlink", { airline: "AS", aircraft: "Embraer E175" });
  addFleet(db, "N1ASYES", "confirmed", {
    airline: "AS",
    verifiedWifi: "Starlink",
    verifiedAt: now - DAY,
    aircraftType: "Embraer E175",
  });
  addFlight(db, "N1ASYES", "AS1900", "SEA", at(17), { arrivalAirport: "PDX", airline: "AS" });
  addRoute("AS1900", "SEA", "PDX", 60, now - HOUR);
  addRoute("AS1900", "PDX", "SFO", 55, now - DAY);
  db.query("INSERT INTO meta (key, value) VALUES ('AS:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );

  app = createApp(db);
});
afterAll(() => setAssignmentFetcher(null));

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

async function page(path: string, host = UA) {
  const res = await app.dispatch(req(path, host));
  expect(res.status).toBe(200);
  const html = await res.text();
  const meta = (attr: string, name: string) =>
    decode(html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1] ?? "");
  return {
    html,
    title: decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""),
    description: meta("name", "description"),
    ogDescription: meta("property", "og:description"),
    imageAlt: meta("property", "og:image:alt"),
    // The card keeps a date on one line with a no-break space.
    heading: decode(html.match(/<h2 class="font-display[^>]*>(.*?)<\/h2>/)?.[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\u00a0/g, " "),
    tone: html.match(/data-tone="(\w+)"/)?.[1],
    text: readableText(html),
    flights: [
      ...html.matchAll(
        /"departureAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\},"arrivalAirport":\{"@type":"Airport","iataCode":"([A-Z]{3})"\}/g
      ),
    ].map((m) => `${m[1]}-${m[2]}`),
  };
}

describe("a dated page, no leg chosen, whose yes holds for one leg only", () => {
  test("the other leg has no plane on record: the answer names its leg and says so", async () => {
    const p = await page(`/check-flight/UA403/${DATE}`);
    const answer =
      /^UA403 on \w{3} \d{1,2} has Starlink on FLL → ORD \(N1YES, verified\); we have no aircraft for DEN → FLL yet$/;
    expect(p.heading).toMatch(answer);
    expect(p.imageAlt).toMatch(answer);
    expect(p.description).toBe(`${p.heading}. Aircraft can be swapped before departure.`);
    expect(p.ogDescription).toBe(p.description);
    // No surface opens with a yes that is true for one leg only.
    for (const line of [p.heading, p.description, p.imageAlt]) expect(line).not.toMatch(/^Yes/);
    expect(p.tone).toBe("partial");
    // The title asks about the date and names no leg: the page answers for both.
    expect(p.title).toMatch(/^Does UA403 on \w{3} \d{1,2} Have Starlink Wi-Fi\?$/);
  });

  test("the structured data lists both legs in travel order, and no stale routing", async () => {
    const p = await page(`/check-flight/UA403/${DATE}`);
    expect(p.flights).toEqual(["DEN-FLL", "FLL-ORD"]);
  });

  test("the card shows the other leg and links its own page", async () => {
    const p = await page(`/check-flight/UA403/${DATE}`);
    expect(p.text).toContain("The other leg that day");
    expect(p.text).toContain("Not known to us yet");
    expect(decode(p.html)).toContain(
      `href="/check-flight/UA403/${DATE}?origin=DEN&destination=FLL"`
    );
  });

  test("the other leg is on a plane found without Starlink: a plain no for that leg", async () => {
    const p = await page(`/check-flight/UA1700/${DATE}`);
    expect(p.heading).toMatch(
      /^UA1700 on \w{3} \d{1,2} has Starlink on ORD → FLL \(N2YES, verified\), not on FLL → IAD \(N1NO\)$/
    );
    expect(p.description).toStartWith(`${p.heading}. `);
    expect(p.text).toContain("No Starlink");
    expect(p.flights).toEqual(["ORD-FLL", "FLL-IAD"]);
  });

  test("the other leg is on a plane we never checked: it is named, and not called a no", async () => {
    const p = await page(`/check-flight/UA1710/${DATE}`);
    expect(p.heading).toMatch(
      /has Starlink on ORD → FLL \(N3YES, verified\); FLL → IAD is on N77UNK, which we haven't checked$/
    );
    expect(p.text).toContain("Not checked yet");
    expect(p.text).not.toContain("No Starlink");
  });

  test("two routings into one airport count as one leg, the more usual one", async () => {
    const p = await page(`/check-flight/UA1740/${DATE}`);
    expect(p.heading).toContain("we have no aircraft for DEN → FLL yet");
    expect(p.heading).not.toContain("IAD");
  });

  test("Alaska's site gives the same answer for its own number", async () => {
    const p = await page(`/check-flight/AS1900/${DATE}`, SITES.alaska.canonicalHost);
    expect(p.heading).toMatch(
      /^AS1900 on \w{3} \d{1,2} has Starlink on SEA → PDX \(N1ASYES, [^)]+\); we have no aircraft for PDX → SFO yet$/
    );
    expect(p.description).toStartWith(`${p.heading}. `);
    expect(p.flights).toEqual(["SEA-PDX", "PDX-SFO"]);
  });

  test("the share picture of a partial answer draws", async () => {
    const res = await app.dispatch(req(`/static/share/flight/UA403/${DATE}.png`, UA));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

describe("pages whose answer already covers what it says keep their lines", () => {
  test("a leg-scoped page of the mixed day answers its own leg, as before", async () => {
    const p = await page(`/check-flight/UA403/${DATE}?origin=FLL&destination=ORD`);
    expect(p.heading).toMatch(/^Yes — UA403 on \w{3} \d{1,2} has Starlink \(N1YES, verified\)$/);
    expect(p.tone).toBe("yes");
    expect(p.html).not.toContain("dayLegs");
  });

  test("a one-leg flight with an unconnected recent route stays a plain yes", async () => {
    const p = await page(`/check-flight/UA1720/${DATE}`);
    expect(p.heading).toMatch(/^Yes — UA1720 on \w{3} \d{1,2} has Starlink \(N4YES, verified\)$/);
    expect(p.flights).toEqual(["DEN-ORD"]);
    expect(p.html).not.toContain("dayLegs");
  });

  test("two legs that both have Starlink stay a yes naming each plane", async () => {
    const p = await page(`/check-flight/UA1730/${DATE}`);
    expect(p.heading).toMatch(
      /^Yes — UA1730 on \w{3} \d{1,2} has Starlink \(ORD → FLL on N5YES, FLL → IAD on N6YES, verified\)$/
    );
    expect(p.html).not.toContain("dayLegs");
  });

  test("the API body of the mixed day is the one it was: no new key", async () => {
    const json = await jsonOf(app, `/api/check-flight?flight_number=UA403&date=${DATE}`, UA);
    expect(Object.keys(json)).toEqual(["hasStarlink", "confidence", "flights"]);
    expect(json.hasStarlink).toBe(true);
  });

  test("a date with no aircraft yet hands the browser the number's legs, and prints none", async () => {
    const p = await page(`/check-flight/UA403/${isoDay(now + 20 * DAY)}`);
    expect(p.heading).not.toMatch(/FLL → ORD|DEN → FLL/);
    const config = jsonIsland<{ dayLegs?: DayLeg[] }>(p.html, "check-flight-config");
    expect(config.dayLegs?.map((l) => `${l.origin}-${l.destination}`).sort()).toEqual([
      "DEN-FLL",
      "FLL-ORD",
    ]);
  });
});

describe("one leg held twice on a date with two planes", () => {
  test("the two are told apart by departure time, in the answer and on its leg page", async () => {
    const twice =
      /\(ORD → FLL \d{1,2}:\d\d [AP]M \w+ on N8YES, ORD → FLL \d{1,2}:\d\d [AP]M \w+ on N8TWO, verified\)$/;
    const p = await page(`/check-flight/UA2000/${DATE}`);
    expect(p.heading).toMatch(twice);
    const [first, second] = p.heading.match(/\d{1,2}:\d\d [AP]M/g) ?? [];
    expect(first).not.toBe(second);
    const scoped = await page(`/check-flight/UA2000/${DATE}?origin=ORD&destination=FLL`);
    expect(scoped.heading).toMatch(twice);
  });
});

describe("the answer card's partial yes, from the API body and the page's legs", () => {
  const ctx: AnswerContext = {
    flightNumber: "UA403",
    date: DATE,
    daysOut: 1,
    origin: "DEN",
    originZone: "America/Denver",
    nowSec: now,
    airlineName: "United Airlines",
    zoneFor: () => "America/New_York",
    liveTv: { likely: "Live TV: likely.", possible: "Live TV: possible.", no: "Live TV: no." },
    watchEnabled: false,
    routePlannerEnabled: true,
    tailPages: true,
    host: UA,
  };
  const flight = (tail: string, from: string, to: string, hour: number) => ({
    tail_number: tail,
    aircraft_type: "Boeing 737-924(ER)",
    flight_number: "UA403",
    departure_airport: from,
    arrival_airport: to,
    departure_time: at(hour),
    fleet_type: "mainline",
  });
  const usual = (origin: string, destination: string): DayLeg => ({
    origin,
    destination,
    departure_time: null,
    tail: null,
    starlink: null,
    dated: false,
  });
  const yes = (flights: ReturnType<typeof flight>[]) => ({
    hasStarlink: true,
    confidence: "verified",
    flights,
  });

  test("the browser's re-check reaches the same sentence from the number's full leg list", () => {
    const dayLegs = [usual("FLL", "ORD"), usual("DEN", "FLL")];
    const answer = renderFlightAnswer(yes([flight("N1YES", "KFLL", "KORD", 21)]), {
      ...ctx,
      dayLegs,
    });
    expect(answer.tone).toBe("partial");
    expect(answer.headline).toMatch(
      /has Starlink on FLL → ORD \(N1YES, verified\); we have no aircraft for DEN → FLL yet$/
    );
    expect(answer.yesLegs).toEqual(["FLL → ORD"]);
    // Trimmed to the uncovered legs, as the server stores them, it reads the same.
    const trimmed = unansweredLegs([flight("N1YES", "FLL", "ORD", 21)], dayLegs);
    expect(trimmed).toEqual([usual("DEN", "FLL")]);
    expect(
      renderFlightAnswer(yes([flight("N1YES", "FLL", "ORD", 21)]), { ...ctx, dayLegs: trimmed })
        .headline
    ).toBe(answer.headline);
  });

  test("three legs, the middle one with Starlink: both others are named, in travel order", () => {
    const dayLegs = [usual("ORD", "IAD"), usual("FLL", "ORD"), usual("DEN", "FLL")];
    const answer = renderFlightAnswer(yes([flight("N1YES", "FLL", "ORD", 21)]), {
      ...ctx,
      dayLegs,
    });
    expect(answer.headline).toMatch(
      /; we have no aircraft for DEN → FLL yet; we have no aircraft for ORD → IAD yet$/
    );
    expect(inTravelOrder([...dayLegs]).map((l) => `${l.origin}-${l.destination}`)).toEqual([
      "DEN-FLL",
      "FLL-ORD",
      "ORD-IAD",
    ]);
  });

  test("a hostile tail and airport in the page's legs are printed as text", () => {
    const answer = renderFlightAnswer(yes([flight("N1YES", "FLL", "ORD", 21)]), {
      ...ctx,
      dayLegs: [
        {
          origin: "ORD",
          destination: '"><img src=x>',
          departure_time: null,
          tail: "<script>",
          starlink: false,
          dated: true,
        },
      ],
    });
    expect(answer.html).not.toContain("<img");
    expect(answer.html).not.toContain("<script>");
  });

  test("with no legs handed over, or a yes that names no leg, the yes reads as before", () => {
    const plain = renderFlightAnswer(yes([flight("N1YES", "FLL", "ORD", 21)]), ctx);
    expect(plain.headline).toMatch(
      /^Yes — UA403 on \w{3} \d{1,2} has Starlink \(N1YES, verified\)$/
    );
    expect(plain.yesLegs).toBeUndefined();
    const unnamed = renderFlightAnswer(
      yes([{ ...flight("N1YES", "FLL", "ORD", 21), departure_airport: "", arrival_airport: "" }]),
      { ...ctx, dayLegs: [usual("DEN", "FLL")] }
    );
    expect(unnamed.tone).toBe("yes");
  });
});
