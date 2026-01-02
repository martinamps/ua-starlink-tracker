/**
 * Fleet Discovery Verifier
 * Discovers Starlink on planes across the entire United fleet
 *
 * Two modes:
 * - Discovery mode: Fast initial scan (1 plane per 30s, ~7.5h for 900 planes)
 * - Maintenance mode: Ongoing re-verification (1 plane per 90s)
 */

import type { Database } from "bun:sqlite";
import { FlightRadar24API } from "../api/flightradar24-api";
import {
  addDiscoveredStarlinkPlane,
  getFleetDiscoveryStats,
  getNextPlanesToVerify,
  initializeDatabase,
  logVerification,
  updateFleetVerificationResult,
} from "../database/database";
import type { FleetAircraft, StarlinkStatus } from "../types";
import { info, error as logError, warn } from "../utils/logger";
import type { StarlinkCheckResult } from "./united-starlink-checker";
import { checkStarlinkStatusSubprocess } from "./united-starlink-checker-subprocess";

// Discovery mode: faster checks for unknown planes
const DISCOVERY_INTERVAL_MS = 30 * 1000; // 30 seconds
// Maintenance mode: slower re-verification of known planes
const MAINTENANCE_INTERVAL_MS = 90 * 1000; // 90 seconds
// Heartbeat interval for logging
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const fr24Api = new FlightRadar24API();

/**
 * Convert ICAO airport code to IATA
 */
function icaoToIata(icao: string): string {
  if (icao.length === 4 && icao.startsWith("K")) {
    return icao.substring(1);
  }
  if (icao.length === 4 && icao.startsWith("C")) {
    return icao.substring(1);
  }
  return icao;
}

/**
 * Extract numeric flight number
 */
function extractFlightNumber(flightNumber: string): string {
  const match = flightNumber.match(/(\d+)$/);
  return match ? match[1] : flightNumber;
}

/**
 * Get an upcoming flight for a plane using FR24 API
 */
async function getUpcomingFlightForPlane(tailNumber: string): Promise<{
  flightNumber: string;
  date: string;
  origin: string;
  destination: string;
} | null> {
  try {
    const flights = await fr24Api.getUpcomingFlights(tailNumber);

    if (flights.length === 0) {
      return null;
    }

    const flight = flights[0];
    const departureDate = new Date(flight.departure_time * 1000).toISOString().split("T")[0];

    return {
      flightNumber: extractFlightNumber(flight.flight_number),
      date: departureDate,
      origin: icaoToIata(flight.departure_airport),
      destination: icaoToIata(flight.arrival_airport),
    };
  } catch (err) {
    logError(`Error getting flights for ${tailNumber}`, err);
    return null;
  }
}

/**
 * Verify a single plane's Starlink status
 */
async function verifyPlane(
  db: Database,
  plane: FleetAircraft
): Promise<StarlinkCheckResult | null> {
  // Get upcoming flight for this plane
  const flightInfo = await getUpcomingFlightForPlane(plane.tail_number);

  if (!flightInfo) {
    info(`No upcoming flights for ${plane.tail_number}, skipping`);
    // Schedule for later check
    updateFleetVerificationResult(db, plane.tail_number, {
      starlinkStatus: plane.starlink_status as StarlinkStatus,
      verifiedWifi: plane.verified_wifi,
      error: "No upcoming flights",
    });
    return null;
  }

  info(
    `Checking ${plane.tail_number} via UA${flightInfo.flightNumber} ${flightInfo.origin}-${flightInfo.destination} on ${flightInfo.date}`
  );

  try {
    const result = await checkStarlinkStatusSubprocess(
      flightInfo.flightNumber,
      flightInfo.date,
      flightInfo.origin,
      flightInfo.destination
    );

    // Log to verification log
    logVerification(db, {
      tail_number: plane.tail_number,
      source: "united",
      has_starlink: result.hasStarlink,
      wifi_provider: result.wifiProvider,
      aircraft_type: result.aircraftType || plane.aircraft_type,
      flight_number: `UA${flightInfo.flightNumber}`,
      error: result.error || null,
    });

    // Determine status
    let starlinkStatus: StarlinkStatus;
    if (result.error) {
      starlinkStatus = plane.starlink_status as StarlinkStatus;
    } else if (result.hasStarlink) {
      starlinkStatus = "confirmed";
    } else {
      starlinkStatus = "negative";
    }

    // Update fleet table
    updateFleetVerificationResult(db, plane.tail_number, {
      starlinkStatus,
      verifiedWifi: result.wifiProvider || null,
      error: result.error || undefined,
    });

    // If we discovered Starlink on a plane not in the spreadsheet, add it
    if (result.hasStarlink && result.wifiProvider === "Starlink") {
      addDiscoveredStarlinkPlane(
        db,
        plane.tail_number,
        result.aircraftType || plane.aircraft_type,
        "Starlink",
        plane.operated_by,
        plane.fleet === "mainline" ? "mainline" : "express"
      );
      info(`DISCOVERY: ${plane.tail_number} has Starlink!`);
    }

    if (result.hasStarlink) {
      info(`${plane.tail_number} confirmed Starlink (${result.wifiProvider})`);
    } else if (result.error) {
      warn(`${plane.tail_number} error: ${result.error}`);
    } else {
      info(`${plane.tail_number} no Starlink (${result.wifiProvider || "unknown"})`);
    }

    return result;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError(`Error verifying ${plane.tail_number}`, errorMessage);

    logVerification(db, {
      tail_number: plane.tail_number,
      source: "united",
      has_starlink: null,
      wifi_provider: null,
      aircraft_type: plane.aircraft_type,
      flight_number: null,
      error: errorMessage,
    });

    updateFleetVerificationResult(db, plane.tail_number, {
      starlinkStatus: plane.starlink_status as StarlinkStatus,
      verifiedWifi: plane.verified_wifi,
      error: errorMessage,
    });

    return null;
  }
}

