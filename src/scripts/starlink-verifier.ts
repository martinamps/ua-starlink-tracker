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
} from "../database/database";
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

  for (const plane of planes) {
    if (result.length >= limit) break;

    // Check if this plane has upcoming flights
    const flights = flightsByTail[plane.TailNumber] || [];
    if (flights.length === 0) continue;

    // Check rate limit (72 hours for United) - skip if forceAll
    if (!forceAll && !needsVerification(db, plane.TailNumber, "united")) {
      continue;
    }

    // Use the first upcoming flight
    result.push({ plane, flight: flights[0] });
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
  // Check rate limit (72 hours for United)
  if (!forceCheck && !needsVerification(db, tailNumber, "united")) {
    console.log(`Skipping ${tailNumber}: checked within last 72 hours`);
    return null;
  }

  const departureDate = new Date(flight.departure_time * 1000).toISOString().split("T")[0];
  const flightNumber = extractFlightNumber(flight.flight_number);
  const origin = icaoToIata(flight.departure_airport);
  const destination = icaoToIata(flight.arrival_airport);

  console.log(
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

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error verifying ${tailNumber}:`, errorMessage);

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
    console.log(`Fetching data from ${API_BASE_URL}/api/data...`);
    const data = await fetchTrackerData();

    if (!data) {
      console.error("Failed to fetch tracker data");
      return stats;
    }

    console.log(`Found ${data.starlinkPlanes.length} Starlink planes`);
    const flightCount = Object.values(data.flightsByTail).flat().length;
    console.log(`Found ${flightCount} upcoming flights`);

    // Get planes that need verification
    const toVerify = getPlanesNeedingVerification(
      db,
      data.starlinkPlanes,
      data.flightsByTail,
      maxPlanes,
      forceAll
    );
    console.log(`${toVerify.length} planes need verification\n`);

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
        console.log(`Waiting ${delayMs / 1000}s before next check...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // Print verification stats
    const dbStats = getVerificationStats(db);
    console.log("\n=== Verification Stats ===");
    console.log(`Total checks ever: ${dbStats.total_checks}`);
    console.log(`Checks in last 24h: ${dbStats.last_24h_checks}`);
    console.log(
      `By source: United=${dbStats.checks_by_source.united}, FR24=${dbStats.checks_by_source.flightradar24}`
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
