import type { Database } from "bun:sqlite";

export interface FlightDataFixResult {
  corruptedFlightsDeleted: number;
  planesReset: number;
  hadCorruptedData: boolean;
}

/**
 * Checks for and fixes corrupted flight data with timestamps that appear to be
 * in seconds instead of milliseconds (showing as 1970 dates)
 */
export function checkAndFixCorruptedFlightData(db: Database): FlightDataFixResult {
  // FIXED: Database stores timestamps in SECONDS, not milliseconds!
  // 946684800 = Jan 1, 2000 in SECONDS
  const minValidTimestamp = 946684800;

  // Check if we have any corrupted timestamps (before year 2000)
  const corruptedCount = db
    .query("SELECT COUNT(*) as count FROM upcoming_flights WHERE departure_time < ?")
    .get(minValidTimestamp) as { count: number };

  if (corruptedCount.count === 0) {
    return {
      corruptedFlightsDeleted: 0,
      planesReset: 0,
      hadCorruptedData: false,
    };
  }

  console.log(`Found ${corruptedCount.count} flights with corrupted timestamps, fixing...`);

  // Delete corrupted flight data (using seconds threshold)
  const deleteResult = db
    .query("DELETE FROM upcoming_flights WHERE departure_time < ?")
    .run(minValidTimestamp);

  // Reset flight check timestamps to force refresh
  const resetResult = db.query("UPDATE starlink_planes SET last_flight_check = 0").run();

  console.log(
    `Fixed: Deleted ${deleteResult.changes} corrupted flights, reset ${resetResult.changes} planes`
  );

  return {
    corruptedFlightsDeleted: deleteResult.changes,
    planesReset: resetResult.changes,
    hadCorruptedData: true,
  };
}

/**
 * Checks if a specific flight has corrupted timestamp data
 */
export function hasCorruptedTimestamp(departureTime: number): boolean {
  // If timestamp is less than year 2000 in SECONDS, it's likely corrupted
  const minValidTimestamp = 946684800; // Jan 1, 2000 in seconds
  return departureTime < minValidTimestamp;
}