/**
 * Run a single discovery batch
 */
export async function runDiscoveryBatch(limit = 1): Promise<{
  checked: number;
  starlink: number;
  notStarlink: number;
  errors: number;
  noFlights: number;
}> {
  const stats = { checked: 0, starlink: 0, notStarlink: 0, errors: 0, noFlights: 0 };
  const db = initializeDatabase();

  try {
    const planes = getNextPlanesToVerify(db, limit);

    if (planes.length === 0) {
      info("No planes need verification at this time");
      return stats;
    }

    for (const plane of planes) {
      const result = await verifyPlane(db, plane);

      if (result === null) {
        stats.noFlights++;
      } else if (result.error) {
        stats.errors++;
      } else if (result.hasStarlink) {
        stats.starlink++;
      } else {
        stats.notStarlink++;
      }
      stats.checked++;
    }
  } finally {
    db.close();
  }

  return stats;
}

/**
 * Start the fleet discovery background process
 */
export function startFleetDiscovery(mode: "discovery" | "maintenance" = "maintenance") {
  const intervalMs = mode === "discovery" ? DISCOVERY_INTERVAL_MS : MAINTENANCE_INTERVAL_MS;

  let runCount = 0;
  let isRunning = false;
  let lastHeartbeat = Date.now();
  const totalStats = { checked: 0, starlink: 0, notStarlink: 0, errors: 0, noFlights: 0 };

  const runVerification = async () => {
    if (isRunning) {
      info("Skipping run - previous verification still in progress");
      return;
    }

    isRunning = true;
    runCount++;

    try {
      const stats = await runDiscoveryBatch(1);

      // Accumulate stats
      totalStats.checked += stats.checked;
      totalStats.starlink += stats.starlink;
      totalStats.notStarlink += stats.notStarlink;
      totalStats.errors += stats.errors;
      totalStats.noFlights += stats.noFlights;

      if (stats.checked > 0) {
        info(
          `Batch complete: ${stats.starlink} Starlink, ${stats.notStarlink} not, ${stats.errors} errors`
        );
      }

      // Heartbeat log
      const now = Date.now();
      if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        const db = initializeDatabase();
        try {
          const fleetStats = getFleetDiscoveryStats(db);
          info(
            `Heartbeat: ${runCount} runs, Total: ${fleetStats.total_fleet} fleet, ` +
              `${fleetStats.verified_starlink} Starlink, ${fleetStats.verified_non_starlink} non-Starlink, ` +
              `${fleetStats.pending_verification} pending`
          );
          lastHeartbeat = now;
        } finally {
          db.close();
        }
      }
    } catch (err) {
      logError("Discovery batch failed", err);
    } finally {
      isRunning = false;
    }
  };

  // Start the interval
  setInterval(() => {
    runVerification().catch((err) => {
      logError("Unexpected error in discovery scheduler", err);
    });
  }, intervalMs);

  // Initial run after 10 seconds
  setTimeout(() => {
    runVerification().catch((err) => {
      logError("Initial discovery run failed", err);
    });
  }, 10 * 1000);

  info(`Fleet discovery started in ${mode} mode (every ${intervalMs / 1000}s)`);
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a === "--discovery" || a === "--maintenance") || "--maintenance";
  const batch = args.find((a) => a.startsWith("--batch="));
  const batchSize = batch ? Number.parseInt(batch.split("=")[1], 10) : 0;
  const stats = args.includes("--stats");

  if (stats) {
    // Just show stats
    const db = initializeDatabase();
    const fleetStats = getFleetDiscoveryStats(db);
    db.close();

    console.log("\n=== Fleet Discovery Stats ===");
    console.log(`Total fleet: ${fleetStats.total_fleet}`);
    console.log(`Verified Starlink: ${fleetStats.verified_starlink}`);
    console.log(`Verified non-Starlink: ${fleetStats.verified_non_starlink}`);
    console.log(`Pending verification: ${fleetStats.pending_verification}`);
    console.log(`Discovered (not in spreadsheet): ${fleetStats.discovered_not_in_spreadsheet}`);

    if (fleetStats.recent_discoveries.length > 0) {
      console.log("\nRecent discoveries:");
      for (const d of fleetStats.recent_discoveries) {
        const date = d.verified_at ? new Date(d.verified_at * 1000).toISOString() : "unknown";
        console.log(
          `  ${d.tail_number} (${d.aircraft_type || "unknown"}) - ${d.verified_wifi} @ ${date}`
        );
      }
    }
  } else if (batchSize > 0) {
    // Run a single batch
    console.log(`Running discovery batch for ${batchSize} planes...\n`);

    runDiscoveryBatch(batchSize)
      .then((result) => {
        console.log("\n=== Batch Results ===");
        console.log(`Checked: ${result.checked}`);
        console.log(`Starlink: ${result.starlink}`);
        console.log(`Not Starlink: ${result.notStarlink}`);
        console.log(`Errors: ${result.errors}`);
        console.log(`No flights: ${result.noFlights}`);
      })
      .catch((err) => {
        console.error("Discovery batch failed:", err);
        process.exit(1);
      });
  } else {
    // Start background process
    console.log(`Starting fleet discovery in ${mode.replace("--", "")} mode...\n`);
    startFleetDiscovery(mode === "--discovery" ? "discovery" : "maintenance");
  }
}
