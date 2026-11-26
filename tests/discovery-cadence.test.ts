/**
 * Fleet discovery's re-check schedule, pinned on built cases: CI has no
 * production roster, so every claim the schedule makes (same budget, likelier
 * tails sooner, ground-gap checks inside the same budget, an error is never a "no")
 * is stated here against fleets seeded by hand.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  getNextPlanesToVerify,
  negativeRecheckPlan,
  recordAirborneSightings,
  recordDiscoveryLag,
  updateDatabase,
  updateFleetVerificationResult,
} from "../src/database/database";
import {
  BASELINE_RECHECK_DAYS,
  type CadenceGroup,
  GAP_BUDGET_SHARE,
  GROUND_GAP_SECS,
  INTERVAL_BUDGET_SHARE,
  MAX_RECHECK_DAYS,
  MIN_RECHECK_DAYS,
  SHEET_LISTING_BUMPS_PER_SYNC,
  baselineDailyChecks,
  gapChecksPerDay,
  plannedDailyChecks,
  solveRecheckDays,
  sweepsCoverGap,
} from "../src/database/discovery-cadence";
import { DAY_SEC } from "../src/database/sql/windows";
import { metrics } from "../src/observability";
import type { FleetStats } from "../src/types";
import { addFleet, makeFreshDb, utc } from "./helpers";

const NOW = utc("2026-11-20T12:00:00Z");
const SWEEP_SECS = 300;

/** Shaped like the roster the 30-day telemetry implies; counts are illustrative. */
const ROSTER: CadenceGroup[] = [
  { key: "b737-800", tails: 70, installs: 14 },
  { key: "b737-900", tails: 90, installs: 12 },
  { key: "b737-max9", tails: 190, installs: 8 },
  { key: "b737-max8", tails: 145, installs: 3 },
  { key: "b777", tails: 95, installs: 2 },
  { key: "b787", tails: 80, installs: 1 },
  { key: "a319", tails: 80, installs: 0 },
  { key: "a320", tails: 75, installs: 0 },
  { key: "b757", tails: 60, installs: 0 },
  { key: "b767", tails: 55, installs: 0 },
  { key: "crj-200", tails: 60, installs: 0 },
];

