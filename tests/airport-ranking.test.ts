/**
 * "How many Starlink flights leave my airport today, and which airports have
 * the most?": the per-day counts behind the ranking on /routes and each
 * airport page's dated figures.
 *
 * Seeded on a fresh database around each airport's own local today and
 * tomorrow, so the rules are pinned on rows the test wrote: today is what left
 * plus what is still to leave, one flight is one departure however it is
 * spelled or listed, the day is the airport's, the count stands alone with no
 * figure credited to the airline, and no share is printed.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { airportIndexes, buildAirportBoard } from "../src/api/airport-board";
import { AIRPORT_RANK_MIN_DEPARTURES, buildAirportRanking } from "../src/api/airport-ranking";
import {
  getAirportDayCounts,
  getAirportHistory,
  getStarlinkDeparturesLeft,
  nextLocalDay,
} from "../src/database/airports";
import { logFlightAssignments } from "../src/database/assignment-log";
import { archivePastDepartures, getRouteStarlinkSchedule } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { airportLocalDate, localDayEndSec } from "../src/utils/airport-tz";
import { addFlight, addPlane, makeFreshDb, req, sectionOf } from "./helpers";

const UA = SITES.united.canonicalHost;
const AS = SITES.alaska.canonicalHost;
const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);

let db: Database;
let app: ReturnType<typeof createApp>;

/** An instant on the airport's next local day, `hoursBeforeEnd` before it ends. */
function onNextDay(airport: string, hoursBeforeEnd: number): number {
  const date = nextLocalDay(airport, now);
  if (!date) throw new Error(`${airport} has no timezone`);
  return localDayEndSec(airport, date) - hoursBeforeEnd * HOUR;
}

/** The first instant of the airport's local today. */
function todayStart(airport: string): number {
  const today = airportLocalDate(airport, now) as string;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000)
    .toISOString()
    .slice(0, 10);
  return localDayEndSec(airport, yesterday);
}

/** Still to leave today: the `k`th of a few instants between now and midnight. */
function laterToday(airport: string, k: number): number {
  const end = localDayEndSec(airport, airportLocalDate(airport, now) as string);
  return now + Math.max(1, Math.floor(((end - now) * k) / 10));
}

/** Already gone today: the `k`th of a few instants between midnight and now. */
function earlierToday(airport: string, k: number): number {
  const start = todayStart(airport);
  return now - Math.max(1, Math.floor(((now - start) * k) / 10));
}

