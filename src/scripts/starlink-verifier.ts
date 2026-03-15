/**
 * Starlink Verification Runner
 * Verifies Starlink status for planes using United.com with rate limiting
 * Reads plane/flight data from local SQLite (including mismatched planes so they can self-heal)
 */

import type { Database } from "bun:sqlite";
import {
  computeWifiConsensus,
  getAllStarlinkPlanes,
  getUpcomingFlights,
  getVerificationStats,
  initializeDatabase,
  logVerification,
  needsVerification,
  updateVerifiedWifi,
} from "../database/database";
import { COUNTERS, metrics, withSpan } from "../observability";
import { verifierLog } from "../utils/logger";
import type { StarlinkCheckResult } from "./united-starlink-checker";
import { checkStarlinkStatusSubprocess } from "./united-starlink-checker-subprocess";

const VERIFICATION_DELAY_MS = 5000; // 5 seconds between checks to be polite

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

/**
 * Get planes that need United verification.
 * Queries the local DB directly (including mismatched planes with
 * verified_wifi != 'Starlink') so they can self-heal on re-verification.
 *
 * Previously this pulled from /api/data which filters out mismatches —
 * creating a one-way door where a single false-negative permanently
 * hid a plane.
 */
function getPlanesNeedingVerification(
  db: Database,
  limit: number,
  forceAll = false
): Array<{ plane: Plane; flight: Flight }> {
  const result: Array<{ plane: Plane; flight: Flight }> = [];
  const now = Math.floor(Date.now() / 1000);

  // Pull ALL planes from starlink_planes (including mismatches)
  const planes = getAllStarlinkPlanes(db) as Plane[];
  const allFlights = getUpcomingFlights(db);

  // Group flights by tail number
  const flightsByTail = new Map<string, Flight[]>();
  for (const f of allFlights) {
    if (!flightsByTail.has(f.tail_number)) {
      flightsByTail.set(f.tail_number, []);
    }
    flightsByTail.get(f.tail_number)!.push(f);
  }

  for (const plane of planes) {
    if (result.length >= limit) break;

    const flights = flightsByTail.get(plane.TailNumber) || [];
    const futureFlights = flights.filter((f) => f.departure_time > now);
    if (futureFlights.length === 0) continue;

    if (!forceAll && !needsVerification(db, plane.TailNumber, "united")) {
      continue;
    }

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

  return withSpan(
    "starlink_verifier.verify_plane",
    async (span) => {
      span.setTag("tail_number", tailNumber);

      const departureDate = new Date(flight.departure_time * 1000).toISOString().split("T")[0];
      const flightNumber = extractFlightNumber(flight.flight_number);
      const origin = icaoToIata(flight.departure_airport);
      const destination = icaoToIata(flight.arrival_airport);

      span.setTag("flight_number", `UA${flightNumber}`);
      span.setTag("route", `${origin}-${destination}`);

      verifierLog.info(
        `Checking ${tailNumber} via UA${flightNumber} ${origin}-${destination} on ${departureDate}`
      );

      try {
        const result = await checkStarlinkStatusSubprocess(
          flightNumber,
          departureDate,
          origin,
          destination
        );

        // Check if the aircraft on the flight matches what we expected
        const actualTail = result.tailNumber;
        const tailMatches = actualTail && actualTail.toUpperCase() === tailNumber.toUpperCase();
        const tailMismatch = actualTail && !tailMatches;

        // If we couldn't extract a tail number from the page, we can't confirm
        // the aircraft wasn't swapped. Only trust a POSITIVE Starlink result in
        // that case (can't falsely hide a plane, only falsely show one — less bad).
        const tailUnknown = !actualTail;

        if (tailMismatch) {
          verifierLog.warn(
            `Aircraft mismatch: expected ${tailNumber} but flight has ${actualTail} - skipping verification update`
          );
        }

        // Log the verification result (always log, but note the mismatch)
        logVerification(db, {
          tail_number: tailNumber,
          source: "united",
          has_starlink: tailMismatch ? null : result.hasStarlink,
          wifi_provider: tailMismatch ? null : result.wifiProvider,
          aircraft_type: result.aircraftType,
          flight_number: `UA${flightNumber}`,
          error: tailMismatch
            ? `Aircraft mismatch: flight has ${actualTail}`
            : result.error || null,
        });

        // Update the plane's verified_wifi status ONLY if:
        // 1. No error
        // 2. We got a wifiProvider
        // 3. The tail number matches (not swapped to a different plane)
        // 4. If tail wasn't extracted, only trust positive Starlink results
        //    (prevents hiding planes due to unconfirmed aircraft swaps)
        const canTrustResult =
          !result.error &&
          result.wifiProvider &&
          !tailMismatch &&
          (!tailUnknown || result.wifiProvider === "Starlink");

        if (canTrustResult) {
          // logVerification above already wrote this check into the log, so
          // consensus includes it. Gate the column write on the 30-day consensus
          // so a single flaky scrape can't hide a plane.
          const consensus = computeWifiConsensus(db, tailNumber);
          if (consensus.verdict !== null) {
            updateVerifiedWifi(db, tailNumber, consensus.verdict);
            verifierLog.info(
              `${tailNumber}: verified_wifi → ${consensus.verdict} (${consensus.reason})`
            );
          } else {
            // Ambiguous — clear to NULL so the check-flight filter
            // (IS NULL OR = 'Starlink') falls through to spreadsheet trust.
            updateVerifiedWifi(db, tailNumber, null);
            verifierLog.info(
              `${tailNumber}: consensus ambiguous, verified_wifi cleared (${consensus.reason})`
            );
          }
        } else if (tailUnknown && result.wifiProvider && result.wifiProvider !== "Starlink") {
          verifierLog.warn(
            `${tailNumber}: got "${result.wifiProvider}" but couldn't confirm tail number — skipping update to avoid false negative`
          );
        }

        // Emit metrics
        if (tailMismatch) {
          metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: "aircraft_mismatch" });
          span.setTag("result", "aircraft_mismatch");
          span.setTag("expected_tail", tailNumber);
          span.setTag("actual_tail", actualTail);
        } else if (result.error) {
          metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: "error" });
          span.setTag("result", "error");
        } else {
          metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: "success" });
          span.setTag("result", result.hasStarlink ? "starlink" : "not_starlink");
          span.setTag("wifi_provider", result.wifiProvider || "unknown");
        }

        if (tailMismatch) {
          // Already logged above, just note we're not updating
          verifierLog.debug(
            `Flight ${flightNumber} aircraft: ${actualTail} (${result.wifiProvider || "unknown"})`
          );
        } else if (result.hasStarlink) {
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
        metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: "error" });
        span.setTag("error", true);
        span.setTag("result", "error");

        logVerification(db, {
          tail_number: tailNumber,
          source: "united",
          has_starlink: null,
          wifi_provider: null,
          aircraft_type: null,
          flight_number: `UA${flightNumber}`,
          error: errorMessage,
        });

        // Return null to allow batch processing to continue
        return null;
      }
    },
    { tail_number: tailNumber }
  );
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
    // Get planes that need verification (from local DB, includes mismatches so they can self-heal)
    const toVerify = getPlanesNeedingVerification(db, maxPlanes, forceAll);

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
 * Runs every ~60 seconds, checking 1 plane per run
 * With ~100 planes, full cycle takes ~100 minutes
 * Combined with 48-96hr jitter per plane, this spreads load nicely
 *
 * Uses setInterval for robustness - ensures scheduler can't die from errors
 */
