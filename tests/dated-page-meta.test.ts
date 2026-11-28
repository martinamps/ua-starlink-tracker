/**
 * A dated flight page's <title> and description say what the page says about
 * that date. The page canonicalizes to the undated one, so search keeps the
 * undated lines; but a link shared in a message, or fetched by an assistant
 * for someone asking about that day, shows the dated page's own lines, and
 * they used to offer the flight's usual odds ("Pick a date for a firm
 * answer") on a page whose answer was a firm yes.
 *
 * Seeded on a fresh database: no outside request is made.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import type { DatedAnswer, FlightFacts } from "../src/components/check-flight/types";
import { logFlightAssignments } from "../src/database/assignment-log";
import { createApp, datedPageLines } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeFreshDb, readableText, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const STAMP = new Date((now - HOUR) * 1000).toISOString();
/** The date at Denver of an instant: a dated page answers by its airport's own day. */
const denverDay = (sec: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(sec * 1000));
const UA100_DEPARTS = now + 3 * HOUR;
const UA900_DEPARTS = now + 5 * HOUR;

let db: Database;
let app: ReturnType<typeof createApp>;

function addFlown(tail: string, fn: string, origin: string, destination: string, daysAgo: number) {
  const departure_time = now - daysAgo * DAY + HOUR;
  logFlightAssignments(
    db,
    "UA",
    tail,
    [
      {
        flight_number: fn,
        departure_airport: origin,
        arrival_airport: destination,
        departure_time,
        arrival_time: departure_time + 2 * HOUR,
      },
    ],
    now
  );
  db.query(
    "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?, ?, ?, 'UA')"
  ).run(tail, origin, departure_time);
}

