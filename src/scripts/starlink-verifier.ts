/**
 * Starlink Verification Runner
 * Verifies Starlink status for planes using United.com with rate limiting
 * Reads plane/flight data from local SQLite (including mismatched planes so they can self-heal)
 */

import type { Database } from "bun:sqlite";
import {
  getAllStarlinkPlanes,
  getUpcomingFlights,
  getVerificationStats,
  initializeDatabase,
  logVerification,
  needsVerification,
} from "../database/database";
import {
  COUNTERS,
  metrics,
  normalizeAircraftType,
  normalizeAirlineTag,
  normalizeFleet,
  normalizeWifiProvider,
  withSpan,
} from "../observability";
import { icaoToIata } from "../utils/airport-tz";
import { extractFlightNumber, pickVerifiableFlight, unitedLookupDate } from "../utils/constants";
import { type JobHandle, startJob } from "../utils/job-runner";
import { verifierLog } from "../utils/logger";
import type { StarlinkCheckResult } from "./united-starlink-checker";
import { checkStarlinkStatusSubprocess } from "./united-starlink-checker-subprocess";
import {
  UNITED_SOURCE,
  type UnitedCheckCategory,
  applyUnitedObservation,
  classifyUnitedCheck,
  logUnitedCheckFailure,
} from "./united-verdict";

const VERIFICATION_DELAY_MS = 5000; // 5 seconds between checks to be polite

export interface VerifyPlaneStarlinkDeps {
  checker?: typeof checkStarlinkStatusSubprocess;
}

// Wrappers (not method refs) so shared verdict-core log lines keep this
// file's logger tag — the logger derives the tag from the call-site file.
// Block bodies on purpose: a single-expression arrow is a proper tail call
// in JSC and its stack frame (the tag source) gets elided.
const verdictLog = {
  info: (m: string) => {
    verifierLog.info(m);
  },
  warn: (m: string) => {
    verifierLog.warn(m);
  },
};

