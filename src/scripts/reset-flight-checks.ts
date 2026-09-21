/**
 * Reset flight check timestamps to force re-fetch of all flight data.
 * Keeps existing flights until new data overwrites them.
 * Run with: bun run reset-flights
 */
import { openDatabase } from "../database/database";

const db = openDatabase();

const resetResult = db.query("UPDATE starlink_planes SET last_flight_check = 0").run();
console.log(`Reset ${resetResult.changes} planes - they will be re-checked by the background job`);
console.log("Existing flight data preserved until new data arrives.");

db.close();
