/**
 * The re-check plan, the ground-gap allowance and the sheet-listing bump, all
 * on at once, under the ceiling on checks of united.com: the real verifier,
 * fleet discovery and sheet sync against a stand-in checker and a fake clock.
 * No test here reaches united.com, FR24, the sheet or any other host.
 */

import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMeta,
  migrate,
  negativeRecheckPlan,
  reconcileConsensus,
  recordAirborneSightings,
  setMeta,
  updateDatabase,
} from "../src/database/database";
import {
  SHEET_LISTING_BUMPS_PER_DAY,
  SHEET_LISTING_NOTED_SECS,
  gapChecksPerDay,
} from "../src/database/discovery-cadence";
import { recordSourceSuccess } from "../src/database/source-health";
import { equippedSql } from "../src/database/sql/equipped";
import { metrics } from "../src/observability";
import { runDiscoveryBatch } from "../src/scripts/fleet-discovery";
import { runVerifierTick } from "../src/scripts/starlink-verifier";
import {
  UNITED_DAILY_CHECK_BUDGET,
  UNITED_SETTLE_RESERVE,
  unitedBudgetState,
} from "../src/scripts/united-check-budget";
import type { FleetStats } from "../src/types";
import { makeFreshDb, utc } from "./helpers";
import { DAY, HOUR, busiestDay, runClock, seedFleet } from "./united-check-sim";

const VERIFIER_BEAT = 60;
const DISCOVERY_BEAT = 90;
const SWEEP_SECS = 300;

// The backtest behind the hours-sooner estimate runs 80 simulated fortnights:
// about a minute. NEW_TAIL_BACKTEST=1 runs it; the suite runs one case of it.
const RUN_BACKTEST = process.env.NEW_TAIL_BACKTEST === "1";

const T0 = utc("2026-12-01T00:00:00Z");
const T0_MS = T0 * 1000;
const HOT = "Boeing 737-900";
const QUIET = "Airbus A319-131";
const STATS: FleetStats = {
  express: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
  mainline: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
};

let quiet: Array<{ mockRestore(): void }> = [];
function report(lines: string[]): void {
  for (const q of quiet) q.mockRestore();
  console.log(lines.join("\n"));
}
beforeEach(() => {
  quiet = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  for (const q of quiet) q.mockRestore();
  setSystemTime();
});
afterAll(() => setSystemTime());

const nowSec = () => Math.floor(Date.now() / 1000);

function openFile(path: string): Database {
  const handle = new Database(path);
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA synchronous = OFF");
  migrate(handle);
  return handle;
}

/** The sheet as the hourly read parses it: every listed tail on one mainline tab. */
function sheetOf(tails: readonly string[]) {
  return tails.map((TailNumber) => ({
    TailNumber,
    Aircraft: HOT,
    WiFi: "StrLnk",
    sheet_gid: "100",
    sheet_type: "B737",
    fleet: "mainline" as const,
    OperatedBy: "United Airlines",
  }));
}

/** The seeded listings become sheet rows, so the sync replaces them in place. */
function listingsFromSheet(db: Database): void {
  db.query("UPDATE starlink_planes SET sheet_gid = '100', sheet_type = 'B737'").run();
}

/** The hourly sheet job's read and its sweep, as sheet-scrape.ts runs them. */
function hourlySheetJob(db: Database, sheet: ReturnType<typeof sheetOf>): void {
  expect(updateDatabase(db, 1000, sheet, STATS, "UA")).toBeNull();
  recordSourceSuccess(db, "sheet_scrape", "UA");
  reconcileConsensus(db);
}

function isCounted(db: Database, tail: string): boolean {
  return (
    db
      .query(`SELECT 1 FROM starlink_planes sp WHERE sp.TailNumber = ? AND ${equippedSql("sp")}`)
      .get(tail) != null
  );
}

function fleetRow(db: Database, tail: string) {
  return db
    .query(
      "SELECT starlink_status, next_check_after, discovery_priority FROM united_fleet WHERE tail_number = ?"
    )
    .get(tail) as { starlink_status: string; next_check_after: number; discovery_priority: number };
}

/** fleet.check_skipped points, by reason, while the returned stop() has not been called. */
function countSkips(): { by: Record<string, number>; stop(): void } {
  const by: Record<string, number> = {};
  const original = metrics.increment;
  metrics.increment = (name, tags) => {
    if (name === "fleet.check_skipped") {
      const reason = String((tags as Record<string, unknown> | undefined)?.reason);
      by[reason] = (by[reason] ?? 0) + 1;
    }
    original(name, tags);
  };
  return {
    by,
    stop() {
      metrics.increment = original;
    },
  };
}

