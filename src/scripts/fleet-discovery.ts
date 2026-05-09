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
  computeWifiConsensus,
  getFleetDiscoveryStats,
  getNextPlanesToVerify,
  getShipToTailMap,
  initializeDatabase,
  logVerification,
  updateFleetVerificationResult,
  updateFlights,
  updateVerifiedWifi,
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
import { normalizeFlightNumber } from "../utils/constants";
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

/**
 * Extract bare flight digits for United.com URL. Must strip carrier prefix
 * FIRST: G74460 → 4460, not 74460 (which 404s). normalizeFlightNumber knows
 * the 2-3 char prefixes (G7, OO, SKW, GJS, ...) so use it, then drop UA.
 */
function extractFlightNumber(flightNumber: string): string {
  const normalized = normalizeFlightNumber(flightNumber);
  return normalized.replace(/^UA/, "");
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

    const firstFlight = flights[0];
    const departureDate = new Date(firstFlight.departure_time * 1000).toISOString().split("T")[0];

    return {
      forVerification: {
        flightNumber: extractFlightNumber(firstFlight.flight_number),
        date: departureDate,
        origin: icaoToIata(firstFlight.departure_airport),
        destination: icaoToIata(firstFlight.arrival_airport),
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

/**
 * Verify a single plane's Starlink status
 */
async function verifyPlane(
  db: Database,
  plane: FleetAircraft
): Promise<StarlinkCheckResult | null> {
  const aircraftTypeTag = normalizeAircraftType(plane.aircraft_type);
  const fleetTag = normalizeFleet(plane.fleet);

  return withSpan(
    "fleet_discovery.verify_plane",
    async (span) => {
      span.setTag("tail_number", plane.tail_number);
      span.setTag("aircraft_type", aircraftTypeTag);
      span.setTag("fleet", fleetTag);

      // Get upcoming flights for this plane
      const flightData = await getUpcomingFlightsForPlane(plane.tail_number);

      if (!flightData) {
        const attempts = plane.check_attempts ?? 0;
        if (attempts >= 20) {
          warn(
            `${plane.tail_number}: ${attempts} consecutive no-flights — likely grounded, manual review needed`
          );
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
        const result = await checkStarlinkStatusSubprocess(
          forVerification.flightNumber,
          forVerification.date,
          forVerification.origin,
          forVerification.destination
        );

        // Aircraft-swap detection: United.com returns the actual tail on the flight.
        // If it doesn't match, the result is for a different plane — don't attribute it.
        const actualTail = result.tailNumber;

        // Mainline pages show ship numbers. Resolve via lookup.
        let resolvedTail = actualTail;
        if (!resolvedTail && result.shipNumber) {
          const shipMap = getShipToTailMap(db);
          resolvedTail = shipMap.get(result.shipNumber) ?? null;
          if (resolvedTail) {
            info(`Resolved ship #${result.shipNumber} → ${resolvedTail}`);
          }
        }

        const tailMismatch =
          resolvedTail && resolvedTail.toUpperCase() !== plane.tail_number.toUpperCase();
        const tailUnknown = !resolvedTail;
        const untrustedNonStarlink =
          tailUnknown && result.wifiProvider && result.wifiProvider !== "Starlink";

        if (tailMismatch) {
          warn(
            `Aircraft swap: expected ${plane.tail_number} but flight has ${resolvedTail} — skipping`
          );
        }

        logVerification(db, {
          tail_number: plane.tail_number,
          source: "united",
          has_starlink: tailMismatch || untrustedNonStarlink ? null : result.hasStarlink,
          wifi_provider: tailMismatch || untrustedNonStarlink ? null : result.wifiProvider,
          aircraft_type: result.aircraftType || plane.aircraft_type,
          flight_number: `UA${forVerification.flightNumber}`,
          tail_confirmed: tailMismatch ? 0 : tailUnknown ? null : 1,
          error: tailMismatch
            ? `Aircraft mismatch: flight has ${resolvedTail}`
            : untrustedNonStarlink
              ? "Tail not extracted — cannot attribute non-Starlink result"
              : result.error || null,
        });

        if (tailMismatch && resolvedTail && result.wifiProvider) {
          logVerification(db, {
            tail_number: resolvedTail,
            source: "united",
            has_starlink: result.hasStarlink,
            wifi_provider: result.wifiProvider,
            aircraft_type: result.aircraftType || null,
            flight_number: `UA${forVerification.flightNumber}`,
            tail_confirmed: 1,
            error: null,
          });
          // Run consensus for the swap-captured tail so it settles without
          // waiting for a direct check that needsVerification may skip (the
          // log entry above makes the tail look recently-checked).
          const swapConsensus = computeWifiConsensus(db, resolvedTail);
          if (swapConsensus.verdict !== null) {
            updateVerifiedWifi(db, resolvedTail, swapConsensus.verdict);
            info(
              `${resolvedTail} (swap-captured): verified_wifi → ${swapConsensus.verdict} (${swapConsensus.reason})`
            );
          }
        }

        // A result is trustworthy only if: no error, got a wifi provider, tail
        // matches, and we could actually confirm attribution when non-Starlink.
        const canTrustResult =
          !result.error && result.wifiProvider && !tailMismatch && !untrustedNonStarlink;

        const wifiProviderTag = normalizeWifiProvider(result.wifiProvider);
        const checkTags = {
          fleet: fleetTag,
          aircraft_type: aircraftTypeTag,
          wifi_provider: wifiProviderTag,
          source: "united",
          airline: normalizeAirlineTag("UA"),
        };

        // Consensus includes the just-logged observation. The status is driven
        // by the 30-day consensus, not this single check, so one flaky scrape
        // can't bounce a plane between confirmed and negative.
        const consensus = canTrustResult ? computeWifiConsensus(db, plane.tail_number) : null;

        const prevStatus = plane.starlink_status as StarlinkStatus;
        let starlinkStatus: StarlinkStatus;
        let needsMoreObs = false;
        if (!canTrustResult) {
          starlinkStatus = prevStatus;
          const resultTag = tailMismatch
            ? "aircraft_mismatch"
            : untrustedNonStarlink
              ? "tail_unknown"
              : "error";
          span.setTag("result", resultTag);
          metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: resultTag, ...checkTags });
        } else {
          metrics.increment(COUNTERS.VERIFICATION_CHECK, { result: "success", ...checkTags });
          if (result.hasStarlink) {
            span.setTag("result", "starlink");
            metrics.increment(COUNTERS.PLANES_STARLINK_DETECTED, {
              fleet: fleetTag,
              aircraft_type: aircraftTypeTag,
            });
          } else {
            span.setTag("result", "not_starlink");
          }

          if (consensus!.verdict === "Starlink") {
            starlinkStatus = "confirmed";
          } else if (consensus!.verdict !== null) {
            starlinkStatus = "negative";
          } else {
            starlinkStatus = prevStatus;
            needsMoreObs = true;
          }
        }

        span.setTag("wifi_provider", wifiProviderTag);

        const statusChanged = starlinkStatus !== prevStatus;
        updateFleetVerificationResult(db, plane.tail_number, {
          starlinkStatus,
          verifiedWifi: consensus ? consensus.verdict : plane.verified_wifi,
          error: tailMismatch
            ? `Aircraft mismatch: flight has ${resolvedTail}`
            : untrustedNonStarlink
              ? "Tail not extracted — cannot attribute non-Starlink result"
              : result.error || undefined,
          needsMoreObs,
        });

        // starlink_planes.verified_wifi tracks the same consensus verdict so
        // the website filter (IS NULL OR = 'Starlink') stays in sync.
        if (consensus) {
          updateVerifiedWifi(db, plane.tail_number, consensus.verdict);
        }

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
            plane.fleet === "mainline" ? "mainline" : "express"
          );
          updateFlights(db, plane.tail_number, allFlights);
          info(
            `DISCOVERY: ${plane.tail_number} has Starlink! (stored ${allFlights.length} flights)`
          );
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
        span.setTag("error", true);
        metrics.increment(COUNTERS.VERIFICATION_CHECK, {
          result: "error",
          fleet: fleetTag,
          aircraft_type: aircraftTypeTag,
          wifi_provider: "unknown",
          source: "united",
          airline: normalizeAirlineTag("UA"),
        });

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
          "express"
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
