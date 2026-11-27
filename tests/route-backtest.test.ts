import { describe, expect, test } from "bun:test";
import { ensureAdsbFlightDrawsTable } from "../src/database/adsb-flight-draws";
import { ROUTE_BACKTEST_SAMPLE, routeBacktests } from "../src/database/outlook";
import { DAY_SEC } from "../src/database/sql/windows";
import { formatRouteBacktest, runRouteBacktest } from "../src/scripts/route-backtest";
import { makeFreshDb, openSnapshot, utc } from "./helpers";

const NOW = utc("2026-11-24T00:00:00Z");

/** 30 787s, 10 listed with Starlink on 1 Sep; UA1 flies SFO-SIN daily on
 * rotating tails through October and November. November's draws carry their
 * airports; October's predate placing. */
function seeded() {
  const db = makeFreshDb();
  ensureAdsbFlightDrawsTable(db);
  const fleet = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, starlink_status, first_seen_source, first_seen_at, last_seen_at, airline)
     VALUES (?, 'Boeing 787-9', 'mainline', 'unknown', 't', 0, 0, 'UA')`
  );
  const listed = db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, airline)
     VALUES ('Boeing 787-9', 'Starlink', 't', 'UA-mainline', '2026-09-01', ?, 'United Airlines', 'mainline', 'UA')`
  );
  for (let i = 1; i <= 30; i++) {
    fleet.run(`N${i}`);
    if (i <= 10) listed.run(`N${i}`);
  }
  const seen = utc("2026-11-20T00:00:00Z");
  db.query(
    "INSERT INTO flight_routes (flight_number, origin, destination, first_seen_at, last_seen_at) VALUES ('UA1', 'SFO', 'SIN', ?, ?)"
  ).run(seen, seen);
  const draw = db.query(
    "INSERT INTO adsb_flight_draws (flight_number, tail_number, first_seen, last_seen, origin, destination) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const oct = utc("2026-10-01T08:00:00Z");
  for (let d = 0; d < 30; d++)
    draw.run("UA1", `N${(d % 30) + 1}`, oct + d * DAY_SEC, oct + d * DAY_SEC + 3600, null, null);
  const nov = utc("2026-11-01T08:00:00Z");
  for (let d = 0; d < 22; d++)
    draw.run("UA1", `N${(d % 30) + 1}`, nov + d * DAY_SEC, nov + d * DAY_SEC + 3600, "SFO", "SIN");
  // Another airline's flight seen on the same pair is not United's departure.
  draw.run("AS1", "N1", nov, nov + 3600, "SFO", "SIN");
  return db;
}

describe("route backtest", () => {
  test("both ways of finding departures, each with months, mix and checks", () => {
    const [byNumbers, placed] = routeBacktests(seeded(), "UA", "SFO", "SIN", NOW);
    expect(byNumbers.source).toBe("numbers");
    expect(placed.source).toBe("placed");

    expect(byNumbers.months.find((m) => m.month === "2026-10")).toMatchObject({
      departures: 30,
      starlink: 10,
    });
    expect(byNumbers.types).toEqual([{ family: "B787", share: 1 }]);
    expect(byNumbers.checks).toHaveLength(1);
    const [nov] = byNumbers.checks;
    expect(nov.month).toBe("2026-11");
    expect(nov.departures).toBe(22);
    expect(nov.projected).toBeCloseTo(1 / 3, 5);
    expect(nov.actual).toBeCloseTo(10 / 22, 5);
    expect(byNumbers.meanAbsErrorPoints).toBeCloseTo(Math.abs(1 / 3 - 10 / 22) * 100, 5);

    // Only November is placed: no month before it to project from.
    expect(placed.months.find((m) => m.month === "2026-11")!.departures).toBe(22);
    expect(placed.checks).toEqual([]);
    expect(placed.meanAbsErrorPoints).toBeNull();
  });

  test("no outlook outside the backtested airlines", () => {
    expect(routeBacktests(seeded(), "HA", "HNL", "LAX", NOW)).toEqual([]);
  });

  test("the log line names the route, source, months and error", () => {
    const [byNumbers, placed] = routeBacktests(seeded(), "UA", "SFO", "SIN", NOW);
    const line = formatRouteBacktest("UA", byNumbers);
    expect(line).toStartWith("route-backtest UA SFO-SIN source=numbers ");
    expect(line).toContain("2026-10:10/30(33%)");
    expect(line).toContain("2026-11:10/22(45%)*");
    expect(line).toContain("types=B787:100%");
    expect(line).toMatch(/checks=2026-11:proj 33% act 45% n=22 mae=\d+\.\dpt$/);
    expect(formatRouteBacktest("UA", placed)).toMatch(/checks=none mae=–$/);
  });

  test("a run pools the checks per source", () => {
    const run = runRouteBacktest(seeded(), "UA", NOW, [["SFO", "SIN"]]);
    expect(run.results).toHaveLength(2);
    expect(run.pooled.numbers.checks).toBe(1);
    expect(run.pooled.placed).toEqual({ checks: 0, meanAbsErrorPoints: null });
  });

  test("the daily sample runs on the snapshot without error", () => {
    const run = runRouteBacktest(openSnapshot(), "UA", NOW);
    expect(run.results).toHaveLength(ROUTE_BACKTEST_SAMPLE.length * 2);
    for (const r of run.results) {
      expect(r.months.length).toBeGreaterThan(0);
      for (const c of r.checks) {
        expect(c.projected).toBeGreaterThanOrEqual(0);
        expect(c.projected).toBeLessThanOrEqual(1);
      }
    }
  });
});
