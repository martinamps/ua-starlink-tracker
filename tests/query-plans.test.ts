/**
 * Serving-path query plans.
 *
 * /check-flight permalinks spent 150ms of their 152ms inside SQLite: the three
 * getFlightHistorySummary queries filter on flight_number, and the only usable
 * indexes led with airline — on a one-airline 76k-row log that is a full range
 * scan per query. The homepage's EQUIPPED_DEPARTURES join likewise had no
 * tail_number index on upcoming_flights.
 *
 * Two things must both hold, and each alone is not enough:
 *  - the indexes exist (idx_vlog_flight, idx_upf_tail)
 *  - ANALYZE has populated sqlite_stat1 — without stats the planner keeps
 *    choosing airline= (zero selectivity) and the new indexes sit unused.
 *    Measured at production cardinality: 14.6ms → 0.01ms only after ANALYZE.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  TYPE_PAGE_EVENTS_SQL,
  TYPE_PAGE_FLIGHTS_SQL,
  TYPE_PAGE_ROUTES_SQL,
  setupTables,
} from "../src/database/database";
import { equippedSql } from "../src/database/sql/equipped";
import { makeSyntheticDb } from "./helpers";

// Airport pairs vary as they do in production: a fixture where every row is
// one pair makes the route index look like a free seek on anything.
const AIRPORTS = [
  "ORD",
  "DEN",
  "SFO",
  "EWR",
  "IAH",
  "IAD",
  "LAX",
  "SEA",
  "BOS",
  "ATL",
  "MCO",
  "LAS",
];
const airport = (i: number) => AIRPORTS[i % AIRPORTS.length];

function seeded() {
  const db = makeSyntheticDb();
  // Production-shaped cardinality in miniature: one airline, many flight
  // numbers — the distribution that makes the airline index worthless.
  const ins = db.query(
    `INSERT INTO starlink_verification_log
       (tail_number, flight_number, checked_at, has_starlink, error, source, airline)
     VALUES (?,?,?,?,NULL,'united','UA')`
  );
  for (let i = 0; i < 2000; i++) {
    ins.run(
      `N${100 + (i % 40)}AB`,
      `UA${1 + (i % 400)}`,
      1_700_000_000 + i * 60,
      i % 3 === 0 ? 1 : 0
    );
  }
  const upf = db.query(
    `INSERT INTO upcoming_flights
       (tail_number, flight_number, departure_airport, arrival_airport,
        departure_time, arrival_time, last_updated, airline)
     VALUES (?,?,?,?,?,?,?, 'UA')`
  );
  for (let i = 0; i < 500; i++) {
    upf.run(
      `N${100 + (i % 40)}AB`,
      `UA${1 + (i % 200)}`,
      airport(i),
      airport(i + 5),
      1_700_000_000 + i * 100,
      1_700_010_000 + i * 100,
      1_700_000_000
    );
  }
  db.exec("ANALYZE");
  return db;
}

const planOf = (db: ReturnType<typeof seeded>, sql: string, params: (string | number)[]) =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(" | ");

describe("hot-path query plans", () => {
  test("both serving-path indexes exist after setupTables", () => {
    const db = makeSyntheticDb();
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("idx_vlog_flight");
    expect(names).toContain("idx_upf_tail");
    db.close();
  });

  test("flight-history queries search by flight_number, not scan by airline", () => {
    const db = seeded();
    const plan = planOf(
      db,
      `SELECT COUNT(*) FROM starlink_verification_log
       WHERE flight_number IN (?,?) AND source IN (?) AND error IS NULL AND airline = ?`,
      ["UA1", "UAL1", "united", "UA"]
    );
    expect(plan).toMatch(
      /SEARCH starlink_verification_log USING (COVERING )?INDEX idx_vlog_flight \(flight_number=\?/
    );
    expect(plan).not.toContain("idx_vlog_airline");
    db.close();
  });

  test("the equipped probe seeks starlink_planes by tail, never scans it", () => {
    // Every equipped test correlates the listing on TailNumber; before
    // idx_sp_tail the check-flight lookup scanned starlink_planes per row.
    const db = seeded();
    const plan = planOf(
      db,
      `SELECT uf.* FROM upcoming_flights uf
       INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
       WHERE uf.flight_number IN (?,?) AND uf.departure_time >= ? AND uf.departure_time < ?
         AND ${equippedSql("sp")}`,
      ["UA1", "UAL1", 1_700_000_000, 1_800_000_000]
    );
    expect(plan).toMatch(/SEARCH sp USING (COVERING )?INDEX idx_sp_tail \(TailNumber=\?\)/);
    expect(plan).not.toMatch(/SCAN sp\b/);
    expect(plan).toMatch(/SEARCH uf USING (COVERING )?INDEX idx_upf_flight \(flight_number=\?/);
    db.close();
  });
});

describe("aircraft-type page passes", () => {
  // Production shape: several airlines share the tables, so a plan that walks
  // idx_upf_tail reads every airline's schedule to serve one.
  function multiAirline() {
    const db = seeded();
    const upf = db.query(
      `INSERT INTO upcoming_flights
         (tail_number, flight_number, departure_airport, arrival_airport,
          departure_time, arrival_time, last_updated, airline)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (let i = 0; i < 1500; i++) {
      const airline = i % 3 === 0 ? "AS" : "HA";
      upf.run(
        `N${i % 90}XY`,
        `${airline}${i % 300}`,
        airport(i + 3),
        airport(i + 7),
        1_700_000_000 + i,
        0,
        0,
        airline
      );
    }
    db.exec("ANALYZE");
    return db;
  }

  test("routes seek upcoming_flights by airline, never a full scan", () => {
    const db = multiAirline();
    const plan = planOf(db, TYPE_PAGE_ROUTES_SQL, ["UA", 1_700_000_000, 1_700_172_800]);
    expect(plan).toMatch(/SEARCH uf USING (COVERING )?INDEX idx_upf_(airline|route) \(airline=\?/);
    expect(plan).not.toMatch(/SCAN upcoming_flights/);
    db.close();
  });

  test("flight numbers seek the verification log by airline", () => {
    const db = seeded();
    const plan = planOf(db, TYPE_PAGE_FLIGHTS_SQL, ["UA", 1_700_000_000]);
    expect(plan).toMatch(
      /SEARCH starlink_verification_log USING (COVERING )?INDEX idx_vlog_airline\w* \(airline=\?/
    );
    expect(plan).not.toMatch(/SCAN starlink_verification_log/);
    db.close();
  });

  test("pipeline-event lastmod seeks by airline", () => {
    const db = seeded();
    const plan = planOf(db, TYPE_PAGE_EVENTS_SQL, ["UA"]);
    expect(plan).toMatch(
      /SEARCH pipeline_events USING (COVERING )?INDEX idx_pipeline_events_time \(airline=\?/
    );
    expect(plan).not.toMatch(/SCAN pipeline_events/);
    db.close();
  });
});

describe("departure_log trim lives in the archive job, not the read path", () => {
  test("archivePastDepartures removes rows older than 30 days", async () => {
    const { archivePastDepartures } = await import("../src/database/database");
    const db = makeSyntheticDb();
    const now = 1_800_000_000;
    db.query(
      "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?,?,?,?)"
    ).run("N1", "ORD", now - 40 * 86400, "UA");
    db.query(
      "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?,?,?,?)"
    ).run("N2", "DEN", now - 5 * 86400, "UA");
    archivePastDepartures(db, now);
    const rows = db.query("SELECT tail_number FROM departure_log ORDER BY tail_number").all() as {
      tail_number: string;
    }[];
    expect(rows.map((r) => r.tail_number)).toEqual(["N2"]);
    db.close();
  });

  test("getAirportDepartures issues no writes", async () => {
    const { getAirportDepartures } = await import("../src/database/database");
    const db = makeSyntheticDb();
    db.query(
      "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES (?,?,?,?)"
    ).run("N1", "ORD", 1, "UA");
    getAirportDepartures(db, "UA", 1_800_000_000);
    // The ancient row survives a read — the trim no longer piggybacks on it.
    expect(db.query("SELECT COUNT(*) AS n FROM departure_log").get()).toEqual({ n: 1 });
    db.close();
  });
});

/**
 * Every index setupTables declares must actually exist.
 *
 * bun:sqlite's query() prepares only the FIRST statement of a multi-statement
 * string, so `db.query("CREATE TABLE …; CREATE INDEX …").run()` silently
 * created the table and dropped the index. Verified in the wild: production
 * carries idx_fleet_discovery and idx_fleet_tail (each written as its own
 * .run()) but not idx_dl_departed, idx_dl_airport, idx_fr_flight, idx_fr_route
 * or idx_qs_* (all written as statement 2+ of a query() string).
 */
