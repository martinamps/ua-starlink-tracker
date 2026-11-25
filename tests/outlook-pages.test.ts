/**
 * The rollout outlook on the flight, route and per-type pages.
 *
 * Seeded on a fresh database with three types in three states: a running
 * install line (737 MAX 9), a type with no line and an airline date (787),
 * and a finished one (E175). The rules pinned: a page states a two-month
 * range only for a running line, never a finish date of ours, and nothing at
 * all where there is nothing backtested to say.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import {
  type RouteOutlookView,
  countSentence,
  directionSentence,
  forecastSentence,
  foundSentence,
  hasTypeOutlook,
  paceBlocks,
  routeOutlookView,
  targetSentence,
} from "../src/components/outlook-copy";
import { ensureAdsbFlightDrawsTable } from "../src/database/adsb-flight-draws";
import { airlineOutlook } from "../src/database/outlook";
import { createReaderFactory } from "../src/database/reader";
import { type TypeOutlook, typeOutlook } from "../src/outlook/pace";
import { publishedTargets } from "../src/outlook/published";
import { routeMonths, routeOutlook } from "../src/outlook/route";
import { createApp } from "../src/server/app";
import { addFlight, bodyOf, makeFreshDb, utc } from "./helpers";

const UA = SITES.united.canonicalHost;
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const isoDay = (daysAgo: number) =>
  new Date((now - daysAgo * DAY) * 1000).toISOString().slice(0, 10);

/** A month name followed by a year: how a finish date of ours would read. */
const DATED = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (?:\d{1,2}, )?20\d\d/;

let db: Database;
let app: ReturnType<typeof createApp>;

function tail(name: string, aircraft: string, foundDaysAgo: number | null) {
  db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
     VALUES (?, ?, 'test', 1, 1, 'mainline', 'unknown', 'UA')`
  ).run(name, aircraft);
  if (foundDaysAgo === null) return;
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
     VALUES (?, 'Starlink', ?, ?, 'United Airlines', 'mainline', 'Starlink', 'UA')`
  ).run(aircraft, isoDay(foundDaysAgo), name);
}

function section(html: string, id: string): string | null {
  const m = html.match(new RegExp(`<(section|p)[^>]*\\sid="${id}"[\\s\\S]*?</\\1>`));
  return m
    ? m[0]
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, " ")
    : null;
}

beforeAll(() => {
  db = makeFreshDb();
  ensureAdsbFlightDrawsTable(db);
  // 737 MAX 9: 60 aircraft, 24 fitted, one every three days for 72 days.
  for (let i = 0; i < 60; i++) tail(`N9M${i}`, "Boeing 737 MAX 9", i < 24 ? i * 3 + 1 : null);
  // 787: 12 aircraft, one fitted long ago.
  for (let i = 0; i < 12; i++) tail(`N78${i}`, "Boeing 787-9", i === 0 ? 300 : null);
  // E175: all six fitted.
  for (let i = 0; i < 6; i++) tail(`N17${i}`, "Embraer E175LR", 400);

  const route = db.query(
    "INSERT INTO flight_routes (flight_number, origin, destination, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
  );
  const draw = db.query(
    "INSERT OR IGNORE INTO adsb_flight_draws (flight_number, tail_number, first_seen, last_seen) VALUES (?, ?, ?, ?)"
  );
  const check = db.query(
    `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, aircraft_type, flight_number, error, tail_confirmed, airline)
     VALUES (?, 'united', ?, ?, ?, ?, ?, NULL, 1, 'UA')`
  );
  for (const [fn, o, d, prefix, n, type] of [
    ["UA500", "DEN", "ORD", "N9M", 60, "Boeing 737 MAX 9"],
    ["UA1", "SFO", "SIN", "N78", 12, "Boeing 787-9"],
    ["UA4000", "ORD", "CMH", "N17", 6, "Embraer E175LR"],
  ] as const) {
    route.run(fn, o, d, now - 100 * DAY, now);
    addFlight(db, `${prefix}0`, fn, o, now + 5 * 3600, { arrivalAirport: d });
    for (let k = 1; k <= 88; k++)
      draw.run(fn, `${prefix}${k % n}`, now - k * DAY, now - k * DAY + 3600);
    for (let k = 1; k <= 3; k++) check.run(`${prefix}0`, now - k * DAY, 1, "Starlink", type, fn);
  }
  app = createApp(db);
});

