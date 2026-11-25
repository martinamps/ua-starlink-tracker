import { describe, expect, test } from "bun:test";
import { ensureAdsbFlightDrawsTable } from "../src/database/adsb-flight-draws";
import { airlineOutlook, listingTime, routeOutlookFor } from "../src/database/outlook";
import { programmeRoster } from "../src/database/roster";
import { DAY_SEC } from "../src/database/sql/windows";
import { backtestCases, backtestMixShare, cutoffs, summarize } from "../src/outlook/backtest";
import {
  FLEET,
  MIN_INSTALLS_FOR_PACE,
  OUTLOOK_BACKTEST,
  PACE_WINDOWS_DAYS,
  paceWindows,
  typeOutlook,
} from "../src/outlook/pace";
import { publishedTargets } from "../src/outlook/published";
import {
  isStarlinkDeparture,
  monthKeys,
  routeDirection,
  routeMonths,
  routeOutlook,
} from "../src/outlook/route";
import { makeFreshDb, openSnapshot, utc } from "./helpers";

const NOW = utc("2026-11-24T00:00:00Z");
const daysAgo = (n: number) => NOW - n * DAY_SEC;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

describe("pace", () => {
  test("one window per configured span, rates non-negative", () => {
    const w = paceWindows([daysAgo(5), daysAgo(40), daysAgo(80), daysAgo(200)], NOW);
    expect(w.map((p) => p.days)).toEqual([...PACE_WINDOWS_DAYS]);
    for (const p of w) {
      expect(p.installs).toBeGreaterThanOrEqual(0);
      expect(p.perMonth).toBeGreaterThanOrEqual(0);
    }
    // Windows nest: a longer one never sees fewer installs.
    for (let i = 1; i < w.length; i++)
      expect(w[i].installs).toBeGreaterThanOrEqual(w[i - 1].installs);
  });

  test("future-dated installs are not counted", () => {
    expect(paceWindows([NOW + DAY_SEC], NOW).every((p) => p.installs === 0)).toBe(true);
  });
});

describe("typeOutlook", () => {
  const busy = Array.from({ length: 40 }, (_, i) => daysAgo(i * 2));

  test("complete when nothing remains", () => {
    const o = typeOutlook({ family: "E175", equipped: 10, total: 10, installedAt: [], now: NOW });
    expect(o.status).toBe("complete");
    expect(o.projection).toBeNull();
    expect(o.dateStatable).toBe(false);
  });

  test("no pace below the install floor, whatever remains", () => {
    const few = Array.from({ length: MIN_INSTALLS_FOR_PACE - 1 }, (_, i) => daysAgo(i + 1));
    const o = typeOutlook({
      family: "B787",
      equipped: few.length,
      total: 100,
      installedAt: few,
      now: NOW,
    });
    expect(o.status).toBe("no_pace");
    expect(o.projection).toBeNull();
    expect(o.dateStatable).toBe(false);
  });

  test("a line opened inside 90 days is starting, with no projection", () => {
    const fresh = Array.from({ length: MIN_INSTALLS_FOR_PACE }, (_, i) => daysAgo(i + 1));
    const o = typeOutlook({
      family: "B737-MAX8",
      equipped: fresh.length,
      total: 100,
      installedAt: fresh,
      now: NOW,
    });
    expect(o.status).toBe("starting");
    expect(o.projection).toBeNull();
    expect(o.next60Days).toBeNull();
  });

  test("a projected range is ordered and dated", () => {
    const o = typeOutlook({
      family: "B737-800",
      equipped: 40,
      total: 60,
      installedAt: busy,
      now: NOW,
    });
    expect(o.status).toBe("projected");
    const p = o.projection!;
    for (const d of [p.earliest, p.likely, p.latest!]) expect(d).toMatch(ISO);
    expect(p.earliest <= p.likely).toBe(true);
    expect(p.likely <= p.latest!).toBe(true);
    expect(o.share).toBeGreaterThan(0);
    expect(o.share).toBeLessThanOrEqual(1);
  });

  test("a date is statable only within the backtested horizon", () => {
    const far = typeOutlook({
      family: "X",
      equipped: 40,
      total: 4000,
      installedAt: busy,
      now: NOW,
    });
    expect(far.status).toBe("projected");
    expect(far.projection!.months).toBeGreaterThan(OUTLOOK_BACKTEST.maxStatableMonths);
    expect(far.dateStatable).toBe(false);
  });

  test("the next 60 days are an ordered range, never past what remains", () => {
    const o = typeOutlook({ family: "X", equipped: 40, total: 45, installedAt: busy, now: NOW });
    const n = o.next60Days!;
    expect(n.low).toBeLessThanOrEqual(n.likely);
    expect(n.likely).toBeLessThanOrEqual(n.high);
    expect(n.high).toBeLessThanOrEqual(o.remaining);
    const thin = typeOutlook({
      family: "X",
      equipped: 1,
      total: 45,
      installedAt: [daysAgo(1)],
      now: NOW,
    });
    expect(thin.next60Days).toBeNull();
  });

  test("undated equipped tails count but don't pace", () => {
    const o = typeOutlook({
      family: "X",
      equipped: 3,
      total: 10,
      installedAt: [null, null, daysAgo(1)],
      now: NOW,
    });
    expect(o.undated).toBe(2);
    expect(o.pace[0].installs).toBe(1);
  });

  test("a published target carries the rate it needs, none once past", () => {
    const source = { title: "t", url: "https://example.com" };
    const o = typeOutlook({
      family: "X",
      equipped: 40,
      total: 60,
      installedAt: busy,
      now: NOW,
      published: [
        { label: "future", deadline: "2027-12-31", statedOn: "2026-01-01", source },
        { label: "past", deadline: "2026-01-31", statedOn: "2025-01-01", source },
      ],
    });
    const [future, past] = o.published;
    expect(future.requiredPerMonth).toBeGreaterThan(0);
    expect(typeof future.onPace).toBe("boolean");
    expect(past.requiredPerMonth).toBeNull();
    expect(past.onPace).toBeNull();
  });
});