describe("setupTables DDL actually executes", () => {
  test("no CREATE INDEX is stranded behind a CREATE TABLE", () => {
    // Record every string setupTables hands to query() on a fresh database —
    // the path that runs each CREATE branch. exec() runs every statement,
    // query().run() only the first, so a CREATE INDEX after a ";" is dead.
    const db = new Database(":memory:");
    const prepared: string[] = [];
    const query = db.query.bind(db);
    db.query = ((sql: string) => {
      prepared.push(sql);
      return query(sql);
    }) as typeof db.query;
    setupTables(db);
    db.close();
    expect(prepared.length).toBeGreaterThan(0);
    const stranded = prepared.filter((sql) =>
      /create\s+index/i.test(sql.split(";").slice(1).join(";"))
    );
    expect(stranded.map((sql) => sql.slice(0, 80))).toEqual([]);
  });

  test("a freshly migrated database has them all", () => {
    const db = makeSyntheticDb();
    const names = new Set(
      (
        db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
      ).map((r) => r.name)
    );
    for (const idx of [
      "idx_ff_airline", // this branch's own table — the one that shipped dead
      "idx_dl_departed",
      "idx_fr_flight",
      "idx_fr_route",
      "idx_sp_tail",
      "idx_dl_tail",
      "idx_upf_flight",
      "idx_upf_route",
      "idx_vlog_airline_time",
      "idx_qfc_date",
    ]) {
      expect(names.has(idx), `${idx} was declared but never created`).toBe(true);
    }
    db.close();
  });

  test("migration drops the redundant indexes an older database still carries", () => {
    const db = makeSyntheticDb();
    db.exec(`
      CREATE INDEX idx_fleet_tail ON united_fleet(tail_number);
      CREATE INDEX idx_qs_flight ON qatar_schedule(flight_number, scheduled_date);
      CREATE INDEX idx_dl_airport ON departure_log(airport);
      CREATE INDEX idx_fleet_discovery ON united_fleet(starlink_status, discovery_priority DESC, next_check_after);
    `);
    setupTables(db);
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const idx of [
      "idx_fleet_tail",
      "idx_qs_flight",
      "idx_dl_airport",
      "idx_fleet_discovery",
    ]) {
      expect(names).not.toContain(idx);
    }
    db.close();
  });
});