describe("sentences", () => {
  const at = (daysAgo: number) => now - daysAgo * DAY;
  const running = () =>
    typeOutlook({
      family: "B737-MAX9",
      equipped: 30,
      total: 190,
      installedAt: Array.from({ length: 30 }, (_, i) => at(i * 3 + 1)),
      now,
      published: publishedTargets("UA", "B737-MAX9"),
    });

  test("a running line gets a two-month range and no date of ours", () => {
    const o = running();
    expect(o.status).toBe("projected");
    const forecast = forecastSentence(o, now)!;
    expect(forecast).toMatch(/^About \d+ to \d+ more are likely in the next two months\.$/);
    expect(forecast).not.toMatch(DATED);
    expect(foundSentence(o, "737 MAX 9")).toMatch(/^\d+ Starlink 737 MAX 9s were found/);
    expect(countSentence(o, "United 737 MAX 9s")).toStartWith("30 of 190 United 737 MAX 9s have");
  });

  test("a range that would reach the last aircraft is not stated", () => {
    const o = typeOutlook({ ...inputOf(running()), total: 34 });
    expect(o.status).toBe("projected");
    expect(o.next60Days!.high).toBe(o.remaining);
    expect(forecastSentence(o, now)).toBe("4 are left.");
  });

  test("a line just opening says it is too new", () => {
    const o = typeOutlook({
      family: "B737-MAX8",
      equipped: 8,
      total: 123,
      installedAt: Array.from({ length: 8 }, (_, i) => at(i * 3 + 1)),
      now,
    });
    expect(o.status).toBe("starting");
    expect(forecastSentence(o, now)).toMatch(
      /^Installs on this type began in .*too new to forecast\.$/
    );
  });

  test("no line: no forecast, and the airline's date only as arithmetic", () => {
    const o = typeOutlook({
      family: "B787",
      equipped: 3,
      total: 98,
      installedAt: [at(200), at(150), at(120)],
      now,
      published: publishedTargets("UA", "B787"),
    });
    expect(o.status).toBe("no_pace");
    expect(forecastSentence(o, now)).toBeNull();
    expect(foundSentence(o, "787")).toBe("No 787 installs were found in the last 90 days.");
    // The date in it is the day the airline spoke, never a finish date.
    expect(targetSentence(o, "United")).toMatch(
      /^United's target is .+ \(stated [A-Z][a-z]{2} \d{1,2}, 20\d\d\); from here that needs about \d+ a month\.$/
    );
  });

  test("a target without the airline's own phrase builds no sentence", () => {
    const o = typeOutlook({
      family: "B787",
      equipped: 3,
      total: 98,
      installedAt: [],
      now,
      published: [
        {
          label: "x",
          deadline: "2099-06-30",
          statedOn: "2026-01-01",
          source: { title: "t", url: "https://example.com" },
        },
      ],
    });
    expect(targetSentence(o, "United")).toBeNull();
  });

  test("nothing is said of a finished type, or one with undated installs", () => {
    const done = typeOutlook({ family: "E175", equipped: 10, total: 10, installedAt: [], now });
    expect(hasTypeOutlook(done)).toBe(false);
    const nearly = typeOutlook({
      family: "CRJ-550",
      equipped: 103,
      total: 104,
      installedAt: [],
      now,
    });
    expect(hasTypeOutlook(nearly)).toBe(false);
    const undated = typeOutlook({
      family: "B777",
      equipped: 10,
      total: 96,
      installedAt: Array.from({ length: 10 }, () => null),
      now,
    });
    expect(hasTypeOutlook(undated)).toBe(false);
    expect(hasTypeOutlook(running())).toBe(true);
  });

  test("the bars are the 90 days, split in three", () => {
    const o = running();
    const blocks = paceBlocks(o);
    expect(blocks).toHaveLength(3);
    expect(blocks.reduce((s, b) => s + b.installs, 0)).toBe(
      o.pace.find((w) => w.days === 90)!.installs
    );
  });

  function inputOf(o: TypeOutlook) {
    return {
      family: o.family,
      equipped: o.equipped,
      total: o.total,
      installedAt: Array.from({ length: 30 }, (_, i) => at(i * 3 + 1)),
      now,
    };
  }
});