/** A departure the updater saw assigned and archived once its time passed. */
function left(
  tail: string,
  flight: string,
  from: string,
  to: string,
  at: number,
  airline = "UA"
): void {
  logFlightAssignments(
    db,
    airline,
    tail,
    [
      {
        flight_number: flight,
        departure_airport: from,
        arrival_airport: to,
        departure_time: at,
        arrival_time: at + 2 * HOUR,
      },
    ],
    now
  );
  db.query(
    "INSERT OR IGNORE INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?, ?, ?, ?)"
  ).run(tail, from, at, airline);
}

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N1VER", "Starlink");
  addPlane(db, "N2LIST", null);
  // The sheet lists this tail on two tabs: two listings, one aircraft.
  addPlane(db, "N3TWICE", null);
  addPlane(db, "N3TWICE", null);

  // DEN, a hub: four departures on its next local day.
  addFlight(db, "N1VER", "UA100", "DEN", onNextDay("DEN", 14), { arrivalAirport: "ORD" });
  addFlight(db, "N2LIST", "UA200", "DEN", onNextDay("DEN", 12), { arrivalAirport: "SFO" });
  // One flight under its marketed and its operating spelling: one departure.
  addFlight(db, "N2LIST", "UA5212", "DEN", onNextDay("DEN", 8), { arrivalAirport: "GJT" });
  addFlight(db, "N2LIST", "SKW5212", "DEN", onNextDay("DEN", 8), { arrivalAirport: "GJT" });
  addFlight(db, "N3TWICE", "UA300", "DEN", onNextDay("DEN", 6), { arrivalAirport: "IAH" });
  // A tail with no listing is not a Starlink plane.
  addFlight(db, "N9NONE", "UA900", "DEN", onNextDay("DEN", 10), { arrivalAirport: "ORD" });

  // DEN today: two gone, one still to leave.
  left("N1VER", "UA150", "DEN", "ORD", earlierToday("DEN", 3));
  // One departure under its operating and its marketed spelling.
  left("N2LIST", "SKW5150", "DEN", "ASE", earlierToday("DEN", 5));
  left("N2LIST", "UA5150", "DEN", "ASE", earlierToday("DEN", 5));
  // A positioning leg under an ATC callsign: nobody books it.
  left("N1VER", "SKW312R", "DEN", "COS", earlierToday("DEN", 7));
  // Gone, but not on a Starlink plane.
  left("N9NONE", "UA950", "DEN", "ORD", earlierToday("DEN", 4));
  // Gone yesterday, inside the look-back but not today's.
  left("N1VER", "UA149", "DEN", "ORD", todayStart("DEN") - HOUR);
  addFlight(db, "N1VER", "UA101", "DEN", laterToday("DEN", 5), { arrivalAirport: "ORD" });

  // GJT and SBA tie on two today, and on two tomorrow; BOI has one today,
  // gone already, and is listed, not ranked.
  for (const [i, airport] of ["GJT", "SBA"].entries()) {
    addFlight(db, "N1VER", `UA${420 + i}`, airport, laterToday(airport, 3), {
      arrivalAirport: "DEN",
    });
    addFlight(db, "N2LIST", `UA${430 + i}`, airport, laterToday(airport, 6), {
      arrivalAirport: "DEN",
    });
    addFlight(db, "N1VER", `UA${400 + i}`, airport, onNextDay(airport, 13), {
      arrivalAirport: "DEN",
    });
    addFlight(db, "N2LIST", `UA${410 + i}`, airport, onNextDay(airport, 9), {
      arrivalAirport: "DEN",
    });
  }
  left("N1VER", "UA501", "BOI", "DEN", earlierToday("BOI", 2));
  addFlight(db, "N1VER", "UA500", "BOI", onNextDay("BOI", 11), { arrivalAirport: "DEN" });

  // Alaska keeps the bars it had: the ranking is United's.
  addPlane(db, "N644AS", "Starlink", { airline: "AS" });
  addFlight(db, "N644AS", "AS118", "SEA", now + 5 * HOUR, { arrivalAirport: "SAN", airline: "AS" });

  db.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(
    new Date((now - HOUR) * 1000).toISOString()
  );
  app = createApp(db);
});

