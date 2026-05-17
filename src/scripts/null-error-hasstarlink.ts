/**
 * One-shot: null out has_starlink on rows where the checker errored. Before
 * hasStarlink defaulted to null, error paths leaked the init `false` → 0,
 * miscounted by readers that don't gate on `error IS NULL`.
 * Run: bun run src/scripts/null-error-hasstarlink.ts
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
