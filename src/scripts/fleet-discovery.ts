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
  type WifiConsensus,
  addDiscoveredStarlinkPlane,
  getFleetDiscoveryStats,
  getNextPlanesToVerify,
  initializeDatabase,
  updateFleetVerificationResult,
  updateFlights,
} from "../database/database";
import {
  COUNTERS,
  DISTRIBUTIONS,
  metrics,
  normalizeAircraftType,
  normalizeAirlineTag,
  normalizeFleet,
  normalizeStarlinkStatus,
  normalizeWifiProvider,
  withSpan,
} from "../observability";
import type { FleetAircraft, StarlinkStatus } from "../types";
import { extractFlightNumber, pickVerifiableFlight, unitedLookupDate } from "../utils/constants";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError, warn } from "../utils/logger";
import type { StarlinkCheckResult } from "./united-starlink-checker";
import { checkStarlinkStatusSubprocess } from "./united-starlink-checker-subprocess";
import {
  UNITED_SOURCE,
  type UnitedCheckCategory,
  applyUnitedObservation,
  classifyUnitedCheck,
  logUnitedCheckFailure,
} from "./united-verdict";

// Wrappers (not method refs) so shared verdict-core log lines keep this
// file's logger tag — the logger derives the tag from the call-site file.
// Block bodies on purpose: a single-expression arrow is a proper tail call
// in JSC and its stack frame (the tag source) gets elided.
const verdictLog = {
  info: (m: string) => {
    info(m);
  },
  warn: (m: string) => {
    warn(m);
  },
};

// Discovery-mode metric tags per verdict category. The mode difference vs
// the verifier is deliberate: a tail-unknown positive counts as "success"
// here, and the degenerate empty-provider cells count as "error".
const DISCOVERY_RESULT_TAG: Record<UnitedCheckCategory, string> = {
  trusted_starlink: "success",
  trusted_other: "success",
  tail_unknown_positive: "success",
  unattributable: "tail_unknown",
  tail_unknown: "error",
  no_provider: "error",
  mismatch: "aircraft_mismatch",
  error: "error",
};

// Discovery mode: faster checks for unknown planes
const DISCOVERY_INTERVAL_MS = 30 * 1000; // 30 seconds
// Maintenance mode: slower re-verification of known planes
const MAINTENANCE_INTERVAL_MS = 90 * 1000; // 90 seconds
// Heartbeat interval for logging
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const fr24Api = new FlightRadar24API();

function emitFleetSnapshot(db: Database) {
  const breakdown = db
    .query(
      `SELECT fleet, starlink_status, COUNT(*) as cnt
       FROM united_fleet WHERE airline = 'UA' GROUP BY fleet, starlink_status`
    )
    .all() as Array<{ fleet: string; starlink_status: string; cnt: number }>;
  for (const row of breakdown) {
    metrics.distribution(DISTRIBUTIONS.FLEET_PLANES, row.cnt, {
      fleet: normalizeFleet(row.fleet),
      starlink_status: normalizeStarlinkStatus(row.starlink_status),
      airline: normalizeAirlineTag("UA"),
    });
  }
}

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

interface FlightInfo {
  flightNumber: string;
  date: string;
  origin: string;
  destination: string;
  // Raw flight data for storage
  raw: {
    flight_number: string;
    departure_airport: string;
    arrival_airport: string;
    departure_time: number;
    arrival_time: number;
  };
}

/**
 * Get upcoming flights for a plane using FR24 API
 * Returns all flights for storage, plus the first one formatted for verification
 */
async function getUpcomingFlightsForPlane(tailNumber: string): Promise<{
  forVerification: Omit<FlightInfo, "raw">;
  allFlights: FlightInfo["raw"][];
} | null> {
  try {
    const flights = await fr24Api.getUpcomingFlights(tailNumber);

    if (flights.length === 0) {
      return null;
    }

    // FR24 returns operator callsigns (SKW578A, C54287) and flights weeks out;
    // pick the first one that united.com can actually resolve.
    const verifiable = pickVerifiableFlight(flights);
    if (!verifiable) {
      info(
        `No verifiable flight for ${tailNumber} (next: ${flights[0].flight_number} on ${unitedLookupDate(flights[0].departure_time)})`
      );
      return null;
    }

    const departureDate = unitedLookupDate(verifiable.departure_time);

    return {
      forVerification: {
        flightNumber: extractFlightNumber(verifiable.flight_number),
        date: departureDate,
        origin: icaoToIata(verifiable.departure_airport),
        destination: icaoToIata(verifiable.arrival_airport),
      },
      allFlights: flights.map((f) => ({
        flight_number: f.flight_number,
        departure_airport: f.departure_airport,
        arrival_airport: f.arrival_airport,
        departure_time: f.departure_time,
        arrival_time: f.arrival_time,
      })),
    };
  } catch (err) {
    logError(`Error getting flights for ${tailNumber}`, err);
    return null;
  }
}