describe("plan, allowance and sheet bump together, under the ceiling", () => {
  test("36 hours with more due than budget, across a restart: never more than 364 in any 24 hours", async () => {
    // The day before: 340 checks in the log and no ledger (the state this
    // ships into). 500 settled tails all overdue for the verifier. 300
    // negative tails in two families, one being retrofitted: 150 come due
    // across the run, 20 of them at once at hour 12; 150 are days away. Of
    // those, the sheet lists four (hours 9 and 22) and eighteen fly again
    // after a ground gap (hours 6, 20 and 31). A restart at hour 18.
    const dir = mkdtempSync(join(tmpdir(), "new-tails-36h-"));
    const path = join(dir, "db.sqlite");
    const END = T0 + 36 * HOUR;
    let db = openFile(path);
    const skips = countSkips();
    try {
      setSystemTime(new Date(T0_MS));
      const fleet = seedFleet(db, T0, {
        equipped: 500,
        unequipped: 300,
        dueWithinDays: 1.4,
        lastReadHoursAgo: [100, 170],
      });
      listingsFromSheet(db);
      const isHot = (tail: string) => fleet.unequipped.indexOf(tail) % 2 === 0;
      for (const tail of fleet.unequipped) {
        if (!isHot(tail)) {
          db.query("UPDATE united_fleet SET aircraft_type = ? WHERE tail_number = ?").run(
            QUIET,
            tail
          );
        }
      }
      // Twelve installs found in the 737-900 family this month: it is the retrofit family.
      for (const tail of fleet.equipped.slice(0, 12)) {
        db.query("UPDATE starlink_planes SET DateFound = '2026-11-20' WHERE TailNumber = ?").run(
          tail
        );
      }
      const plan = negativeRecheckPlan(db, "UA", T0);
      expect(plan.daysFor("x", HOT)).toBeLessThan(plan.daysFor("x", QUIET));
      const allowance = gapChecksPerDay(plan.negativeTails);
      expect(allowance).toBe(2);

      const dueInRun = fleet.unequipped.slice(0, 150);
      const far = fleet.unequipped.slice(150);
      const FAR_DUE = T0 + 10 * DAY;
      for (const tail of far) {
        db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = ?").run(
          FAR_DUE,
          tail
        );
      }
      const burst = dueInRun.slice(0, 20);
      for (const tail of burst) {
        db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = ?").run(
          T0 + 12 * HOUR,
          tail
        );
      }

      // The sheet lists two tails at hour 9 and two at hour 22: one of each
      // pair has a scheduled flight (the verifier can read it too), one has
      // none (only discovery, so only the bump, reaches it).
      const listings = [
        { at: T0 + 9 * HOUR, tails: [far[0], far[1]] },
        { at: T0 + 22 * HOUR, tails: [far[2], far[3]] },
      ];
      const withFlight = new Set([far[0], far[2]]);
      const listedAt = new Map<string, number>();
      for (const l of listings) for (const tail of l.tails) listedAt.set(tail, l.at);

      // Ground-gap returns: hot-family tails last seen airborne 40 hours
      // before the run, with the sweeps running all the while.
      const hotFar = far.slice(4).filter(isHot);
      const returns = [
        { at: T0 + 6 * HOUR, tails: hotFar.slice(0, 6) },
        { at: T0 + 20 * HOUR, tails: hotFar.slice(6, 12) },
        { at: T0 + 31 * HOUR, tails: hotFar.slice(12, 18) },
      ];
      for (const r of returns) {
        for (const tail of r.tails) {
          db.query("UPDATE united_fleet SET adsb_last_airborne = ? WHERE tail_number = ?").run(
            T0 - 40 * HOUR,
            tail
          );
        }
      }
      const addSweep = db.query(
        `INSERT INTO adsb_sweeps (swept_at, provider, requests, latency_ms, tails_queried, observed, airborne, matched, mismatched, no_assignment, no_callsign)
         VALUES (?, 'test', 1, 1, 900, 400, 400, 0, 0, 0, 0)`
      );
      db.transaction(() => {
        for (let at = T0 - 41 * HOUR; at < END; at += SWEEP_SECS) addSweep.run(at);
      })();
      const pulledAt = new Map<string, number>();

      const yesterday = Array.from(
        { length: 340 },
        (_, i) => T0 - DAY + Math.floor((i * DAY) / 340) + 60
      );
      const logYesterday = db.query(
        `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
         VALUES (?, 'united', ?, 1, 'Starlink', 1, 'UA')`
      );
      yesterday.forEach((at, i) => logYesterday.run(`N9${i}`, at));
      expect(getMeta(db, "united_check_budget", "UA")).toBeNull();
      expect(unitedBudgetState(db).used).toBe(340);

      const held = {
        verifier: { settle: 0, reconfirm: 0 },
        discovery: { settle: 0, reconfirm: 0 },
      };
      const listed = [...fleet.equipped];
      /** What the hourly jobs do at the top of an hour, before either checker job ticks. */
      const onTheHour = () => {
        const now = nowSec();
        if ((now - T0) % HOUR !== 0) return;
        for (const l of listings) {
          if (l.at !== now) continue;
          for (const tail of l.tails) {
            listed.push(tail);
            fleet.retrofit(tail);
            if (withFlight.has(tail)) fleet.scheduleFlight(db, tail, now);
          }
        }
        // The real hourly sheet sync and its sweep, every hour, whether or not anything is new.
        hourlySheetJob(db, sheetOf(listed));
        for (const r of returns) {
          if (r.at !== now) continue;
          for (const tail of recordAirborneSightings(db, "UA", r.tails, now, SWEEP_SECS)) {
            pulledAt.set(tail, now);
          }
        }
      };
      const run = (fromSec: number, toSec: number) =>
        runClock({
          db,
          fleet,
          fromSec,
          toSec,
          verifierEverySec: VERIFIER_BEAT,
          discoveryEverySec: DISCOVERY_BEAT,
          verifierTick: async () => {
            onTheHour();
            const tick = await runVerifierTick(db, fleet.verifier);
            if (tick.held) held.verifier[tick.held]++;
          },
          discoveryTick: async () => {
            const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
            if (stats.held) held.discovery[stats.held]++;
          },
        });

      const restartAt = T0 + 18 * HOUR;
      await run(T0, restartAt);
      const usedBeforeRestart = unitedBudgetState(db).used;
      db.close();
      db = openFile(path);
      fleet.reopen(db);
      expect(unitedBudgetState(db).used).toBe(usedBeforeRestart);
      await run(restartAt, END);

      const { checks } = fleet;
      const starts = [...yesterday, ...checks.map((c) => c.at)];
      const checksOf = (tail: string) => checks.filter((c) => c.tail === tail);
      const unequipped = checks.filter((c) => c.kind === "unequipped");
      const equipped = checks.filter((c) => c.kind === "equipped");
      const scheduled = unequipped.filter((c) => dueInRun.includes(c.tail));
      const worstScheduledLate = Math.max(...scheduled.map((c) => c.lateBy));
      const lastDay = checks.filter((c) => c.at >= END - DAY).length;
      const listingWaits = [...listedAt].map(([tail, at]) => checksOf(tail)[0]?.at - at);
      const pullWaits = [...pulledAt].map(([tail, at]) => checksOf(tail)[0]?.at - at);
      report([
        "[new-tails-under-ceiling] 36 hours, plan + allowance + sheet bump on, 500 overdue settled + 300 negative tails, restart at hour 18:",
        `  busiest 24 hours        ${busiestDay(starts)} (ceiling ${UNITED_DAILY_CHECK_BUDGET}); last 24 hours ${lastDay}`,
        `  scheduled unequipped    ${new Set(scheduled.map((c) => c.tail)).size} of 150 checked, worst ${(worstScheduledLate / 60).toFixed(1)} min late`,
        `  sheet-listed tails      ${listingWaits.length} listed, first read ${listingWaits.map((w) => `${w} s`).join(", ")} after the sync`,
        `  ground-gap returns      ${pulledAt.size} pulled of 18 seen (allowance ${allowance} a day), read ${pullWaits.map((w) => `${w} s`).join(", ")} after the sweep`,
        `  equipped checked        ${new Set(equipped.map((c) => c.tail)).size} of 500`,
        `  turns put off unspent   ${JSON.stringify(skips.by)}`,
        `  ticks sat out           verifier ${held.verifier.reconfirm} (settle ${held.verifier.settle}), discovery ${held.discovery.reconfirm} (settle ${held.discovery.settle})`,
      ]);

      // The ceiling, in every rolling 24 hours: the day before, the restart,
      // the burst, the pulls and the listings included.
      expect(busiestDay(starts)).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
      // And it is reached: more was due than the budget.
      expect(lastDay).toBeGreaterThanOrEqual(
        UNITED_DAILY_CHECK_BUDGET - UNITED_SETTLE_RESERVE - 10
      );
      expect(held.verifier.reconfirm).toBeGreaterThan(1000);

      // Unequipped aircraft are reached as soon as under the ceiling alone:
      // none was ever held, and the worst wait is the 20-tail burst at one
      // tail per tick, plus the few named tails that went ahead of it.
      expect(new Set(scheduled.map((c) => c.tail)).size).toBe(150);
      expect(held.discovery.settle).toBe(0);
      expect(held.verifier.settle).toBe(0);
      expect(worstScheduledLate).toBeLessThanOrEqual(24 * DISCOVERY_BEAT);
      expect(Math.min(...scheduled.map((c) => c.lateBy))).toBeGreaterThanOrEqual(0);

      // The plan's order: when the burst is all due at once, the retrofit
      // family is read before the quiet one.
      const burstAt = (hot: boolean) =>
        burst.filter((t) => isHot(t) === hot).map((t) => checksOf(t)[0].at);
      expect(Math.max(...burstAt(true))).toBeLessThan(Math.min(...burstAt(false)));
      // And its intervals: a tail read as non-Starlink comes round sooner in
      // the retrofit family, and no later than 28 days (plus the 10% spread) in any.
      const nextDays = (tail: string) => (fleetRow(db, tail).next_check_after - T0) / DAY;
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const checkedDue = dueInRun.filter((t) => !burst.includes(t));
      expect(mean(checkedDue.filter(isHot).map(nextDays))).toBeLessThan(
        mean(checkedDue.filter((t) => !isHot(t)).map(nextDays))
      );
      for (const tail of dueInRun) expect(nextDays(tail)).toBeLessThanOrEqual(1.5 + 28 * 1.1001);

      // A newly sheet-listed tail we held as not Starlink is read at once: by
      // whichever job ticks first when it has a flight on file, and by
      // discovery, moved up, when it has none. Each still claimed its slot.
      for (const [tail, at] of listedAt) {
        const mine = checksOf(tail);
        expect(mine.length).toBeGreaterThanOrEqual(1);
        expect(mine[0].at - at).toBeLessThanOrEqual(2 * DISCOVERY_BEAT);
        if (!withFlight.has(tail)) expect(mine[0].by).toBe("discovery");
        // One reading, not two a minute apart: the next comes on the daily
        // pace (the verifier's 24 hours, spread a third either way by tail).
        for (let i = 1; i < mine.length; i++) {
          expect(mine[i].at - mine[i - 1].at).toBeGreaterThanOrEqual(24 * 0.67 * HOUR);
        }
        // The sheet lists it and our one reading is Starlink: counted on that
        // reading, and nothing is settled by it.
        expect(isCounted(db, tail)).toBe(true);
        expect(fleetRow(db, tail).starlink_status).not.toBe("confirmed");
      }
      expect(skips.by.just_read ?? 0).toBeGreaterThanOrEqual(2);
      // Moved once, at the listing: thirty-odd later syncs left it alone.
      for (const tail of far.slice(4)) {
        if (!pulledAt.has(tail)) expect(fleetRow(db, tail).next_check_after).toBe(FAR_DUE);
      }

      // The allowance: two pulls in any rolling day, however many return.
      expect(pulledAt.size).toBe(2 * allowance);
      expect(busiestDay([...pulledAt.values()].sort((a, b) => a - b))).toBeLessThanOrEqual(
        allowance
      );
      for (const [tail, at] of pulledAt) {
        expect(checksOf(tail)[0].at - at).toBeLessThanOrEqual(3 * DISCOVERY_BEAT);
        expect(checksOf(tail)[0].by).toBe("discovery");
      }

      // What the ceiling's own changes did is still done. The verifier takes
      // the longest-waiting equipped tail, so none was looked at twice...
      expect(new Set(equipped.map((c) => c.tail)).size).toBe(equipped.length);
      expect(equipped.length).toBeGreaterThan(200);
      // ...and discovery put off settled tails the verifier had just confirmed.
      expect(skips.by.verifier_fresh ?? 0).toBeGreaterThan(0);
    } finally {
      skips.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe("discovery and a tail either job has just read", () => {
  function setup() {
    const db = makeFreshDb();
    setSystemTime(new Date(T0_MS));
    const fleet = seedFleet(db, T0, { equipped: 0, unequipped: 1 });
    setMeta(db, "united_check_budget", "[]", "UA");
    const [tail] = fleet.unequipped;
    db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = ?").run(T0, tail);
    const addRead = (
      hoursAgo: number,
      over: { starlink?: boolean; error?: string; confirmed?: number } = {}
    ) =>
      db
        .query(
          `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, error, tail_confirmed, airline)
           VALUES (?, 'united', ?, ?, ?, ?, ?, 'UA')`
        )
        .run(
          tail,
          T0 - Math.floor(hoursAgo * HOUR),
          over.error ? null : over.starlink ? 1 : 0,
          over.error ? null : over.starlink ? "Starlink" : "Viasat",
          over.error ?? null,
          over.confirmed ?? 1
        );
    return { db, fleet, tail, addRead };
  }

  test("a first Starlink reading two hours old stands in for discovery's own: no check, the next a day after it", async () => {
    const { db, fleet, tail, addRead } = setup();
    fleet.retrofit(tail);
    addRead(2, { starlink: true });
    // The reading is in the log and not in the ledger, so it is counted once.
    const usedBefore = unitedBudgetState(db).used;
    expect(usedBefore).toBe(1);
    const skips = countSkips();
    const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
    skips.stop();
    expect(fleet.checks).toEqual([]);
    expect(stats.checked).toBe(0);
    expect(stats.deferred).toBe(1);
    expect(stats.held).toBeNull();
    expect(skips.by).toEqual({ just_read: 1 });
    expect(unitedBudgetState(db).used).toBe(usedBefore);
    expect(fleetRow(db, tail).next_check_after).toBe(T0 - 2 * HOUR + 24 * HOUR);
    expect(fleetRow(db, tail).starlink_status).toBe("negative");

    // When that time comes the reading is made.
    setSystemTime(new Date((T0 + 34 * HOUR) * 1000));
    await runDiscoveryBatch(db, 1, fleet.discovery);
    expect(fleet.checks.map((c) => c.tail)).toEqual([tail]);
    db.close();
  });

  test("a reading that settled the tail as Starlink is followed at once: that check writes the roster", async () => {
    const { db, fleet, tail, addRead } = setup();
    fleet.retrofit(tail);
    addRead(80, { starlink: true });
    addRead(40, { starlink: true });
    addRead(0.05, { starlink: true });
    await runDiscoveryBatch(db, 1, fleet.discovery);
    expect(fleet.checks.map((c) => c.tail)).toEqual([tail]);
    expect(fleetRow(db, tail).starlink_status).toBe("confirmed");
    db.close();
  });

  test("a tail we do not count is read at once after a reading of another provider", async () => {
    // Nothing to protect: no second reading of that page can count it early.
    const { db, fleet, tail, addRead } = setup();
    addRead(2);
    const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
    expect(stats.deferred).toBe(0);
    expect(fleet.checks.map((c) => c.tail)).toEqual([tail]);
    db.close();
  });

  test("a tail we do not count is read at once when its two newest readings are Starlink", async () => {
    // The hourly job queues this reading the moment the pair is in: it is the
    // one that counts the tail. Put off, it came 35 hours late.
    const { db, fleet, tail, addRead } = setup();
    fleet.retrofit(tail);
    addRead(300);
    addRead(200);
    addRead(26, { starlink: true });
    addRead(0.5, { starlink: true });
    expect(isCounted(db, tail)).toBe(false);
    const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
    expect(stats.deferred).toBe(0);
    expect(fleet.checks.map((c) => c.tail)).toEqual([tail]);
    expect(fleetRow(db, tail).starlink_status).toBe("confirmed");
    expect(isCounted(db, tail)).toBe(true);
    db.close();
  });

  test("a failed check, a reading of another aircraft, or one from yesterday puts nothing off", async () => {
    for (const newest of [
      () => ({ hoursAgo: 1, over: { error: "timeout" } }),
      () => ({ hoursAgo: 1, over: { confirmed: 0 } }),
      () => ({ hoursAgo: 13, over: { starlink: true } }),
    ]) {
      const { db, fleet, tail, addRead } = setup();
      const { hoursAgo, over } = newest();
      addRead(hoursAgo, over);
      const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
      expect(stats.deferred).toBe(0);
      expect(fleet.checks.map((c) => c.tail)).toEqual([tail]);
      db.close();
    }
  });
});

// ── How much sooner a sheet-listed tail we held as not Starlink is counted ───

interface Trial {
  /** Days between discovery's routine looks at the tail before it was listed. */
  intervalDays: number;
  /** How far through that interval the listing arrives, 0 to 1. */
  phase: number;
  bump: boolean;
  index: number;
}

/**
 * One tail held as not Starlink, read as another provider every
 * `intervalDays`, is fitted and listed by the sheet at T0. Both jobs and the
 * hourly sync then run until the roster counts it. Returns the hours from the
 * listing to that moment, the hours to the first count that includes it, and
 * the checks it took with the times between them.
 */
async function hoursToCounted(
  t: Trial
): Promise<{ hours: number | null; counted: number | null; reads: number; gaps: number[] }> {
  const db = makeFreshDb();
  setSystemTime(new Date(T0_MS));
  const fleet = seedFleet(db, T0, { equipped: 3, unequipped: 16, noFlightEvery: 0 });
  listingsFromSheet(db);
  setMeta(db, "united_check_budget", "[]", "UA");
  const tail = fleet.unequipped[t.index % 16];
  db.query("DELETE FROM united_fleet WHERE starlink_status = 'negative' AND tail_number != ?").run(
    tail
  );
  db.query("DELETE FROM starlink_verification_log WHERE tail_number = ?").run(tail);
  const addRead = db.query(
    `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
     VALUES (?, 'united', ?, 0, 'Viasat', 1, 'UA')`
  );
  for (let age = t.phase * t.intervalDays; age <= 60; age += t.intervalDays) {
    addRead.run(tail, T0 - Math.floor(age * DAY));
  }
  const routineDue = T0 + Math.floor((1 - t.phase) * t.intervalDays * DAY);
  db.query(
    "UPDATE united_fleet SET next_check_after = ?, discovery_priority = 0.5 WHERE tail_number = ?"
  ).run(routineDue, tail);

  fleet.retrofit(tail);
  fleet.scheduleFlight(db, tail, T0);
  const sheet = sheetOf([...fleet.equipped, tail]);
  hourlySheetJob(db, sheet);
  if (!t.bump) {
    // The code before this change: the listing leaves the tail's turn where it was.
    db.query(
      "UPDATE united_fleet SET next_check_after = ?, discovery_priority = 0.5 WHERE tail_number = ?"
    ).run(routineDue, tail);
  }

  let countedAt: number | null = null;
  let firstCountedAt: number | null = null;
  const noteCount = () => {
    if (firstCountedAt === null && isCounted(db, tail)) firstCountedAt = nowSec();
  };
  const END = T0 + 14 * DAY;
  await runClock({
    db,
    fleet,
    fromSec: T0,
    toSec: END,
    verifierEverySec: 300,
    discoveryEverySec: 450,
    verifierTick: async () => {
      if (countedAt !== null) return;
      if ((nowSec() - T0) % HOUR === 0 && nowSec() > T0) hourlySheetJob(db, sheet);
      await runVerifierTick(db, fleet.verifier);
      noteCount();
    },
    discoveryTick: async () => {
      if (countedAt !== null) return;
      await runDiscoveryBatch(db, 1, fleet.discovery);
      noteCount();
      if (fleetRow(db, tail).starlink_status === "confirmed") countedAt = nowSec();
    },
  });
  const mine = fleet.checks.filter((c) => c.tail === tail);
  db.close();
  const hoursFrom = (at: number | null) => (at === null ? null : (at - T0) / HOUR);
  return {
    hours: hoursFrom(countedAt),
    counted: hoursFrom(firstCountedAt),
    reads: mine.length,
    gaps: mine.slice(1).map((c, i) => (c.at - mine[i].at) / HOUR),
  };
}

describe("a sheet-listed tail we held as not Starlink: hours until it is counted", () => {
  test("moved to the front, it is counted on its first reading and settled after three, each on the daily pace", async () => {
    // Read as another provider every 14 days, last 7 days ago: two such
    // readings inside the 30 days the consensus looks at, so three Starlink
    // readings in a row settle it, with the bump exactly as without it.
    const on = await hoursToCounted({ intervalDays: 14, phase: 0.5, bump: true, index: 0 });
    const off = await hoursToCounted({ intervalDays: 14, phase: 0.5, bump: false, index: 0 });
    // The sheet lists it, so the first Starlink reading counts it: minutes
    // after the listing, not days.
    expect(on.counted as number).toBeLessThanOrEqual(0.25);
    expect(off.counted as number).toBeGreaterThanOrEqual(on.counted as number);
    expect(on.reads).toBe(3);
    // No two readings of one page: every gap is a day, spread a third either
    // way by tail for the verifier and a tenth for discovery.
    for (const gap of on.gaps) {
      expect(gap).toBeGreaterThanOrEqual(24 * 0.67);
      expect(gap).toBeLessThanOrEqual(24 * 1.33 + 1);
    }
    // Without the bump the listing leaves discovery's turn a week off and the
    // verifier makes the first reading. The count itself then moves that turn
    // to a day after the reading: left to the verifier's own pace the second
    // reading came at 49 hours and the tail settled at 99. So the bump no
    // longer decides how soon the tail settles: both take two daily gaps.
    expect(off.counted as number).toBeLessThanOrEqual(0.25);
    expect(off.reads).toBe(3);
    expect(off.hours as number).toBeLessThanOrEqual(2 * (24 * 1.33 + 1));
    for (const gap of off.gaps) {
      expect(gap).toBeGreaterThanOrEqual(24 * 0.67);
      expect(gap).toBeLessThanOrEqual(24 * 1.33 + 1);
    }
  }, 60_000);

  test.skipIf(!RUN_BACKTEST)(
    "backtest: with and without the bump, over re-check intervals and arrival times (NEW_TAIL_BACKTEST=1)",
    async () => {
      const median = (xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      };
      const lines = [
        "[new-tails-under-ceiling] hours from the sheet listing to the roster counting the tail, 8 arrival times per interval:",
        "  interval   without the bump (median, range)   with (median, range)   sooner by (median, range)   reads without/with",
      ];
      const allGains: number[] = [];
      let index = 0;
      for (const intervalDays of [3, 7, 14, 21, 28]) {
        const off: number[] = [];
        const on: number[] = [];
        const gains: number[] = [];
        let readsOff = 0;
        let readsOn = 0;
        for (let k = 0; k < 8; k++) {
          const phase = (2 * k + 1) / 16;
          index++;
          const a = await hoursToCounted({ intervalDays, phase, bump: false, index });
          const b = await hoursToCounted({ intervalDays, phase, bump: true, index });
          expect(a.hours).not.toBeNull();
          expect(b.hours).not.toBeNull();
          off.push(a.hours as number);
          on.push(b.hours as number);
          gains.push((a.hours as number) - (b.hours as number));
          readsOff += a.reads;
          readsOn += b.reads;
        }
        allGains.push(...gains);
        const span = (xs: number[]) =>
          `${median(xs).toFixed(0)} (${Math.min(...xs).toFixed(0)} to ${Math.max(...xs).toFixed(0)})`;
        lines.push(
          `  ${String(intervalDays).padStart(2)} days    ${span(off).padEnd(34)} ${span(on).padEnd(22)} ${span(gains).padEnd(27)} ${(readsOff / 8).toFixed(1)} / ${(readsOn / 8).toFixed(1)}`
        );
      }
      lines.push(
        `  all 40: sooner by median ${median(allGains).toFixed(0)} h, range ${Math.min(...allGains).toFixed(0)} to ${Math.max(...allGains).toFixed(0)} h; slower in ${allGains.filter((g) => g < -1).length}`
      );
      report(lines);
    },
    600_000
  );
});

describe("the sheet's pull on the queue is bounded: strangers edit it", () => {
  const FAR = T0 + 20 * DAY;
  const movedTails = (db: Database) =>
    (
      db
        .query(
          "SELECT tail_number FROM united_fleet WHERE sheet_bumped_at IS NOT NULL ORDER BY tail_number"
        )
        .all() as { tail_number: string }[]
    ).map((r) => r.tail_number);

  /** discovery.lag_hours points credited to the sheet, while stop() has not been called. */
  function countSheetLag(): { points: string[]; stop(): void } {
    const points: string[] = [];
    const original = metrics.distribution;
    metrics.distribution = (name, value, tags) => {
      const t = tags as Record<string, unknown> | undefined;
      if (name === "discovery.lag_hours" && t?.first_source === "sheet") points.push(name);
      original(name, value, tags);
    };
    return {
      points,
      stop() {
        metrics.distribution = original;
      },
    };
  }

  function seed(db: Database) {
    const fleet = seedFleet(db, T0, { equipped: 5, unequipped: 40 });
    listingsFromSheet(db);
    db.query("UPDATE united_fleet SET next_check_after = ? WHERE starlink_status = 'negative'").run(
      FAR
    );
    return fleet;
  }

  test("ten moves in any rolling 24 hours, across reads and a restart; a refused move is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "sheet-cap-"));
    try {
      const path = join(dir, "db.sqlite");
      let db = openFile(path);
      setSystemTime(new Date(T0_MS));
      const fleet = seed(db);
      const fresh = (block: number) => fleet.unequipped.slice(block * 4, block * 4 + 4);
      const read = (at: number, block: number) => {
        setSystemTime(new Date(at * 1000));
        updateDatabase(db, 1000, sheetOf([...fleet.equipped, ...fresh(block)]), STATS, "UA");
      };

      read(T0 + HOUR, 0);
      read(T0 + 2 * HOUR, 1);
      expect(movedTails(db)).toHaveLength(8);
      db.close();
      db = openFile(path);

      // The third read's four would make twelve: two move, two are refused.
      read(T0 + 3 * HOUR, 2);
      expect(movedTails(db)).toHaveLength(SHEET_LISTING_BUMPS_PER_DAY);
      const refused = fresh(2).filter((t) => !movedTails(db).includes(t));
      expect(refused).toHaveLength(2);
      for (const t of refused) {
        expect(fleetRow(db, t)).toMatchObject({ next_check_after: FAR, discovery_priority: 0.5 });
      }
      for (let block = 3; block < 8; block++) read(T0 + (block + 1) * HOUR, block);
      expect(movedTails(db)).toHaveLength(SHEET_LISTING_BUMPS_PER_DAY);

      // A second before the first read's four are a day old, still shut.
      read(T0 + HOUR + DAY - 1, 8);
      expect(movedTails(db)).toHaveLength(SHEET_LISTING_BUMPS_PER_DAY);
      // Then four slots free. A refused tail listed again does not take one:
      // it was dropped, not queued, and keeps its routine turn.
      setSystemTime(new Date((T0 + HOUR + DAY) * 1000));
      updateDatabase(db, 1000, sheetOf([...fleet.equipped, ...refused, ...fresh(9)]), STATS, "UA");
      expect(movedTails(db)).toHaveLength(SHEET_LISTING_BUMPS_PER_DAY + 4);
      for (const t of refused) expect(fleetRow(db, t).next_check_after).toBe(FAR);
      for (const t of fresh(9)) {
        expect(fleetRow(db, t)).toMatchObject({
          next_check_after: T0 + HOUR + DAY,
          discovery_priority: 1,
        });
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tail dropped and listed again is moved, and sends its lag point, once", () => {
    const db = makeFreshDb();
    setSystemTime(new Date(T0_MS));
    const fleet = seed(db);
    const tail = fleet.unequipped[0];
    const withTail = sheetOf([...fleet.equipped, tail]);
    const without = sheetOf(fleet.equipped);
    const lag = countSheetLag();
    try {
      const read = (at: number, sheet: typeof withTail) => {
        setSystemTime(new Date(at * 1000));
        updateDatabase(db, 1000, sheet, STATS, "UA");
      };
      read(T0 + HOUR, withTail);
      expect(lag.points).toHaveLength(1);
      expect(fleetRow(db, tail).next_check_after).toBe(T0 + HOUR);

      // Its turn has since gone back to a routine date; the sheet flaps for two days.
      db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = ?").run(FAR, tail);
      for (let h = 2; h < 50; h++) read(T0 + h * HOUR, h % 2 ? withTail : without);
      expect(lag.points).toHaveLength(1);
      expect(fleetRow(db, tail).next_check_after).toBe(FAR);
      expect(movedTails(db)).toEqual([tail]);

      // Listed again once the first listing is no longer noted: a new listing.
      read(T0 + HOUR + SHEET_LISTING_NOTED_SECS - 1, without);
      read(T0 + HOUR + SHEET_LISTING_NOTED_SECS, withTail);
      expect(lag.points).toHaveLength(2);
      expect(fleetRow(db, tail).next_check_after).toBe(T0 + HOUR + SHEET_LISTING_NOTED_SECS);
    } finally {
      lag.stop();
      db.close();
    }
  });
});