/** Deterministic generator, so a failing case can be replayed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("solveRecheckDays", () => {
  test("no negative tails, no plan", () => {
    expect(solveRecheckDays([]).size).toBe(0);
    expect(solveRecheckDays([{ key: "a", tails: 0, installs: 5 }]).size).toBe(0);
  });

  test("one family keeps the old 14 days exactly", () => {
    const plan = solveRecheckDays([{ key: "b737-900", tails: 120, installs: 9 }]);
    expect(plan.get("b737-900")).toBeCloseTo(BASELINE_RECHECK_DAYS, 6);
  });

  test("families with the same install rate per tail all keep 14 days", () => {
    // Nothing to tell them apart except the prior, which is too small to matter here.
    const plan = solveRecheckDays([
      { key: "a", tails: 50, installs: 500 },
      { key: "b", tails: 100, installs: 1000 },
      { key: "c", tails: 10, installs: 100 },
    ]);
    for (const days of plan.values()) expect(days).toBeCloseTo(BASELINE_RECHECK_DAYS, 1);
  });

  test("retrofit families are checked sooner, families with no installs later", () => {
    const plan = solveRecheckDays(ROSTER);
    const days = (k: string) => plan.get(k) as number;

    for (const k of ["b737-800", "b737-900", "b737-max9"]) {
      expect(days(k)).toBeLessThan(BASELINE_RECHECK_DAYS);
    }
    for (const k of ["a319", "a320", "b757", "b767", "crj-200"]) {
      expect(days(k)).toBeGreaterThan(BASELINE_RECHECK_DAYS);
    }
    // More installs per negative tail, shorter interval.
    expect(days("b737-800")).toBeLessThan(days("b737-900"));
    expect(days("b737-900")).toBeLessThan(days("b737-max9"));
    expect(days("b737-max9")).toBeLessThan(days("b737-max8"));
    expect(days("b737-max8")).toBeLessThan(days("a319"));
  });

  test("spends the old budget and no more", () => {
    const plan = solveRecheckDays(ROSTER);
    const planned = plannedDailyChecks(ROSTER, plan);
    const baseline = baselineDailyChecks(ROSTER);
    expect(planned).toBeLessThanOrEqual(baseline + 1e-9);
    expect(planned).toBeGreaterThan(baseline * 0.999);
  });

  test("never over budget and never outside the clamp, on 500 random rosters", () => {
    const rnd = lcg(20261123);
    for (let i = 0; i < 500; i++) {
      const groups: CadenceGroup[] = Array.from({ length: 1 + Math.floor(rnd() * 14) }, (_, g) => ({
        key: `g${g}`,
        tails: Math.floor(rnd() * 300),
        installs: rnd() < 0.4 ? 0 : Math.floor(rnd() * 40),
      }));
      const plan = solveRecheckDays(groups);
      expect(plannedDailyChecks(groups, plan)).toBeLessThanOrEqual(
        baselineDailyChecks(groups) + 1e-9
      );
      for (const days of plan.values()) {
        expect(days).toBeGreaterThanOrEqual(MIN_RECHECK_DAYS);
        expect(days).toBeLessThanOrEqual(MAX_RECHECK_DAYS);
      }
    }
  });

  test("a family with no installs is still looked at within the cap", () => {
    const plan = solveRecheckDays([
      { key: "hot", tails: 20, installs: 30 },
      { key: "cold", tails: 800, installs: 0 },
    ]);
    expect(plan.get("cold")).toBeLessThanOrEqual(MAX_RECHECK_DAYS);
    expect(plan.get("hot")).toBeGreaterThanOrEqual(MIN_RECHECK_DAYS);
  });

  // The tests above compare against the constants, so they pass whatever the
  // constants say. These state the figures themselves.
  test("the clamp is 3 to 28 days, in figures", () => {
    expect(MIN_RECHECK_DAYS).toBe(3);
    expect(MAX_RECHECK_DAYS).toBe(28);
  });

  test("a family that would be left for months is looked at every 28 days, one that would be checked daily every 3", () => {
    // Unclamped, the square-root rule puts the quiet family past 100 days here.
    const plan = solveRecheckDays([
      { key: "hot", tails: 500, installs: 400 },
      { key: "cold", tails: 50, installs: 0 },
    ]);
    expect(plan.get("cold")).toBe(28);
    // And the budget cannot buy a shorter interval than 3 days however hot.
    const rich = solveRecheckDays([
      { key: "hot", tails: 2, installs: 500 },
      { key: "cold", tails: 800, installs: 0 },
    ]);
    expect(rich.get("hot")).toBe(3);
    expect(rich.get("cold")).toBeLessThanOrEqual(28);
  });
});

describe("the ground-gap share of the budget", () => {
  test("the interval plan leaves the ground-gap share unspent, on any roster", () => {
    const rnd = lcg(7);
    for (let i = 0; i < 200; i++) {
      const groups: CadenceGroup[] = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, g) => ({
        key: `g${g}`,
        tails: Math.floor(rnd() * 300),
        installs: rnd() < 0.4 ? 0 : Math.floor(rnd() * 40),
      }));
      const tails = groups.reduce((n, g) => n + g.tails, 0);
      const planned = plannedDailyChecks(groups, solveRecheckDays(groups, INTERVAL_BUDGET_SHARE));
      // Interval checks plus every ground-gap check the day allows: never over the old budget.
      expect(planned + gapChecksPerDay(tails)).toBeLessThanOrEqual(
        baselineDailyChecks(groups) + 1e-9
      );
    }
  });

  test("with one family the interval stretches by exactly the reserved share", () => {
    const plan = solveRecheckDays([{ key: "a", tails: 300, installs: 4 }], INTERVAL_BUDGET_SHARE);
    expect(plan.get("a")).toBeCloseTo(BASELINE_RECHECK_DAYS / INTERVAL_BUDGET_SHARE, 6);
  });

  test("the allowance is the reserved share, rounded down", () => {
    expect(gapChecksPerDay(0)).toBe(0);
    expect(gapChecksPerDay(50)).toBe(0); // too small a fleet to afford one
    expect(gapChecksPerDay(935)).toBe(Math.floor((GAP_BUDGET_SHARE * 935) / BASELINE_RECHECK_DAYS));
    expect(gapChecksPerDay(935)).toBe(6);
  });

  test("a silence counts only when the sweeps ran through it", () => {
    const gap = 40 * 3600;
    expect(sweepsCoverGap(gap / SWEEP_SECS, gap, SWEEP_SECS)).toBe(true);
    expect(sweepsCoverGap(gap / SWEEP_SECS / 2, gap, SWEEP_SECS)).toBe(true);
    expect(sweepsCoverGap(gap / SWEEP_SECS / 2 - 1, gap, SWEEP_SECS)).toBe(false);
    expect(sweepsCoverGap(0, gap, SWEEP_SECS)).toBe(false);
  });
});

// ── against a built fleet ───────────────────────────────────────────────────

const TYPES = {
  hot: "Boeing 737-824",
  quiet: "Airbus A319-131",
} as const;

function fleetRow(db: Database, tail: string) {
  return db
    .query(
      `SELECT starlink_status, next_check_after, check_attempts, discovery_priority,
              adsb_last_airborne, gap_pulled_at
       FROM united_fleet WHERE tail_number = ?`
    )
    .get(tail) as {
    starlink_status: string;
    next_check_after: number;
    check_attempts: number;
    discovery_priority: number;
    adsb_last_airborne: number | null;
    gap_pulled_at: number | null;
  };
}

function addInstall(db: Database, tail: string, aircraft: string, daysAgo: number): void {
  const date = new Date((NOW - daysAgo * DAY_SEC) * 1000).toISOString().slice(0, 10);
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
     VALUES (?, 'Starlink', '100', 'B737', ?, ?, 'United Airlines', 'mainline', 'Starlink', 'UA')`
  ).run(aircraft, date, tail);
  addFleet(db, tail, "confirmed", { aircraftType: aircraft, verifiedWifi: "Starlink" });
}

/** `perFamily` negative 737-800s with 6 recent installs beside them, and as many negative A319s with none. */
function builtFleet(perFamily = 12): Database {
  const db = makeFreshDb();
  for (let i = 0; i < perFamily; i++) {
    addFleet(db, `N${100 + i}HT`, "negative", { aircraftType: TYPES.hot, verifiedWifi: "Viasat" });
    addFleet(db, `N${100 + i}QT`, "negative", {
      aircraftType: TYPES.quiet,
      verifiedWifi: "Panasonic",
    });
  }
  for (let i = 0; i < 6; i++) addInstall(db, `N${200 + i}SL`, TYPES.hot, 3 + i);
  return db;
}

