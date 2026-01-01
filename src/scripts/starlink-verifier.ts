/**
 * Starlink Verification Runner
 * Verifies Starlink status for planes using United.com with rate limiting
 * Fetches plane/flight data from unitedstarlinktracker.com API
 */

import type { Database } from "bun:sqlite";
import {
  type VerificationSource,
  getLastVerification,
  getVerificationStats,
  initializeDatabase,
  logVerification,
  needsVerification,
  updateVerifiedWifi,
} from "../database/database";
import { verifierLog } from "../utils/logger";
import { type StarlinkCheckResult, checkStarlinkStatus } from "./united-starlink-checker";

const VERIFICATION_DELAY_MS = 5000; // 5 seconds between checks to be polite
const API_BASE_URL = "https://unitedstarlinktracker.com";

/**
 * Convert ICAO airport code to IATA (remove K prefix for US airports)
 */
function icaoToIata(icao: string): string {
  if (icao.length === 4 && icao.startsWith("K")) {
    return icao.substring(1);
  }
  // Handle Canadian airports (start with C/Y)
  if (icao.length === 4 && icao.startsWith("C")) {
    return icao.substring(1);
  }
  return icao;
}

/**
 * Extract numeric flight number from carrier-prefixed format
 * e.g., "GJS4467" -> "4467", "ASH3991" -> "3991", "SKW5882" -> "5882"
 */
function extractFlightNumber(flightNumber: string): string {
  // Match trailing digits
  const match = flightNumber.match(/(\d+)$/);
  return match ? match[1] : flightNumber;
}

interface Flight {
  tail_number: string;
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  departure_time: number;
  arrival_time: number;
}

interface Plane {
  TailNumber: string;
  Aircraft: string;
  WiFi: string;
  DateFound: string;
  OperatedBy: string;
  fleet: string;
}

interface ApiDataResponse {
  totalCount: number;
  starlinkPlanes: Plane[];
  lastUpdated: string;
  flightsByTail: Record<string, Flight[]>;
}

/**
 * Fetch data from unitedstarlinktracker.com API
 */
