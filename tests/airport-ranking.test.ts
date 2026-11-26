/**
 * "Which airports have the most Starlink flights?": the per-day count behind
 * the ranking on /routes and each airport page's dated figure.
 *
 * Seeded on a fresh database around each airport's own next local day, so the
 * rules are pinned on rows the test wrote: one flight is one departure however
 * it is spelled or listed, the day is the airport's, the airline's own figure
 * rides beside ours only as the airline's, and no share is printed.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { HUB_FIGURE_MAX_AGE_DAYS, hubFigures } from "../src/airlines/hub-figures";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { buildAirportBoard } from "../src/api/airport-board";
import { AIRPORT_RANK_MIN_DEPARTURES, buildAirportRanking } from "../src/api/airport-ranking";
import { getAirportDayCounts, nextLocalDay } from "../src/database/airports";
import { getRouteStarlinkSchedule } from "../src/database/database";
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

beforeAll(() => {
  db = makeFreshDb();
  addPlane(db, "N1VER", "Starlink");
  addPlane(db, "N2LIST", null);
  // The sheet lists this tail on two tabs: two listings, one aircraft.
  addPlane(db, "N3TWICE", null);
  addPlane(db, "N3TWICE", null);

  // DEN, a hub with a United figure: four departures on its next local day.
  addFlight(db, "N1VER", "UA100", "DEN", onNextDay("DEN", 14), { arrivalAirport: "ORD" });
  addFlight(db, "N2LIST", "UA200", "DEN", onNextDay("DEN", 12), { arrivalAirport: "SFO" });
  // One flight under its marketed and its operating spelling: one departure.
  addFlight(db, "N2LIST", "UA5212", "DEN", onNextDay("DEN", 8), { arrivalAirport: "GJT" });
  addFlight(db, "N2LIST", "SKW5212", "DEN", onNextDay("DEN", 8), { arrivalAirport: "GJT" });
  addFlight(db, "N3TWICE", "UA300", "DEN", onNextDay("DEN", 6), { arrivalAirport: "IAH" });
  // Still today at DEN, or already gone: either way not the next day's.
  addFlight(db, "N1VER", "UA101", "DEN", now + 60, { arrivalAirport: "ORD" });
  // A tail with no listing is not a Starlink plane.
  addFlight(db, "N9NONE", "UA900", "DEN", onNextDay("DEN", 10), { arrivalAirport: "ORD" });

  // GJT and SBA tie on two; BOI has one and is listed, not ranked.
  for (const [i, airport] of ["GJT", "SBA"].entries()) {
    addFlight(db, "N1VER", `UA${400 + i}`, airport, onNextDay(airport, 13), {
      arrivalAirport: "DEN",
    });
    addFlight(db, "N2LIST", `UA${410 + i}`, airport, onNextDay(airport, 9), {
      arrivalAirport: "DEN",
    });
  }
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
  test("counts each departure on the airport's next local day once", () => {
    const rows = getAirportDayCounts(db, "UA", now);
    const den = rows.find((r) => r.airport === "DEN");
    // UA100, UA200, UA5212 (two spellings) and UA300 (a tail listed twice).
    expect(den).toEqual({
      airport: "DEN",
      date: nextLocalDay("DEN", now) as string,
      departures: 4,
    });
    expect(rows.find((r) => r.airport === "BOI")?.departures).toBe(1);
    expect(rows.every((r) => r.departures > 0)).toBe(true);
    expect(rows.map((r) => r.departures)).toEqual(
      [...rows.map((r) => r.departures)].sort((a, b) => b - a)
    );
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

describe("buildAirportRanking", () => {
  test("ranks from the minimum up, equal counts sharing a rank", () => {
    const ranking = buildAirportRanking(AIRLINES.UA, reader(), now);
    expect(ranking.rows.map((r) => [r.rank, r.airport])).toEqual([
      [1, "DEN"],
      [2, "GJT"],
      [2, "SBA"],
    ]);
    expect(ranking.rows.every((r) => r.departures >= AIRPORT_RANK_MIN_DEPARTURES)).toBe(true);
    expect(ranking.unranked).toEqual(["BOI"]);
    expect(ranking.date).toBe(nextLocalDay("DEN", now));
  });

  test("the airline's own figure sits on its hubs only, and carries its source", () => {
    const figures = hubFigures("UA", Date.parse("2026-11-26T00:00:00Z") / 1000);
    expect(figures).not.toBeNull();
    expect(Object.keys(figures?.perDay ?? {}).sort()).toEqual(
      ["DEN", "EWR", "IAD", "IAH", "LAX", "ORD", "SFO"].sort()
    );
    expect(figures?.reported).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(figures?.source.url).toMatch(/^https:\/\//);
    expect(figures?.source.url).not.toContain("united.com");
    const ranking = buildAirportRanking(AIRLINES.UA, reader(), now);
    for (const r of ranking.rows) {
      expect(r.airlineFigure, r.airport).toBe(ranking.figures?.perDay[r.airport] ?? null);
    }
    expect(Object.keys(ranking).filter((k) => /share|ratio|percent/i.test(k))).toEqual([]);
  });

  test("a figure past its age bound is no longer shown, and no other airline has one", () => {
    const reported = Date.parse(`${hubFigures("UA", 0)?.reported}T00:00:00Z`) / 1000;
    expect(hubFigures("UA", reported + HUB_FIGURE_MAX_AGE_DAYS * 86400)).not.toBeNull();
    expect(hubFigures("UA", reported + (HUB_FIGURE_MAX_AGE_DAYS + 1) * 86400)).toBeNull();
    expect(hubFigures("AS", reported)).toBeNull();
    const late = reported + (HUB_FIGURE_MAX_AGE_DAYS + 1) * 86400;
    expect(buildAirportRanking(AIRLINES.UA, reader(), late).figures).toBeNull();
    expect(buildAirportBoard(AIRLINES.UA, reader(), "DEN", late).airlineFigure).toBeNull();
  });
});

describe("/routes", () => {
  test("ranks the airports for a dated day, each linked to its page", async () => {
    const body = await page("/routes");
    const block = sectionOf(body, "Airports with the most Starlink departures");
    for (const airport of ["DEN", "GJT", "SBA", "BOI"]) {
      expect(block, airport).toContain(`href="/routes/${airport}"`);
    }
    expect(body).toContain('id="airports"');
    // The day is named, weekday and date.
    expect(text(block)).toMatch(/scheduled on Starlink planes for \w+day, \w{3} \d{1,2}/);
    expect(text(block)).toContain("we list as having Starlink");
    expect(text(block)).toContain("swapped before departure");
  });

  test("shows the airline's figure as the airline's, dated and sourced, and no share", async () => {
    const ranking = buildAirportRanking(AIRLINES.UA, reader());
    const block = sectionOf(await page("/routes"), "Airports with the most Starlink departures");
    const said = text(block);
    if (ranking.figures) {
      expect(said).toContain("United's own estimate of equipped departures a day, as reported by");
      expect(block).toContain(`href="${ranking.figures.source.url}"`);
      expect(said).toContain("different day from ours");
    } else {
      expect(said).not.toContain("own estimate");
    }
    expect(said).not.toMatch(/\d\s*%|percent/i);
  });

  test("an airline without airport pages keeps its top-airport bars", async () => {
    const body = await page("/routes", AS);
    expect(body).toContain("Busiest airports");
    expect(body).not.toContain("Airports with the most Starlink departures");
  });
});

describe("/routes/{airport}", () => {
  test("gives the day's count with its date and its place in the ranking", async () => {
    const board = buildAirportBoard(AIRLINES.UA, reader(), "DEN");
    expect(board.day).toEqual({
      date: nextLocalDay("DEN") as string,
      departures: 4,
      rank: 1,
      ranked: 3,
    });
    const said = text(await page("/routes/DEN"));
    expect(said).toMatch(/4 Starlink departures scheduled for \w+day, \w{3} \d{1,2}/);
    expect(said).toContain("No. 1 of 3 airports");
    expect(said).toContain("DEN's own calendar day");
  });

  test("the day's count is a count of the rows the page lists", () => {
    for (const airport of ["DEN", "GJT", "BOI"]) {
      const board = buildAirportBoard(AIRLINES.UA, reader(), airport);
      const date = board.day?.date as string;
      expect(board.day?.departures, airport).toBe(
        board.departures.filter((d) => airportLocalDate(airport, d.departure_time) === date).length
      );
    }
  });

  test("an airport under the ranking's minimum has a count and no rank", async () => {
    const board = buildAirportBoard(AIRLINES.UA, reader(), "BOI");
    expect(board.day?.departures).toBe(1);
    expect(board.day?.rank).toBeNull();
    const said = text(await page("/routes/BOI"));
    expect(said).toMatch(/1 Starlink departure scheduled for/);
    expect(said).not.toContain("No. ");
  });

  test("the airline's figure appears at its hubs alone", async () => {
    const hub = buildAirportBoard(AIRLINES.UA, reader(), "DEN");
    const spoke = buildAirportBoard(AIRLINES.UA, reader(), "GJT");
    expect(spoke.airlineFigure).toBeNull();
    const [den, gjt] = [text(await page("/routes/DEN")), text(await page("/routes/GJT"))];
    expect(gjt).not.toContain("own estimate");
    if (hub.airlineFigure) {
      expect(den).toContain("United's figure for DEN:");
      expect(den).toContain("as reported by");
    } else {
      expect(den).not.toContain("own estimate");
    }
  });
});

describe("home page", () => {
  test("links the ranking from its airport panel", async () => {
    expect(await page("/")).toContain('href="/routes#airports"');
    expect(await page("/", AS)).not.toContain('href="/routes#airports"');
  });
});
