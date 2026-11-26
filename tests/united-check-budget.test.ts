/**
 * The ceiling on checks of united.com (src/scripts/united-check-budget.ts) and
 * the two jobs that live under it. Everything runs against a stand-in checker
 * and a fake clock: no test here reaches united.com, FR24 or any other host.
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
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMeta,
  getNextPlanesToVerify,
  logVerification,
  migrate,
  setMeta,
} from "../src/database/database";
import { runDiscoveryBatch, verifyPlane } from "../src/scripts/fleet-discovery";
import { runVerifierTick } from "../src/scripts/starlink-verifier";
import {
  UNITED_DAILY_CHECK_BUDGET,
  UNITED_RECONFIRM_HOURLY_PACE,
  UNITED_SETTLE_RESERVE,
  claimUnitedCheck,
  endUnitedCheck,
  unitedBudgetState,
} from "../src/scripts/united-check-budget";
import { makeFreshDb, openFileDb, utc } from "./helpers";
import {
  DAY,
  HOUR,
  type SimFleet,
  busiestDay,
  gapsBetweenChecks,
  runClock,
  seedFleet,
} from "./united-check-sim";

// The jobs' real beats. Every run below that is about the two jobs sharing
// the budget uses them; only the cadence measurement uses a coarser one.
const VERIFIER_BEAT = 60;
const DISCOVERY_BEAT = 90;

// A whole week of both jobs at those beats over a 1,930-tail fleet takes about
// a minute and a half, which is too long for every run of the suite. The suite
// runs the week on the ledger alone and 36 hours of the real jobs;
// UNITED_SIM_WEEK=1 runs the real jobs for the week as well.
const RUN_JOBS_WEEK = process.env.UNITED_SIM_WEEK === "1";

const T0 = utc("2026-12-01T00:00:00Z");
const T0_MS = T0 * 1000;
const RECONFIRM_LINE = UNITED_DAILY_CHECK_BUDGET - UNITED_SETTLE_RESERVE;

// A full budget laid out at an even pace inside one day: 230 s apart, the
// newest ten minutes back, so the hour behind `nowMs` holds 14 of them.
const FILL_GAP_MS = 230_000;
const FILL_NEWEST_AGO_MS = 600_000;
/** When the i-th oldest of `n` filled slots started. */
const fillStart = (i: number, n: number, nowMs: number) =>
  nowMs - FILL_NEWEST_AGO_MS - (n - 1 - i) * FILL_GAP_MS;

/** Spend `n` slots as settle checks made before `nowMs`, at that even pace. */
function fill(db: Database, n: number, nowMs: number): void {
  for (let i = 0; i < n; i++) {
    expect(claimUnitedCheck(db, "settle", fillStart(i, n, nowMs))).toBe(true);
  }
}

// The jobs log a line per check; a simulated week would print thousands.
let quiet: Array<{ mockRestore(): void }> = [];
/** Print what a run measured, past the muted console. */
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

