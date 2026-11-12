import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import {
  applyUaMembershipRepair,
  previewUaMembershipRepair,
} from "../database/ua-membership-repair";

// No implicit DB_PATH, initializeDatabase(), startup job, or schema migration.
// Default review opens read-only; applying requires an explicit reviewed hash.
if (import.meta.main) {
  const [path, flag, fingerprint, ...extra] = process.argv.slice(2);
  if (
    !path ||
    !isAbsolute(path) ||
    extra.length ||
    (flag !== undefined && (flag !== "--apply" || !/^[0-9a-f]{64}$/.test(fingerprint ?? "")))
  ) {
    console.error(
      "Usage: bun src/scripts/review-ua-membership.ts /absolute/existing.sqlite [--apply REVIEWED_SHA256]"
    );
    process.exitCode = 2;
  } else {
    let db: Database | undefined;
    try {
      db = new Database(
        path,
        flag === "--apply" ? { readwrite: true, create: false } : { readonly: true }
      );
      const result =
        flag === "--apply"
          ? applyUaMembershipRepair(db, fingerprint)
          : previewUaMembershipRepair(db);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Membership review failed");
      process.exitCode = 1;
    } finally {
      db?.close();
    }
  }
}