export interface VerifyPlaneDeps {
  checker?: typeof checkStarlinkStatusSubprocess;
  getFlights?: typeof getUpcomingFlightsForPlane;
}

/**
 * Verify a single plane's Starlink status
 */
export async function verifyPlane(
  db: Database,
  plane: FleetAircraft,
  deps: VerifyPlaneDeps = {}
): Promise<StarlinkCheckResult | null> {
  const checker = deps.checker ?? checkStarlinkStatusSubprocess;
  const getFlights = deps.getFlights ?? getUpcomingFlightsForPlane;
  const aircraftTypeTag = normalizeAircraftType(plane.aircraft_type);
  const fleetTag = normalizeFleet(plane.fleet);

  return withSpan(
    "fleet_discovery.verify_plane",
    async (span) => {
      span.setTag("tail_number", plane.tail_number);
      span.setTag("aircraft_type", aircraftTypeTag);
      span.setTag("fleet", fleetTag);

      // Get upcoming flights for this plane
      const flightData = await getFlights(plane.tail_number);

      if (!flightData) {
        // Counting this check, to match the increment updateFleetVerificationResult applies.
        const failures = (plane.check_attempts ?? 0) + 1;
        if (failures === 20) {
          // Warn once at the parked threshold; after that it's weekly backoff and repeats are noise.
          warn(`${plane.tail_number}: ${failures} consecutive no-flights — likely parked/stored`);
        } else {
          info(`No upcoming flights for ${plane.tail_number}, skipping`);
        }
        span.setTag("result", "no_flights");
        metrics.increment(COUNTERS.FLEET_CHECK_SKIPPED, { reason: "no_flights", fleet: fleetTag });
        // Schedule for later check
        updateFleetVerificationResult(db, plane.tail_number, {
          starlinkStatus: plane.starlink_status as StarlinkStatus,
          verifiedWifi: plane.verified_wifi,
          error: "No upcoming flights",
        });
        return null;
      }

      const { forVerification, allFlights } = flightData;
      span.setTag("flight_number", `UA${forVerification.flightNumber}`);
      span.setTag("route", `${forVerification.origin}-${forVerification.destination}`);

      info(
        `Checking ${plane.tail_number} via UA${forVerification.flightNumber} ${forVerification.origin}-${forVerification.destination} on ${forVerification.date}`
      );

      try {
        const result = await checker(
          forVerification.flightNumber,
          forVerification.date,
          forVerification.origin,
          forVerification.destination
        );

        // Aircraft-swap detection: United.com returns the actual tail on the
        // flight. A mismatched result is for a different plane — don't
        // attribute it.
        const verdict = classifyUnitedCheck(db, result, plane.tail_number, verdictLog);
        const { tailMismatch, resolvedTail } = verdict;

        // Discovery mode settles united_fleet.starlink_status from the same
        // consensus the shared writer computes; one transaction over the log
        // row(s), the starlink_planes settle, and the united_fleet write so
        // the two tables can't diverge mid-check.
        const prevStatus = plane.starlink_status as StarlinkStatus;
        let consensus: WifiConsensus | null = null;
        let starlinkStatus: StarlinkStatus = prevStatus;
        let needsMoreObs = false;
        db.transaction(() => {
          consensus = applyUnitedObservation(db, verdict, {
            flightNumber: `UA${forVerification.flightNumber}`,
            aircraftType: result.aircraftType || plane.aircraft_type,
            log: verdictLog,
          });

          if (verdict.trusted) {
            if (consensus?.verdict === "Starlink") {
              starlinkStatus = "confirmed";
            } else if (consensus?.verdict != null) {
              starlinkStatus = "negative";
            } else {
              needsMoreObs = true;
            }
          }

          updateFleetVerificationResult(db, plane.tail_number, {
            starlinkStatus,
            verifiedWifi: consensus ? consensus.verdict : plane.verified_wifi,
            error: verdict.observation.error ?? undefined,
            needsMoreObs,
          });
        })();

        const wifiProviderTag = normalizeWifiProvider(result.wifiProvider);
        const checkTags = {
          fleet: fleetTag,
          aircraft_type: aircraftTypeTag,
          wifi_provider: wifiProviderTag,
          source: UNITED_SOURCE,
          airline: normalizeAirlineTag("UA"),
        };

        const resultTag = DISCOVERY_RESULT_TAG[verdict.category];
        metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: resultTag, ...checkTags });
        if (!verdict.trusted) {
          span.setTag("result", resultTag);
        } else if (result.hasStarlink) {
          span.setTag("result", "starlink");
          metrics.increment(COUNTERS.PLANES_STARLINK_DETECTED, {
            fleet: fleetTag,
            aircraft_type: aircraftTypeTag,
          });
        } else {
          span.setTag("result", "not_starlink");
        }

        span.setTag("wifi_provider", wifiProviderTag);

        const statusChanged = starlinkStatus !== prevStatus;

        if (statusChanged) {
          info(
            `STATUS CHANGE: ${plane.tail_number} ${prevStatus} → ${starlinkStatus} (${consensus?.reason ?? "n/a"})`
          );
          // FLEET_STATUS_CHANGE is emitted at the DB write site (updateFleetVerificationResult).
          emitFleetSnapshot(db);
        }

        // Sheet-independence KPI: flag whenever the crawler's consensus
        // disagrees with what the Google Sheet claims. Exclude rows we added
        // ourselves via discovery — those aren't sheet claims.
        if (consensus?.verdict) {
          const sheetClaim = db
            .query(
              "SELECT wifi FROM starlink_planes WHERE TailNumber = ? AND sheet_gid != 'discovery'"
            )
            .get(plane.tail_number) as { wifi: string } | null;
          if (sheetClaim) {
            const sheetSaysStarlink =
              sheetClaim.wifi === "StrLnk" || sheetClaim.wifi === "Starlink";
            const crawlerSaysStarlink = consensus.verdict === "Starlink";
            if (sheetSaysStarlink !== crawlerSaysStarlink) {
              metrics.increment(COUNTERS.FLEET_SHEET_DISAGREEMENT, {
                fleet: fleetTag,
                sheet_says: sheetSaysStarlink ? "starlink" : "not_starlink",
                crawler_says: crawlerSaysStarlink ? "starlink" : "not_starlink",
              });
              info(
                `SHEET DISAGREEMENT: ${plane.tail_number} sheet=${sheetClaim.wifi} crawler=${consensus.verdict} (${consensus.reason})`
              );
            }
          }
        }

        // First time consensus flips to Starlink → add to starlink_planes and
        // seed its flight cache. Re-checks of already-confirmed planes skip this.
        if (statusChanged && starlinkStatus === "confirmed") {
          addDiscoveredStarlinkPlane(
            db,
            plane.tail_number,
            result.aircraftType || plane.aircraft_type,
            "Starlink",
            plane.operated_by,
            plane.fleet === "mainline" ? "mainline" : "express",
            { airline: "UA", evidence: "observed" }
          );
          updateFlights(db, plane.tail_number, allFlights);
          info(
            `DISCOVERY: ${plane.tail_number} has Starlink! (stored ${allFlights.length} flights)`
          );
        }

        if (result.error) {
          warn(`${plane.tail_number} error: ${result.error}`);
        } else if (tailMismatch) {
          info(`${plane.tail_number} skipped (aircraft swap to ${resolvedTail})`);
        } else if (result.hasStarlink) {
          info(`${plane.tail_number} confirmed Starlink (${result.wifiProvider})`);
        } else {
          info(`${plane.tail_number} no Starlink (${result.wifiProvider || "unknown"})`);
        }

        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logError(`Error verifying ${plane.tail_number}`, errorMessage);
        span.setTag("error", true);
        metrics.increment(COUNTERS.VERIFICATION_CHECK, {
          result: "error",
          fleet: fleetTag,
          aircraft_type: aircraftTypeTag,
          wifi_provider: "unknown",
          source: UNITED_SOURCE,
          airline: normalizeAirlineTag("UA"),
        });

        logUnitedCheckFailure(db, plane.tail_number, errorMessage, {
          flightNumber: `UA${forVerification.flightNumber}`,
          aircraftType: plane.aircraft_type,
        });

        updateFleetVerificationResult(db, plane.tail_number, {
          starlinkStatus: plane.starlink_status as StarlinkStatus,
          verifiedWifi: plane.verified_wifi,
          error: errorMessage,
        });

        // Return null to allow batch processing to continue
        return null;
      }
    },
    { tail_number: plane.tail_number }
  );
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
export function startFleetDiscovery(mode: "discovery" | "maintenance" = "maintenance"): JobHandle {
  const intervalMs = mode === "discovery" ? DISCOVERY_INTERVAL_MS : MAINTENANCE_INTERVAL_MS;

  let runCount = 0;
  let lastHeartbeat = Date.now();
  const totalStats = { checked: 0, starlink: 0, notStarlink: 0, errors: 0, noFlights: 0 };

  const runVerification = async () => {
    runCount++;

    try {
      await withSpan(
        "fleet_discovery.run",
        async (span) => {
          span.setTag("job.type", "background");
          span.setTag("mode", mode);

          const stats = await runDiscoveryBatch(1);

          // Accumulate stats
          totalStats.checked += stats.checked;
          totalStats.starlink += stats.starlink;
          totalStats.notStarlink += stats.notStarlink;
          totalStats.errors += stats.errors;
          totalStats.noFlights += stats.noFlights;

          span.setTag("checked", stats.checked);
          span.setTag("starlink", stats.starlink);
          span.setTag("errors", stats.errors);

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
              const fleetStats = getFleetDiscoveryStats(db, "UA");
              info(
                `Heartbeat: ${runCount} runs, Total: ${fleetStats.total_fleet} fleet, ` +
                  `${fleetStats.verified_starlink} Starlink, ${fleetStats.verified_non_starlink} non-Starlink, ` +
                  `${fleetStats.pending_verification} pending`
              );

              emitFleetSnapshot(db);

              lastHeartbeat = now;
            } finally {
              db.close();
            }
          }
        },
        { "job.type": "background", mode }
      );
    } catch (err) {
      logError("Discovery batch failed", err);
    }
  };

  // A never-settling vendor call must not hold the loop forever — the
  // runner's stuck-run escape abandons it past the deadline.
  const handle = startJob({
    name: "fleet_discovery",
    intervalMs,
    initialDelayMs: 10 * 1000,
    run: runVerification,
  });

  info(`Fleet discovery started in ${mode} mode (every ${intervalMs / 1000}s)`);
  return handle;
}