describe("the ledger", () => {
  test("the ceiling is the figure the owner was given", () => {
    expect(UNITED_DAILY_CHECK_BUDGET).toBe(364);
    expect(UNITED_SETTLE_RESERVE).toBeGreaterThan(0);
    expect(UNITED_SETTLE_RESERVE).toBeLessThan(UNITED_DAILY_CHECK_BUDGET);
  });

  test("a settle check may use the whole budget, a re-confirmation stops a reserve short", () => {
    const db = makeFreshDb();
    fill(db, RECONFIRM_LINE - 1, T0_MS);
    expect(unitedBudgetState(db, T0_MS).open).toEqual({ settle: true, reconfirm: true });

    expect(claimUnitedCheck(db, "reconfirm", T0_MS)).toBe(true);
    expect(unitedBudgetState(db, T0_MS).open).toEqual({ settle: true, reconfirm: false });
    expect(claimUnitedCheck(db, "reconfirm", T0_MS)).toBe(false);

    for (let i = 0; i < UNITED_SETTLE_RESERVE; i++) {
      expect(claimUnitedCheck(db, "settle", T0_MS)).toBe(true);
    }
    expect(unitedBudgetState(db, T0_MS)).toEqual({
      used: UNITED_DAILY_CHECK_BUDGET,
      open: { settle: false, reconfirm: false },
    });
    expect(claimUnitedCheck(db, "settle", T0_MS)).toBe(false);
    // A refusal spends nothing.
    expect(unitedBudgetState(db, T0_MS).used).toBe(UNITED_DAILY_CHECK_BUDGET);
  });

  test("a slot frees 24 hours after its check started, and goes to a settle check first", () => {
    const db = makeFreshDb();
    fill(db, UNITED_DAILY_CHECK_BUDGET, T0_MS);
    const firstStart = fillStart(0, UNITED_DAILY_CHECK_BUDGET, T0_MS);

    expect(claimUnitedCheck(db, "settle", firstStart + DAY * 1000 - 1)).toBe(false);
    const freed = firstStart + DAY * 1000;
    expect(unitedBudgetState(db, freed).used).toBe(UNITED_DAILY_CHECK_BUDGET - 1);
    // The verifier would get here first (it ticks more often); it is refused.
    expect(claimUnitedCheck(db, "reconfirm", freed)).toBe(false);
    expect(claimUnitedCheck(db, "settle", freed)).toBe(true);
  });

  test("re-confirmations keep to the budget's hourly pace; settle checks do not", () => {
    const db = makeFreshDb();
    // A backlog: the verifier asks every minute with the day's budget untouched.
    let granted = 0;
    for (let min = 0; min < 60; min++) {
      if (claimUnitedCheck(db, "reconfirm", T0_MS + min * 60_000)) granted++;
    }
    expect(UNITED_RECONFIRM_HOURLY_PACE).toBe(16);
    expect(granted).toBe(UNITED_RECONFIRM_HOURLY_PACE);
    const at = T0_MS + 59 * 60_000;
    expect(unitedBudgetState(db, at)).toEqual({
      used: UNITED_RECONFIRM_HOURLY_PACE,
      open: { settle: true, reconfirm: false },
    });
    // A burst of unequipped tails is not paced: it runs at discovery's own beat.
    for (let i = 0; i < 40; i++) expect(claimUnitedCheck(db, "settle", at)).toBe(true);
    // The first slot of the hour ages out of it, and one re-confirmation fits
    // again only once the burst has, too.
    expect(claimUnitedCheck(db, "reconfirm", T0_MS + 61 * 60_000)).toBe(false);
    expect(claimUnitedCheck(db, "reconfirm", at + 60 * 60_000)).toBe(true);
  });

  test("a hand-forced check is counted and never refused; the jobs make room for it", () => {
    const db = makeFreshDb();
    fill(db, UNITED_DAILY_CHECK_BUDGET, T0_MS);
    expect(claimUnitedCheck(db, "manual", T0_MS)).toBe(true);
    expect(unitedBudgetState(db, T0_MS).used).toBe(UNITED_DAILY_CHECK_BUDGET + 1);
    // Two slots have to free before a job gets one.
    const freed = (i: number) => fillStart(i, UNITED_DAILY_CHECK_BUDGET, T0_MS) + DAY * 1000;
    expect(claimUnitedCheck(db, "settle", freed(0))).toBe(false);
    expect(claimUnitedCheck(db, "settle", freed(1))).toBe(true);
  });

  test("a restart does not reset it", () => {
    const dir = mkdtempSync(join(tmpdir(), "united-budget-"));
    try {
      const path = join(dir, "db.sqlite");
      let db = openFileDb(path);
      fill(db, UNITED_DAILY_CHECK_BUDGET, T0_MS);
      db.close();

      db = openFileDb(path);
      expect(unitedBudgetState(db, T0_MS + 60_000)).toEqual({
        used: UNITED_DAILY_CHECK_BUDGET,
        open: { settle: false, reconfirm: false },
      });
      expect(claimUnitedCheck(db, "settle", T0_MS + 60_000)).toBe(false);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no ledger yet, the last day's logged checks stand in for it", () => {
    const db = makeFreshDb();
    setSystemTime(new Date(T0_MS - 2 * HOUR * 1000));
    for (let i = 0; i < 5; i++) {
      logVerification(db, {
        tail_number: `N${i}`,
        airline: "UA",
        source: "united",
        has_starlink: true,
        wifi_provider: "Starlink",
        aircraft_type: null,
        flight_number: null,
        tail_confirmed: 1,
        error: null,
      });
    }
    // Another airline's checker, and a check older than the window, are not ours.
    logVerification(db, {
      tail_number: "N999AS",
      airline: "AS",
      source: "alaska",
      has_starlink: true,
      wifi_provider: "Starlink",
      aircraft_type: null,
      flight_number: null,
      tail_confirmed: 1,
      error: null,
    });
    db.query("UPDATE starlink_verification_log SET checked_at = ? WHERE tail_number = 'N0'").run(
      T0 - 2 * DAY
    );

    expect(unitedBudgetState(db, T0_MS).used).toBe(4);
    expect(claimUnitedCheck(db, "settle", T0_MS)).toBe(true);
    expect(unitedBudgetState(db, T0_MS).used).toBe(5);
  });

  describe("checks an older version made after a revert", () => {
    const logCheck = (handle: Database, at: number, i: number) =>
      handle
        .query(
          `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
           VALUES (?, 'united', ?, 1, 'Starlink', 1, 'UA')`
        )
        .run(`N${i}`, at);

    /** One process's life on the file: boot, then every claim it can get. */
    function withBoot<T>(path: string, run: (handle: Database) => T): T {
      const handle = new Database(path);
      // A scratch file: no need to wait on the disk for each of a few thousand claims.
      handle.exec("PRAGMA synchronous = OFF");
      migrate(handle);
      try {
        return run(handle);
      } finally {
        handle.close();
      }
    }

    /**
     * This version runs a day at the ceiling, and `offsetMin` minutes into the
     * next hour. It is reverted for `revertMin` minutes, and the older version,
     * which has no ledger, checks `perHour` times an hour and writes only the
     * log. Then this version boots again and takes every slot it is given for
     * `daysAfter` days. Returns when every check really started.
     */
    function revertFor(
      {
        offsetMin = 0,
        revertMin,
        perHour,
        cutShort = false,
      }: { offsetMin?: number; revertMin: number; perHour: number; cutShort?: boolean },
      logLagSec = 0,
      daysAfter = 1
    ) {
      const dir = mkdtempSync(join(tmpdir(), "united-revert-"));
      const path = join(dir, "db.sqlite");
      const made: number[] = [];
      let n = 0;
      // `stoppedAt`: the process is stopped there, while the page of its last
      // check loads. That check started, so it counts, and it wrote no log row.
      const takeAll = (handle: Database, from: number, to: number, stoppedAt?: number) => {
        for (let t = from; t < to; t += 60) {
          if (claimUnitedCheck(handle, "settle", t * 1000)) {
            made.push(t);
            if (stoppedAt !== undefined && t + 60 >= stoppedAt) return;
            logCheck(handle, t + logLagSec, n++);
            endUnitedCheck(handle);
          }
        }
      };
      try {
        const revertAt = T0 + DAY + offsetMin * 60;
        const returnAt = revertAt + revertMin * 60;
        withBoot(path, (handle) => takeAll(handle, T0, revertAt, cutShort ? revertAt : undefined));
        withBoot(path, (handle) => {
          for (let t = revertAt; t < returnAt; t += Math.floor(HOUR / perHour)) {
            made.push(t);
            logCheck(handle, t + logLagSec, n++);
          }
        });
        const seenOnReturn = withBoot(path, (handle) => {
          const used = unitedBudgetState(handle, returnAt * 1000).used;
          takeAll(handle, returnAt, returnAt + daysAfter * DAY);
          return used;
        });
        const inWindowOnReturn = made.filter((t) => t > returnAt - DAY && t < returnAt).length;
        return { made, seenOnReturn, inWindowOnReturn, returnAt };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const revertAndReturn = (revertHours: number, perHour: number, logLagSec = 0) =>
      revertFor({ revertMin: revertHours * 60, perHour }, logLagSec);

    /** The most checks in any rolling 24 hours that ends at a check this version made after its return. */
    function busiestAfterReturn(made: readonly number[], returnAt: number): number {
      const sorted = [...made].sort((a, b) => a - b);
      let most = 0;
      let from = 0;
      for (let to = 0; to < sorted.length; to++) {
        while (sorted[from] <= sorted[to] - DAY) from++;
        if (sorted[to] >= returnAt) most = Math.max(most, to - from + 1);
      }
      return most;
    }

    test.each([
      [6, 20],
      [1, 30],
      [23, 15],
      [30, 15],
    ])(
      "a %i-hour revert at %i checks an hour: no rolling 24 hours passes the ceiling",
      (hours, perHour) => {
        const { made, seenOnReturn, inWindowOnReturn } = revertAndReturn(hours, perHour);
        // Every check made in the window is counted on boot, whoever made it.
        expect(seenOnReturn).toBe(inWindowOnReturn);
        // The older version has no ceiling, so its own hours can pass it. From
        // the return on, this version adds nothing until the count is under it.
        const sorted = [...made].sort((a, b) => a - b);
        const returnAt = T0 + DAY + hours * HOUR;
        const olderAlone = busiestDay(sorted.filter((t) => t < returnAt));
        expect(busiestDay(sorted)).toBeLessThanOrEqual(
          Math.max(UNITED_DAILY_CHECK_BUDGET, olderAlone)
        );
        const afterReturn = sorted.filter((t) => t >= returnAt);
        for (const t of afterReturn) {
          const window = sorted.filter((s) => s > t - DAY && s <= t).length;
          expect(window).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
        }
        // And it is not shut for good: a day after the return it runs at the line.
        expect(afterReturn.length).toBeGreaterThan(0);
      }
    );

    // In the hour a revert starts, this version's checks are that hour's oldest
    // log rows and the older version's its newest. Counting the oldest as the
    // surplus dropped the newest an hour early, and a day later this version
    // took their slots while they were still inside the window: up to 374.
    test.each([
      [0, 360, 20],
      [30, 360, 20],
      [30, 25, 20],
      [20, 40, 30],
      [45, 14, 60],
      [50, 9, 120],
      [55, 4, 600],
      [30, 720, 18],
      [30, 26 * 60, 15],
    ])(
      "a revert %i minutes into an hour, for %i minutes at %i checks an hour: two days on, none of this version's checks passes the ceiling",
      (offsetMin, revertMin, perHour) => {
        const { made, returnAt } = revertFor({ offsetMin, revertMin, perHour }, 0, 2);
        expect(made.some((t) => t >= returnAt + DAY)).toBe(true);
        expect(busiestAfterReturn(made, returnAt)).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
      },
      30_000
    );

    // Finding 2a of the second look. The check under way when a revert starts
    // is claimed and never logged. Counted as logged, it stood for one of the
    // older version's log rows in that hour, so that check went uncounted and
    // a day later a rolling 24 hours held 365.
    test.each([
      [30, 360, 20],
      [30, 25, 20],
      [20, 40, 30],
      [45, 14, 60],
      [50, 9, 120],
      [10, 45, 6],
      [30, 720, 18],
    ])(
      "a revert %i minutes into an hour that cuts a check short, for %i minutes at %i checks an hour: none of this version's checks passes the ceiling",
      (offsetMin, revertMin, perHour) => {
        const { made, returnAt, seenOnReturn, inWindowOnReturn } = revertFor(
          { offsetMin, revertMin, perHour, cutShort: true },
          0,
          2
        );
        // The check that was cut short and every one of the older version's.
        expect(seenOnReturn).toBe(inWindowOnReturn);
        expect(made.some((t) => t >= returnAt + DAY)).toBe(true);
        expect(busiestAfterReturn(made, returnAt)).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
      },
      30_000
    );

    test("a claim that is never ended costs the next boot at most three slots, and never opens one", () => {
      const dir = mkdtempSync(join(tmpdir(), "united-revert-"));
      const path = join(dir, "db.sqlite");
      try {
        // Forty checks, each logged, none ended: a caller that forgot to.
        withBoot(path, (handle) => {
          for (let i = 0; i < 40; i++) {
            expect(claimUnitedCheck(handle, "settle", (T0 + i * 300) * 1000)).toBe(true);
            logCheck(handle, T0 + i * 300 + 20, i);
          }
        });
        const now = (T0 + 40 * 300) * 1000;
        const used = withBoot(path, (handle) => unitedBudgetState(handle, now).used);
        expect(used).toBeGreaterThanOrEqual(40);
        expect(used).toBeLessThanOrEqual(43);
        // That boot kept its three and emptied the list. A list nobody can
        // read is no list, and times that are in no ledger stand for nothing:
        // later boots read what the first one read, and not a slot more.
        for (const raw of ["not json", '{"a":1}', '["x"]', "[null]", "[1,2,3]"]) {
          withBoot(path, (handle) => setMeta(handle, "united_check_under_way", raw, "UA"));
          expect(withBoot(path, (handle) => unitedBudgetState(handle, now).used)).toBe(used);
        }
        // With nothing kept and nothing listed, the count is the ledger's and the log's.
        withBoot(path, (handle) => setMeta(handle, "united_check_no_row", "[]", "UA"));
        expect(withBoot(path, (handle) => unitedBudgetState(handle, now).used)).toBe(40);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("the list of unended claims can only add to the count a boot reads", () => {
      // Random ledgers, logs and lists: the same file read with the list and
      // without it. The list may close the budget sooner, never open it.
      let seed = 20261126;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const now = T0_MS + 2 * DAY * 1000;
      const dir = mkdtempSync(join(tmpdir(), "united-list-"));
      let added = 0;
      try {
        for (let run = 0; run < 60; run++) {
          const path = join(dir, `${run}.sqlite`);
          const starts = Array.from({ length: Math.floor(rand() * 300) }, () =>
            Math.floor(now - rand() * 26 * HOUR * 1000)
          ).sort((a, b) => a - b);
          withBoot(path, (handle) => {
            setMeta(handle, "united_check_budget", JSON.stringify(starts), "UA");
            const rows = Math.floor(rand() * 400);
            for (let i = 0; i < rows; i++) {
              logCheck(handle, Math.floor((now - rand() * 26 * HOUR * 1000) / 1000), i);
            }
          });
          const without = withBoot(path, (handle) => unitedBudgetState(handle, now).used);
          const picked = starts.filter(() => rand() < 0.1);
          const listed = [...picked, ...(rand() < 0.3 ? [now - 5, 12, now + 99_000] : [])];
          withBoot(path, (handle) =>
            setMeta(handle, "united_check_under_way", JSON.stringify(listed), "UA")
          );
          const withList = withBoot(path, (handle) => unitedBudgetState(handle, now).used);
          expect(withList).toBeGreaterThanOrEqual(without);
          expect(withList - without).toBeLessThanOrEqual(3);
          added += withList - without;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect(added).toBeGreaterThan(0);
    });

    test("ending a check clears its own claim and nothing else, and never throws", () => {
      const db = makeFreshDb();
      const open = () => JSON.parse(getMeta(db, "united_check_under_way", "UA") ?? "[]");
      endUnitedCheck(db);
      expect(open()).toEqual([]);
      setMeta(db, "united_check_under_way", JSON.stringify([T0_MS - 5000]), "UA");
      expect(claimUnitedCheck(db, "settle", T0_MS)).toBe(true);
      expect(claimUnitedCheck(db, "settle", T0_MS + 1000)).toBe(true);
      expect(open()).toEqual([T0_MS - 5000, T0_MS, T0_MS + 1000]);
      endUnitedCheck(db);
      expect(open()).toEqual([T0_MS - 5000, T0_MS + 1000]);
      endUnitedCheck(db);
      endUnitedCheck(db);
      expect(open()).toEqual([T0_MS - 5000]);
      // A claim made a day later drops what has left the window.
      expect(claimUnitedCheck(db, "settle", T0_MS + DAY * 1000)).toBe(true);
      expect(open()).toEqual([T0_MS + DAY * 1000]);
      setMeta(db, "united_check_under_way", "not json", "UA");
      endUnitedCheck(db);
      expect(open()).toEqual([]);
      db.close();
      expect(() => endUnitedCheck(db)).not.toThrow();
    });

    test("the log can only add to the count: a ledger the log trails is counted whole", () => {
      const dir = mkdtempSync(join(tmpdir(), "united-revert-"));
      const path = join(dir, "db.sqlite");
      try {
        // 200 claims, of which only every other check reached the log.
        withBoot(path, (handle) => {
          for (let i = 0; i < 200; i++) {
            const at = T0 + i * 300;
            expect(claimUnitedCheck(handle, "settle", at * 1000)).toBe(true);
            if (i % 2 === 0) logCheck(handle, at + 40, i);
          }
        });
        const now = (T0 + 200 * 300) * 1000;
        expect(withBoot(path, (handle) => unitedBudgetState(handle, now).used)).toBe(200);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("this version's own checks, logged a little after their claim, are not counted twice", () => {
      // A claim is made before the page loads and the log row after it, so the
      // two can fall either side of an hour's edge: at most one over per hour.
      const { seenOnReturn, inWindowOnReturn } = revertAndReturn(0, 1, 45);
      expect(seenOnReturn).toBeGreaterThanOrEqual(inWindowOnReturn);
      expect(seenOnReturn - inWindowOnReturn).toBeLessThanOrEqual(24);
    });

    test("it is read once, on boot: a claim after it still lands in the ledger alone", () => {
      const db = makeFreshDb();
      setMeta(db, "united_check_budget", "[]", "UA");
      logCheck(db, T0 - HOUR, 1);
      expect(unitedBudgetState(db, T0_MS).used).toBe(1);
      expect(claimUnitedCheck(db, "settle", T0_MS)).toBe(true);
      logCheck(db, T0 + 30, 2);
      expect(unitedBudgetState(db, T0_MS + 60_000).used).toBe(2);
      expect(JSON.parse(getMeta(db, "united_check_budget", "UA") as string)).toEqual([T0_MS]);
      // The log's surplus frees a day after the check, like any other start.
      expect(unitedBudgetState(db, T0_MS + 23 * HOUR * 1000 + 1000).used).toBe(1);
    });

    // ── more than three checks cut short in a day ─────────────────────────
    //
    // One list for the whole day, of which a boot believed the newest three:
    // the fourth check cut short in a day was counted as logged again, hid
    // one of the older version's log rows, and a rolling day held 365 to 367.
    // Each boot now takes over what the process before it left, three at
    // most, into a kept list, and starts its own list empty.

    const metaList = (handle: Database, key: string): number[] =>
      JSON.parse(getMeta(handle, key, "UA") ?? "[]");

    /** The most real checks in any rolling 24 hours that ends at one of `ours`. */
    function busiestEndingAt(all: readonly number[], ours: ReadonlySet<number>): number {
      const sorted = [...all].sort((a, b) => a - b);
      let most = 0;
      let from = 0;
      for (let to = 0; to < sorted.length; to++) {
        while (sorted[from] <= sorted[to] - DAY) from++;
        if (ours.has(sorted[to])) most = Math.max(most, to - from + 1);
      }
      return most;
    }

    /**
     * `stops` times in a day and a half this version is stopped with
     * `inFlight` checks under way, and each time the older version, which has
     * no ledger, runs ten minutes inside the same hour at a check a minute.
     * Then this version takes every slot it is given for two days.
     */
    function stopsInADay(stops: number, inFlight: number, everyHours: number) {
      const dir = mkdtempSync(join(tmpdir(), "united-stops-"));
      const path = join(dir, "db.sqlite");
      const made: number[] = [];
      const ours = new Set<number>();
      const returns: { counted: number; really: number; kept: number; listed: number }[] = [];
      let n = 0;
      const steady = (handle: Database, from: number, to: number, every: number) => {
        for (let t = from; t < to; t += every) {
          if (!claimUnitedCheck(handle, "settle", t * 1000)) continue;
          made.push(t);
          ours.add(t);
          logCheck(handle, t + 10, n++);
          endUnitedCheck(handle);
        }
      };
      try {
        let from = T0;
        let stopAt = T0 + 40 * 60;
        for (let i = 0; i < stops; i++) {
          withBoot(path, (handle) => {
            steady(handle, from, stopAt - 30, 360);
            for (let k = 0; k < inFlight; k++) {
              const t = stopAt - 20 + k;
              if (claimUnitedCheck(handle, "settle", t * 1000)) {
                made.push(t);
                ours.add(t);
              }
            }
          });
          withBoot(path, (handle) => {
            for (let t = stopAt; t < stopAt + 600; t += 60) {
              made.push(t);
              logCheck(handle, t + 10, n++);
            }
          });
          const back = stopAt + 600;
          returns.push(
            withBoot(path, (handle) => ({
              counted: unitedBudgetState(handle, back * 1000).used,
              really: made.filter((t) => t > back - DAY && t <= back).length,
              kept: metaList(handle, "united_check_no_row").length,
              listed: metaList(handle, "united_check_under_way").length,
            }))
          );
          from = back;
          stopAt = back + everyHours * HOUR;
        }
        withBoot(path, (handle) => steady(handle, from, from + 2 * DAY, 30));
        return { returns, busiest: busiestEndingAt(made, ours) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    test.each([
      [1, 2, 3],
      [3, 1, 3],
      [2, 2, 3],
      [4, 1, 3],
      [3, 2, 3],
      [7, 2, 3],
      [8, 3, 3],
      [20, 2, 1],
      [30, 3, 1],
    ])(
      "%i stops in a day with %i checks under way at each: every return counts them all, and the day holds 364",
      (stops, inFlight, everyHours) => {
        const { returns, busiest } = stopsInADay(stops, inFlight, everyHours);
        for (const r of returns) {
          // Never short. A row that falls across an hour's edge from its
          // claim can count one over, on the safe side.
          expect(r.counted).toBeGreaterThanOrEqual(r.really);
          expect(r.counted - r.really).toBeLessThanOrEqual(stops > 8 ? 2 : 0);
        }
        expect(busiest).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
        for (const r of returns) expect(r.listed).toBe(0);
        // Kept for a day, then dropped: the list does not grow without end.
        expect(Math.max(...returns.map((r) => r.kept))).toBeLessThanOrEqual(
          Math.min(stops, Math.ceil(24 / everyHours) + 1) * inFlight
        );
      },
      60_000
    );

    /**
     * Any order of boots. This version and the older, ledger-less one take
     * turns of three minutes to three hours on one file. Two jobs each hold a
     * check under way; its row is written when it ends, 5 to 60 seconds after
     * its claim. A stop cuts this version's checks short, or (three times in
     * ten) falls between a check's row and its end. Now and then the command
     * line forces a check in a process of its own, which never ends its claim.
     * The older version's checks are let finish: a check it had under way at a
     * stop is in no ledger and no log, and no version can count it.
     */
    function anyOrderOfBoots(seed: number, days: number) {
      let state = seed;
      const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
      };
      const dir = mkdtempSync(join(tmpdir(), "united-boots-"));
      const path = join(dir, "db.sqlite");
      const copy = join(dir, "copy.sqlite");
      const made: number[] = [];
      const ours = new Set<number>();
      // Claims of this version whose check was cut short or never ended.
      const unended: number[] = [];
      const boots: { counted: number; really: number; asOneList: number }[] = [];
      let n = 0;
      let mostLeft = 0;
      try {
        withBoot(path, () => {});
        let t = T0;
        let newVersion = true;
        const end = T0 + days * DAY;
        while (t < end) {
          const turn = 180 + Math.floor(rand() * (rand() < 0.6 ? 1350 : 3 * HOUR));
          const stop = Math.min(end, t + turn);
          const from = t;
          const isNew = newVersion;
          withBoot(path, (handle) => {
            if (isNew) {
              mostLeft = Math.max(mostLeft, metaList(handle, "united_check_under_way").length);
              // The same file as 897f00d kept it: one list of every unended
              // claim of the day, of which the boot believes the newest three.
              handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
              copyFileSync(path, copy);
              const asOneList = withBoot(copy, (other) => {
                setMeta(other, "united_check_no_row", "[]", "UA");
                const day = unended.filter((s) => s > from * 1000 - DAY * 1000);
                setMeta(other, "united_check_under_way", JSON.stringify(day), "UA");
                return unitedBudgetState(other, from * 1000).used;
              });
              boots.push({
                counted: unitedBudgetState(handle, from * 1000).used,
                really: made.filter((m) => m > from - DAY && m <= from).length,
                asOneList,
              });
            }
            const flying: { claim: number; done: number }[] = [];
            const olderEvery = Math.floor(HOUR / (10 + Math.floor(rand() * 30)));
            let nextOlder = from;
            for (let s = from; s < stop; s += 20) {
              for (let i = flying.length - 1; i >= 0; i--) {
                if (flying[i].done > s) continue;
                logCheck(handle, flying[i].done, n++);
                if (isNew) endUnitedCheck(handle);
                flying.splice(i, 1);
              }
              if (!isNew) {
                if (s >= nextOlder && flying.length < 2) {
                  made.push(s);
                  flying.push({ claim: s, done: s + 5 + Math.floor(rand() * 55) });
                  nextOlder = s + olderEvery;
                }
                continue;
              }
              if (rand() < 1 / 400) {
                // The command line's forced check: its own process and boot.
                const at = s * 1000 + 7;
                withBoot(path, (cli) => claimUnitedCheck(cli, "manual", at));
                made.push(s);
                unended.push(at);
              }
              for (let job = flying.length; job < 2; job++) {
                const cls = rand() < 0.6 ? "settle" : "reconfirm";
                if (rand() < 0.6 && claimUnitedCheck(handle, cls, s * 1000 + job)) {
                  made.push(s);
                  ours.add(s);
                  flying.push({ claim: s * 1000 + job, done: s + 5 + Math.floor(rand() * 55) });
                }
              }
            }
            for (const check of flying) {
              if (!isNew || rand() < 0.3) logCheck(handle, stop, n++);
              if (isNew) unended.push(check.claim);
            }
          });
          t = stop;
          newVersion = rand() < 0.5;
        }
        return { boots, busiest: busiestEndingAt(made, ours), mostLeft };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    test.each([20261126, 7, 104736, 99991])(
      "any order of boots (seed %i): no rolling 24 hours passes the ceiling, and no boot counts short",
      (seed) => {
        const { boots, busiest, mostLeft } = anyOrderOfBoots(seed, 4);
        expect(boots.length).toBeGreaterThan(20);
        expect(busiest).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
        // The budget was in use: a run that never neared it would prove nothing.
        expect(busiest).toBeGreaterThan(UNITED_DAILY_CHECK_BUDGET - 4);
        // What the code can leave at a stop: two jobs' checks and a forced one.
        expect(mostLeft).toBeLessThanOrEqual(3);
        for (const boot of boots) {
          expect(boot.counted).toBeGreaterThanOrEqual(boot.really);
          // Never under what one day-long list, read as 897f00d read it, gives.
          expect(boot.counted).toBeGreaterThanOrEqual(boot.asOneList);
        }
        expect(boots.some((boot) => boot.counted > boot.asOneList)).toBe(true);
      },
      120_000
    );

    test("a boot takes over what was left under way, three at most, and empties the list", () => {
      const dir = mkdtempSync(join(tmpdir(), "united-kept-"));
      const path = join(dir, "db.sqlite");
      const at = (i: number) => T0_MS + i * 60_000;
      try {
        withBoot(path, (handle) => {
          for (let i = 0; i < 5; i++) expect(claimUnitedCheck(handle, "settle", at(i))).toBe(true);
          expect(metaList(handle, "united_check_under_way")).toHaveLength(5);
        });
        withBoot(path, (handle) => {
          expect(unitedBudgetState(handle, at(6)).used).toBe(5);
          expect(metaList(handle, "united_check_no_row")).toEqual([at(2), at(3), at(4)]);
          expect(metaList(handle, "united_check_under_way")).toEqual([]);
          // This process's own claim is listed again, and ended as before.
          expect(claimUnitedCheck(handle, "settle", at(7))).toBe(true);
          expect(metaList(handle, "united_check_under_way")).toEqual([at(7)]);
          endUnitedCheck(handle);
          expect(metaList(handle, "united_check_under_way")).toEqual([]);
          expect(claimUnitedCheck(handle, "settle", at(8))).toBe(true);
        });
        // The next stop gets its own three: the earlier ones are not crowded out.
        withBoot(path, (handle) => {
          unitedBudgetState(handle, at(9));
          expect(metaList(handle, "united_check_no_row")).toEqual([at(2), at(3), at(4), at(8)]);
          // Read again by the same process: nothing moves.
          unitedBudgetState(handle, at(9));
          expect(metaList(handle, "united_check_no_row")).toHaveLength(4);
        });
        // A day on, what was kept has left the ledger and the kept list with it.
        withBoot(path, (handle) => {
          expect(unitedBudgetState(handle, at(8) + DAY * 1000 + 1).used).toBe(0);
          expect(metaList(handle, "united_check_no_row")).toEqual([]);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("two claims in the same millisecond, both cut short, are both kept", () => {
      const dir = mkdtempSync(join(tmpdir(), "united-kept-"));
      const path = join(dir, "db.sqlite");
      try {
        withBoot(path, (handle) => {
          expect(claimUnitedCheck(handle, "settle", T0_MS)).toBe(true);
          expect(claimUnitedCheck(handle, "manual", T0_MS)).toBe(true);
          // The older version's two checks, logged in the same hour.
          logCheck(handle, T0 + 100, 1);
          logCheck(handle, T0 + 200, 2);
        });
        withBoot(path, (handle) => {
          expect(unitedBudgetState(handle, T0_MS + 600_000).used).toBe(4);
          expect(metaList(handle, "united_check_no_row")).toEqual([T0_MS, T0_MS]);
        });
        expect(withBoot(path, (handle) => unitedBudgetState(handle, T0_MS + 600_000).used)).toBe(4);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a check that ends after another process booted on the file is not kept as cut short", () => {
      const dir = mkdtempSync(join(tmpdir(), "united-kept-"));
      const path = join(dir, "db.sqlite");
      try {
        withBoot(path, (server) => {
          expect(claimUnitedCheck(server, "settle", T0_MS)).toBe(true);
          // A command-line run boots while the server's check is under way.
          withBoot(path, (cli) => {
            unitedBudgetState(cli, T0_MS + 1000);
            expect(metaList(cli, "united_check_no_row")).toEqual([T0_MS]);
            expect(claimUnitedCheck(cli, "manual", T0_MS + 2000)).toBe(true);
          });
          logCheck(server, T0 + 30, 1);
          endUnitedCheck(server);
          expect(metaList(server, "united_check_no_row")).toEqual([]);
          expect(metaList(server, "united_check_under_way")).toEqual([T0_MS + 2000]);
        });
        // One check with its row and the forced one: two, not three.
        expect(withBoot(path, (handle) => unitedBudgetState(handle, T0_MS + 60_000).used)).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a hostile kept list closes the budget or leaves it right, and never opens it", () => {
      const dir = mkdtempSync(join(tmpdir(), "united-kept-"));
      const path = join(dir, "db.sqlite");
      const now = T0_MS + DAY * 1000;
      try {
        // A full day at the ceiling, every check logged and ended.
        const starts = withBoot(path, (handle) => {
          const granted: number[] = [];
          for (let t = T0 + 60; t * 1000 < now; t += 200) {
            if (!claimUnitedCheck(handle, "settle", t * 1000)) continue;
            granted.push(t * 1000);
            logCheck(handle, t + 5, granted.length);
            endUnitedCheck(handle);
          }
          return granted;
        });
        const real = starts.filter((s) => s > now - DAY * 1000).length;
        expect(real).toBe(UNITED_DAILY_CHECK_BUDGET);
        const lists: Array<[string, string, number]> = [
          ["not JSON", "{{{", 0],
          ["a string", '"all"', 0],
          ["an object", '{"0":1}', 0],
          ["text and null entries", '["a",null,1]', 0],
          ["nested arrays", JSON.stringify([[starts[0]]]), 0],
          ["times in no ledger", JSON.stringify([1, 2, now + 30 * DAY * 1000, -1, 0.5]), 0],
          ["100,000 entries that match nothing", JSON.stringify(Array(100000).fill(7)), 0],
          [
            "the newest three, twice",
            JSON.stringify([...starts.slice(-3), ...starts.slice(-3)]),
            3,
          ],
          ["every start of the day", JSON.stringify(starts), real],
        ];
        for (const key of ["united_check_no_row", "united_check_under_way"]) {
          for (const [label, raw, kept] of lists) {
            withBoot(path, (handle) => {
              setMeta(handle, "united_check_no_row", "[]", "UA");
              setMeta(handle, "united_check_under_way", "[]", "UA");
              setMeta(handle, key, raw, "UA");
            });
            const most = key === "united_check_under_way" ? Math.min(kept, 3) : kept;
            withBoot(path, (handle) => {
              const used = unitedBudgetState(handle, now).used;
              expect([label, used >= real, used <= real + most]).toEqual([label, true, true]);
              for (let i = 0; i < 20; i++) {
                expect(claimUnitedCheck(handle, "settle", now + i)).toBe(false);
              }
              expect(metaList(handle, "united_check_under_way")).toEqual([]);
            });
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a boot that cannot write still reads the same count, and throws nothing", () => {
      const dir = mkdtempSync(join(tmpdir(), "united-kept-"));
      const path = join(dir, "db.sqlite");
      try {
        withBoot(path, (handle) => {
          for (let i = 0; i < 4; i++) {
            expect(claimUnitedCheck(handle, "settle", T0_MS + i * 1000)).toBe(true);
          }
          // The older version's rows, in the same hour.
          for (let i = 0; i < 6; i++) logCheck(handle, T0 + 100 + i, i);
          handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        });
        const readOnly = new Database(path, { readonly: true });
        const seen = unitedBudgetState(readOnly, T0_MS + 600_000).used;
        expect(metaList(readOnly, "united_check_under_way")).toHaveLength(4);
        readOnly.close();
        // Four claims, three believed to have no row: 4 + (6 rows - 1 ledgered).
        expect(seen).toBe(9);
        expect(withBoot(path, (handle) => unitedBudgetState(handle, T0_MS + 600_000).used)).toBe(9);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test.each(["not json", '{"starts":[1]}', '["a"]', "[null]"])(
    "an unreadable ledger (%s) falls back to the log, never to empty-and-open",
    (raw) => {
      const db = makeFreshDb();
      setSystemTime(new Date(T0_MS - HOUR * 1000));
      for (let i = 0; i < 3; i++) {
        logVerification(db, {
          tail_number: `N${i}`,
          airline: "UA",
          source: "united",
          has_starlink: null,
          wifi_provider: null,
          aircraft_type: null,
          flight_number: null,
          tail_confirmed: null,
          error: "Timeout after 60s",
        });
      }
      setMeta(db, "united_check_budget", raw, "UA");
      expect(unitedBudgetState(db, T0_MS).used).toBe(3);
      expect(claimUnitedCheck(db, "settle", T0_MS)).toBe(true);
      expect(JSON.parse(getMeta(db, "united_check_budget", "UA") as string)).toHaveLength(4);
    }
  );

  test("a week of both jobs asking on their own beats never passes the ceiling", () => {
    // The ledger alone, at the real figure: the verifier wants a re-confirmation
    // on every 60 s tick (more due than budget, all week); discovery has a
    // settle check about every 16 minutes (90 a day), and 60 at once on day 3.
    const db = makeFreshDb();
    const granted: number[] = [];
    let settleQueue = 0;
    let settleRefusals = 0;
    let reconfirmWhileSettleWaited = 0;
    let longestSettleWaitSec = 0;
    let waitingSince: number | null = null;

    for (let t = 0; t < 7 * DAY; t += 30) {
      const now = (T0 + t) * 1000;
      if (t % 960 === 0) settleQueue++;
      if (t === 3 * DAY) settleQueue += 60;
      if (t % 60 === 0 && claimUnitedCheck(db, "reconfirm", now)) {
        granted.push(T0 + t);
        if (waitingSince !== null) reconfirmWhileSettleWaited++;
      }
      if (t % 90 === 0 && settleQueue > 0) {
        if (claimUnitedCheck(db, "settle", now)) {
          granted.push(T0 + t);
          settleQueue--;
          if (waitingSince !== null) {
            longestSettleWaitSec = Math.max(longestSettleWaitSec, t - waitingSince);
            waitingSince = null;
          }
        } else {
          settleRefusals++;
          waitingSince ??= t;
        }
      }
    }

    expect(busiestDay(granted)).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
    // The budget is used, not just respected: a steady day runs at the line.
    const lastDay = granted.filter((at) => at >= T0 + 6 * DAY).length;
    expect(lastDay).toBeGreaterThanOrEqual(RECONFIRM_LINE - 5);
    // Outside the burst no settle check waits at all; inside it, a refused one
    // gets the very next slot that frees, ahead of the verifier.
    expect(settleQueue).toBe(0);
    expect(reconfirmWhileSettleWaited).toBe(0);
    expect(settleRefusals).toBeGreaterThan(0);
    expect(longestSettleWaitSec).toBeLessThanOrEqual(15 * 60);
  });
});

describe("the jobs under the ceiling", () => {
  let db: Database;
  let fleet: SimFleet;

  const state = () => unitedBudgetState(db);
  const fleetRow = (tail: string) =>
    db
      .query(
        "SELECT next_check_after, verified_at, check_attempts, starlink_status FROM united_fleet WHERE tail_number = ?"
      )
      .get(tail) as {
      next_check_after: number;
      verified_at: number;
      check_attempts: number;
      starlink_status: string;
    };
  const logCount = () =>
    (db.query("SELECT COUNT(*) AS n FROM starlink_verification_log").get() as { n: number }).n;

  function setup(opts: Parameters<typeof seedFleet>[2]): void {
    db = makeFreshDb();
    setSystemTime(new Date(T0_MS));
    fleet = seedFleet(db, T0, opts);
    // Start from an empty ledger: the seeded history is older than this test's
    // subject, and the log fallback has its own tests above. A seeded read
    // inside the last day is still counted, as a check the ledger never saw,
    // so a test that seeds one measures from `state().used` before its run.
    setMeta(db, "united_check_budget", "[]", "UA");
  }

  /** Make one equipped tail the verifier's next pick: its last read was 5 days ago. */
  function makeVerifierDue(tail: string): void {
    db.query(
      "UPDATE starlink_verification_log SET checked_at = ? WHERE tail_number = ? AND checked_at > ?"
    ).run(T0 - 5 * DAY, tail, T0 - 9 * DAY);
  }

  test("the verifier sits a tick out when the budget is closed to what is due", async () => {
    setup({ equipped: 4, unequipped: 0, noFlightEvery: 0 });
    for (const tail of fleet.equipped) makeVerifierDue(tail);
    fill(db, RECONFIRM_LINE, T0_MS);
    const rowsBefore = logCount();

    const sat = await runVerifierTick(db, fleet.verifier);
    expect(sat).toEqual({ checked: 0, held: "reconfirm" });
    expect(fleet.checks).toHaveLength(0);
    expect(logCount()).toBe(rowsBefore);
    expect(state().used).toBe(RECONFIRM_LINE);

    // It does not queue: nothing runs until a later tick finds the budget open.
    setSystemTime(new Date(T0_MS + 60_000));
    expect((await runVerifierTick(db, fleet.verifier)).held).toBe("reconfirm");
    setMeta(db, "united_check_budget", "[]", "UA");
    setSystemTime(new Date(T0_MS + 120_000));
    expect(await runVerifierTick(db, fleet.verifier)).toEqual({ checked: 1, held: null });
    expect(fleet.checks).toHaveLength(1);
    expect(state().used).toBe(1);
  });

  test("a disputed listing is a settle check: the verifier still reaches it past the reserve line", async () => {
    setup({ equipped: 3, unequipped: 0, noFlightEvery: 0 });
    for (const tail of fleet.equipped) makeVerifierDue(tail);
    const disputed = fleet.equipped[2];
    // The sheet says Starlink, our reads settled on another provider.
    db.query("UPDATE starlink_planes SET verified_wifi = 'Viasat' WHERE TailNumber = ?").run(
      disputed
    );
    fill(db, RECONFIRM_LINE, T0_MS);

    expect(await runVerifierTick(db, fleet.verifier)).toEqual({ checked: 1, held: null });
    expect(fleet.checks.map((c) => c.tail)).toEqual([disputed]);

    // The same tail, due and disputed again, with the whole budget spent.
    for (let i = 0; i < UNITED_SETTLE_RESERVE - 1; i++) claimUnitedCheck(db, "settle");
    db.query("DELETE FROM starlink_verification_log WHERE tail_number = ?").run(disputed);
    db.query("UPDATE starlink_planes SET verified_wifi = 'Viasat' WHERE TailNumber = ?").run(
      disputed
    );
    expect(state().open.settle).toBe(false);
    expect(await runVerifierTick(db, fleet.verifier)).toEqual({ checked: 0, held: "settle" });
    expect(fleet.checks).toHaveLength(1);
  });

  test("discovery checks an unsettled tail in place of a re-confirmation the budget refuses", async () => {
    setup({ equipped: 2, unequipped: 0, noFlightEvery: 1 });
    // Both are due now. One is confirmed on the roster but its listing was
    // cleared as ambiguous: it sorts among the settled tails, behind the other.
    const [settled, doubtful] = fleet.equipped;
    db.query(
      "UPDATE united_fleet SET next_check_after = 0, discovery_priority = 0.9 WHERE tail_number = ?"
    ).run(settled);
    db.query(
      "UPDATE united_fleet SET next_check_after = 0, discovery_priority = 0.1 WHERE tail_number = ?"
    ).run(doubtful);
    db.query("UPDATE starlink_planes SET verified_wifi = NULL WHERE TailNumber = ?").run(doubtful);
    for (const tail of fleet.equipped) makeVerifierDue(tail);
    expect(getNextPlanesToVerify(db, 1, "UA")[0].tail_number).toBe(settled);
    fill(db, RECONFIRM_LINE, T0_MS);

    const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
    expect(stats.checked).toBe(1);
    expect(stats.held).toBeNull();
    expect(fleet.checks.map((c) => c.tail)).toEqual([doubtful]);
    // The settled tail was left exactly as it was: still due, nothing written.
    expect(fleetRow(settled).next_check_after).toBe(0);
    expect(fleetRow(settled).check_attempts).toBe(0);

    // With only the re-confirmation left, the tick is sat out.
    const sat = await runDiscoveryBatch(db, 1, fleet.discovery);
    expect(sat.checked).toBe(0);
    expect(sat.held).toBe("reconfirm");
    expect(fleet.checks).toHaveLength(1);
    expect(fleetRow(settled).next_check_after).toBe(0);
  });

  test("with the whole budget spent discovery checks nothing and looks no flight up", async () => {
    setup({ equipped: 0, unequipped: 3 });
    db.query("UPDATE united_fleet SET next_check_after = 0").run();
    fill(db, UNITED_DAILY_CHECK_BUDGET, T0_MS);
    let lookups = 0;
    const deps = {
      ...fleet.discovery,
      getFlights: async (tail: string) => {
        lookups++;
        return fleet.discovery.getFlights(tail);
      },
    };

    const stats = await runDiscoveryBatch(db, 1, deps);
    expect(stats).toMatchObject({ checked: 0, held: "settle", deferred: 0 });
    expect(lookups).toBe(0);
    expect(fleet.checks).toHaveLength(0);
    expect(getNextPlanesToVerify(db, 5, "UA")).toHaveLength(3);
  });

  test("a claim lost between the flight lookup and the check writes nothing", async () => {
    setup({ equipped: 0, unequipped: 1 });
    db.query("UPDATE united_fleet SET next_check_after = 0").run();
    const [plane] = getNextPlanesToVerify(db, 1, "UA");
    fill(db, UNITED_DAILY_CHECK_BUDGET - 1, T0_MS);
    const rowsBefore = logCount();
    const deps = {
      ...fleet.discovery,
      // The verifier takes the last slot while discovery awaits FR24.
      getFlights: async (tail: string) => {
        expect(claimUnitedCheck(db, "settle")).toBe(true);
        return fleet.discovery.getFlights(tail);
      },
    };

    expect(await verifyPlane(db, plane, deps)).toBeNull();
    expect(fleet.checks).toHaveLength(0);
    expect(logCount()).toBe(rowsBefore);
    expect(fleetRow(plane.tail_number)).toMatchObject({ next_check_after: 0, check_attempts: 0 });
  });

  describe("discovery and a tail the verifier has just confirmed", () => {
    const dueNow = (tail: string) =>
      db.query("UPDATE united_fleet SET next_check_after = 0 WHERE tail_number = ?").run(tail);
    const lastReadAt = (tail: string, at: number) =>
      db
        .query(
          "UPDATE starlink_verification_log SET checked_at = ? WHERE tail_number = ? AND checked_at > ?"
        )
        .run(at, tail, T0 - 9 * DAY);

    test("its turn is put off a week, unspent: no lookup, no check, no slot", async () => {
      setup({ equipped: 1, unequipped: 0 });
      const [tail] = fleet.equipped;
      dueNow(tail);
      lastReadAt(tail, T0 - 20 * HOUR);
      const before = fleetRow(tail);
      const usedBefore = state().used;
      let lookups = 0;
      const deps = {
        ...fleet.discovery,
        getFlights: async (t: string) => {
          lookups++;
          return fleet.discovery.getFlights(t);
        },
      };

      const stats = await runDiscoveryBatch(db, 1, deps);
      expect(stats).toMatchObject({ checked: 0, deferred: 1, held: null });
      expect(lookups).toBe(0);
      expect(fleet.checks).toHaveLength(0);
      expect(state().used).toBe(usedBefore);
      const after = fleetRow(tail);
      // The interval a clean check would have set (7 days ±10%), from now.
      expect(after.next_check_after).toBeGreaterThanOrEqual(T0 + 6.3 * DAY - 1);
      expect(after.next_check_after).toBeLessThanOrEqual(T0 + 7.7 * DAY + 1);
      expect(after).toMatchObject({
        verified_at: before.verified_at,
        check_attempts: before.check_attempts,
        starlink_status: "confirmed",
      });
    });

    test("it is put off even while the budget is closed to re-confirmations", async () => {
      setup({ equipped: 1, unequipped: 0 });
      const [tail] = fleet.equipped;
      dueNow(tail);
      lastReadAt(tail, T0 - 20 * HOUR);
      fill(db, UNITED_DAILY_CHECK_BUDGET - state().used, T0_MS);
      expect(state().open).toEqual({ settle: false, reconfirm: false });
      const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
      expect(stats).toMatchObject({ checked: 0, deferred: 1, held: null });
    });

    test.each<[string, (tail: string) => void]>([
      [
        "the verifier's read is older than its own window",
        (tail) => lastReadAt(tail, T0 - 97 * HOUR),
      ],
      [
        "the newest read failed",
        (tail) => {
          lastReadAt(tail, T0 - 30 * HOUR);
          logVerification(db, {
            tail_number: tail,
            airline: "UA",
            source: "united",
            has_starlink: null,
            wifi_provider: null,
            aircraft_type: null,
            flight_number: "UA1",
            tail_confirmed: null,
            error: "Timeout after 60s",
          });
        },
      ],
      [
        "the newest read was of another aircraft",
        (tail) => {
          lastReadAt(tail, T0 - 30 * HOUR);
          logVerification(db, {
            tail_number: tail,
            airline: "UA",
            source: "united",
            has_starlink: null,
            wifi_provider: null,
            aircraft_type: null,
            flight_number: "UA1",
            tail_confirmed: 0,
            error: "Aircraft mismatch: flight has N1",
          });
        },
      ],
      [
        "the newest read was not Starlink",
        (tail) => {
          lastReadAt(tail, T0 - 30 * HOUR);
          logVerification(db, {
            tail_number: tail,
            airline: "UA",
            source: "united",
            has_starlink: false,
            wifi_provider: "Viasat",
            aircraft_type: null,
            flight_number: "UA1",
            tail_confirmed: 1,
            error: null,
          });
        },
      ],
      [
        "the listing is not settled Starlink",
        (tail) => {
          lastReadAt(tail, T0 - 20 * HOUR);
          db.query("UPDATE starlink_planes SET verified_wifi = NULL WHERE TailNumber = ?").run(
            tail
          );
        },
      ],
      [
        "the roster does not hold it confirmed",
        (tail) => {
          lastReadAt(tail, T0 - 20 * HOUR);
          db.query("UPDATE united_fleet SET starlink_status = 'unknown' WHERE tail_number = ?").run(
            tail
          );
        },
      ],
    ])("it is checked as before when %s", async (_why, arrange) => {
      setup({ equipped: 1, unequipped: 0 });
      const [tail] = fleet.equipped;
      dueNow(tail);
      arrange(tail);
      const usedBefore = state().used;
      const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
      expect(stats).toMatchObject({ checked: 1, deferred: 0, held: null });
      expect(fleet.checks.map((c) => c.tail)).toEqual([tail]);
      expect(state().used).toBe(usedBefore + 1);
    });
  });

  test("measured: three weeks with and without the deferral, same seeded fleet", async () => {
    // 70 settled tails (7 of them with no scheduled flight, so only discovery
    // can reach them) and 40 negative ones. Both jobs have
    // many times the capacity this fleet needs, so cadence is all that shows.
    // (A 15-minute beat: this one is about days, not about the jobs racing.)
    const run = async (deferral: boolean) => {
      setup({ equipped: 70, unequipped: 40, dueWithinDays: 14 });
      let deferred = 0;
      await runClock({
        db,
        fleet,
        fromSec: T0,
        toSec: T0 + 21 * DAY,
        verifierEverySec: 900,
        discoveryEverySec: 1350,
        verifierTick: () => runVerifierTick(db, fleet.verifier),
        // Without the deferral: the batch body this branch started from.
        discoveryTick: deferral
          ? async () => {
              deferred += (await runDiscoveryBatch(db, 1, fleet.discovery)).deferred;
            }
          : async () => {
              const [plane] = getNextPlanesToVerify(db, 1, "UA");
              if (plane) await verifyPlane(db, plane, fleet.discovery);
            },
      });
      const settledWeeks = fleet.checks.filter((c) => c.at >= T0 + 7 * DAY);
      const covered = new Set(fleet.equipped.filter((_, i) => i % 10 !== 0));
      const perDay = (kind: "equipped" | "unequipped") =>
        settledWeeks.filter((c) => c.kind === kind).length / 14;
      return {
        equippedPerDay: perDay("equipped"),
        unequippedPerDay: perDay("unequipped"),
        coveredPerTailDay:
          settledWeeks.filter((c) => covered.has(c.tail)).length / 14 / covered.size,
        longestCoveredGap: Math.max(
          ...gapsBetweenChecks(
            fleet.checks.filter((c) => covered.has(c.tail)),
            "equipped"
          )
        ),
        shortestEquippedGap: Math.min(...gapsBetweenChecks(fleet.checks, "equipped")),
        uncoveredChecks: fleet.checks.filter((c) => c.kind === "equipped" && !covered.has(c.tail))
          .length,
        discoveryOnCovered: fleet.checks.filter((c) => c.by === "discovery" && covered.has(c.tail))
          .length,
        deferred,
      };
    };

    const before = await run(false);
    const after = await run(true);
    report([
      "[united-check-budget] deferral, 70 settled + 40 negative tails, days 8-21:",
      `  equipped checks/day   ${before.equippedPerDay.toFixed(1)} -> ${after.equippedPerDay.toFixed(1)}`,
      `  per covered tail/day  ${before.coveredPerTailDay.toFixed(3)} -> ${after.coveredPerTailDay.toFixed(3)}`,
      `  unequipped checks/day ${before.unequippedPerDay.toFixed(1)} -> ${after.unequippedPerDay.toFixed(1)}`,
      `  longest gap, covered  ${(before.longestCoveredGap / HOUR).toFixed(1)} h -> ${(after.longestCoveredGap / HOUR).toFixed(1)} h`,
      `  shortest gap, equipped ${(before.shortestEquippedGap / HOUR).toFixed(1)} h -> ${(after.shortestEquippedGap / HOUR).toFixed(1)} h`,
      `  discovery checks of covered tails ${before.discoveryOnCovered} -> ${after.discoveryOnCovered} (${after.deferred} turns put off)`,
    ]);

    // Discovery stops re-checking what the verifier covers: a turn put off for
    // each check it used to make.
    expect(before.discoveryOnCovered).toBeGreaterThan(100);
    // (Not quite none: now and then a tail's turn falls in the minutes after
    // the verifier's window lapsed and before its next tick. Discovery then
    // checks it, and the verifier counts that check as its own.)
    expect(after.discoveryOnCovered).toBeLessThanOrEqual(5);
    expect(after.deferred).toBeGreaterThan(100);
    // The count falls by less than discovery gave up: each of its checks also
    // reset the verifier's clock, so the verifier now comes round sooner. On
    // a 72-hour window that is 3 checks in 7 days down to 2.33.
    expect(after.coveredPerTailDay).toBeLessThan(before.coveredPerTailDay * 0.9);
    expect(after.coveredPerTailDay).toBeGreaterThan(before.coveredPerTailDay * 0.7);
    // No loss of freshness: a covered tail is never left longer than the
    // verifier's own 96-hour limit (plus a beat), with or without discovery.
    expect(after.longestCoveredGap).toBeLessThanOrEqual(96 * HOUR + 2 * HOUR);
    expect(after.longestCoveredGap).toBeLessThanOrEqual(before.longestCoveredGap + HOUR);
    // Never sooner: no equipped tail is looked at again inside the verifier's
    // shortest window.
    expect(after.shortestEquippedGap).toBeGreaterThanOrEqual(48 * HOUR);
    // Tails only discovery can reach, and negative tails, are checked as before.
    // (To within the ±10% the schedule spreads each turn by: 7 tails, 3 weeks.)
    expect(after.uncoveredChecks).toBeGreaterThanOrEqual(14);
    expect(Math.abs(after.uncoveredChecks - before.uncoveredChecks)).toBeLessThanOrEqual(4);
    expect(Math.abs(after.unequippedPerDay - before.unequippedPerDay)).toBeLessThan(0.5);
  }, 60_000);

  /** Both jobs on their real beats from `fromSec` to `toSec`, counting the ticks each sat out. */
  function runJobs(
    fromSec: number,
    toSec: number,
    held: Record<"verifier" | "discovery", Record<"settle" | "reconfirm", number>>
  ): Promise<void> {
    return runClock({
      db,
      fleet,
      fromSec,
      toSec,
      verifierEverySec: VERIFIER_BEAT,
      discoveryEverySec: DISCOVERY_BEAT,
      verifierTick: async () => {
        const tick = await runVerifierTick(db, fleet.verifier);
        if (tick.held) held.verifier[tick.held]++;
      },
      discoveryTick: async () => {
        const stats = await runDiscoveryBatch(db, 1, fleet.discovery);
        if (stats.held) held.discovery[stats.held]++;
      },
    });
  }
  const noneHeld = () => ({
    verifier: { settle: 0, reconfirm: 0 },
    discovery: { settle: 0, reconfirm: 0 },
  });
  function openFile(path: string): Database {
    const handle = new Database(path);
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec("PRAGMA synchronous = OFF");
    migrate(handle);
    return handle;
  }

  test("36 hours with more aircraft due than budget, across a restart", async () => {
    // The day before: 340 checks, evenly spread, in the log and in no ledger
    // (the state this ships into). 500 settled tails are all overdue, last read
    // four to seven days ago; 150 negative tails come due across the run, 20
    // of them at once at hour 12. 670 due against a budget of 546.
    const dir = mkdtempSync(join(tmpdir(), "united-36h-"));
    const path = join(dir, "db.sqlite");
    const END = T0 + 36 * HOUR;
    try {
      db = openFile(path);
      setSystemTime(new Date(T0_MS));
      fleet = seedFleet(db, T0, {
        equipped: 500,
        unequipped: 150,
        dueWithinDays: 1.4,
        lastReadHoursAgo: [100, 170],
      });
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

      const burst = fleet.unequipped.slice(0, 20);
      for (const tail of burst) {
        db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = ?").run(
          T0 + 12 * HOUR,
          tail
        );
      }

      const held = noneHeld();
      const restartAt = T0 + 18 * HOUR;
      await runJobs(T0, restartAt, held);
      const usedBeforeRestart = unitedBudgetState(db).used;
      db.close();
      db = openFile(path);
      fleet.reopen(db);
      expect(unitedBudgetState(db).used).toBe(usedBeforeRestart);
      await runJobs(restartAt, END, held);

      const { checks } = fleet;
      const starts = [...yesterday, ...checks.map((c) => c.at)];
      const unequipped = checks.filter((c) => c.kind === "unequipped");
      const equipped = checks.filter((c) => c.kind === "equipped");
      const worstUnequippedLate = Math.max(...unequipped.map((c) => c.lateBy));
      const lastDay = checks.filter((c) => c.at >= END - DAY).length;
      report([
        "[united-check-budget] 36 hours, 500 overdue settled + 150 negative tails, 340 checks the day before, restart at hour 18:",
        `  busiest 24 hours      ${busiestDay(starts)} (ceiling ${UNITED_DAILY_CHECK_BUDGET}); last 24 hours ${lastDay}`,
        `  unequipped checked    ${new Set(unequipped.map((c) => c.tail)).size} of 150, worst ${(worstUnequippedLate / 60).toFixed(1)} min late`,
        `  equipped checked      ${new Set(equipped.map((c) => c.tail)).size} of 500`,
        `  ticks sat out         verifier ${held.verifier.reconfirm} (settle ${held.verifier.settle}), discovery ${held.discovery.reconfirm} (settle ${held.discovery.settle})`,
      ]);

      // The ceiling, in every rolling 24 hours: the day before, the restart
      // and the burst included.
      expect(busiestDay(starts)).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
      // It is a ceiling that is reached, not a job that stopped.
      expect(lastDay).toBeGreaterThanOrEqual(RECONFIRM_LINE - 10);

      // Every unequipped tail that came due was checked, on time. Discovery
      // was never held for one, and the worst wait is the 20-tail burst
      // working through one tail per 90 s tick, as it would with no ceiling.
      expect(new Set(unequipped.map((c) => c.tail)).size).toBe(150);
      expect(held.discovery.settle).toBe(0);
      expect(held.verifier.settle).toBe(0);
      expect(worstUnequippedLate).toBeLessThanOrEqual(21 * DISCOVERY_BEAT);
      expect(Math.min(...unequipped.map((c) => c.lateBy))).toBeGreaterThanOrEqual(0);

      // Equipped tails are what waited: every one was due from the first
      // minute, the verifier sat most of its ticks out, and by the end fewer
      // had been reached than a day and a half without a ceiling would reach.
      expect(held.verifier.reconfirm).toBeGreaterThan(1000);
      expect(new Set(equipped.map((c) => c.tail)).size).toBeLessThan(450);
      expect(equipped.length).toBeGreaterThan(250);
      // None was looked at twice: the longest-waiting goes first.
      expect(new Set(equipped.map((c) => c.tail)).size).toBe(equipped.length);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!RUN_JOBS_WEEK)(
    "a week with more aircraft due than budget, across a restart (UNITED_SIM_WEEK=1)",
    async () => {
      // 1,300 settled tails want about 400 re-confirmations a day from the
      // verifier alone; 630 negative tails come due once each in the week (90
      // a day), 20 of them all at once on day 2.
      const dir = mkdtempSync(join(tmpdir(), "united-week-"));
      const path = join(dir, "db.sqlite");
      try {
        db = openFile(path);
        setSystemTime(new Date(T0_MS));
        // The budget is read once before the fleet is seeded: the seeded reads
        // of the last day (about 390) are this fixture's history, not checks
        // an older version made, and read after seeding they would be counted
        // as those and start the week over the ceiling.
        setMeta(db, "united_check_budget", "[]", "UA");
        expect(unitedBudgetState(db).used).toBe(0);
        fleet = seedFleet(db, T0, { equipped: 1300, unequipped: 630 });
        const burst = fleet.unequipped.slice(0, 20);
        for (const tail of burst) {
          db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = ?").run(
            T0 + 2 * DAY,
            tail
          );
        }

        const held = noneHeld();
        const restartAt = T0 + 3.5 * DAY;
        await runJobs(T0, restartAt, held);
        const usedBeforeRestart = unitedBudgetState(db).used;
        db.close();
        db = openFile(path);
        fleet.reopen(db);
        expect(unitedBudgetState(db).used).toBe(usedBeforeRestart);
        await runJobs(restartAt, T0 + 7 * DAY, held);

        const { checks } = fleet;
        const perDay = Array.from(
          { length: 7 },
          (_, d) => checks.filter((c) => c.at >= T0 + d * DAY && c.at < T0 + (d + 1) * DAY).length
        );
        const unequipped = checks.filter((c) => c.kind === "unequipped");
        const worstUnequippedLate = Math.max(...unequipped.map((c) => c.lateBy));
        const equippedGaps = gapsBetweenChecks(checks, "equipped");
        const eligible = fleet.equipped.filter((_, i) => i % 10 !== 0);
        const noFlightTails = new Set(fleet.equipped.filter((_, i) => i % 10 === 0));
        const reached = new Set(checks.filter((c) => c.kind === "equipped").map((c) => c.tail));
        const reachedByDiscovery = [...noFlightTails].filter((tail) => reached.has(tail));
        const busiest = busiestDay(checks.map((c) => c.at));
        report([
          "[united-check-budget] week, 1,300 settled + 630 negative tails, restart at day 3.5:",
          `  checks per day        ${perDay.join(", ")}`,
          `  busiest 24 hours      ${busiest} (ceiling ${UNITED_DAILY_CHECK_BUDGET})`,
          `  unequipped checked    ${new Set(unequipped.map((c) => c.tail)).size} of 630, worst ${(worstUnequippedLate / 60).toFixed(1)} min late`,
          `  equipped checked      ${reached.size} of 1,300; of 130 only discovery can reach, ${reachedByDiscovery.length}`,
          `  longest equipped gap  ${(Math.max(...equippedGaps) / HOUR).toFixed(1)} h, shortest ${(Math.min(...equippedGaps) / HOUR).toFixed(1)} h`,
          `  ticks sat out         verifier ${held.verifier.reconfirm} (settle ${held.verifier.settle}), discovery ${held.discovery.reconfirm} (settle ${held.discovery.settle})`,
        ]);

        expect(busiest).toBeLessThanOrEqual(UNITED_DAILY_CHECK_BUDGET);
        for (const n of perDay) expect(n).toBeGreaterThanOrEqual(RECONFIRM_LINE - 10);

        expect(new Set(unequipped.map((c) => c.tail)).size).toBeGreaterThanOrEqual(628);
        expect(held.discovery.settle).toBe(0);
        expect(held.verifier.settle).toBe(0);
        expect(worstUnequippedLate).toBeLessThanOrEqual(21 * DISCOVERY_BEAT);
        expect(Math.min(...unequipped.map((c) => c.lateBy))).toBeGreaterThanOrEqual(0);

        // Equipped tails wait, and none waits for ever: every tail the
        // verifier can see was reached inside the week, longest-waiting first.
        expect(held.verifier.reconfirm).toBeGreaterThan(1000);
        for (const tail of eligible) expect(reached.has(tail)).toBe(true);
        expect(Math.min(...equippedGaps)).toBeGreaterThanOrEqual(48 * HOUR);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000
  );
});

describe("two guards the ceiling leans on", () => {
  test("starts stamped ahead of the clock still count, until the clock is a day past them", () => {
    const db = makeFreshDb();
    // The clock ran five hours ahead while a full budget was spent, then came back.
    const ahead = T0_MS + 5 * HOUR * 1000;
    setMeta(
      db,
      "united_check_budget",
      JSON.stringify(Array.from({ length: UNITED_DAILY_CHECK_BUDGET }, (_, i) => ahead - i)),
      "UA"
    );
    const shut = { used: UNITED_DAILY_CHECK_BUDGET, open: { settle: false, reconfirm: false } };
    expect(unitedBudgetState(db, T0_MS)).toEqual(shut);
    expect(claimUnitedCheck(db, "settle", T0_MS)).toBe(false);
    expect(claimUnitedCheck(db, "reconfirm", T0_MS)).toBe(false);
    // A forced run is counted beside them, and does not rewrite them away.
    expect(claimUnitedCheck(db, "manual", T0_MS)).toBe(true);
    expect(unitedBudgetState(db, T0_MS).used).toBe(UNITED_DAILY_CHECK_BUDGET + 1);

    const lastMs = ahead + DAY * 1000;
    expect(unitedBudgetState(db, lastMs - UNITED_DAILY_CHECK_BUDGET).open.settle).toBe(false);
    expect(unitedBudgetState(db, lastMs).used).toBe(0);
    expect(claimUnitedCheck(db, "settle", lastMs)).toBe(true);
    db.close();
  });

  test("the verifier takes the tail left longest first, whatever order the roster lists them in", async () => {
    const db = makeFreshDb();
    setSystemTime(new Date(T0_MS));
    const fleet = seedFleet(db, T0, { equipped: 6, unequipped: 0, noFlightEvery: 0 });
    setMeta(db, "united_check_budget", "[]", "UA");
    // All due, last read 5 to 6.7 days ago, the roster's first tail the most recently:
    // a fixed order would start from the wrong end.
    const lastRead = db.query(
      "UPDATE starlink_verification_log SET checked_at = ? WHERE tail_number = ? AND checked_at > ?"
    );
    fleet.equipped.forEach((tail, i) =>
      lastRead.run(T0 - 5 * DAY - i * 8 * HOUR, tail, T0 - 9 * DAY)
    );

    for (let tick = 0; tick < 6; tick++) {
      setSystemTime(new Date(T0_MS + tick * VERIFIER_BEAT * 1000));
      expect(await runVerifierTick(db, fleet.verifier)).toEqual({ checked: 1, held: null });
    }
    expect(fleet.checks.map((c) => c.tail)).toEqual([...fleet.equipped].reverse());
    db.close();
  });
});
