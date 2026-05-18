#!/usr/bin/env bun
/**
 * One-shot cleanup for the 2026-05-18 integrity audit.
 * - Drops invalid-registration starlink_planes rows (e.g. N7943SK).
 * - Nulls the false 'None' verification rows for HA A321neos written before
 *   the A321-NEO regex fix, and resets their next_check_after so they
 *   re-verify on the fixed code path.
 * Run: bun run src/scripts/cleanup-integrity-2026-05-18.ts
 */

import { Database } from "bun:sqlite";
import { DB_PATH } from "../utils/constants";
import { info } from "../utils/logger";
import { looksLikeValidTailNumber } from "../utils/utils";

const db = new Database(DB_PATH);

const allTails = db
  .query<{ TailNumber: string }, []>("SELECT DISTINCT TailNumber FROM starlink_planes")
  .all();
const bad = allTails.map((r) => r.TailNumber).filter((t) => !looksLikeValidTailNumber(t));
if (bad.length) {
  const ph = bad.map(() => "?").join(",");
  const r1 = db.run(`DELETE FROM starlink_planes WHERE TailNumber IN (${ph})`, bad);
  const r2 = db.run(`DELETE FROM upcoming_flights WHERE tail_number IN (${ph})`, bad);
  info(
    `dropped invalid registrations ${bad.join(", ")}: ${r1.changes} planes, ${r2.changes} flights`
  );
} else {
  info("no invalid registrations found");
}

const haNeo = db
  .query<{ tail_number: string }, []>(
    `SELECT tail_number FROM united_fleet
     WHERE airline = 'HA' AND verified_wifi = 'None'
       AND UPPER(aircraft_type) LIKE '%A321%'`
  )
  .all()
  .map((r) => r.tail_number);

if (haNeo.length) {
  const ph = haNeo.map(() => "?").join(",");
  const r1 = db.run(
    `UPDATE starlink_verification_log SET has_starlink = NULL, wifi_provider = NULL
     WHERE source = 'alaska' AND wifi_provider = 'None' AND tail_number IN (${ph})`,
    haNeo
  );
  const r2 = db.run(
    `UPDATE united_fleet SET verified_wifi = NULL, next_check_after = 0
     WHERE tail_number IN (${ph})`,
    haNeo
  );
  info(
    `reset ${haNeo.length} HA A321neo tails for re-verify: ${r1.changes} log rows nulled, ${r2.changes} fleet rows reset`
  );
} else {
  info("no HA A321neo false-None rows found");
}

db.close();
