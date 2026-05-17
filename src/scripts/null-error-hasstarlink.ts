/**
 * One-shot: null out has_starlink on rows where the checker errored.
 *
 * Before the checker returned hasStarlink=null on error, the redirected-to-
 * search and catch paths returned the init value `false`, so error rows landed
 * as has_starlink=0. computeWifiConsensus already filters error IS NULL, but
 * db-status, getVerificationObservations, and getVerificationStats read
 * has_starlink directly and miscount these as real "no Starlink" observations.
 *
 * Prod check (2026-05-17): 1,728 such rows, all wifi_provider=NULL — no real
 * observation lost.
 *
 * Run with: bun run src/scripts/null-error-hasstarlink.ts
 */
import { Database } from "bun:sqlite";
import { DB_PATH } from "../utils/constants";

const db = new Database(DB_PATH);

const before = db
  .query(
    "SELECT COUNT(*) AS n FROM starlink_verification_log WHERE error IS NOT NULL AND has_starlink = 0"
  )
  .get() as { n: number };
console.log(`Found ${before.n} rows with error set and has_starlink=0`);

const result = db
  .query(
    "UPDATE starlink_verification_log SET has_starlink = NULL WHERE error IS NOT NULL AND has_starlink = 0"
  )
  .run();
console.log(`Updated ${result.changes} rows → has_starlink=NULL`);

db.close();