const page = async (path: string, host = UA) =>
  (
    await app.dispatch(
      req(path, host, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
    )
  ).text();
const text = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
const reader = () => createReaderFactory(db)("UA");

describe("nextLocalDay", () => {
  test("is the calendar day after today at the airport, whole inside the window", () => {
    for (const airport of ["DEN", "EWR", "HNL", "GUM", "LHR"]) {
      const date = nextLocalDay(airport, now);
      expect(date, airport).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const today = airportLocalDate(airport, now) as string;
      expect(localDayEndSec(airport, today), airport).toBeGreaterThan(now);
      expect((date as string) > today, airport).toBe(true);
      // The day's last instant is still inside the 48 hours the schedule
      // holds, give or take the hour a clock change adds.
      expect(localDayEndSec(airport, date as string) - now, airport).toBeLessThanOrEqual(49 * HOUR);
    }
  });

  test("an airport on the far side of the date line counts its own date", () => {
    const utcMidday = Date.parse("2026-11-26T12:00:00Z") / 1000;
    expect(nextLocalDay("DEN", utcMidday)).toBe("2026-11-27");
    expect(nextLocalDay("GUM", utcMidday)).toBe("2026-11-27");
    const utcEvening = Date.parse("2026-11-26T20:00:00Z") / 1000;
    expect(nextLocalDay("DEN", utcEvening)).toBe("2026-11-27");
    expect(nextLocalDay("GUM", utcEvening)).toBe("2026-11-28");
  });

  test("an airport with no mapped timezone has no day to count", () => {
    expect(nextLocalDay("QQQ", now)).toBeNull();
  });
});

describe("getAirportDayCounts", () => {
  test("counts each departure on the airport's local today and tomorrow once", () => {
    const rows = getAirportDayCounts(db, "UA", now);
    const den = rows.find((r) => r.airport === "DEN");
    // Today: UA150 and UA5150 (two spellings) gone, UA101 to come; not the
    // callsign leg, the unlisted tail or yesterday's. Tomorrow: UA100, UA200,
    // UA5212 (two spellings) and UA300 (a tail listed twice).
    expect(den).toEqual({
      airport: "DEN",
      today: { date: airportLocalDate("DEN", now) as string, left: 2, toGo: 1, departures: 3 },
      tomorrow: { date: nextLocalDay("DEN", now) as string, departures: 4 },
    });
    expect(rows.find((r) => r.airport === "BOI")?.today).toMatchObject({ left: 1, toGo: 0 });
    expect(rows.every((r) => r.today.departures + r.tomorrow.departures > 0)).toBe(true);
    expect(rows.map((r) => r.today.departures)).toEqual(
      [...rows.map((r) => r.today.departures)].sort((a, b) => b - a)
    );
  });

  test("what left is read from the archive alone, never from the schedule", () => {
    // UA101 is in the schedule and has not left; nothing archived is to come.
    const gone = getStarlinkDeparturesLeft(db, "UA", now, "DEN");
    expect(gone.every((d) => d.departure_time < now)).toBe(true);
    expect(gone.length).toBe(3);
  });

  test("a tail with two listings does not double the route counts either", () => {
    const schedule = getRouteStarlinkSchedule(db, "UA", now);
    expect(
      schedule.rows.find((r) => r.origin === "DEN" && r.destination === "IAH")?.departures
    ).toBe(1);
    expect(schedule.totalDepartures).toBe(schedule.rows.reduce((s, r) => s + r.departures, 0));
  });

  test("an airline's count never takes another's rows", () => {
    expect(getAirportDayCounts(db, "UA", now).some((r) => r.airport === "SEA")).toBe(false);
  });
});

describe("a late swap", () => {
  // UA1234 ORD-DEN at 13:00 at O'Hare, swapped late: the old tail's row is
  // still in the schedule when the time passes, so both rows are archived.
  const t0 = Date.parse("2026-11-27T18:00:00Z") / 1000;
  const dep = t0 + HOUR;
  const seed = (to: string, toListed: boolean) => {
    const swapDb = makeFreshDb();
    addPlane(swapDb, "N37501", "Starlink");
    if (toListed) addPlane(swapDb, to, "Starlink");
    for (const [tail, seen] of [
      ["N37501", t0 - 3 * HOUR],
      [to, t0 - HOUR],
    ] as const) {
      addFlight(swapDb, tail, "UA1234", "ORD", dep, { arrivalAirport: "DEN", lastUpdated: seen });
      logFlightAssignments(
        swapDb,
        "UA",
        tail,
        [
          {
            flight_number: "UA1234",
            departure_airport: "ORD",
            arrival_airport: "DEN",
            departure_time: dep,
            arrival_time: dep + 2 * HOUR,
          },
        ],
        seen
      );
    }
    return swapDb;
  };
  const today = (swapDb: Database, at: number) =>
    getAirportDayCounts(swapDb, "UA", at).find((c) => c.airport === "ORD")?.today;

  test("between two Starlink planes is one departure before and after it leaves", () => {
    const swapDb = seed("N37502", true);
    expect(today(swapDb, t0)).toMatchObject({ left: 0, toGo: 1, departures: 1 });
    expect(archivePastDepartures(swapDb, dep + 60)).toBe(2);
    expect(today(swapDb, dep + 120)).toMatchObject({ left: 1, toGo: 0, departures: 1 });
  });

  // The six-day figure ends at the newest observation: one after departure.
  const observeAfter = (swapDb: Database) =>
    addFlight(swapDb, "N37502", "UA1300", "DEN", dep + 5 * HOUR, { lastUpdated: dep + 90 });

  test("is one flight in the six-day figure too, as in what already left", () => {
    const swapDb = seed("N37502", true);
    archivePastDepartures(swapDb, dep + 60);
    observeAfter(swapDb);
    const ord = getAirportHistory(swapDb, "UA", dep + 120).airports.get("ORD");
    expect(ord).toEqual({ starlink: 1, destinations: [{ destination: "DEN", starlink: 1 }] });
    expect(ord?.starlink).toBe(today(swapDb, dep + 120)?.left);
  });

  test("onto a plane without Starlink is no Starlink departure once it is seen", () => {
    const swapDb = seed("N99NOT", false);
    archivePastDepartures(swapDb, dep + 60);
    expect(today(swapDb, dep + 120)?.left ?? 0).toBe(0);
    observeAfter(swapDb);
    expect(getAirportHistory(swapDb, "UA", dep + 120).airports.has("ORD")).toBe(false);
  });
});

describe("buildAirportRanking", () => {
  test("ranks from the minimum up, equal counts sharing a rank", () => {
    const ranking = buildAirportRanking(AIRLINES.UA, reader());
    expect(ranking.rows.map((r) => [r.rank, r.airport])).toEqual([
      [1, "DEN"],
      [2, "GJT"],
      [2, "SBA"],
    ]);
    expect(ranking.rows.every((r) => r.departures >= AIRPORT_RANK_MIN_DEPARTURES)).toBe(true);
    expect(ranking.unranked).toEqual(["BOI"]);
    expect(ranking.date).toBe(airportLocalDate("DEN", now));
    expect(ranking.rows[0]).toMatchObject({ departures: 3, tomorrow: 4 });
  });

  test("carries our count alone: no reported figure, no share", () => {
    const ranking = buildAirportRanking(AIRLINES.UA, reader());
    expect(Object.keys(ranking).sort()).toEqual(["airline", "date", "rows", "unranked"]);
    for (const r of ranking.rows) {
      expect(Object.keys(r).sort(), r.airport).toEqual([
        "airport",
        "date",
        "departures",
        "rank",
        "tomorrow",
        "tomorrowDate",
      ]);
    }
  });
});

describe("/routes", () => {
  test("labels every cell of its tables but the one naming the row, for when they stack", async () => {
    // Stacked under a larger browser font, the headings are hidden; the
    // labels (tests/table-stack-labels.test.ts) say what each count is.
    const tables = [
      ...(await page("/routes")).matchAll(/<table class="table-stack[^"]*">([\s\S]*?)<\/table>/g),
    ];
    expect(tables).toHaveLength(2);
    for (const [, table] of tables) {
      const rows =
        table.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const tr of rows) {
        const cells = tr.match(/<td\b[^>]*>/g) ?? [];
        expect(
          cells.filter((td) => !td.includes("data-label=")),
          tr
        ).toHaveLength(1);
      }
    }
  });

  test("ranks the airports for a dated day, each linked where its page indexes", async () => {
    const body = await page("/routes");
    const block = sectionOf(body, "Airports with the most Starlink departures");
    const r = reader();
    for (const airport of ["DEN", "GJT", "SBA", "BOI"]) {
      expect(block, airport).toContain(airport);
      expect(block.includes(`href="/routes/${airport}"`), airport).toBe(airportIndexes(r, airport));
    }
    expect(body).toContain('id="airports"');
    // The day is named, weekday and date.
    expect(text(block)).toMatch(/on Starlink planes today, \w+day, \w{3} \d{1,2}/);
    expect(block).toMatch(/<th[^>]*>Today<\/th>/);
    expect(block).toMatch(/<th[^>]*>Tomorrow<\/th>/);
    expect(text(block)).toContain("we list as having Starlink");
    expect(text(block)).toContain("swapped before departure");
  });

  test("says the count can rise, credits no figure to the airline, and prints no share", async () => {
    const block = sectionOf(await page("/routes"), "Airports with the most Starlink departures");
    const said = text(block);
    expect(said).toContain("those that already left to those still scheduled");
    expect(said).toContain("it can rise as the day nears");
    expect(said).not.toMatch(/own estimate|as reported by|Travel And Tour World|recounts/i);
    expect(block).not.toMatch(/<th[^>]*>United<\/th>/);
    expect(said).not.toMatch(/\d\s*%|percent/i);
  });

  test("an airline without airport pages keeps its top-airport bars", async () => {
    const body = await page("/routes", AS);
    expect(body).toContain("Busiest airports");
    expect(body).not.toContain("Airports with the most Starlink departures");
  });
});