describe("route view", () => {
  const NOW = utc("2026-11-24T00:00:00Z");
  const departures = (month: string, n: number, starlink: number) =>
    Array.from({ length: n }, (_, i) => ({
      departedAt: utc(`${month}-10T00:00:00Z`) + i * 60,
      tail: `N${i}`,
      family: "B787",
      equippedSince: i < starlink ? 0 : null,
    }));
  const view = (deps: ReturnType<typeof departures>, historyFrom?: number) =>
    routeOutlookView(
      routeOutlook({
        origin: "SFO",
        destination: "SIN",
        departures: deps,
        outlooks: new Map(),
        now: NOW,
        historyFrom,
      }),
      () => null
    );

  test("a month that began before the kept history is not a full month", () => {
    const months = routeMonths(departures("2026-08", 30, 3), NOW, 4, utc("2026-08-26T00:00:00Z"));
    expect(months.find((m) => m.month === "2026-08")!.complete).toBe(false);
    expect(months.find((m) => m.month === "2026-09")!.complete).toBe(true);
  });

  test("no month with enough departures: no view", () => {
    expect(view(departures("2026-10", 5, 1))).toBeNull();
    // The month so far alone is not a month either.
    expect(view(departures("2026-11", 40, 10))).toBeNull();
  });

  test("the direction names the months it compared, or says nothing", () => {
    const one = view(departures("2026-10", 30, 3)) as RouteOutlookView;
    expect(one.months.map((m) => m.month)).toEqual(["2026-10"]);
    expect(directionSentence(one)).toBeNull();
    const two = view([...departures("2026-09", 30, 3), ...departures("2026-10", 30, 15)])!;
    expect(directionSentence(two)).toBe("Up 40 points from Sep 2026 to Oct 2026.");
    // A cut-short August is neither shown nor compared.
    const cut = view(
      [
        ...departures("2026-08", 30, 30),
        ...departures("2026-09", 30, 3),
        ...departures("2026-10", 30, 3),
      ],
      utc("2026-08-26T00:00:00Z")
    )!;
    expect(cut.months.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
    expect(directionSentence(cut)).toBe("About level from Sep 2026 to Oct 2026.");
  });
});

describe("pages", () => {
  test("the seed is in the three states the pages are checked in", () => {
    const o = airlineOutlook(db, "UA", now);
    const status = (family: string) => o.families.find((f) => f.family === family)?.status;
    expect(status("B737-MAX9")).toBe("projected");
    expect(status("B787")).toBe("no_pace");
    expect(status("E175")).toBe("complete");
  });

  test("type page: pace, range and the airline's date; no finish date of ours", async () => {
    const { status, text } = await bodyOf(app, "/fleet/737-max-9", UA);
    expect(status).toBe(200);
    const pace = section(text, "pace")!;
    expect(pace).toContain("were found in the last 30 days");
    expect(pace).toMatch(/About \d+ to \d+ more are likely in the next two months/);
    expect(pace).toContain("We don't forecast a finish date");
    // The only dated thing in the card is the day the airline stated its target.
    expect(pace.replace(/\(stated [^)]+\)/g, "")).not.toMatch(DATED);
    expect(pace).not.toMatch(/\b(?:done|finish(?:ed)?|complete[d]?) by\b/i);
  });

  test("type page: no line means no range", async () => {
    const pace = section((await bodyOf(app, "/fleet/787", UA)).text, "pace")!;
    expect(pace).toContain("No 787 installs were found in the last 90 days.");
    expect(pace).not.toContain("likely in the next two months");
    expect(pace).toContain("United's target is its entire widebody fleet by summer 2027");
  });

  test("type page: a finished type shows nothing", async () => {
    const { status, text } = await bodyOf(app, "/fleet/e175", UA);
    expect(status).toBe(200);
    expect(section(text, "pace")).toBeNull();
  });

  test("flight page: the count and one more sentence, for an unfinished type only", async () => {
    const line = section((await bodyOf(app, "/check-flight/UA500", UA)).text, "type-outlook")!;
    expect(line).toMatch(/24 of 60 United 737 MAX 9s have Starlink, and \d+ were found/);
    expect(line).toContain("likely in the next two months");
    expect(line).not.toMatch(DATED);
    const done = await bodyOf(app, "/check-flight/UA4000", UA);
    expect(done.status).toBe(200);
    expect(section(done.text, "type-outlook")).toBeNull();
  });

  test("route page: months with their counts, then the types that fly it", async () => {
    const trend = section((await bodyOf(app, "/route-planner/DEN/ORD", UA)).text, "trend")!;
    expect(trend).toContain("The share of departures we saw on a Starlink aircraft.");
    expect(trend).toMatch(/\d+% of \d+/);
    expect(trend).toMatch(/737 MAX 9 ?, 100% of these departures: 24 of 60 have Starlink/);
    expect(trend.replace(/[A-Z][a-z]{2} 20\d\d/g, "")).not.toMatch(DATED);
  });

  test("route page: a route we saw no departures on shows nothing", async () => {
    db.query(
      "INSERT INTO flight_routes (flight_number, origin, destination, first_seen_at, last_seen_at) VALUES ('UA777', 'IAH', 'EWR', ?, ?)"
    ).run(now - DAY, now);
    const { status, text } = await bodyOf(app, "/route-planner/IAH/EWR", UA);
    expect(status).toBe(200);
    expect(section(text, "trend")).toBeNull();
  });

  test("no outlook for an airline whose install dates were never backtested", () => {
    const readers = createReaderFactory(db);
    expect(readers("UA").getRolloutOutlook()).not.toBeNull();
    for (const scope of ["AS", "HA", "ALL"] as const) {
      expect(readers(scope).getRolloutOutlook()).toBeNull();
      expect(readers(scope).getRouteOutlook("SEA", "PDX")).toBeNull();
    }
  });
});
