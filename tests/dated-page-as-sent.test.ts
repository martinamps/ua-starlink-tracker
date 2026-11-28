/**
 * A dated flight page as sent (title, description, the answer card's first
 * line) says what the browser's re-check then shows, when an earlier lookup
 * already stored the plane. UA1 on 28 Nov 2026 was sent as "Under 1% chance…
 * We don't have the aircraft assignment yet" and then drawn as "No — … N81107
 * · 787-9 … Panasonic": the plane is one the flight updater doesn't track, so
 * the schedule never held it, and only the lookup's log did.
 *
 * Seeded on a fresh database. The browser's answer is the real
 * /api/check-flight with its live lookup stubbed to return the logged plane:
 * no outside request is made.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { type CheckFlightBody, renderFlightAnswer } from "../src/client/flight-answer";
import { logFlightAssignments, noteUnreadAircraft } from "../src/database/assignment-log";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeFreshDb, readableText, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HOUR = 3600;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

let db: Database;
let app: ReturnType<typeof createApp>;

interface Leg {
  fn: string;
  tail: string;
  from: string;
  to: string;
  dep: number;
  seen?: number;
}

/** Departures the stubbed live lookup returns, by flight number. */
const live = new Map<string, Leg[]>();

function logged(leg: Leg, routeCached = true) {
  live.set(leg.fn, [...(live.get(leg.fn) ?? []), leg]);
  if (routeCached) {
    db.query(
      `INSERT OR IGNORE INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
       VALUES (?, ?, ?, 10800, ?, ?, 3)`
    ).run(leg.fn, leg.from, leg.to, now - 9 * DAY, now - HOUR);
  }
  logFlightAssignments(
    db,
    "UA",
    leg.tail,
    [
      {
        flight_number: leg.fn,
        departure_airport: leg.from,
        arrival_airport: leg.to,
        departure_time: leg.dep,
        arrival_time: leg.dep + 3 * HOUR,
      },
    ],
    leg.seen ?? now - 10 * 60
  );
}

/** The airport-local date of a departure, for the page's own path. */
const localDate = (sec: number, zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(sec * 1000));

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

async function sent(path: string) {
  const res = await app.dispatch(req(path, UA));
  const html = await res.text();
  const meta = (name: string) =>
    decode(html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1] ?? "");
  const config = html.match(
    /<script type="application\/json" id="check-flight-config">(.*?)<\/script>/s
  );
  return {
    status: res.status,
    html,
    title: decode(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? ""),
    description: meta("description"),
    ogDescription: decode(
      html.match(/<meta property="og:description" content="([^"]*)"/)?.[1] ?? ""
    ),
    firstLine: readableText(
      html.match(/<div id="flight-answer"[^>]*>.*?<h2[^>]*>(.*?)<\/h2>/s)?.[1] ?? ""
    ),
    config: config ? JSON.parse(config[1]) : null,
    text: readableText(html),
  };
}

/** What the page's script draws after it asks the API, as check-flight.ts does. */
async function browser(path: string, config: Record<string, unknown>) {
  const [, fn, date] = path.match(/^\/check-flight\/([^/?]+)\/([^/?]+)/) ?? [];
  const leg = (config.leg ?? {}) as { origin?: string; destination?: string };
  const q = new URLSearchParams({ flight_number: fn, date });
  if (leg.origin) q.set("origin", leg.origin);
  if (leg.destination) q.set("destination", leg.destination);
  const res = await app.dispatch(req(`/api/check-flight?${q}`, UA));
  const body = (await res.json()) as CheckFlightBody;
  return renderFlightAnswer(body, {
    ...(config as unknown as Parameters<typeof renderFlightAnswer>[1]),
    seenAt: undefined,
    zoneFor: () => undefined,
    nowSec: Math.floor(Date.now() / 1000),
  });
}

const DEP_UA1 = now + 10 * HOUR;
const DATE_UA1 = localDate(DEP_UA1, "America/Los_Angeles");