function nextCheckDays(db: Database, tail: string): number {
  return (fleetRow(db, tail).next_check_after - NOW) / DAY_SEC;
}

/** updateFleetVerificationResult jitters by ±10%. */
const JITTER = 0.1001;

describe("negativeRecheckPlan", () => {
  test("reads families, recent installs and the budget from the fleet tables", () => {
    const db = builtFleet();
    const plan = negativeRecheckPlan(db, "UA", NOW);

    const hot = plan.daysFor("N100HT", TYPES.hot);
    const quiet = plan.daysFor("N100QT", TYPES.quiet);
    expect(hot).toBeLessThan(BASELINE_RECHECK_DAYS);
    expect(quiet).toBeGreaterThan(BASELINE_RECHECK_DAYS);
    expect(plan.negativeTails).toBe(24);
    expect(plan.retrofitting("N100HT", TYPES.hot)).toBe(true);
    expect(plan.retrofitting("N100QT", TYPES.quiet)).toBe(false);
    expect(plannedDailyChecks(plan.groups, plan.days)).toBeLessThanOrEqual(
      INTERVAL_BUDGET_SHARE * baselineDailyChecks(plan.groups) + 1e-9
    );
    db.close();
  });

  test("installs older than the trailing window no longer count", () => {
    const db = makeFreshDb();
    addFleet(db, "N100HT", "negative", { aircraftType: TYPES.hot });
    addFleet(db, "N100QT", "negative", { aircraftType: TYPES.quiet });
    addInstall(db, "N200SL", TYPES.hot, 90);
    const plan = negativeRecheckPlan(db, "UA", NOW);
    const flat = BASELINE_RECHECK_DAYS / INTERVAL_BUDGET_SHARE;
    expect(plan.daysFor("N100HT", TYPES.hot)).toBeCloseTo(flat, 6);
    expect(plan.daysFor("N100QT", TYPES.quiet)).toBeCloseTo(flat, 6);
    expect(plan.retrofitting("N100HT", TYPES.hot)).toBe(false);
    db.close();
  });

  test("a tail the install pipeline marks gets the shortest interval, others pay for it", () => {
    const db = builtFleet();
    const before = negativeRecheckPlan(db, "UA", NOW);
    db.query(
      `INSERT INTO fleet_progress_tails (airline, segment, type_code, tail, state, mod_location, sheet_updated, fetched_at)
       VALUES ('UA', 'mainline_nb', 'A319', 'N100QT', 'in_mod', 'MLB', NULL, ?),
              ('UA', 'mainline_nb', 'A319', 'N101QT', 'scheduled', NULL, NULL, ?)`
    ).run(NOW - 3600, NOW - 3600);

    const plan = negativeRecheckPlan(db, "UA", NOW);
    expect(plan.daysFor("N100QT", TYPES.quiet)).toBeCloseTo(MIN_RECHECK_DAYS, 6);
    // "scheduled" is a plan, not a hangar visit: no shortcut.
    expect(plan.daysFor("N101QT", TYPES.quiet)).toBeGreaterThan(BASELINE_RECHECK_DAYS);
    expect(plan.retrofitting("N100QT", TYPES.quiet)).toBe(true);
    expect(plan.daysFor("N100HT", TYPES.hot)).toBeGreaterThanOrEqual(
      before.daysFor("N100HT", TYPES.hot)
    );
    expect(plannedDailyChecks(plan.groups, plan.days)).toBeLessThanOrEqual(
      INTERVAL_BUDGET_SHARE * baselineDailyChecks(plan.groups) + 1e-9
    );
    db.close();
  });

  test("a pipeline read that stopped days ago is ignored", () => {
    const db = builtFleet();
    db.query(
      `INSERT INTO fleet_progress_tails (airline, segment, type_code, tail, state, mod_location, sheet_updated, fetched_at)
       VALUES ('UA', 'mainline_nb', 'A319', 'N100QT', 'in_mod', 'MLB', NULL, ?)`
    ).run(NOW - 10 * DAY_SEC);
    const plan = negativeRecheckPlan(db, "UA", NOW);
    expect(plan.daysFor("N100QT", TYPES.quiet)).toBeGreaterThan(BASELINE_RECHECK_DAYS);
    db.close();
  });

  test("another airline's tails and installs stay out of the plan", () => {
    const db = builtFleet();
    const before = negativeRecheckPlan(db, "UA", NOW).daysFor("N100HT", TYPES.hot);
    for (let i = 0; i < 40; i++) {
      addFleet(db, `N${500 + i}AS`, "negative", { aircraftType: TYPES.hot, airline: "AS" });
    }
    expect(negativeRecheckPlan(db, "UA", NOW).daysFor("N100HT", TYPES.hot)).toBe(before);
    db.close();
  });
});