describe("published targets", () => {
  test("UA widebodies carry their own date beside the fleet-wide one", () => {
    const wide = publishedTargets("UA", "B787");
    const narrow = publishedTargets("UA", "B737-800");
    expect(wide.length).toBeGreaterThan(narrow.length);
    for (const t of [...wide, ...narrow]) {
      expect(t.deadline).toMatch(ISO);
      expect(t.statedOn).toMatch(ISO);
      expect(t.source.url).toMatch(/^https:\/\//);
    }
  });

  test("a count target applies to the fleet, never to one type", () => {
    expect(publishedTargets("UA", FLEET).some((t) => t.count !== undefined)).toBe(true);
    expect(publishedTargets("UA", "B737-800").some((t) => t.count !== undefined)).toBe(false);
  });
});

describe("route months", () => {
  const dep = (iso: string, equippedSince: number | null, family = "B737-800") => ({
    departedAt: utc(iso),
    tail: "N1",
    family,
    equippedSince,
  });

  test("a departure is Starlink only once its tail was listed", () => {
    const listed = utc("2026-10-15T00:00:00Z");
    expect(isStarlinkDeparture(dep("2026-10-14T12:00:00Z", listed))).toBe(false);
    expect(isStarlinkDeparture(dep("2026-10-16T12:00:00Z", listed))).toBe(true);
    expect(isStarlinkDeparture(dep("2026-10-16T12:00:00Z", null))).toBe(false);
  });

  test("months run oldest first and end with the current, unfinished one", () => {
    const keys = monthKeys(NOW, 4);
    expect(keys).toHaveLength(4);
    expect(keys.at(-1)).toBe("2026-11");
    const months = routeMonths([], NOW, 4);
    expect(months.map((m) => m.month)).toEqual(keys);
    expect(months.at(-1)!.complete).toBe(false);
    for (const m of months) expect(m.share).toBe(0);
  });

  test("direction needs two full months with enough departures", () => {
    expect(routeDirection(routeMonths([], NOW)).direction).toBe("too_few");
    const rising = [
      ...Array.from({ length: 30 }, () => dep("2026-09-10T00:00:00Z", null)),
      ...Array.from({ length: 30 }, () => dep("2026-10-10T00:00:00Z", 0)),
    ];
    const r = routeDirection(routeMonths(rising, NOW));
    expect(r.direction).toBe("rising");
    expect(r.changePoints).toBeGreaterThan(0);
  });

  test("types are shares of the window's departures", () => {
    const deps = [
      dep("2026-10-01T00:00:00Z", null, "B787"),
      dep("2026-10-02T00:00:00Z", 0, "B787"),
      dep("2026-10-03T00:00:00Z", null, "B777"),
    ];
    const o = routeOutlook({
      origin: "SFO",
      destination: "SIN",
      departures: deps,
      outlooks: new Map(),
      now: NOW,
    });
    expect(o.types.map((t) => t.family)).toEqual(["B787", "B777"]);
    expect(o.types.reduce((s, t) => s + t.share, 0)).toBeCloseTo(1);
  });
});

describe("backtest", () => {
  const installs = Array.from({ length: 200 }, (_, i) => ({
    family: i % 2 ? "A" : "B",
    installedAt: daysAgo(i),
  }));
  const totals = new Map([
    [FLEET, 400],
    ["A", 200],
    ["B", 200],
  ]);

  test("cutoffs stay a full horizon before now", () => {
    const cs = cutoffs(daysAgo(120), NOW, 30);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) expect(c + 30 * DAY_SEC).toBeLessThanOrEqual(NOW);
  });

  test("cases and summaries have the reported fields", () => {
    const cases = backtestCases({
      installs,
      totals,
      cutoffs: cutoffs(daysAgo(150), NOW, 30),
      horizonDays: 30,
      windowDays: 30,
    });
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c.actual).toBeGreaterThanOrEqual(0);
      if (c.projected !== null) expect(c.projected).toBeGreaterThanOrEqual(0);
    }
    const s = summarize(cases, 0.4);
    expect(new Set(s.map((x) => x.family))).toEqual(new Set([FLEET, "A", "B"]));
    for (const x of s) {
      expect(x.cases + x.noPace).toBeGreaterThan(0);
      if (x.wape !== null) expect(x.wape).toBeGreaterThanOrEqual(0);
    }
  });

  test("a mix's share stays within 0 and 1", () => {
    const r = backtestMixShare({
      mix: [
        { family: "A", weight: 3 },
        { family: "B", weight: 1 },
      ],
      installs,
      totals,
      cutoff: daysAgo(60),
      horizonDays: 30,
      windowDays: 30,
    });
    for (const v of [r.atCutoff, r.projected, r.actual]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("readers on the snapshot", () => {
  const db = openSnapshot();

  test("counts are the programme roster's, family by family", () => {
    const out = airlineOutlook(db, "UA", NOW);
    const roster = programmeRoster(db, "UA");
    expect(out.fleet.family).toBe(FLEET);
    expect(out.fleet.total).toBe(roster.length);
    expect(out.fleet.equipped).toBe(roster.filter((t) => t.equipped).length);
    expect(out.families.reduce((s, f) => s + f.total, 0)).toBe(out.fleet.total);
    expect(out.families.reduce((s, f) => s + f.equipped, 0)).toBe(out.fleet.equipped);
  });

  test("one airline's outlook never counts another's tails", () => {
    const ha = airlineOutlook(db, "HA", NOW);
    expect(ha.fleet.total).toBe(programmeRoster(db, "HA").length);
    expect(airlineOutlook(db, "UA", NOW).fleet.total).toBe(programmeRoster(db, "UA").length);
  });

  test("a route answers with months even with no departures held", () => {
    const r = routeOutlookFor(db, "UA", "SFO", "SIN", NOW);
    expect(r).not.toBeNull();
    expect(r!.months.length).toBeGreaterThan(0);
    expect(["rising", "flat", "falling", "too_few"]).toContain(r!.direction);
  });

  test("no departure history outside UA", () => {
    expect(routeOutlookFor(db, "HA", "HNL", "LAX", NOW)).toBeNull();
  });
});

describe("route reader", () => {
  test("counts single-pair numbers' draws by the tail's listing date", () => {
    const db = makeFreshDb();
    ensureAdsbFlightDrawsTable(db);
    const seen = utc("2026-11-20T00:00:00Z");
    db.exec(`
      INSERT INTO united_fleet (tail_number, aircraft_type, fleet, starlink_status, first_seen_source, first_seen_at, last_seen_at, airline)
      VALUES ('N1', 'Boeing 787-9', 'mainline', 'unknown', 't', 0, 0, 'UA'),
             ('N2', 'Boeing 787-9', 'mainline', 'unknown', 't', 0, 0, 'UA');
      INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, airline)
      VALUES ('Boeing 787-9', 'Starlink', 't', 'UA-mainline', '2026-10-15', 'N1', 'United Airlines', 'mainline', 'UA');
    `);
    db.query(
      "INSERT INTO flight_routes (flight_number, origin, destination, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
    ).run("UA1", "SFO", "SIN", seen, seen);
    // A through number: also flies another pair, so it says nothing about this one.
    for (const [o, d] of [
      ["SFO", "SIN"],
      ["SIN", "BLR"],
    ]) {
      db.query(
        "INSERT INTO flight_routes (flight_number, origin, destination, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
      ).run("UA9", o, d, seen, seen);
    }
    const draw = db.query(
      "INSERT INTO adsb_flight_draws (flight_number, tail_number, first_seen, last_seen) VALUES (?, ?, ?, ?)"
    );
    draw.run("UA1", "N1", utc("2026-10-01T00:00:00Z"), utc("2026-10-01T10:00:00Z"));
    draw.run("UA1", "N1", utc("2026-10-20T00:00:00Z"), utc("2026-10-20T10:00:00Z"));
    draw.run("UA1", "N2", utc("2026-10-21T00:00:00Z"), utc("2026-10-21T10:00:00Z"));
    draw.run("UA9", "N1", utc("2026-10-22T00:00:00Z"), utc("2026-10-22T10:00:00Z"));

    const r = routeOutlookFor(db, "UA", "SFO", "SIN", NOW)!;
    expect(r.flightNumbers).toEqual(["UA1"]);
    expect(r.excludedFlightNumbers).toEqual(["UA9"]);
    const oct = r.months.find((m) => m.month === "2026-10")!;
    expect(oct.departures).toBe(3);
    expect(oct.starlink).toBe(1);
    expect(r.types.map((t) => t.family)).toEqual(["B787"]);
    expect(r.types[0].outlook?.total).toBe(2);
  });
});

test("listing dates parse only as ISO days", () => {
  expect(listingTime("2026-10-15")).toBe(utc("2026-10-15T00:00:00Z"));
  expect(listingTime("2026-10-15T08:00:00Z")).toBe(utc("2026-10-15T00:00:00Z"));
  expect(listingTime("10/15/2026")).toBeNull();
  expect(listingTime(null)).toBeNull();
});
