/**
 * starlink.consensus.settle_transition: a listing's first settle is not a move.
 * A new sheet row whose reads are Viasat used to count as from_starlink (NULL
 * sits on the Starlink side), which fired the burst alert on six new 737s.
 */
import type { Database } from "bun:sqlite";
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
import { reconcileConsensus, updateDatabase } from "../src/database/database";
import type { FirstReadEvent } from "../src/database/first-read";
import { recordSourceSuccess } from "../src/database/source-health";
import { COUNTERS, metrics } from "../src/observability/metrics";
import type { FleetStats } from "../src/types";
import { makeFreshDb, utc } from "./helpers";

const DAY = 86_400;
const T0 = utc("2026-11-01T00:00:00Z");
const STATS: FleetStats = {
  express: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
  mainline: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
};

let points: Array<Record<string, unknown>> = [];
let logLines: string[] = [];
const original = metrics.increment;
let logSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  setSystemTime(new Date(T0 * 1000));
  points = [];
  logLines = [];
  metrics.increment = (name, tags) => {
    if (name === COUNTERS.CONSENSUS_SETTLE_TRANSITION) points.push(tags as Record<string, unknown>);
    original(name, tags);
  };
  logSpy = spyOn(console, "log").mockImplementation((line: unknown) => {
    logLines.push(String(line));
  });
});
afterEach(() => {
  metrics.increment = original;
  logSpy?.mockRestore();
  setSystemTime();
});
afterAll(() => setSystemTime());

const sheetRow = (TailNumber: string) => ({
  TailNumber,
  Aircraft: "Boeing 737 MAX 9",
  WiFi: "StrLnk",
  sheet_gid: "100",
  sheet_type: "B737",
  fleet: "mainline" as const,
  OperatedBy: "United Airlines",
});

function storedRead(db: Database, tail: string, atSec: number, provider: string): void {
  db.query(
    `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
     VALUES (?, 'united', ?, ?, ?, 1, 'UA')`
  ).run(tail, atSec, provider === "Starlink" ? 1 : 0, provider);
}

function hourlySheet(db: Database, tails: readonly string[]): void {
  const rows = [...tails, "N10001", "N10002", "N10003"].map(sheetRow);
  expect(updateDatabase(db, 1000, rows, STATS, "UA")).toBeNull();
  recordSourceSuccess(db, "sheet_scrape", "UA");
  const events: FirstReadEvent[] = [];
  reconcileConsensus(db, undefined, events);
}

const forTail = (tail: string) => logLines.filter((l) => l.includes(`${tail}: verified_wifi`));

describe("settle_transition direction", () => {
  test("a new sheet row first settled as Viasat is a first settle, not a move off Starlink", () => {
    const db = makeFreshDb();
    storedRead(db, "N77584", T0 - 2 * DAY, "Viasat");
    storedRead(db, "N77584", T0 - DAY, "Viasat");
    hourlySheet(db, ["N77584"]);

    const listing = db
      .query("SELECT verified_wifi FROM starlink_planes WHERE TailNumber = 'N77584'")
      .get() as { verified_wifi: string | null };
    expect(listing.verified_wifi).toBe("Viasat");
    expect(points.map((p) => p.direction)).toEqual(["first_settle"]);
    expect(points[0]).toMatchObject({ path: "reconcile", airline: "united" });
    expect(forTail("N77584").length).toBe(1);
    db.close();
  });

  test("a settled Starlink listing that settles Viasat still counts from_starlink", () => {
    const db = makeFreshDb();
    hourlySheet(db, ["N37536"]);
    db.query(
      "UPDATE starlink_planes SET verified_wifi = 'Starlink', verified_at = ? WHERE TailNumber = 'N37536'"
    ).run(T0 - 30 * DAY);
    points = [];
    logLines = [];
    for (let i = 1; i <= 4; i++) storedRead(db, "N37536", T0 - i * 3600, "Viasat");
    hourlySheet(db, ["N37536"]);

    expect(points.map((p) => p.direction)).toEqual(["from_starlink"]);
    expect(forTail("N37536").length).toBe(1);
    db.close();
  });

  test("a listing cleared back to unverified after a settle is not a first settle", () => {
    const db = makeFreshDb();
    hourlySheet(db, ["N76532"]);
    // verified_at stamped with a NULL verdict: the verifier's ambiguous clear.
    db.query(
      "UPDATE starlink_planes SET verified_wifi = NULL, verified_at = ? WHERE TailNumber = 'N76532'"
    ).run(T0 - 10 * DAY);
    points = [];
    storedRead(db, "N76532", T0 - 2 * DAY, "Viasat");
    storedRead(db, "N76532", T0 - DAY, "Viasat");
    hourlySheet(db, ["N76532"]);

    expect(points.map((p) => p.direction)).toEqual(["from_starlink"]);
    db.close();
  });
});