describe("updateFleetVerificationResult schedule", () => {
  test("a negative reading schedules the retrofit family sooner than the quiet one", () => {
    const db = builtFleet();
    const plan = negativeRecheckPlan(db, "UA", NOW);
    updateFleetVerificationResult(
      db,
      "N100HT",
      { starlinkStatus: "negative", verifiedWifi: "Viasat" },
      NOW
    );
    updateFleetVerificationResult(
      db,
      "N100QT",
      { starlinkStatus: "negative", verifiedWifi: "Panasonic" },
      NOW
    );

    const hot = plan.daysFor("N100HT", TYPES.hot);
    const quiet = plan.daysFor("N100QT", TYPES.quiet);
    expect(Math.abs(nextCheckDays(db, "N100HT") - hot)).toBeLessThanOrEqual(hot * JITTER);
    expect(Math.abs(nextCheckDays(db, "N100QT") - quiet)).toBeLessThanOrEqual(quiet * JITTER);
    expect(nextCheckDays(db, "N100HT")).toBeLessThan(nextCheckDays(db, "N100QT"));
    db.close();
  });

  test("an upstream error changes no status and retries on the old backoff", () => {
    const db = builtFleet();
    updateFleetVerificationResult(
      db,
      "N100HT",
      { starlinkStatus: "negative", verifiedWifi: "Viasat", error: "timeout" },
      NOW
    );
    const row = fleetRow(db, "N100HT");
    expect(row.starlink_status).toBe("negative");
    expect(row.check_attempts).toBe(1);
    expect(Math.abs(row.next_check_after - NOW - 3600)).toBeLessThanOrEqual(3600 * JITTER);
    db.close();
  });

  test("an unsettled reading and a confirmed one keep their old intervals", () => {
    const db = builtFleet();
    updateFleetVerificationResult(
      db,
      "N100HT",
      { starlinkStatus: "negative", verifiedWifi: "Viasat", needsMoreObs: true },
      NOW
    );
    expect(Math.abs(nextCheckDays(db, "N100HT") - 1.5)).toBeLessThanOrEqual(1.5 * JITTER);

    updateFleetVerificationResult(
      db,
      "N101HT",
      { starlinkStatus: "confirmed", verifiedWifi: "Starlink" },
      NOW
    );
    expect(Math.abs(nextCheckDays(db, "N101HT") - 7)).toBeLessThanOrEqual(7 * JITTER);
    db.close();
  });
});

describe("the longest a negative tail is left", () => {
  test("no negative reading schedules the next look past 28 days plus the jitter, on any built fleet", () => {
    // Fleets where the plan wants far more than 28 days for the quiet family:
    // many quiet tails, a few very hot ones.
    for (const perFamily of [12, 60, 200]) {
      const db = builtFleet(perFamily);
      for (let i = 0; i < 30; i++) addInstall(db, `N${300 + i}SL`, TYPES.hot, 1 + (i % 20));
      for (const [tail, wifi] of [
        ["N100HT", "Viasat"],
        ["N100QT", "Panasonic"],
      ] as const) {
        updateFleetVerificationResult(
          db,
          tail,
          { starlinkStatus: "negative", verifiedWifi: wifi },
          NOW
        );
        expect(nextCheckDays(db, tail)).toBeLessThanOrEqual(28 * (1 + JITTER));
        expect(nextCheckDays(db, tail)).toBeGreaterThanOrEqual(3 * (1 - JITTER));
      }
      db.close();
    }
  });
});

describe("getNextPlanesToVerify order", () => {
  test("never-checked, then named, then likeliest family, then the rest, then confirmed", () => {
    const db = builtFleet();
    db.query("UPDATE united_fleet SET next_check_after = ? WHERE airline = 'UA'").run(
      NOW + DAY_SEC
    );
    const due = db.query(
      "UPDATE united_fleet SET next_check_after = ?, discovery_priority = ? WHERE tail_number = ?"
    );
    // Priorities set against the wanted order, so only the new keys can produce it.
    due.run(NOW - 60, 0.5, "N200SL"); // confirmed
    due.run(NOW - 60, 0.8, "N100QT"); // quiet family
    due.run(NOW - 60, 0.5, "N100HT"); // retrofit family
    due.run(NOW - 60, 0.9, "N101QT"); // quiet family, bumped by name
    addFleet(db, "N900NW", "unknown", { aircraftType: TYPES.quiet });
    db.query("UPDATE united_fleet SET next_check_after = 0 WHERE tail_number = 'N900NW'").run();

    const order = getNextPlanesToVerify(db, 10, "UA", NOW).map((p) => p.tail_number);
    expect(order).toEqual(["N900NW", "N101QT", "N100HT", "N100QT", "N200SL"]);
    expect(getNextPlanesToVerify(db, 2, "UA", NOW).map((p) => p.tail_number)).toEqual([
      "N900NW",
      "N101QT",
    ]);
    db.close();
  });

  test("a tail that is not due is never returned", () => {
    const db = builtFleet();
    db.query("UPDATE united_fleet SET next_check_after = ? WHERE airline = 'UA'").run(NOW + 1);
    expect(getNextPlanesToVerify(db, 10, "UA", NOW)).toEqual([]);
    db.close();
  });
});