describe("/routes/{airport}", () => {
  test("gives today's and tomorrow's counts with their dates and today's rank", async () => {
    const board = buildAirportBoard(AIRLINES.UA, reader(), "DEN");
    expect(board.today).toEqual({
      date: airportLocalDate("DEN", now) as string,
      left: 2,
      toGo: 1,
      departures: 3,
      rank: 1,
      ranked: 3,
    });
    expect(board.tomorrow).toEqual({ date: nextLocalDay("DEN") as string, departures: 4 });
    const said = text(await page("/routes/DEN"));
    expect(said).toMatch(
      /3 Starlink departures today, \w+day, \w{3} \d{1,2}: 2 gone, 1 still to leave/
    );
    expect(said).toMatch(/4 Starlink departures scheduled for tomorrow, \w+day, \w{3} \d{1,2}/);
    expect(said).toContain("No. 1 of 3 airports");
    expect(said).toContain("DEN's own calendar day");
  });

  test("the page's counts still to come are counts of the rows it lists", () => {
    for (const airport of ["DEN", "GJT", "BOI"]) {
      const board = buildAirportBoard(AIRLINES.UA, reader(), airport);
      const on = (date: string | undefined) =>
        board.departures.filter((d) => airportLocalDate(airport, d.departure_time) === date).length;
      expect(board.today?.toGo, airport).toBe(on(board.today?.date));
      expect(board.tomorrow?.departures, airport).toBe(on(board.tomorrow?.date));
    }
  });

  test("the page and the ranking give an airport the same count", () => {
    const counts = getAirportDayCounts(db, "UA", now);
    for (const airport of ["DEN", "GJT", "SBA", "BOI"]) {
      const board = buildAirportBoard(AIRLINES.UA, reader(), airport);
      const row = counts.find((c) => c.airport === airport);
      expect(board.today?.departures, airport).toBe(row?.today.departures);
      expect(board.tomorrow?.departures, airport).toBe(row?.tomorrow.departures);
    }
  });

  test("an airport under the ranking's minimum has a count and no rank", async () => {
    const board = buildAirportBoard(AIRLINES.UA, reader(), "BOI");
    expect(board.today?.departures).toBe(1);
    expect(board.today?.rank).toBeNull();
    const said = text(await page("/routes/BOI"));
    expect(said).toMatch(
      /1 Starlink departure today, \w+day, \w{3} \d{1,2}: 1 gone, 0 still to leave/
    );
    expect(said).not.toContain("No. ");
  });

  test("a hub page explains its count and credits no figure to the airline", async () => {
    const board = buildAirportBoard(AIRLINES.UA, reader(), "DEN");
    expect(Object.keys(board).filter((k) => /figure|share|ratio/i.test(k))).toEqual([]);
    const said = text(await page("/routes/DEN"));
    expect(said).toContain("it can rise as the day nears");
    expect(said).not.toMatch(/United's figure|own estimate|as reported by|Travel And Tour World/i);
  });
});

describe("home page", () => {
  test("links the ranking from its airport panel", async () => {
    expect(await page("/")).toContain('href="/routes#airports"');
    expect(await page("/", AS)).not.toContain('href="/routes#airports"');
  });
});
