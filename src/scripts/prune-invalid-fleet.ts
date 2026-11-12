/**
 * Remove united_fleet rows the membership gate (fleet-admission.ts) would
 * refuse today, plus the per-tail rows they spawned. One-off cleanup for the
 * 2026-11-05 FR24 parser break (type names stored as tails) and untyped
 * non-airliners like N63571; idempotent, so re-running is a no-op.
 *
 *   bun src/scripts/prune-invalid-fleet.ts           # preview
 *   bun src/scripts/prune-invalid-fleet.ts --apply   # delete
 * DB_PATH picks the database.
 */

import type { Database } from "bun:sqlite";
import { lastUpdatedOwner } from "../airlines/registry";
import { initializeDatabase, refreshFleetMeta } from "../database/database";
import { type FleetRejectReason, fleetRejectReason } from "../database/fleet-admission";
import { programmeRoster } from "../database/roster";

// Per-tail tables a fleet member can seed (flights, checks, listings).
const DEPENDENT_TABLES: Array<{ table: string; column: string }> = [
  { table: "starlink_planes", column: "TailNumber" },
  { table: "upcoming_flights", column: "tail_number" },
  { table: "starlink_verification_log", column: "tail_number" },
  { table: "departure_log", column: "tail_number" },
  { table: "first_flights", column: "tail_number" },
  { table: "flight_assignment_log", column: "tail_number" },
];

export interface PruneCandidate {
  airline: string;
  tail: string;
  reason: FleetRejectReason;
}

export function findInvalidFleetRows(db: Database): PruneCandidate[] {
  const rows = db
    .query(
      "SELECT airline, tail_number, aircraft_type FROM united_fleet ORDER BY airline, tail_number"
    )
    .all() as { airline: string; tail_number: string; aircraft_type: string | null }[];
  return rows.flatMap((r) => {
    const reason = fleetRejectReason(db, r.airline, r.tail_number, {
      aircraftType: r.aircraft_type?.trim() || null,
      isNew: true,
    });
    return reason ? [{ airline: r.airline, tail: r.tail_number, reason }] : [];
  });
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (
    db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]
  ).some((c) => c.name === column);
}

export function pruneInvalidFleetRows(
  db: Database,
  candidates: PruneCandidate[]
): Record<string, number> {
  const removed: Record<string, number> = {};
  db.transaction(() => {
    for (const { table, column } of [
      ...DEPENDENT_TABLES,
      { table: "united_fleet", column: "tail_number" },
    ]) {
      if (!hasColumn(db, table, column)) continue;
      const scoped = hasColumn(db, table, "airline");
      const stmt = db.query(
        `DELETE FROM ${table} WHERE ${column} = ?${scoped ? " AND airline = ?" : ""}`
      );
      let n = 0;
      for (const c of candidates) {
        n += (scoped ? stmt.run(c.tail, c.airline) : stmt.run(c.tail)).changes;
      }
      removed[table] = n;
    }
    for (const airline of new Set(candidates.map((c) => c.airline))) {
      if (lastUpdatedOwner(airline) !== "sheet-scrape") refreshFleetMeta(db, airline);
    }
  })();
  return removed;
}

function rosterTotals(db: Database, airlines: string[]): Record<string, number> {
  return Object.fromEntries(airlines.map((a) => [a, programmeRoster(db, a).length]));
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");
  const db = initializeDatabase();
  const candidates = findInvalidFleetRows(db);
  const airlines = [...new Set(candidates.map((c) => c.airline))];

  console.log(`${candidates.length} invalid united_fleet rows:`);
  for (const c of candidates) console.log(`  ${c.airline}  ${c.reason.padEnd(20)}  ${c.tail}`);
  const before = rosterTotals(db, airlines);

  if (!apply) {
    console.log(`\nprogramme roster now: ${JSON.stringify(before)}`);
    console.log("Preview only; re-run with --apply to delete.");
  } else {
    const removed = pruneInvalidFleetRows(db, candidates);
    console.log(`\nrows removed: ${JSON.stringify(removed)}`);
    console.log(
      `programme roster: ${JSON.stringify(before)} -> ${JSON.stringify(rosterTotals(db, airlines))}`
    );
  }
  db.close();
}
