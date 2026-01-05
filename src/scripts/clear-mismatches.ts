/**
 * One-time script to clear stale mismatch verifications
 * Run this after deploying the fix to starlink-verifier.ts
 * so planes can be re-verified with the corrected logic.
 */

import {
  clearMismatchVerifications,
  getWifiMismatches,
  initializeDatabase,
} from "../database/database";

const db = initializeDatabase();

// Show current mismatches
const mismatches = getWifiMismatches(db);
console.log(`Found ${mismatches.length} mismatched planes:`);
for (const m of mismatches) {
  console.log(`  ${m.TailNumber}: spreadsheet=${m.spreadsheet_wifi}, verified=${m.verified_wifi}`);
}

if (mismatches.length === 0) {
  console.log("\nNo mismatches to clear.");
  db.close();
  process.exit(0);
}

// Clear them
console.log("\nClearing verified_wifi for these planes...");
const cleared = clearMismatchVerifications(db);
console.log(`Cleared ${cleared} planes. They will be re-verified on next cycle.`);

db.close();