async function fetchTrackerData(): Promise<ApiDataResponse | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/data`);
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Failed to fetch tracker data:", error);
    return null;
  }
}

/**
 * Get planes that need United verification based on local verification log
 */
function getPlanesNeedingVerification(
  db: Database,
  planes: Plane[],
  flightsByTail: Record<string, Flight[]>,
  limit: number,
  forceAll = false
): Array<{ plane: Plane; flight: Flight }> {
  const result: Array<{ plane: Plane; flight: Flight }> = [];
  const now = Math.floor(Date.now() / 1000);

  for (const plane of planes) {
    if (result.length >= limit) break;

    // Check if this plane has upcoming flights
    const flights = flightsByTail[plane.TailNumber] || [];
    if (flights.length === 0) continue;

    const futureFlights = flights.filter((f) => f.departure_time > now);
    if (futureFlights.length === 0) continue;

    if (!forceAll && !needsVerification(db, plane.TailNumber, "united")) {
      continue;
    }

    // Use the first upcoming flight
    result.push({ plane, flight: futureFlights[0] });
  }

  return result;
}

/**
 * Verify a single plane's Starlink status via United.com
 */
export async function verifyPlaneStarlink(
  db: Database,
  tailNumber: string,
  flight: Flight,
  forceCheck = false
): Promise<StarlinkCheckResult | null> {
  if (!forceCheck && !needsVerification(db, tailNumber, "united")) {
    return null;
  }

  const departureDate = new Date(flight.departure_time * 1000).toISOString().split("T")[0];
  const flightNumber = extractFlightNumber(flight.flight_number);
  const origin = icaoToIata(flight.departure_airport);
  const destination = icaoToIata(flight.arrival_airport);

  verifierLog.info(
    `Checking ${tailNumber} via UA${flightNumber} ${origin}-${destination} on ${departureDate}`
  );

  try {
    const result = await checkStarlinkStatus(flightNumber, departureDate, origin, destination);

    // Log the verification result
    logVerification(db, {
      tail_number: tailNumber,
      source: "united",
      has_starlink: result.hasStarlink,
      wifi_provider: result.wifiProvider,
      aircraft_type: result.aircraftType,
      flight_number: `UA${flightNumber}`,
      error: result.error || null,
    });

    // Update the plane's verified_wifi status (only if no error)
    if (!result.error && result.wifiProvider) {
      updateVerifiedWifi(db, tailNumber, result.wifiProvider);
    }

    if (result.hasStarlink) {
      verifierLog.info(`✓ ${tailNumber} confirmed Starlink (${result.wifiProvider})`);
    } else if (result.error) {
      verifierLog.warn(
        `✗ ${tailNumber} error: ${result.error}`,
        result.debugFile ? { debugFile: result.debugFile } : undefined
      );
    } else {
      verifierLog.info(
        `✗ ${tailNumber} no Starlink (${result.wifiProvider || "unknown provider"})`,
        result.debugFile ? { debugFile: result.debugFile } : undefined
      );
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    verifierLog.error(`Error verifying ${tailNumber}`, errorMessage);

    logVerification(db, {
      tail_number: tailNumber,
      source: "united",
      has_starlink: null,
      wifi_provider: null,
      aircraft_type: null,
      flight_number: `UA${flightNumber}`,
      error: errorMessage,
    });

    return null;
  }
}

/**
 * Run verification for planes that need checking
 * Fetches data from unitedstarlinktracker.com API
 */
export async function runVerificationBatch(
  maxPlanes = 5,
  delayMs = VERIFICATION_DELAY_MS,
  forceAll = false
): Promise<{
  checked: number;
  starlink: number;
  notStarlink: number;
  errors: number;
  skipped: number;
}> {
  const db = initializeDatabase();
  const stats = { checked: 0, starlink: 0, notStarlink: 0, errors: 0, skipped: 0 };

  try {
    // Fetch data from the API
    verifierLog.debug(`Fetching data from ${API_BASE_URL}/api/data`);
    const data = await fetchTrackerData();

    if (!data) {
      verifierLog.error("Failed to fetch tracker data");
      return stats;
    }

    const flightCount = Object.values(data.flightsByTail).flat().length;
    verifierLog.debug(`Found ${data.starlinkPlanes.length} planes, ${flightCount} flights`);

    // Get planes that need verification
    const toVerify = getPlanesNeedingVerification(
      db,
      data.starlinkPlanes,
      data.flightsByTail,
      maxPlanes,
      forceAll
    );

    if (toVerify.length === 0) {
      verifierLog.debug("No planes need verification at this time");
      return stats;
    }

    verifierLog.info(`${toVerify.length} plane(s) need verification`);

    for (let i = 0; i < toVerify.length; i++) {
      const { plane, flight } = toVerify[i];
      const result = await verifyPlaneStarlink(db, plane.TailNumber, flight, forceAll);

      if (result === null) {
        stats.skipped++;
      } else if (result.error) {
        stats.errors++;
      } else if (result.hasStarlink) {
        stats.starlink++;
      } else {
        stats.notStarlink++;
      }
      stats.checked++;

      // Delay between checks
      if (i < toVerify.length - 1) {
        verifierLog.debug(`Waiting ${delayMs / 1000}s before next check`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // Log verification stats
    const dbStats = getVerificationStats(db);
    verifierLog.info(
      `Stats: ${dbStats.total_checks} total checks, ${dbStats.last_24h_checks} in last 24h`
    );
  } finally {
    db.close();
  }

  return stats;
}

/**
 * Log a FlightRadar24 verification (used when scraping FR24 data)
 */
export function logFR24Verification(db: Database, tailNumber: string, aircraftType: string): void {
  logVerification(db, {
    tail_number: tailNumber,
    source: "flightradar24",
    has_starlink: null, // FR24 doesn't tell us Starlink status
    wifi_provider: null,
    aircraft_type: aircraftType,
    flight_number: null,
    error: null,
  });
}

/**
 * Log a spreadsheet verification (used when scraping Google Sheets)
 */
export function logSpreadsheetVerification(
  db: Database,
  tailNumber: string,
  hasStarlink: boolean,
  aircraftType: string
): void {
  logVerification(db, {
    tail_number: tailNumber,
    source: "spreadsheet",
    has_starlink: hasStarlink,
    wifi_provider: hasStarlink ? "Starlink" : null,
    aircraft_type: aircraftType,
    flight_number: null,
    error: null,
  });
}

/**
 * Start the background Starlink verifier
 * Runs every ~60 seconds (±15s jitter), checking 1 plane per run
 * With ~100 planes, full cycle takes ~100 minutes
 * Combined with 48-96hr jitter per plane, this spreads load nicely
 */
export function startStarlinkVerifier() {
  const BASE_INTERVAL_MS = 60 * 1000; // 60 seconds
  const JITTER_MS = 15 * 1000; // ±15 seconds
  const PLANES_PER_RUN = 1;

  const getJitteredInterval = () => {
    return BASE_INTERVAL_MS + (Math.random() * 2 - 1) * JITTER_MS;
  };

  const scheduleNext = () => {
    const interval = getJitteredInterval();
    setTimeout(runAndSchedule, interval);
  };

  const runAndSchedule = async () => {
    try {
      const stats = await runVerificationBatch(PLANES_PER_RUN, VERIFICATION_DELAY_MS);

      if (stats.checked > 0) {
        verifierLog.info(
          `Batch complete: ${stats.starlink} Starlink, ${stats.notStarlink} not, ${stats.errors} errors`
        );
      }
    } catch (error) {
      verifierLog.error("Background verification failed", error);
    }
    scheduleNext();
  };

  // Initial run after 5 seconds
  setTimeout(runAndSchedule, 5 * 1000);

  verifierLog.info("Background verifier started (every ~60s ±15s, 1 plane/run)");
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const forceAll = args.includes("--force");
  const maxPlanes = Number.parseInt(args.find((a) => !a.startsWith("--")) || "5", 10);

  console.log(
    `Running Starlink verification for up to ${maxPlanes} planes${forceAll ? " (FORCE ALL - ignoring rate limits)" : ""}...\n`
  );

  runVerificationBatch(maxPlanes, VERIFICATION_DELAY_MS, forceAll)
    .then((stats) => {
      console.log("\n=== Batch Results ===");
      console.log(`Checked: ${stats.checked}`);
      console.log(`Starlink confirmed: ${stats.starlink}`);
      console.log(`Not Starlink: ${stats.notStarlink}`);
      console.log(`Errors: ${stats.errors}`);
      console.log(`Skipped: ${stats.skipped}`);
    })
    .catch(console.error);
}