/**
 * Verify a specific tail number manually
 */
async function verifySpecificTail(tailNumber: string): Promise<void> {
  const db = initializeDatabase();

  try {
    console.log(`\nVerifying ${tailNumber}...\n`);

    // Get flights from FR24
    const flightData = await getUpcomingFlightsForPlane(tailNumber);

    if (!flightData) {
      console.log(`No upcoming flights found for ${tailNumber}`);
      db.close();
      return;
    }

    const { forVerification, allFlights } = flightData;
    console.log(`Found ${allFlights.length} upcoming flights`);
    console.log(
      `Checking via UA${forVerification.flightNumber} ${forVerification.origin}-${forVerification.destination} on ${forVerification.date}\n`
    );

    // Check Starlink status
    const result = await checkStarlinkStatusSubprocess(
      forVerification.flightNumber,
      forVerification.date,
      forVerification.origin,
      forVerification.destination
    );

    console.log("=== Result ===");
    console.log(`Has Starlink: ${result.hasStarlink}`);
    console.log(`WiFi Provider: ${result.wifiProvider || "unknown"}`);
    console.log(`Aircraft Type: ${result.aircraftType || "unknown"}`);
    if (result.error) console.log(`Error: ${result.error}`);

    // If Starlink found, add to database
    if (result.hasStarlink && result.wifiProvider === "Starlink") {
      // Check if already in starlink_planes
      const existing = db
        .query("SELECT id FROM starlink_planes WHERE TailNumber = ?")
        .get(tailNumber);

      if (existing) {
        console.log(`\n${tailNumber} already in database, updating flights...`);
        updateFlights(db, tailNumber, allFlights);
      } else {
        console.log(`\nAdding ${tailNumber} to database with ${allFlights.length} flights...`);
        addDiscoveredStarlinkPlane(
          db,
          tailNumber,
          result.aircraftType || null,
          "Starlink",
          null,
          "express",
          { airline: "UA", evidence: "observed" }
        );
        updateFlights(db, tailNumber, allFlights);
      }
      console.log("Done!");
    } else {
      console.log(`\n${tailNumber} does not have Starlink, not adding to database.`);
    }
  } finally {
    db.close();
  }
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a === "--discovery" || a === "--maintenance") || "--maintenance";
  const batch = args.find((a) => a.startsWith("--batch="));
  const force = args.includes("--force");
  let batchSize = batch ? Number.parseInt(batch.split("=")[1], 10) : 0;
  if (batchSize > 20 && !force) {
    console.warn(`--batch=${batchSize} exceeds cap of 20; clamping. Use --force to override.`);
    batchSize = 20;
  }
  const tailArg = args.find((a) => a.startsWith("--tail="));
  const tailNumber = tailArg?.split("=")[1];
  const stats = args.includes("--stats");

  if (tailNumber) {
    // Verify a specific tail
    verifySpecificTail(tailNumber).catch((err) => {
      console.error("Verification failed:", err);
      process.exit(1);
    });
  } else if (stats) {
    // Just show stats
    const db = initializeDatabase();
    const fleetStats = getFleetDiscoveryStats(db, "UA");
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
