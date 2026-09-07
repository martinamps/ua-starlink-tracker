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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSyntheticDb } from "./helpers";

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
      "ORD",
      "DEN",
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
    expect(plan).toContain("idx_vlog_flight");
    expect(plan).not.toContain("idx_vlog_airline");
    db.close();
  });

  test("the equipped-departures join seeks upcoming_flights by tail", () => {
    const db = seeded();
    const plan = planOf(
      db,
      `SELECT uf.departure_airport, COUNT(DISTINCT uf.flight_number || ':' || uf.departure_time)
       FROM upcoming_flights uf
       INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
       WHERE (sp.verified_wifi IS NULL OR sp.verified_wifi = 'Starlink')
         AND uf.departure_time >= ? AND uf.departure_time < ? AND uf.airline = ?
       GROUP BY uf.departure_airport`,
      [1_700_000_000, 1_800_000_000, "UA"]
    );
    expect(plan).toContain("idx_upf_tail");
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
    const src = readFileSync(join(import.meta.dir, "..", "src", "database", "database.ts"), "utf8");
    // A query() template that declares an index is the bug shape, whatever
    // table it belongs to — exec() runs every statement, query().run() doesn't.
    const stranded = [...src.matchAll(/db\.query\(\s*`([^`]*)`\s*\)\s*\.run\(\)/g)].filter(
      ([, sql]) => /create\s+index/i.test(sql.split(";").slice(1).join(";"))
    );
    expect(stranded.map(([, sql]) => sql.slice(0, 80))).toEqual([]);
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
      "idx_dl_airport",
      "idx_fr_flight",
      "idx_fr_route",
      "idx_qs_flight",
    ]) {
      expect(names.has(idx), `${idx} was declared but never created`).toBe(true);
    }
    db.close();
  });
});
