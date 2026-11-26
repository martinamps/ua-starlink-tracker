/**
 * The first-read count (src/database/first-read.ts): a tail the community
 * sheet itself lists is counted on our first Starlink read of it, and taken
 * back when the next read disagrees or the sheet withdraws the row.
 *
 * Each named tail is the shape of a real case in the 30-day backtest
 * (27 Oct to 26 Nov 2026), rebuilt from the report's rows: no test here
 * opens united.com, the sheet or any other host. Reads go through
 * applyUnitedObservation, the path the verifier and discovery both write by.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import {
  type FirstReadEvent,
  computeWifiConsensus,
  getFlightAssignments,
  getListedNotCounted,
  getRecentInstalls,
  reconcileConsensus,
  settleReads,
  updateDatabase,
  updateFleetVerificationResult,
} from "../src/database/database";
import {
  FIRST_READ_MAX_AGE_SECS,
  firstReadDecision,
  firstReadNote,
  firstReadTakenBackNote,
} from "../src/database/first-read";
import { recordSourceSuccess } from "../src/database/source-health";
import { equippedSql, verifiedEquippedSql } from "../src/database/sql/equipped";
import { COUNTERS, metrics } from "../src/observability/metrics";
import {
  applyUnitedObservation,
  classifyCheckResult,
  logUnitedCheckFailure,
} from "../src/scripts/united-verdict";
import { createApp } from "../src/server/app";
import type { FleetStats } from "../src/types";
import { makeFreshDb, req, utc } from "./helpers";

const HOUR = 3600;
const DAY = 24 * HOUR;
const T0 = utc("2026-11-01T00:00:00Z");
const STATS: FleetStats = {
  express: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
  mainline: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
};

let clock = T0;
const at = (sec: number) => {
  clock = sec;
  setSystemTime(new Date(sec * 1000));
};
const later = (secs: number) => at(clock + secs);

let points: Array<Record<string, unknown>> = [];
let restoreMetrics = () => {};
beforeEach(() => {
  at(T0);
  points = [];
  const original = metrics.increment;
  metrics.increment = (name, tags) => {
    if (name === COUNTERS.FIRST_READ_COUNT) points.push(tags as Record<string, unknown>);
    original(name, tags);
  };
  restoreMetrics = () => {
    metrics.increment = original;
  };
});
afterEach(() => {
  restoreMetrics();
  setSystemTime();
});
afterAll(() => setSystemTime());

const sheetRow = (TailNumber: string) => ({
  TailNumber,
  Aircraft: "Boeing 737-900",
  WiFi: "StrLnk",
  sheet_gid: "100",
  sheet_type: "B737",
  fleet: "mainline" as const,
  OperatedBy: "United Airlines",
});

/** The hourly sheet job: the read, its health mark and the sweep. */
function hourlySheet(db: Database, tails: readonly string[]): FirstReadEvent[] {
  // Three other listings ride along so the read is never an empty sheet.
  const rows = [...tails, "N10001", "N10002", "N10003"].map(sheetRow);
  expect(updateDatabase(db, 1000, rows, STATS, "UA")).toBeNull();
  recordSourceSuccess(db, "sheet_scrape", "UA");
  const events: FirstReadEvent[] = [];
  reconcileConsensus(db, undefined, events);
  return events;
}