describe("recordAirborneSightings", () => {
  const TAIL = "N100HT";
  /** 150 negatives per family: enough for an allowance of two ground-gap checks a day. */
  const PER_FAMILY = 150;

  function addSweeps(db: Database, from: number, to: number): void {
    const stmt = db.query(
      `INSERT INTO adsb_sweeps (swept_at, provider, requests, latency_ms, tails_queried, observed,
         airborne, matched, mismatched, no_assignment, no_callsign)
       VALUES (?, 'adsb.fi', 1, 100, 24, 10, 8, 0, 0, 8, 0)`
    );
    for (let t = from + SWEEP_SECS; t < to; t += SWEEP_SECS) stmt.run(t);
  }

  /** Every tail last seen airborne `hours` ago, regular checks due in 5 days. */
  function grounded(hours: number, sweeps = true): Database {
    const db = builtFleet(PER_FAMILY);
    const lastSeen = NOW - hours * 3600;
    db.query(
      "UPDATE united_fleet SET adsb_last_airborne = ?, next_check_after = ? WHERE airline = 'UA'"
    ).run(lastSeen, NOW + 5 * DAY_SEC);
    if (sweeps) addSweeps(db, lastSeen, NOW);
    return db;
  }

  test("the built fleet affords two ground-gap checks a day", () => {
    const db = builtFleet(PER_FAMILY);
    expect(gapChecksPerDay(negativeRecheckPlan(db, "UA", NOW).negativeTails)).toBe(2);
    db.close();
  });

  test("a first sighting only sets the stamp", () => {
    const db = builtFleet(PER_FAMILY);
    const before = fleetRow(db, TAIL).next_check_after;
    expect(recordAirborneSightings(db, "UA", [TAIL], NOW, SWEEP_SECS)).toEqual([]);
    expect(fleetRow(db, TAIL).adsb_last_airborne).toBe(NOW);
    expect(fleetRow(db, TAIL).next_check_after).toBe(before);
    expect(fleetRow(db, "N101HT").adsb_last_airborne).toBeNull();
    db.close();
  });

  test("a negative tail of a retrofit family, back after a ground gap, is checked next", () => {
    const db = grounded(40);
    expect(recordAirborneSightings(db, "UA", [TAIL], NOW, SWEEP_SECS)).toEqual([TAIL]);
    const row = fleetRow(db, TAIL);
    expect(row.next_check_after).toBe(NOW);
    expect(row.gap_pulled_at).toBe(NOW);
    expect(row.adsb_last_airborne).toBe(NOW);
    expect(getNextPlanesToVerify(db, 1, "UA", NOW)[0]?.tail_number).toBe(TAIL);

    // Seen again five minutes later: no second pull.
    expect(recordAirborneSightings(db, "UA", [TAIL], NOW + SWEEP_SECS, SWEEP_SECS)).toEqual([]);

    // The pulled check reads non-Starlink: back on the family's regular interval.
    updateFleetVerificationResult(
      db,
      TAIL,
      { starlinkStatus: "negative", verifiedWifi: "Viasat" },
      NOW
    );
    const days = negativeRecheckPlan(db, "UA", NOW).daysFor(TAIL, TYPES.hot);
    expect(Math.abs(nextCheckDays(db, TAIL) - days)).toBeLessThanOrEqual(days * JITTER);
    db.close();
  });

  test("never more pulls in a rolling day than the allowance, longest silence first", () => {
    const db = grounded(40);
    // N105HT has been gone longest.
    db.query("UPDATE united_fleet SET adsb_last_airborne = ? WHERE tail_number = 'N105HT'").run(
      NOW - 60 * 3600
    );
    addSweeps(db, NOW - 60 * 3600, NOW - 40 * 3600);
    const hot = Array.from({ length: 10 }, (_, i) => `N${100 + i}HT`);

    const first = recordAirborneSightings(db, "UA", hot, NOW, SWEEP_SECS);
    expect(first.length).toBe(2);
    expect(first[0]).toBe("N105HT");

    // More returns later the same day: the allowance is spent.
    const later = Array.from({ length: 10 }, (_, i) => `N${120 + i}HT`);
    addSweeps(db, NOW, NOW + 6 * 3600);
    expect(recordAirborneSightings(db, "UA", later, NOW + 6 * 3600, SWEEP_SECS)).toEqual([]);

    // A day on, it is available again.
    const nextDay = NOW + DAY_SEC + 60;
    addSweeps(db, NOW + 6 * 3600, nextDay);
    const again = Array.from({ length: 10 }, (_, i) => `N${140 + i}HT`);
    expect(recordAirborneSightings(db, "UA", again, nextDay, SWEEP_SECS).length).toBe(2);

    const pulledEver = db
      .query("SELECT COUNT(*) AS n FROM united_fleet WHERE gap_pulled_at IS NOT NULL")
      .get() as { n: number };
    expect(pulledEver.n).toBe(4);
    db.close();
  });

  test.each<[string, (db: Database) => void, number, string]>([
    ["a silence shorter than the gap", () => {}, GROUND_GAP_SECS / 3600 - 1, TAIL],
    [
      "a confirmed tail",
      (db) =>
        db
          .query("UPDATE united_fleet SET starlink_status = 'confirmed' WHERE tail_number = ?")
          .run(TAIL),
      40,
      TAIL,
    ],
    [
      "a never-checked tail (already first in the queue)",
      (db) =>
        db
          .query("UPDATE united_fleet SET starlink_status = 'unknown' WHERE tail_number = ?")
          .run(TAIL),
      40,
      TAIL,
    ],
    [
      "a tail whose regular check is within a day anyway",
      (db) =>
        db
          .query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = ?")
          .run(NOW + 3600, TAIL),
      40,
      TAIL,
    ],
    [
      "a tail of a family with no installs: a maintenance visit, not a retrofit",
      () => {},
      40,
      "N100QT",
    ],
  ])("not pulled forward: %s", (_name, arrange, hours, tail) => {
    const db = grounded(hours);
    arrange(db);
    const before = fleetRow(db, tail).next_check_after;
    expect(recordAirborneSightings(db, "UA", [tail], NOW, SWEEP_SECS)).toEqual([]);
    expect(fleetRow(db, tail).next_check_after).toBe(before);
    expect(fleetRow(db, tail).gap_pulled_at).toBeNull();
    expect(fleetRow(db, tail).adsb_last_airborne).toBe(NOW);
    db.close();
  });

  test("a pipeline-marked tail is pulled forward whatever its family", () => {
    const db = grounded(40);
    db.query(
      `INSERT INTO fleet_progress_tails (airline, segment, type_code, tail, state, mod_location, sheet_updated, fetched_at)
       VALUES ('UA', 'mainline_nb', 'A319', 'N100QT', 'in_mod', 'MLB', NULL, ?)`
    ).run(NOW - 3600);
    expect(recordAirborneSightings(db, "UA", ["N100QT"], NOW, SWEEP_SECS)).toEqual(["N100QT"]);
    db.close();
  });

  test("an aggregator outage does not queue the fleet", () => {
    // 40 hours with no successful sweep: every tail "returns" at once.
    const db = grounded(40, false);
    const tails = Array.from({ length: PER_FAMILY }, (_, i) => `N${100 + i}HT`);

    expect(recordAirborneSightings(db, "UA", tails, NOW, SWEEP_SECS)).toEqual([]);
    expect(getNextPlanesToVerify(db, 50, "UA", NOW)).toEqual([]);
    for (const t of tails) expect(fleetRow(db, t).adsb_last_airborne).toBe(NOW);
    db.close();
  });

  test("a fleet too small to afford a ground-gap check gets none", () => {
    const db = builtFleet(12);
    db.query(
      "UPDATE united_fleet SET adsb_last_airborne = ?, next_check_after = ? WHERE airline = 'UA'"
    ).run(NOW - 40 * 3600, NOW + 5 * DAY_SEC);
    addSweeps(db, NOW - 40 * 3600, NOW);
    expect(recordAirborneSightings(db, "UA", [TAIL], NOW, SWEEP_SECS)).toEqual([]);
    db.close();
  });

  test("another airline's sweep leaves this airline's tail untouched", () => {
    const db = grounded(40);
    expect(recordAirborneSightings(db, "AS", [TAIL], NOW, SWEEP_SECS)).toEqual([]);
    expect(fleetRow(db, TAIL).adsb_last_airborne).toBe(NOW - 40 * 3600);
    db.close();
  });
});