// Verification-mode metric tags per verdict category. The mode difference vs
// discovery is deliberate: this ladder tags every tail-unknown cell
// "tail_unknown" and the degenerate no-provider cell "success".
const VERIFIER_RESULT_TAG: Record<UnitedCheckCategory, string> = {
  trusted_starlink: "success",
  trusted_other: "success",
  no_provider: "success",
  tail_unknown_positive: "tail_unknown",
  unattributable: "tail_unknown",
  tail_unknown: "tail_unknown",
  mismatch: "aircraft_mismatch",
  error: "error",
};

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

  // Pull ALL planes from starlink_planes (including mismatches) — UA only;
  // HA is type-deterministic and AS uses alaska-json, neither needs united.com checks.
  const planes = getAllStarlinkPlanes(db, "UA") as Plane[];
  const allFlights = getUpcomingFlights(db, undefined, "UA");

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
    // Skip flights united.com can't resolve yet (lookup date too far out) —
    // checking them is a guaranteed "redirected to search page" error.
    const candidate = pickVerifiableFlight(
      flights.filter((f) => f.departure_time > now),
      now
    );
    if (!candidate) continue;

    if (!forceAll && !needsVerification(db, plane.TailNumber, UNITED_SOURCE)) {
      continue;
    }

    result.push({ plane, flight: candidate });
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
  forceCheck = false,
  context?: { aircraftType?: string | null; fleet?: string | null },
  deps: VerifyPlaneStarlinkDeps = {}
): Promise<StarlinkCheckResult | null> {
  const checker = deps.checker ?? checkStarlinkStatusSubprocess;
  if (!forceCheck && !needsVerification(db, tailNumber, UNITED_SOURCE)) {
    return null;
  }

  const aircraftTypeTag = normalizeAircraftType(context?.aircraftType);
  const fleetTag = normalizeFleet(context?.fleet);

  return withSpan(
    "starlink_verifier.verify_plane",
    async (span) => {
      span.setTag("tail_number", tailNumber);
      span.setTag("aircraft_type", aircraftTypeTag);
      span.setTag("fleet", fleetTag);

      const departureDate = unitedLookupDate(flight.departure_time, flight.departure_airport);
      const flightNumber = extractFlightNumber(flight.flight_number);
      const origin = icaoToIata(flight.departure_airport);
      const destination = icaoToIata(flight.arrival_airport);

      span.setTag("flight_number", `UA${flightNumber}`);
      span.setTag("route", `${origin}-${destination}`);

      verifierLog.info(
        `Checking ${tailNumber} via UA${flightNumber} ${origin}-${destination} on ${departureDate}`
      );

      try {
        const result = await checker(flightNumber, departureDate, origin, destination);

        const verdict = classifyUnitedCheck(db, result, tailNumber, verdictLog);
        const { tailMismatch, resolvedTail } = verdict;

        applyUnitedObservation(db, verdict, {
          flightNumber: `UA${flightNumber}`,
          aircraftType: result.aircraftType,
          log: verdictLog,
        });

        const wifiProviderTag = normalizeWifiProvider(result.wifiProvider);
        const checkTags = {
          fleet: fleetTag,
          aircraft_type: aircraftTypeTag,
          wifi_provider: wifiProviderTag,
          source: UNITED_SOURCE,
          airline: normalizeAirlineTag("UA"),
        };
        span.setTag("wifi_provider", wifiProviderTag);

        const resultTag = VERIFIER_RESULT_TAG[verdict.category];
        metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: resultTag, ...checkTags });
        if (verdict.category === "mismatch") {
          span.setTag("result", "aircraft_mismatch");
          span.setTag("expected_tail", tailNumber);
          span.setTag("actual_tail", resolvedTail);
        } else if (resultTag === "success") {
          span.setTag("result", result.hasStarlink ? "starlink" : "not_starlink");
        } else {
          span.setTag("result", resultTag);
        }

        if (tailMismatch) {
          // Already logged above, just note we're not updating
          verifierLog.debug(
            `Flight ${flightNumber} aircraft: ${resolvedTail} (${result.wifiProvider || "unknown"})`
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
        metrics.increment(COUNTERS.VERIFICATION_CHECK, {
          result: "error",
          fleet: fleetTag,
          aircraft_type: aircraftTypeTag,
          wifi_provider: "unknown",
          source: UNITED_SOURCE,
          airline: normalizeAirlineTag("UA"),
        });
        span.setTag("error", true);
        span.setTag("result", "error");

        logUnitedCheckFailure(db, tailNumber, errorMessage, {
          flightNumber: `UA${flightNumber}`,
          aircraftType: context?.aircraftType ?? null,
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
// Cheap pre-flight so the background loop can skip span creation on no-op ticks.
export function hasVerificationWork(maxPlanes: number, forceAll = false): boolean {
  const db = initializeDatabase();
  try {
    return getPlanesNeedingVerification(db, maxPlanes, forceAll).length > 0;
  } finally {
    db.close();
  }
}

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
      const result = await verifyPlaneStarlink(db, plane.TailNumber, flight, forceAll, {
        aircraftType: plane.Aircraft,
        fleet: plane.fleet,
      });

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
    airline: "UA",
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
    airline: "UA",
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
 */
export function startStarlinkVerifier(): JobHandle {
  const BASE_INTERVAL_MS = 60 * 1000; // 60 seconds
  const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const PLANES_PER_RUN = 1;

  let runCount = 0;
  let lastHeartbeat = Date.now();

  const runVerification = async () => {
    runCount++;

    // Heartbeat log every 10 minutes to show scheduler is alive
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      verifierLog.info(`Heartbeat: ${runCount} runs completed, scheduler healthy`);
      lastHeartbeat = now;
    }

    // ~97% of ticks find nothing to do — skip span creation on no-op runs.
    if (!hasVerificationWork(PLANES_PER_RUN)) return;

    await withSpan(
      "starlink_verifier.run",
      async (span) => {
        const stats = await runVerificationBatch(PLANES_PER_RUN, VERIFICATION_DELAY_MS);

        span.setTag("checked", stats.checked);
        span.setTag("starlink", stats.starlink);
        span.setTag("errors", stats.errors);

        if (stats.checked > 0) {
          verifierLog.info(
            `Batch complete: ${stats.starlink} Starlink, ${stats.notStarlink} not, ${stats.errors} errors`
          );
        }
      },
      { "job.type": "background" }
    );
  };

  const handle = startJob({
    name: "starlink_verifier",
    intervalMs: BASE_INTERVAL_MS,
    initialDelayMs: 5 * 1000,
    run: runVerification,
  });

  verifierLog.info(
    `Background verifier started (every ${BASE_INTERVAL_MS / 1000}s, ${PLANES_PER_RUN} plane/run)`
  );
  return handle;
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
    let maxPlanes = Number.parseInt(args.find((a) => !a.startsWith("--")) || "5", 10);
    if (maxPlanes > 20 && !forceAll) {
      console.warn(`Batch size ${maxPlanes} exceeds cap of 20; clamping. Use --force to override.`);
      maxPlanes = 20;
    }

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