beforeAll(() => {
  db = makeFreshDb();
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(STAMP);

  // UA100: a Starlink plane assigned within hours, with a history behind it.
  addPlane(db, "N1VER", "Starlink");
  addFleet(db, "N1VER", "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
  addFlight(db, "N1VER", "UA100", "DEN", UA100_DEPARTS, { arrivalAirport: "ORD" });
  // UA300: a plane settled on another provider, assigned within hours.
  addFleet(db, "N4VIA", "negative", { verifiedWifi: "Viasat", verifiedAt: now - 3 * DAY });
  addFlight(db, "N4VIA", "UA300", "DEN", now + 4 * HOUR, { arrivalAirport: "SFO" });
  for (let d = 1; d < 9; d++) {
    addFlown(d % 2 ? "N1VER" : "N4VIA", "UA100", "DEN", "ORD", d);
    addFlown("N4VIA", "UA300", "DEN", "SFO", d);
  }

  app = createApp(db);
});

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

async function page(path: string) {
  const res = await app.dispatch(req(path, UA));
  const html = await res.text();
  const meta = (attr: string, name: string) => {
    const m = html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`));
    return m ? decode(m[1]) : null;
  };
  return {
    status: res.status,
    html,
    title: decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""),
    description: meta("name", "description"),
    ogTitle: meta("property", "og:title"),
    ogDescription: meta("property", "og:description"),
    canonical: html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null,
    text: readableText(html),
  };
}

describe("a dated page's title and description give that date's answer", () => {
  test("an assigned Starlink plane: a yes, never odds", async () => {
    const date = denverDay(UA100_DEPARTS);
    const p = await page(`/check-flight/UA100/${date}`);
    expect(p.status).toBe(200);
    expect(p.description).toMatch(
      /^Yes — UA100 on \w{3} \d{1,2} has Starlink \(N1VER, verified\)\./
    );
    expect(p.description).toContain("Aircraft can be swapped before departure.");
    expect(p.description).not.toMatch(/odds|Pick a date/);
    expect(p.title).toMatch(/^Does UA100 on \w{3} \d{1,2} Have Starlink Wi-Fi\?$/);
    expect(p.ogTitle).toBe(p.title);
    expect(p.ogDescription).toBe(p.description);
    // The line is one the page itself prints, in its answer card.
    const headline = (p.description ?? "").split(". ")[0];
    expect(p.text).toContain(headline.replace(/\.$/, ""));
    // Search still keeps the undated page.
    expect(p.canonical).toBe(`https://${UA}/check-flight/UA100`);
    expect(date).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  test("a date before assignments: that date's odds, and when they firm up", async () => {
    const p = await page(`/check-flight/UA100/${isoDay(now + 12 * DAY)}`);
    expect(p.status).toBe(200);
    expect(p.description).toMatch(/chance UA100 on \w{3} \d{1,2} has Starlink\./);
    expect(p.description).toContain(
      "United Airlines assigns aircraft about 2 days before departure. Check again then for a firm answer."
    );
    expect(p.title).toMatch(/^Does UA100 on \w{3} \d{1,2} Have Starlink Wi-Fi\?$/);
  });

  test("a date already over keeps the pre-dated lines: no answer, no date", async () => {
    const undated = await page("/check-flight/UA100");
    const past = await page(`/check-flight/UA100/${isoDay(now - 6 * DAY)}`);
    expect(past.status).toBe(200);
    expect(past.title).toBe(undated.title);
    expect(past.description).not.toMatch(/^(Yes|No) — /);
    expect(past.description).not.toContain(" on ");
  });

  test("the undated page is unchanged: no date in its title", async () => {
    const p = await page("/check-flight/UA100");
    expect(p.title).toMatch(/^Does UA100 \(DEN → ORD\) Have Starlink Wi-Fi\?$/);
    expect(p.description).not.toMatch(/ on \w{3} \d{1,2} has Starlink \(/);
  });
});

describe("hostile dates never reach the title", () => {
  for (const tail of [
    "2026-13-40",
    "2026-02-30",
    "<script>",
    "%3Cscript%3E",
    "2026-11-27%22%3E%3Cb%3E",
    "2026-11-27/extra",
    `${"1".repeat(400)}`,
  ]) {
    test(tail.slice(0, 40), async () => {
      const res = await app.dispatch(req(`/check-flight/UA100/${tail}`, UA));
      const html = res.status === 200 ? await res.text() : "";
      const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
      expect(title).not.toContain("<");
      expect(title).not.toMatch(/script|13-40|02-30|1111/);
    });
  }
});

describe("each kind of dated answer, line by line", () => {
  const SITE = SITES.united;
  const facts = (over: Partial<FlightFacts> = {}): FlightFacts => ({
    flightNumber: "UA100",
    airlineName: "United Airlines",
    observedTotal: 0,
    observedStarlink: 0,
    aircraftTypes: [],
    lastStarlink: null,
    routes: [],
    upcoming: [],
    siblings: [],
    ...over,
  });
  const dated = (body: DatedAnswer["body"], daysOut = 1): DatedAnswer => ({
    flightNumber: "UA100",
    date: isoDay(now + daysOut * DAY),
    daysOut,
    body,
  });

  test("a verified no", () => {
    const lines = datedPageLines(
      SITE,
      facts(),
      dated({
        hasStarlink: false,
        confidence: "verified",
        message: "UA100 is assigned to tail N4VIA, verified as Viasat WiFi",
      })
    );
    expect(lines?.description).toMatch(/^No — UA100 on \w{3} \d{1,2} doesn't have Starlink\. /);
    expect(lines?.description).toContain("Aircraft can be swapped before departure.");
    expect(lines?.title).toMatch(/^Does UA100 on \w{3} \d{1,2} Have Starlink Wi-Fi\?$/);
  });

  test("an unknown says so, and promises no firm answer", () => {
    const lines = datedPageLines(SITE, facts(), dated({ hasStarlink: null }));
    expect(lines?.description).toMatch(/^Not sure yet about UA100 on \w{3} \d{1,2}\.$/);
  });

  test("a forecast gives odds and when they firm up, never a yes", () => {
    for (const probability of [0.02, 0.41, 0.97]) {
      const lines = datedPageLines(
        SITE,
        facts(),
        dated(
          {
            hasStarlink: null,
            confidence: "predicted",
            prediction: { probability, n_observations: 30 },
          },
          6
        )
      );
      expect(lines?.description).toMatch(
        /chance UA100 on \w{3} \d{1,2} has Starlink\. United Airlines assigns aircraft about 2 days before departure\. Check again then for a firm answer\.$/
      );
      expect(lines?.description).not.toMatch(/^Yes/);
    }
  });

  test("a forecast's caveat is the card's own: a named aircraft, or a lookup that failed", () => {
    const prediction = { probability: 0.41, n_observations: 30 };
    const assigned = datedPageLines(
      SITE,
      facts(),
      dated({
        hasStarlink: null,
        confidence: "predicted",
        prediction,
        assignment: { tail_number: "N4VIA" },
      })
    );
    expect(assigned?.description).toMatch(
      /has Starlink\. Aircraft can be swapped before departure\.$/
    );
    const degraded = datedPageLines(
      SITE,
      facts(),
      dated({
        hasStarlink: null,
        confidence: "predicted",
        prediction,
        message: "We couldn't confirm the aircraft assignment right now — try again shortly.",
      })
    );
    expect(degraded?.description).toMatch(
      /has Starlink\. We couldn't confirm the aircraft assignment just now\. Try again shortly\.$/
    );
    for (const lines of [assigned, degraded]) {
      expect(lines?.description).not.toContain("about 2 days before departure");
    }
  });

  test("a leg-scoped date names its leg; the plain date doesn't", () => {
    const routes = [
      { departure_airport: "SFO", arrival_airport: "IAH" },
      { departure_airport: "SBA", arrival_airport: "SFO" },
    ] as FlightFacts["routes"];
    const body = { hasStarlink: true, confidence: "verified", flights: [{ tail_number: "N1VER" }] };
    const scoped = datedPageLines(SITE, facts({ routes }), {
      ...dated(body),
      leg: { origin: "SFO", destination: "IAH" },
    });
    expect(scoped?.title).toMatch(
      /^Does UA100 \(SFO → IAH\) on \w{3} \d{1,2} Have Starlink Wi-Fi\?$/
    );
    expect(scoped?.description).toMatch(/^Yes — UA100 on \w{3} \d{1,2} has Starlink \(N1VER/);
    // A leg the flight's routes don't lead with is named from the asked airports.
    const elsewhere = datedPageLines(SITE, facts({ routes }), {
      ...dated(body),
      leg: { origin: "ORD" },
    });
    expect(elsewhere?.title).toMatch(/^Does UA100 \(from ORD\) on /);
    const plain = datedPageLines(SITE, facts({ routes }), dated(body));
    expect(plain?.title).toMatch(/^Does UA100 on \w{3} \d{1,2} Have Starlink Wi-Fi\?$/);
  });

  test("an error, a passed date, or no date: no lines of its own", () => {
    expect(datedPageLines(SITE, facts(), undefined)).toBeNull();
    expect(datedPageLines(SITE, facts(), dated({ error: "lookup failed" }))).toBeNull();
    const prediction = { probability: 0.5, n_observations: 9 };
    expect(
      datedPageLines(
        SITE,
        facts(),
        dated({ hasStarlink: null, confidence: "predicted", prediction }, -4)
      )
    ).toBeNull();
  });

  test("a tail number from the body can't close the attribute or open a tag", () => {
    const lines = datedPageLines(
      SITE,
      facts(),
      dated({
        hasStarlink: true,
        confidence: "verified",
        flights: [{ tail_number: '"><script>alert(1)</script>&' }],
      })
    );
    expect(lines?.description).toStartWith("Yes — UA100");
    expect(lines?.description).not.toMatch(/[<>"]/);
    expect(lines?.description).toContain("&lt;script&gt;");
    expect(lines?.description).toContain("&amp;");
  });
});

describe("a hostile tail stored from a feed stays inside the head's text", () => {
  test("the dated page's head holds no tag the tail tried to open", async () => {
    const bad = '"><img src=x onerror=alert(1)>';
    addPlane(db, bad, "Starlink");
    addFleet(db, bad, "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
    addFlight(db, bad, "UA900", "DEN", UA900_DEPARTS, { arrivalAirport: "LAX" });
    const res = await app.dispatch(req(`/check-flight/UA900/${denverDay(UA900_DEPARTS)}`, UA));
    const head = (await res.text()).split("<body")[0];
    expect(head).toContain("Yes — UA900 on ");
    expect(head).not.toContain("<img");
    expect(head).not.toContain("alert(1)>");
  });
});