describe("discovery.lag_hours", () => {
  const STATS: FleetStats = {
    express: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
    mainline: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
  };

  function captureLag<T>(run: () => T): { result: T; points: Array<Record<string, unknown>> } {
    const points: Array<Record<string, unknown>> = [];
    const original = metrics.distribution;
    metrics.distribution = (name, value, tags) => {
      if (name === "discovery.lag_hours") points.push({ value, ...(tags ?? {}) });
      original(name, value, tags);
    };
    try {
      return { result: run(), points };
    } finally {
      metrics.distribution = original;
    }
  }

  function addCheck(
    db: Database,
    tail: string,
    hoursAgo: number,
    over: { hasStarlink?: number | null; provider?: string | null; error?: string | null } = {}
  ): void {
    const { hasStarlink = 0, provider = "Viasat", error = null } = over;
    db.query(
      `INSERT INTO starlink_verification_log
         (tail_number, source, checked_at, has_starlink, wifi_provider, error, tail_confirmed, airline)
       VALUES (?, 'united', ?, ?, ?, ?, 1, 'UA')`
    ).run(tail, NOW - hoursAgo * 3600, hasStarlink, provider, error);
  }

  test("hours since the last clean non-Starlink reading, tagged with who was first", () => {
    const db = builtFleet();
    addCheck(db, "N100HT", 300);
    addCheck(db, "N100HT", 96);
    addCheck(db, "N100HT", 2, { hasStarlink: 1, provider: "Starlink" });

    const { result, points } = captureLag(() =>
      recordDiscoveryLag(db, "N100HT", "UA", "own", "mainline", NOW)
    );
    expect(result).toBe(96);
    expect(points).toEqual([
      {
        value: 96,
        first_source: "own",
        trigger: "scheduled",
        fleet: "mainline",
        airline: "united",
      },
    ]);

    // Found within days of a ground-gap pull: credited to it.
    db.query("UPDATE united_fleet SET gap_pulled_at = ? WHERE tail_number = 'N100HT'").run(
      NOW - 2 * DAY_SEC
    );
    const viaGap = captureLag(() => recordDiscoveryLag(db, "N100HT", "UA", "own", "mainline", NOW));
    expect(viaGap.points[0]).toMatchObject({ first_source: "own", trigger: "ground_gap" });

    // A pull from weeks ago is not what found it.
    db.query("UPDATE united_fleet SET gap_pulled_at = ? WHERE tail_number = 'N100HT'").run(
      NOW - 20 * DAY_SEC
    );
    const stale = captureLag(() => recordDiscoveryLag(db, "N100HT", "UA", "own", "mainline", NOW));
    expect(stale.points[0]).toMatchObject({ trigger: "scheduled" });
    db.close();
  });

  test("an errored or empty check is not a negative reading to measure from", () => {
    const db = builtFleet();
    addCheck(db, "N100HT", 200);
    addCheck(db, "N100HT", 50, { hasStarlink: null, provider: null, error: "timeout" });
    addCheck(db, "N100HT", 20, { provider: "" });
    const { result } = captureLag(() =>
      recordDiscoveryLag(db, "N100HT", "UA", "own", "mainline", NOW)
    );
    expect(result).toBe(200);
    db.close();
  });

  test("a tail never read as non-Starlink emits nothing", () => {
    const db = builtFleet();
    const { result, points } = captureLag(() =>
      recordDiscoveryLag(db, "N100HT", "UA", "sheet", "mainline", NOW)
    );
    expect(result).toBeNull();
    expect(points).toEqual([]);
    db.close();
  });

  test("the sheet listing a tail our checks hold as negative emits first_source:sheet, once", () => {
    const db = builtFleet();
    addCheck(db, "N100HT", 72);
    const sheet = [
      // Already listed before this scrape: not news.
      ...Array.from({ length: 6 }, (_, i) => ({ TailNumber: `N${200 + i}SL` })),
      // New on the sheet, negative to us: the sheet was first.
      { TailNumber: "N100HT" },
      // New on the sheet, but we never read it as non-Starlink: nothing to measure.
      { TailNumber: "N101HT" },
    ].map((r) => ({
      ...r,
      Aircraft: TYPES.hot,
      WiFi: "Starlink",
      sheet_gid: "100",
      sheet_type: "B737",
      fleet: "mainline" as const,
      OperatedBy: "United Airlines",
    }));

    const first = captureLag(() => updateDatabase(db, 900, sheet, STATS, "UA"));
    expect(first.result).toBeNull();
    expect(first.points.length).toBe(1);
    expect(first.points[0]).toMatchObject({
      first_source: "sheet",
      trigger: "sheet",
      fleet: "mainline",
    });
    expect(first.points[0].value as number).toBeGreaterThanOrEqual(72);

    // The next hourly scrape lists the same tails: no second point.
    const second = captureLag(() => updateDatabase(db, 900, sheet, STATS, "UA"));
    expect(second.points).toEqual([]);
    db.close();
  });

  test("a tail we hold as confirmed emits nothing when the sheet first lists it", () => {
    // Confirmed on the roster with no listing row (the listing was dropped),
    // and an old non-Starlink reading to measure from: only the roster-status
    // guard stands between this tail and a first_source:sheet point.
    const db = builtFleet();
    addFleet(db, "N300CF", "confirmed", { aircraftType: TYPES.hot, verifiedWifi: "Starlink" });
    addCheck(db, "N300CF", 500);
    addCheck(db, "N300CF", 30, { hasStarlink: 1, provider: "Starlink" });
    const { points } = captureLag(() =>
      updateDatabase(db, 900, sheetOf([...LISTED, "N300CF"]), STATS, "UA")
    );
    expect(points).toEqual([]);
    db.close();
  });

  const LISTED = Array.from({ length: 6 }, (_, i) => `N${200 + i}SL`);
  function sheetOf(tails: string[]) {
    return tails.map((TailNumber) => ({
      TailNumber,
      Aircraft: TYPES.hot,
      WiFi: "Starlink",
      sheet_gid: "100",
      sheet_type: "B737",
      fleet: "mainline" as const,
      OperatedBy: "United Airlines",
    }));
  }

  describe("a first sheet listing moves the tail's discovery check to the front", () => {
    const realNow = () => Math.floor(Date.now() / 1000);
    /** Every UA tail's next look is days away, at an ordinary priority. */
    function notDue(db: Database): number {
      const later = realNow() + 10 * DAY_SEC;
      db.query(
        "UPDATE united_fleet SET next_check_after = ?, discovery_priority = 0.5 WHERE airline = 'UA'"
      ).run(later);
      return later;
    }

    test("a tail we hold as not Starlink is due at once and leads the negatives", () => {
      const db = builtFleet();
      const later = notDue(db);
      // Another negative already due, bumped by name earlier: the listing still leads.
      db.query(
        "UPDATE united_fleet SET next_check_after = 0, discovery_priority = 0.9 WHERE tail_number = 'N105HT'"
      ).run();

      expect(updateDatabase(db, 900, sheetOf([...LISTED, "N100HT"]), STATS, "UA")).toBeNull();

      const row = fleetRow(db, "N100HT");
      expect(row.next_check_after).toBeLessThanOrEqual(realNow());
      expect(row.discovery_priority).toBe(1);
      // What we hold is untouched: the listing settles nothing by itself.
      expect(row.starlink_status).toBe("negative");
      expect(getNextPlanesToVerify(db, 1, "UA")[0].tail_number).toBe("N100HT");
      // Nobody else moved.
      expect(fleetRow(db, "N101HT").next_check_after).toBe(later);
      expect(fleetRow(db, "N100QT").next_check_after).toBe(later);
      db.close();
    });

    test("once: the next hourly read does not move it again", () => {
      const db = builtFleet();
      notDue(db);
      const sheet = sheetOf([...LISTED, "N100HT"]);
      updateDatabase(db, 900, sheet, STATS, "UA");
      // The check it was moved up for read another provider and put it back on its interval.
      updateFleetVerificationResult(db, "N100HT", {
        starlinkStatus: "negative",
        verifiedWifi: "Viasat",
      });
      const after = fleetRow(db, "N100HT");
      expect(after.next_check_after).toBeGreaterThan(realNow() + 2 * DAY_SEC);

      for (let hour = 0; hour < 3; hour++) updateDatabase(db, 900, sheet, STATS, "UA");
      expect(fleetRow(db, "N100HT")).toEqual(after);
      db.close();
    });

    test("not for a tail the sheet already listed", () => {
      const db = builtFleet();
      // Listed for weeks, and our reads still say another provider: a held tail.
      db.query(
        `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, airline)
         VALUES (?, 'Starlink', '100', 'B737', '2026-11-01', 'N100HT', 'United Airlines', 'mainline', 'UA')`
      ).run(TYPES.hot);
      const later = notDue(db);
      updateDatabase(db, 900, sheetOf([...LISTED, "N100HT"]), STATS, "UA");
      expect(fleetRow(db, "N100HT").next_check_after).toBe(later);
      expect(fleetRow(db, "N100HT").discovery_priority).toBe(0.5);
      db.close();
    });

    test("not for a tail we hold as confirmed", () => {
      const db = builtFleet();
      addFleet(db, "N300CF", "confirmed", { aircraftType: TYPES.hot, verifiedWifi: "Starlink" });
      const later = notDue(db);
      updateDatabase(db, 900, sheetOf([...LISTED, "N300CF"]), STATS, "UA");
      expect(fleetRow(db, "N300CF").next_check_after).toBe(later);
      expect(fleetRow(db, "N300CF").discovery_priority).toBe(0.5);
      db.close();
    });

    test("a tail already due keeps its due time and still gets the lead", () => {
      const db = builtFleet();
      notDue(db);
      db.query(
        "UPDATE united_fleet SET next_check_after = 1234 WHERE tail_number = 'N100HT'"
      ).run();
      updateDatabase(db, 900, sheetOf([...LISTED, "N100HT"]), STATS, "UA");
      expect(fleetRow(db, "N100HT").next_check_after).toBe(1234);
      expect(fleetRow(db, "N100HT").discovery_priority).toBe(1);
      db.close();
    });

    test("a look already due within a day and a half is left where it is", () => {
      const db = builtFleet();
      notDue(db);
      const soon = realNow() + 20 * 3600;
      db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = 'N100HT'").run(
        soon
      );
      updateDatabase(db, 900, sheetOf([...LISTED, "N100HT"]), STATS, "UA");
      expect(fleetRow(db, "N100HT").next_check_after).toBe(soon);
      expect(fleetRow(db, "N100HT").discovery_priority).toBe(1);
      db.close();
    });

    test("one read moves at most ten; the rest keep their scheduled look", () => {
      const db = builtFleet(15);
      const later = notDue(db);
      const hot = Array.from({ length: 15 }, (_, i) => `N${100 + i}HT`);
      updateDatabase(db, 900, sheetOf([...LISTED, ...hot]), STATS, "UA");
      const moved = hot.filter((t) => fleetRow(db, t).next_check_after < later);
      expect(moved.length).toBe(SHEET_LISTING_BUMPS_PER_SYNC);
      expect(SHEET_LISTING_BUMPS_PER_SYNC).toBe(10);
      // The five left over are listed now, so no later read moves them either.
      updateDatabase(db, 900, sheetOf([...LISTED, ...hot]), STATS, "UA");
      expect(hot.filter((t) => fleetRow(db, t).next_check_after < later).length).toBe(10);
      db.close();
    });
  });
});