/** A roster row we hold as not Starlink, the way a jet stood before its fit. */
function rosterNegative(db: Database, tail: string, provider = "Viasat"): void {
  db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at,
       fleet, operated_by, starlink_status, verified_wifi, verified_at, next_check_after, discovery_priority, airline)
     VALUES (?, 'Boeing 737-900', 'test', 1, ?, 'mainline', 'United Airlines', 'negative', ?, ?, ?, 0.5, 'UA')`
  ).run(tail, clock, provider, clock - 12 * DAY, clock + 7 * DAY);
}

/** One reading of united.com for the tail, written as both jobs write it. */
function read(db: Database, tail: string, provider: string) {
  return applyUnitedObservation(
    db,
    classifyCheckResult(
      {
        hasStarlink: provider === "Starlink",
        wifiProvider: provider,
        tailNumber: tail,
        shipNumber: null,
        aircraftType: "737-900",
        flightNumber: "UA100",
        date: "2026-11-01",
        origin: "SFO",
        destination: "EWR",
      },
      tail,
      new Map()
    ),
    { flightNumber: "UA100", aircraftType: "737-900" }
  );
}

const counted = (db: Database, tail: string) =>
  db
    .query(`SELECT 1 FROM starlink_planes sp WHERE sp.TailNumber = ? AND ${equippedSql("sp")}`)
    .get(tail) != null;
const verified = (db: Database, tail: string) =>
  db
    .query(
      `SELECT 1 FROM starlink_planes sp WHERE sp.TailNumber = ? AND ${verifiedEquippedSql("sp")}`
    )
    .get(tail) != null;
const roster = (db: Database, tail: string) =>
  db
    .query(
      "SELECT starlink_status, verified_wifi, first_read_counted_at, first_read_taken_back_at, first_read_taken_back_reason, next_check_after FROM united_fleet WHERE tail_number = ?"
    )
    .get(tail) as {
    starlink_status: string;
    verified_wifi: string | null;
    first_read_counted_at: number | null;
    first_read_taken_back_at: number | null;
    first_read_taken_back_reason: string | null;
    next_check_after: number;
  };
const listing = (db: Database, tail: string) =>
  db.query("SELECT verified_wifi FROM starlink_planes WHERE TailNumber = ?").get(tail) as {
    verified_wifi: string | null;
  } | null;
const outcomes = () => points.map((p) => `${p.outcome}:${p.reason}`);

/** A tail we read as Viasat a fortnight ago, now on the sheet. */
function retrofit(db: Database, tail: string): void {
  rosterNegative(db, tail);
  at(T0 - 14 * DAY);
  read(db, tail, "Viasat");
  at(T0 - 7 * DAY);
  read(db, tail, "Viasat");
  at(T0);
  hourlySheet(db, [tail]);
}

/** A clean, tail-confirmed read of ours stored at `atSec`, with no settle run. */
function storedRead(db: Database, tail: string, atSec: number, provider: string): void {
  db.query(
    `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
     VALUES (?, 'united', ?, ?, ?, 1, 'UA')`
  ).run(tail, atSec, provider === "Starlink" ? 1 : 0, provider);
}

/** The hourly job's sweep with no new sheet read: the import is as old as it was. */
function sweepOnly(db: Database): FirstReadEvent[] {
  const events: FirstReadEvent[] = [];
  reconcileConsensus(db, undefined, events);
  return events;
}

describe("the sheet alone never counts a tail (guard 1)", () => {
  // N34455, N62849, N66848: listed for days in the backtest's window, every
  // read of ours another provider. Thirteen such listings never read Starlink.
  test.each(["N34455", "N62849", "N66848"])(
    "%s: listed, never read Starlink, never counted",
    (tail) => {
      const db = makeFreshDb();
      retrofit(db, tail);
      expect(counted(db, tail)).toBe(false);
      for (let day = 1; day <= 5; day++) {
        at(T0 + day * DAY);
        read(db, tail, "Viasat");
        hourlySheet(db, [tail]);
        expect(counted(db, tail)).toBe(false);
      }
      expect(roster(db, tail).first_read_counted_at).toBeNull();
      expect(points).toEqual([]);
      db.close();
    }
  );

  test("one Starlink read of ours alone does not count an unlisted tail", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N11206");
    hourlySheet(db, []);
    later(HOUR);
    const consensus = read(db, "N11206", "Starlink");
    expect(consensus?.rule).not.toBe("first_read");
    expect(counted(db, "N11206")).toBe(false);
    expect(roster(db, "N11206").starlink_status).toBe("negative");
    expect(points).toEqual([]);
    db.close();
  });

  test("a row our own discovery wrote is not the sheet's listing", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N47330");
    hourlySheet(db, []);
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, sheet_gid, airline)
       VALUES ('Boeing 737-900', 'StrLnk', '2026-11-01', 'N47330', 'United Airlines', 'mainline', 'discovery', 'UA')`
    ).run();
    later(HOUR);
    expect(read(db, "N47330", "Starlink")?.rule).not.toBe("first_read");
    expect(counted(db, "N47330")).toBe(false);
    expect(points).toEqual([]);
    db.close();
  });

  test("a sheet import that is not current lists nothing", () => {
    const db = makeFreshDb();
    retrofit(db, "N14527");
    // The sheet has not been read for seven hours: its row is yesterday's word.
    later(7 * HOUR);
    expect(read(db, "N14527", "Starlink")?.rule).not.toBe("first_read");
    expect(counted(db, "N14527")).toBe(false);
    expect(points).toEqual([]);
    db.close();
  });

  test("a hangar note that holds the listing holds the count too", () => {
    const db = makeFreshDb();
    retrofit(db, "N76528");
    db.query(
      `INSERT INTO sheet_mod_notes (airline, tail_number, station, started, unsure, holds_until, read_at)
       VALUES ('UA', 'N76528', 'TPA', '2026-10-28', 0, '2999-01-01', ?)`
    ).run(clock);
    later(HOUR);
    read(db, "N76528", "Starlink");
    expect(counted(db, "N76528")).toBe(false);
    expect(roster(db, "N76528").first_read_counted_at).toBeNull();
    // No count, so nothing of it is written: the roster keeps what we held.
    expect(roster(db, "N76528")).toMatchObject({
      starlink_status: "negative",
      verified_wifi: "Viasat",
    });
    expect(sweepOnly(db)).toEqual([]);
    expect(roster(db, "N76528").starlink_status).toBe("negative");
    expect(points).toEqual([]);
    db.close();
  });

  test("the hourly job does not take a row our own discovery wrote for the sheet's listing", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N47330");
    at(T0 - 7 * DAY);
    read(db, "N47330", "Viasat");
    at(T0);
    hourlySheet(db, []);
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, sheet_gid, airline)
       VALUES ('Boeing 737-900', 'StrLnk', '2026-11-01', 'N47330', 'United Airlines', 'mainline', 'discovery', 'UA')`
    ).run();
    later(HOUR);
    read(db, "N47330", "Starlink");
    // The sheet import is current and does not list the tail; only our row does.
    expect(hourlySheet(db, [])).toEqual([]);
    expect(counted(db, "N47330")).toBe(false);
    expect(roster(db, "N47330")).toMatchObject({
      starlink_status: "negative",
      first_read_counted_at: null,
    });
    expect(points).toEqual([]);
    db.close();
  });

  test("the hourly job makes no count on an import that is not current", () => {
    const db = makeFreshDb();
    retrofit(db, "N14527");
    // Seven hours with no sheet read, then our first Starlink read.
    later(7 * HOUR);
    read(db, "N14527", "Starlink");
    expect(sweepOnly(db)).toEqual([]);
    expect(counted(db, "N14527")).toBe(false);
    expect(roster(db, "N14527")).toMatchObject({
      starlink_status: "negative",
      first_read_counted_at: null,
    });
    expect(points).toEqual([]);
    // The import returns with the row still there: now it is the sheet's word.
    later(HOUR);
    expect(hourlySheet(db, ["N14527"]).map((e) => e.outcome)).toEqual(["counted"]);
    db.close();
  });
});

describe("the one read has an age limit", () => {
  test("a Starlink read older than the limit is not counted when the sheet lists the tail", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N55555");
    storedRead(db, "N55555", T0 - 28 * DAY, "Viasat");
    storedRead(db, "N55555", T0 - 27 * DAY, "Viasat");
    // The check's real case was a read 26 days old; an hour past the limit is enough.
    storedRead(db, "N55555", T0 - FIRST_READ_MAX_AGE_SECS - HOUR, "Starlink");
    expect(hourlySheet(db, ["N55555"])).toEqual([]);
    expect(counted(db, "N55555")).toBe(false);
    expect(roster(db, "N55555")).toMatchObject({
      starlink_status: "negative",
      first_read_counted_at: null,
    });
    expect(computeWifiConsensus(db, "N55555", { airline: "UA" }).rule).not.toBe("first_read");
    expect(points).toEqual([]);
    db.close();
  });

  test("a read inside the limit is counted, and stamped with its own date", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N55556");
    storedRead(db, "N55556", T0 - 28 * DAY, "Viasat");
    const readAt = T0 - FIRST_READ_MAX_AGE_SECS + HOUR;
    storedRead(db, "N55556", readAt, "Starlink");
    expect(hourlySheet(db, ["N55556"]).map((e) => e.outcome)).toEqual(["counted"]);
    expect(counted(db, "N55556")).toBe(true);
    expect(roster(db, "N55556").first_read_counted_at).toBe(readAt);
    db.close();
  });

  test("a standing count does not lapse when its read passes the limit", () => {
    const db = makeFreshDb();
    retrofit(db, "N673UA");
    later(HOUR);
    read(db, "N673UA", "Starlink");
    later(FIRST_READ_MAX_AGE_SECS + DAY);
    expect(hourlySheet(db, ["N673UA"])).toEqual([]);
    expect(computeWifiConsensus(db, "N673UA", { airline: "UA" }).rule).toBe("first_read");
    expect(counted(db, "N673UA")).toBe(true);
    expect(outcomes()).toEqual(["counted:first_read"]);
    db.close();
  });

  test("the pure rule takes the read's age", () => {
    const S = { has_starlink: 1, wifi_provider: "Starlink" };
    const V = { has_starlink: 0, wifi_provider: "Viasat" };
    expect(settleReads([S, V, V], true, FIRST_READ_MAX_AGE_SECS).rule).toBe("first_read");
    expect(settleReads([S, V, V], true, FIRST_READ_MAX_AGE_SECS + 1).rule).not.toBe("first_read");
    // The age limits making a count, never taking one back.
    expect(settleReads([V, S], true, FIRST_READ_MAX_AGE_SECS + 1).rule).toBe(
      "first_read_taken_back"
    );
  });
});

describe("a listed tail is counted on our first Starlink read (guards 2, 3, 4)", () => {
  test("N673UA: listed, one read, then a failed read and no flights: counted, not confirmed", () => {
    const db = makeFreshDb();
    retrofit(db, "N673UA");
    later(HOUR);
    const consensus = read(db, "N673UA", "Starlink");

    expect(consensus?.rule).toBe("first_read");
    // The verdict stays undecided: nothing downstream reads one read as settled.
    expect(consensus?.verdict).toBeNull();
    expect(counted(db, "N673UA")).toBe(true);
    expect(verified(db, "N673UA")).toBe(false);
    expect(listing(db, "N673UA")?.verified_wifi).toBeNull();
    expect(roster(db, "N673UA").starlink_status).toBe("unknown");
    expect(roster(db, "N673UA").first_read_counted_at).toBe(clock);
    expect(outcomes()).toEqual(["counted:first_read"]);

    // A read that failed is no read: it neither confirms nor takes back.
    later(DAY);
    logUnitedCheckFailure(db, "N673UA", "Timeout after 90s", {
      flightNumber: "UA100",
      aircraftType: "737-900",
    });
    for (let h = 0; h < 72; h++) {
      later(HOUR);
      expect(hourlySheet(db, ["N673UA"])).toEqual([]);
    }
    expect(counted(db, "N673UA")).toBe(true);
    expect(verified(db, "N673UA")).toBe(false);
    expect(roster(db, "N673UA").starlink_status).toBe("unknown");
    expect(roster(db, "N673UA").first_read_counted_at).not.toBeNull();
    expect(outcomes()).toEqual(["counted:first_read"]);
    db.close();
  });

  test("the hourly sweep makes the same count when no check's own settle did", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N17327");
    at(T0 - 7 * DAY);
    read(db, "N17327", "Viasat");
    at(T0);
    // Read before the sheet lists it: the read alone counts nothing.
    read(db, "N17327", "Starlink");
    expect(counted(db, "N17327")).toBe(false);
    later(HOUR);
    const events = hourlySheet(db, ["N17327"]);
    expect(events.map((e) => `${e.tail}:${e.outcome}`)).toEqual(["N17327:counted"]);
    expect(counted(db, "N17327")).toBe(true);
    expect(roster(db, "N17327").starlink_status).toBe("unknown");
    // One read marks nothing verified, on this path as on a check's own.
    expect(listing(db, "N17327")?.verified_wifi).toBeNull();
    expect(verified(db, "N17327")).toBe(false);
    expect(points[0]).toMatchObject({
      outcome: "counted",
      reason: "first_read",
      path: "reconcile",
    });
    expect(typeof points[0].airline).toBe("string");
    db.close();
  });

  test("with no older reads, the second Starlink read settles it by the ordinary rule", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N17428");
    hourlySheet(db, ["N17428"]);
    later(HOUR);
    expect(read(db, "N17428", "Starlink")?.rule).toBe("first_read");
    expect(counted(db, "N17428")).toBe(true);
    later(DAY);
    const second = read(db, "N17428", "Starlink");
    expect(second?.verdict).toBe("Starlink");
    expect(verified(db, "N17428")).toBe(true);
    expect(roster(db, "N17428").first_read_counted_at).toBeNull();
    expect(outcomes()).toEqual(["counted:first_read", "confirmed:second_read"]);
    db.close();
  });

  test("after reads of another provider it stays counted, unverified, until three in a row", () => {
    const db = makeFreshDb();
    retrofit(db, "N76533");
    later(HOUR);
    read(db, "N76533", "Starlink");
    later(DAY);
    const second = read(db, "N76533", "Starlink");
    expect(second?.verdict).toBeNull();
    expect(counted(db, "N76533")).toBe(true);
    expect(verified(db, "N76533")).toBe(false);
    later(DAY);
    expect(read(db, "N76533", "Starlink")?.verdict).toBe("Starlink");
    expect(verified(db, "N76533")).toBe(true);
    expect(outcomes()).toEqual(["counted:first_read", "confirmed:second_read"]);
    db.close();
  });
});

describe("the count is taken back (guards 1, 2, 6)", () => {
  test("the next read names another provider: off the count, and not counted again on one read", () => {
    const db = makeFreshDb();
    retrofit(db, "N16234");
    later(HOUR);
    read(db, "N16234", "Starlink");
    expect(counted(db, "N16234")).toBe(true);

    later(DAY);
    hourlySheet(db, ["N16234"]);
    const back = read(db, "N16234", "Viasat");
    // Three of four reads now name Viasat: the ordinary rule's own verdict.
    expect(back?.verdict).toBe("Viasat");
    expect(counted(db, "N16234")).toBe(false);
    // The provider is written to both rows, so the sheet's row cannot keep it counted.
    expect(listing(db, "N16234")?.verified_wifi).toBe("Viasat");
    expect(roster(db, "N16234")).toMatchObject({
      starlink_status: "negative",
      verified_wifi: "Viasat",
      first_read_counted_at: null,
      first_read_taken_back_at: clock,
    });
    expect(outcomes()).toEqual(["counted:first_read", "taken_back:other_provider"]);
    expect(points[1]).toMatchObject({ path: "verifier" });

    // The sheet still lists it; the hourly job must not put it back.
    later(HOUR);
    expect(hourlySheet(db, ["N16234"])).toEqual([]);
    expect(counted(db, "N16234")).toBe(false);

    // It shows on the list of listings we do not count, with the correction's date.
    const reported = getListedNotCounted(db, "UA", { scope: "tail" }).find(
      (r) => r.TailNumber === "N16234"
    );
    expect(reported?.reason).toBe("other_provider");
    expect(typeof reported?.first_read_taken_back_at).toBe("number");

    // Starlink, other, Starlink: the ordinary rule's case, never a second quick count.
    later(DAY);
    expect(read(db, "N16234", "Starlink")?.rule).not.toBe("first_read");
    hourlySheet(db, ["N16234"]);
    expect(counted(db, "N16234")).toBe(false);
    expect(outcomes()).toEqual(["counted:first_read", "taken_back:other_provider"]);
    db.close();
  });

  test("with no older reads the ordinary rule is undecided, and the read still takes it back", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N62849");
    hourlySheet(db, ["N62849"]);
    later(HOUR);
    read(db, "N62849", "Starlink");
    expect(counted(db, "N62849")).toBe(true);
    later(DAY);
    hourlySheet(db, ["N62849"]);
    const back = read(db, "N62849", "Panasonic");
    expect(back).toMatchObject({ rule: "first_read_taken_back", verdict: "Panasonic" });
    expect(counted(db, "N62849")).toBe(false);
    expect(roster(db, "N62849")).toMatchObject({
      starlink_status: "negative",
      verified_wifi: "Panasonic",
    });
    expect(outcomes()).toEqual(["counted:first_read", "taken_back:other_provider"]);
    db.close();
  });

  test("the sheet withdraws the row before a second read: off the count", () => {
    const db = makeFreshDb();
    retrofit(db, "N78009");
    later(HOUR);
    read(db, "N78009", "Starlink");
    expect(counted(db, "N78009")).toBe(true);

    later(HOUR);
    const events = hourlySheet(db, []);
    expect(events.map((e) => `${e.tail}:${e.outcome}:${e.reason}`)).toEqual([
      "N78009:taken_back:sheet_delisted",
    ]);
    expect(counted(db, "N78009")).toBe(false);
    expect(roster(db, "N78009").first_read_counted_at).toBeNull();
    expect(roster(db, "N78009").starlink_status).not.toBe("confirmed");
    expect(outcomes()).toEqual(["counted:first_read", "taken_back:sheet_delisted"]);
    db.close();
  });
});

describe("the second read comes within about a day, whichever job made the first (guard 4)", () => {
  test("a count on a check's read moves discovery's turn to a day after that read", () => {
    const db = makeFreshDb();
    retrofit(db, "N11206");
    // The listing's own move is long spent and discovery's routine turn is ten
    // days off, so the verifier makes the first read.
    db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = 'N11206'").run(
      T0 + 10 * DAY
    );
    later(HOUR);
    read(db, "N11206", "Starlink");
    expect(roster(db, "N11206").first_read_counted_at).toBe(clock);
    expect(roster(db, "N11206").next_check_after).toBe(clock + DAY);
    db.close();
  });

  test("a count the hourly job makes does the same, from the read's own time", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N17327");
    at(T0 - 7 * DAY);
    read(db, "N17327", "Viasat");
    at(T0);
    read(db, "N17327", "Starlink");
    expect(roster(db, "N17327").next_check_after).toBe(T0 + 7 * DAY);
    // The listing was noted before, so it does not move the turn itself.
    db.query("UPDATE united_fleet SET sheet_listed_at = ? WHERE tail_number = 'N17327'").run(T0);
    later(5 * HOUR);
    hourlySheet(db, ["N17327"]);
    expect(counted(db, "N17327")).toBe(true);
    expect(roster(db, "N17327").next_check_after).toBe(T0 + DAY);
    db.close();
  });

  test("a turn already sooner is left where it is: the count never puts a read off", () => {
    const db = makeFreshDb();
    retrofit(db, "N14527");
    db.query("UPDATE united_fleet SET next_check_after = ? WHERE tail_number = 'N14527'").run(
      T0 + 3 * HOUR
    );
    later(HOUR);
    read(db, "N14527", "Starlink");
    expect(counted(db, "N14527")).toBe(true);
    expect(roster(db, "N14527").next_check_after).toBe(T0 + 3 * HOUR);
    db.close();
  });
});

describe("a stale sheet import neither makes nor ends a count", () => {
  /** Enough older reads that the ordinary rule still says Viasat after two Starlink ones. */
  function countedWithLongHistory(db: Database, tail: string): void {
    retrofit(db, tail);
    for (let d = 20; d < 25; d++) storedRead(db, tail, T0 - d * DAY, "Viasat");
    db.query("UPDATE starlink_planes SET DateFound = '2026-11-01'").run();
    later(HOUR);
    read(db, tail, "Starlink");
    expect(counted(db, tail)).toBe(true);
  }
  const HOST = SITES.united.canonicalHost;
  const page = async (db: Database, path: string) =>
    (await createApp(db).dispatch(req(path, HOST))).text();

  test("a second Starlink read 25 hours after the last import leaves the count standing", async () => {
    const db = makeFreshDb();
    countedWithLongHistory(db, "N16234");
    later(DAY);
    const second = read(db, "N16234", "Starlink");
    // The ordinary rule alone would say Viasat here (seven of nine reads).
    expect(
      settleReads(
        Array(2)
          .fill({ has_starlink: 1, wifi_provider: "Starlink" })
          .concat(Array(7).fill({ has_starlink: 0, wifi_provider: "Viasat" })),
        false
      ).verdict
    ).toBe("Viasat");
    expect(second).toMatchObject({ rule: "first_read", verdict: null });
    expect(counted(db, "N16234")).toBe(true);
    expect(roster(db, "N16234")).toMatchObject({
      starlink_status: "unknown",
      first_read_taken_back_at: null,
    });
    expect(roster(db, "N16234").first_read_counted_at).not.toBeNull();
    // The hourly sweep, still with no import, agrees with the check.
    expect(sweepOnly(db)).toEqual([]);
    expect(counted(db, "N16234")).toBe(true);
    expect(outcomes()).toEqual(["counted:first_read"]);
    const feed = await page(db, "/feed.xml");
    const entry = feed.split("<entry>").find((e) => e.includes("N16234")) ?? "";
    expect(entry).toContain("now has Starlink");
    expect(feed).not.toContain("Correction");
    expect(await page(db, "/newly-equipped")).not.toContain("Correction");

    // The import returns: nothing to count again, nothing flapped.
    later(HOUR);
    expect(hourlySheet(db, ["N16234"])).toEqual([]);
    later(DAY);
    expect(read(db, "N16234", "Starlink")?.verdict).toBe("Starlink");
    expect(outcomes()).toEqual(["counted:first_read", "confirmed:second_read"]);
    db.close();
  });

  test("with the import stale a read of another provider still takes it back, worded as that", async () => {
    const db = makeFreshDb();
    countedWithLongHistory(db, "N16234");
    later(DAY);
    read(db, "N16234", "Viasat");
    expect(counted(db, "N16234")).toBe(false);
    expect(roster(db, "N16234")).toMatchObject({
      starlink_status: "negative",
      first_read_taken_back_reason: "other_provider",
    });
    expect(outcomes()).toEqual(["counted:first_read", "taken_back:other_provider"]);
    expect(await page(db, "/feed.xml")).toContain(
      "A later check read another provider, so the count was taken back."
    );
    db.close();
  });

  test("the ordinary rule outvoting a Starlink read is no reason to take a count back", () => {
    const db = makeFreshDb();
    countedWithLongHistory(db, "N16234");
    // A read of another provider stored with no settle, then a Starlink read:
    // the first-read shape is broken and the ordinary rule says Viasat, but
    // the newest read agrees with the count and the sheet's row is there.
    storedRead(db, "N16234", clock + 30 * 60, "Viasat");
    later(HOUR);
    const c = read(db, "N16234", "Starlink");
    expect(c?.verdict).toBe("Viasat");
    expect(roster(db, "N16234").first_read_counted_at).not.toBeNull();
    expect(roster(db, "N16234").first_read_taken_back_at).toBeNull();
    expect(outcomes()).toEqual(["counted:first_read"]);
    db.close();
  });
});

describe("a correction is worded by why the count was taken back", () => {
  test("each reason has its own sentence, and none claims a read that did not happen", () => {
    const at0 = utc("2026-11-02T01:00:00Z");
    const other = firstReadTakenBackNote(at0, "other_provider");
    const delisted = firstReadTakenBackNote(at0, "sheet_delisted");
    expect(other).toContain("Correction (2026-11-02)");
    expect(other).toContain("A later check read another provider");
    expect(delisted).toContain("dropped its listing");
    expect(delisted).not.toContain("another provider");
    expect(firstReadTakenBackNote(at0, null)).not.toContain("another provider");
  });

  test("the sheet dropping the row is stored and told as that, when the row returns and we hold the tail", async () => {
    const db = makeFreshDb();
    retrofit(db, "N78009");
    db.query("UPDATE starlink_planes SET DateFound = '2026-11-01'").run();
    later(HOUR);
    read(db, "N78009", "Starlink");
    later(HOUR);
    hourlySheet(db, []);
    expect(roster(db, "N78009").first_read_taken_back_reason).toBe("sheet_delisted");
    // The row returns and our next reads name Viasat: the ordinary rule holds
    // the tail, and the list of listings we do not count shows the correction.
    later(HOUR);
    hourlySheet(db, ["N78009"]);
    db.query("UPDATE starlink_planes SET DateFound = '2026-11-01'").run();
    later(DAY);
    read(db, "N78009", "Viasat");
    expect(counted(db, "N78009")).toBe(false);
    const reported = getListedNotCounted(db, "UA", { scope: "tail" }).find(
      (r) => r.TailNumber === "N78009"
    );
    expect(reported?.first_read_taken_back_reason).toBe("sheet_delisted");
    const feed = await (
      await createApp(db).dispatch(req("/feed.xml", SITES.united.canonicalHost))
    ).text();
    const entry = feed.split("<entry>").find((e) => e.includes("N78009")) ?? "";
    expect(entry).toContain("dropped its listing");
    expect(entry).not.toContain("A later check read another provider");
    db.close();
  });
});

describe("a check that finds the sheet's row gone", () => {
  test("takes the count back as the sheet's withdrawal, not as a read of another provider", () => {
    const db = makeFreshDb();
    retrofit(db, "N16234");
    for (let d = 20; d < 25; d++) storedRead(db, "N16234", T0 - d * DAY, "Viasat");
    later(HOUR);
    read(db, "N16234", "Starlink");
    // The import has dropped the row and its sweep has not run yet.
    db.query("DELETE FROM starlink_planes WHERE TailNumber = 'N16234'").run();
    later(HOUR);
    expect(read(db, "N16234", "Starlink")?.verdict).toBe("Viasat");
    expect(roster(db, "N16234")).toMatchObject({
      first_read_counted_at: null,
      first_read_taken_back_reason: "sheet_delisted",
    });
    expect(outcomes()).toEqual(["counted:first_read", "taken_back:sheet_delisted"]);
    db.close();
  });
});

describe("a read of no Wi-Fi neither confirms a count nor takes it back", () => {
  test("six daily reads of None after the first Starlink read: counted, unverified, one metric point", () => {
    const db = makeFreshDb();
    retrofit(db, "N16234");
    later(HOUR);
    read(db, "N16234", "Starlink");
    const stamp = roster(db, "N16234").first_read_counted_at;
    for (let i = 0; i < 6; i++) {
      later(DAY);
      hourlySheet(db, ["N16234"]);
      const c = read(db, "N16234", "None");
      expect(c).toMatchObject({ rule: "first_read", verdict: null });
      expect(counted(db, "N16234")).toBe(true);
      expect(verified(db, "N16234")).toBe(false);
    }
    expect(roster(db, "N16234")).toMatchObject({
      starlink_status: "unknown",
      first_read_counted_at: stamp,
      first_read_taken_back_at: null,
    });
    expect(outcomes()).toEqual(["counted:first_read"]);
    // A named provider after them still takes it back.
    later(DAY);
    hourlySheet(db, ["N16234"]);
    read(db, "N16234", "Viasat");
    expect(counted(db, "N16234")).toBe(false);
    expect(outcomes()).toEqual(["counted:first_read", "taken_back:other_provider"]);
    db.close();
  });
});

describe("the decision is a pure function of the reads and the listing", () => {
  const S = { has_starlink: 1, wifi_provider: "Starlink" };
  const V = { has_starlink: 0, wifi_provider: "Viasat" };
  const ordinary = (obs: Array<typeof S>) => settleReads(obs, false);

  test("replayed over newest-first reads", () => {
    expect(settleReads([S], true).rule).toBe("first_read");
    expect(settleReads([S], false).rule).not.toBe("first_read");
    expect(settleReads([S, V, V], true).rule).toBe("first_read");
    expect(settleReads([S, S, V, V], true).rule).toBe("first_read");
    expect(settleReads([S, S, S, V, V], true).verdict).toBe("Starlink");
    expect(settleReads([V, S], true)).toMatchObject({
      rule: "first_read_taken_back",
      verdict: "Viasat",
    });
    // Without the listing the same two reads decide nothing.
    expect(settleReads([V, S], false).verdict).toBeNull();
    expect(settleReads([V, S, V, V], true).verdict).toBe("Viasat");
    // A Starlink read behind another provider: the ordinary rule's tail.
    expect(settleReads([S, V, S], true).rule).not.toBe("first_read");
    expect(settleReads([V, V, V], true).rule).not.toBe("first_read_taken_back");
    expect(settleReads([], true).verdict).toBeNull();
  });

  test("a tail the ordinary rule had settled keeps that rule's tolerance of one stray read", () => {
    expect(firstReadDecision([V, S, S, S], true, null, ordinary)).toBeNull();
  });

  test("the database path and the pure path agree", () => {
    const db = makeFreshDb();
    retrofit(db, "N11206");
    later(HOUR);
    read(db, "N11206", "Starlink");
    const stored = computeWifiConsensus(db, "N11206", { airline: "UA" });
    expect(stored.rule).toBe(settleReads([S, V, V], true).rule);
    expect(stored.verdict).toBe(settleReads([S, V, V], true).verdict);
    db.close();
  });
});

describe("how a first-read count is told, until the next read", () => {
  test("the note names both sources and the day, and no surface says verified", () => {
    const note = firstReadNote(utc("2026-11-20T15:00:00Z"));
    expect(note).toContain("community fleet sheet");
    expect(note).toContain("united.com");
    expect(note).toContain("2026-11-20");
    expect(note).not.toMatch(/verified|confirmed that/i);
    // It promises the two ways a count ends, not what "the next check" does:
    // a read of no Wi-Fi does neither, and a second read may not settle it.
    expect(note).not.toMatch(/the next (one|check|read)/i);
    expect(note).toContain("names another provider");
    expect(note).toContain("drops the listing");
  });

  test("the install log and a flight's assignment carry the read while the count stands", () => {
    const db = makeFreshDb();
    retrofit(db, "N673UA");
    db.query(
      `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
       VALUES ('N673UA', 'UA100', 'KSFO', 'KEWR', ?, ?, ?, 'UA')`
    ).run(T0 + 2 * DAY, T0 + 2 * DAY + 5 * HOUR, T0);
    const flights = () => getFlightAssignments(db, ["UA100"], T0, T0 + 7 * DAY, "UA");
    const logged = () => getRecentInstalls(db, "UA", 50).find((i) => i.TailNumber === "N673UA");

    // Held as not Starlink: the flight has no Starlink assignment to word.
    expect(flights().every((f) => f.settled_negative === 1)).toBe(true);
    expect(logged()).toBeUndefined();

    later(HOUR);
    read(db, "N673UA", "Starlink");
    expect(flights()[0]).toMatchObject({ first_read_counted_at: clock, settled_negative: 0 });
    expect(logged()?.first_read_at).toBe(clock);

    later(DAY);
    read(db, "N673UA", "Starlink");
    later(DAY);
    read(db, "N673UA", "Starlink");
    expect(flights()[0].first_read_counted_at).toBeNull();
    expect(flights()[0].verified_wifi).toBe("Starlink");
    expect(logged()?.first_read_at).toBeNull();
    db.close();
  });
});

describe("what a visitor is told while the count stands, and after it is taken back", () => {
  const HOST = SITES.united.canonicalHost;
  const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

  test("check-flight, the tail's page and the feed say how it is known; the feed corrects itself", async () => {
    const db = makeFreshDb();
    retrofit(db, "N673UA");
    // The feed dates entries by the day the listing was first seen.
    db.query("UPDATE starlink_planes SET DateFound = ?").run(day(T0));
    const depart = T0 + DAY + 20 * HOUR;
    db.query(
      `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
       VALUES ('N673UA', 'UA100', 'KSFO', 'KEWR', ?, ?, ?, 'UA')`
    ).run(depart, depart + 5 * HOUR, T0);
    const get = async (path: string) => {
      const res = await createApp(db).dispatch(req(path, HOST));
      return { status: res.status, body: await res.text() };
    };
    const check = async () =>
      JSON.parse(
        (await get(`/api/check-flight?flight_number=UA100&date=${day(depart - 8 * HOUR)}`)).body
      );

    const before = await check();
    expect(before.first_read).toBeUndefined();

    later(HOUR);
    read(db, "N673UA", "Starlink");
    const readAt = clock;
    const note = firstReadNote(readAt);

    const standing = await check();
    expect(standing.hasStarlink).toBe(true);
    // One read is never "verified".
    expect(standing.confidence).toBe("likely");
    expect(standing.first_read).toEqual({ tail_number: "N673UA", read_at: readAt, note });

    const feed = await get("/feed.xml");
    expect(feed.status).toBe(200);
    const entry = feed.body.split("<entry>").find((e) => e.includes("N673UA")) ?? "";
    expect(entry).toContain("now has Starlink");
    expect(entry).toContain("Counted on two sources");

    const page = await get("/fleet/N673UA");
    expect(page.status).toBe(200);
    expect(page.body).toContain("Counted on two sources");

    later(DAY);
    hourlySheet(db, ["N673UA"]);
    read(db, "N673UA", "Viasat");

    const after = await check();
    expect(after.hasStarlink).toBe(false);
    expect(after.first_read).toBeUndefined();
    const corrected = (await createApp(db).dispatch(req("/feed.xml", HOST))).text();
    const now = (await corrected).split("<entry>").find((e) => e.includes("N673UA")) ?? "";
    expect(now).not.toContain("now has Starlink");
    expect(now).toContain("reported with Starlink, not yet confirmed");
    expect(now).toContain("Correction");
    expect(now).toContain("A later check read another provider, so the count was taken back.");
    db.close();
  });
});

describe("a tail not yet settled stays on the daily pace after a Starlink read (part 3)", () => {
  test("the next check is due within about a day, whatever the older reads say", () => {
    const db = makeFreshDb();
    rosterNegative(db, "N11206");
    const due = (awaitingSettle: boolean) => {
      updateFleetVerificationResult(
        db,
        "N11206",
        { starlinkStatus: "unknown", verifiedWifi: null, needsMoreObs: true, awaitingSettle },
        clock
      );
      return (roster(db, "N11206").next_check_after - clock) / HOUR;
    };
    // A day, spread a tenth either way like every discovery turn.
    for (let i = 0; i < 20; i++) {
      const hours = due(true);
      expect(hours).toBeGreaterThanOrEqual(24 * 0.9 - 0.01);
      expect(hours).toBeLessThanOrEqual(24 * 1.1 + 0.01);
    }
    db.close();
  });
});