beforeAll(() => {
  db = makeFreshDb();
  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  // UA1: a 787-9 the updater doesn't track, checked as Panasonic.
  addFleet(db, "N81107", "negative", {
    aircraftType: "Boeing 787-9",
    verifiedWifi: "Panasonic",
    verifiedAt: now - 2 * DAY,
  });
  logged({ fn: "UA1", tail: "N81107", from: "SFO", to: "SIN", dep: DEP_UA1 });

  // UA2: the same, seen too long ago to stand for today's plane.
  addFleet(db, "N2STAL", "negative", { aircraftType: "Boeing 777-200", verifiedWifi: "Panasonic" });
  logged({ fn: "UA2", tail: "N2STAL", from: "SFO", to: "NRT", dep: DEP_UA1, seen: now - 2 * HOUR });

  // UA3: swapped onto a plane we hold nothing for: the old plane is not the plane.
  addFleet(db, "N3OLD1", "negative", { aircraftType: "Boeing 777-200", verifiedWifi: "Panasonic" });
  logged({ fn: "UA3", tail: "N3OLD1", from: "SFO", to: "ORD", dep: DEP_UA1, seen: now - HOUR });
  logged({ fn: "UA3", tail: "N3NEW1", from: "SFO", to: "ORD", dep: DEP_UA1 });

  // UA4: the last lookup named an aircraft it couldn't read.
  addFleet(db, "N4READ", "negative", { aircraftType: "Boeing 777-200", verifiedWifi: "Panasonic" });
  logged({ fn: "UA4", tail: "N4READ", from: "SFO", to: "DEN", dep: DEP_UA1 });
  noteUnreadAircraft(
    db,
    ["UA"],
    "UA4",
    [{ origin: "SFO", departure_time: DEP_UA1, unread: true }],
    now
  );

  // UA5: an untracked tail our check reads as Starlink: never replayed as a yes.
  addFleet(db, "N5YES1", "confirmed", { aircraftType: "Boeing 737-800", verifiedWifi: "Starlink" });
  logged({ fn: "UA5", tail: "N5YES1", from: "SFO", to: "LAX", dep: DEP_UA1 });

  // UA6: two legs, a Starlink plane in the schedule on one and a logged
  // Panasonic plane on the other: the schedule answers, never a bare yes.
  addPlane(db, "N6STAR", "Starlink");
  addFleet(db, "N6STAR", "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
  addFlight(db, "N6STAR", "UA6", "SFO", DEP_UA1, { arrivalAirport: "DEN" });
  addFleet(db, "N6PANA", "negative", { aircraftType: "Boeing 737-900", verifiedWifi: "Panasonic" });
  logged({ fn: "UA6", tail: "N6PANA", from: "DEN", to: "IAD", dep: DEP_UA1 + 4 * HOUR });

  // UA7: two legs, both logged Panasonic planes.
  addFleet(db, "N7AAAA", "negative", { aircraftType: "Boeing 757-200", verifiedWifi: "Panasonic" });
  addFleet(db, "N7BBBB", "negative", { aircraftType: "Boeing 757-200", verifiedWifi: "Viasat" });
  logged({ fn: "UA7", tail: "N7AAAA", from: "SFO", to: "DEN", dep: DEP_UA1 });
  logged({ fn: "UA7", tail: "N7BBBB", from: "DEN", to: "EWR", dep: DEP_UA1 + 4 * HOUR });

  // UA8: a listed Starlink plane logged but gone from the schedule: a swap.
  addPlane(db, "N8GONE", "Starlink");
  addFleet(db, "N8GONE", "confirmed", { verifiedWifi: "Starlink", verifiedAt: now - DAY });
  db.query("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = 'N8GONE'").run(now);
  logged({ fn: "UA8", tail: "N8GONE", from: "SFO", to: "BOS", dep: DEP_UA1, seen: now - HOUR });

  // UA9: a number whose only trace is the lookup's log (no cached route).
  addFleet(db, "N9ONLY", "negative", { aircraftType: "Boeing 767-300", verifiedWifi: "Panasonic" });
  logged({ fn: "UA9", tail: "N9ONLY", from: "SFO", to: "HNL", dep: DEP_UA1 }, false);

  setAssignmentFetcher(async (fn) =>
    (live.get(fn) ?? []).map((l) => ({
      tail_number: l.tail,
      aircraft_model: null,
      origin: l.from,
      destination: l.to,
      departure_time: l.dep,
      arrival_time: l.dep + 3 * HOUR,
    }))
  );
  app = createApp(db);
});

afterAll(() => setAssignmentFetcher(null));

describe("the page as sent and the browser's answer agree", () => {
  test("UA1: a stored, untracked plane is named as sent, in all three places", async () => {
    const path = `/check-flight/UA1/${DATE_UA1}`;
    const p = await sent(path);
    expect(p.status).toBe(200);
    expect(p.title).toMatch(/^Does UA1 on \w{3} \d{1,2} Have Starlink Wi-Fi\?$/);
    expect(p.firstLine).toMatch(/^No — UA1 on \w{3} \d{1,2} doesn't have Starlink$/);
    expect(p.description.startsWith(`${p.firstLine}.`)).toBe(true);
    expect(p.description).toContain("N81107");
    expect(p.description).toContain("Panasonic Wi-Fi");
    expect(p.description).toMatch(/Aircraft as of \w{3} \d{1,2}, \d\d:\d\d UTC\./);
    expect(p.description).not.toMatch(/chance|assignment yet|Pick a date/);
    expect(p.ogDescription).toBe(p.description);
    expect(p.text).toContain("N81107");
    // The browser still re-checks a read-back answer, and draws the same line.
    expect(p.config.refresh).toBe(true);
    const b = await browser(path, p.config);
    expect(b.headline).toBe(p.firstLine);
    expect(b.tone).toBe("no");
  });

  test("a page made from the log asks United's site for nothing", async () => {
    const before = db
      .query(
        "SELECT next_check_after, discovery_priority FROM united_fleet WHERE tail_number = 'N81107'"
      )
      .get();
    await sent(`/check-flight/UA1/${DATE_UA1}`);
    const after = db
      .query(
        "SELECT next_check_after, discovery_priority FROM united_fleet WHERE tail_number = 'N81107'"
      )
      .get();
    expect(after).toEqual(before);
  });

  test("a one-leg page reads the same stored plane", async () => {
    const p = await sent(`/check-flight/UA1/${DATE_UA1}?origin=SFO&destination=SIN`);
    expect(p.firstLine).toMatch(/^No — /);
    expect(p.description).toContain("N81107");
  });

  for (const [fn, why] of [
    ["UA2", "a sighting older than the lookup cache's hour"],
    ["UA3", "a plane swapped out, its successor unchecked"],
    ["UA4", "an aircraft the last lookup could not read"],
    ["UA5", "an untracked plane that would answer yes"],
    ["UA8", "a listed plane the schedule no longer holds"],
  ] as const) {
    test(`${fn}: ${why} sends the cautious line, never a stored no or yes`, async () => {
      const p = await sent(`/check-flight/${fn}/${DATE_UA1}`);
      expect(p.status).toBe(200);
      expect(p.firstLine).not.toMatch(/^(No|Yes) — /);
      expect(p.description).not.toMatch(/^(No|Yes) — /);
      expect(p.config.refresh).toBe(true);
    });
  }

  test("UA6: a Starlink leg in the schedule and a logged no leg: no bare yes", async () => {
    const p = await sent(`/check-flight/UA6/${DATE_UA1}`);
    expect(p.firstLine).not.toMatch(/^Yes — UA6 on \w{3} \d{1,2} has Starlink \(/);
    expect(p.firstLine).toMatch(/SFO → DEN/);
  });

  test("UA9: a number known only from the log still sends its card's line", async () => {
    const p = await sent(`/check-flight/UA9/${DATE_UA1}`);
    expect(p.firstLine).toMatch(/^No — UA9 on /);
    expect(p.description.startsWith(`${p.firstLine}.`)).toBe(true);
    expect(p.html).toContain('content="noindex, follow"');
  });

  test("UA7: two logged no legs: a no that names both planes on the card", async () => {
    const path = `/check-flight/UA7/${DATE_UA1}`;
    const p = await sent(path);
    expect(p.firstLine).toMatch(/^No — UA7 on /);
    expect(p.text).toContain("N7AAAA");
    expect(p.text).toContain("N7BBBB");
    const b = await browser(path, p.config);
    expect(b.headline).toBe(p.firstLine);
  });
});