export function startStarlinkVerifier() {
  const BASE_INTERVAL_MS = 60 * 1000; // 60 seconds
  const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const PLANES_PER_RUN = 1;

  let runCount = 0;
  let isRunning = false;
  let lastHeartbeat = Date.now();

  const runVerification = async () => {
    // Prevent overlapping runs
    if (isRunning) {
      verifierLog.debug("Skipping run - previous verification still in progress");
      return;
    }

    isRunning = true;
    runCount++;

    try {
      await withSpan(
        "starlink_verifier.run",
        async (span) => {
          span.setTag("job.type", "background");

          const stats = await runVerificationBatch(PLANES_PER_RUN, VERIFICATION_DELAY_MS);

          span.setTag("checked", stats.checked);
          span.setTag("starlink", stats.starlink);
          span.setTag("errors", stats.errors);

          if (stats.checked > 0) {
            verifierLog.info(
              `Batch complete: ${stats.starlink} Starlink, ${stats.notStarlink} not, ${stats.errors} errors`
            );
          }

          // Heartbeat log every 10 minutes to show scheduler is alive
          const now = Date.now();
          if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
            verifierLog.info(`Heartbeat: ${runCount} runs completed, scheduler healthy`);
            lastHeartbeat = now;
          }
        },
        { "job.type": "background" }
      );
    } catch (error) {
      verifierLog.error("Background verification failed", error);
    } finally {
      isRunning = false;
    }
  };

  // Use setInterval for robust scheduling - won't die if one run fails
  setInterval(() => {
    runVerification().catch((error) => {
      // This catch should never trigger (runVerification has its own try/catch)
      // but adding it as an extra safety layer
      verifierLog.error("Unexpected error in verification scheduler", error);
    });
  }, BASE_INTERVAL_MS);

  // Initial run after 5 seconds
  setTimeout(() => {
    runVerification().catch((error) => {
      verifierLog.error("Initial verification run failed", error);
    });
  }, 5 * 1000);

  verifierLog.info(
    `Background verifier started (every ${BASE_INTERVAL_MS / 1000}s, ${PLANES_PER_RUN} plane/run)`
  );
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const forceAll = args.includes("--force");
  const tailArg = args.find((a) => a.startsWith("--tail="));
  const tailNumber = tailArg?.split("=")[1];

  if (tailNumber) {
    // Verify a specific plane
    console.log(`Verifying specific plane: ${tailNumber}\n`);

    const db = initializeDatabase();

    // Get flight data for this plane
    const flight = db
      .query(
        `SELECT * FROM upcoming_flights
         WHERE tail_number = ? AND departure_time > ?
         ORDER BY departure_time LIMIT 1`
      )
      .get(tailNumber, Math.floor(Date.now() / 1000)) as Flight | null;

    if (!flight) {
      console.error(`No upcoming flights found for ${tailNumber}`);
      db.close();
      process.exit(1);
    }

    console.log(
      `Using flight: ${flight.flight_number} ${flight.departure_airport}-${flight.arrival_airport}`
    );

    verifyPlaneStarlink(db, tailNumber, flight, true)
      .then((result) => {
        console.log("\n=== Result ===");
        console.log(JSON.stringify(result, null, 2));

        // Show updated plane record
        const plane = db
          .query(
            "SELECT TailNumber, wifi, verified_wifi, verified_at FROM starlink_planes WHERE TailNumber = ?"
          )
          .get(tailNumber);
        console.log("\n=== Updated Plane Record ===");
        console.log(JSON.stringify(plane, null, 2));

        db.close();
      })
      .catch((err) => {
        console.error(err);
        db.close();
        process.exit(1);
      });
  } else {
    // Batch verification
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
}
