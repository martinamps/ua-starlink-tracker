import "dotenv/config";
import {
  getStarlinkPlanes,
  initializeDatabase,
  needsFlightCheck,
  updateFlights,
  updateLastFlightCheck,
} from "../database/database";
import type { Aircraft, Flight } from "../types";
import { FLIGHT_DATA_SOURCE } from "../utils/constants";
import { error, info } from "../utils/logger";
import { FlightAwareAPI } from "./flightaware-api";
import { FlightRadar24API } from "./flightradar24-api";

// Common interface for flight APIs
type FlightUpdate = Pick<
  Flight,
  "flight_number" | "departure_airport" | "arrival_airport" | "departure_time" | "arrival_time"
>;

interface FlightAPI {
  getUpcomingFlights(tailNumber: string): Promise<FlightUpdate[]>;
}

/**
 * Create the appropriate flight API based on configuration
 */
function createFlightAPI(): FlightAPI | null {
  const source = FLIGHT_DATA_SOURCE;

  if (source === "flightradar24") {
    info("Using FlightRadar24 API (free)");
    return new FlightRadar24API();
  }

  if (source === "flightaware") {
    const apiKey = process.env.AEROAPI_KEY;
    if (!apiKey) {
      error("AEROAPI_KEY environment variable not set for FlightAware");
      return null;
    }
    info("Using FlightAware API (requires API key)");
    return new FlightAwareAPI(apiKey);
  }

  error(`Unknown flight data source: ${source}`);
  return null;
}

async function updateFlightsForTailNumber(api: FlightAPI, tailNumber: string): Promise<boolean> {
  let success = false;
  const db = initializeDatabase();

  try {
    info(`Fetching upcoming flights for ${tailNumber}`);
    const flights = await api.getUpcomingFlights(tailNumber);

    if (flights.length === 0) {
      info(`No upcoming flights found for ${tailNumber}`);
    } else {
      info(`Found ${flights.length} upcoming flights for ${tailNumber}`);
    }

    updateFlights(db, tailNumber, flights);
    updateLastFlightCheck(db, tailNumber, true);

    info(`Successfully updated ${flights.length} upcoming flights for ${tailNumber}`);
    success = true;
  } catch (err) {
    error(`Failed to update flights for ${tailNumber}`, err);

    try {
      updateLastFlightCheck(db, tailNumber, false);
    } catch (updateError) {
      error(`Failed to update last check status for ${tailNumber}`, updateError);
    }
  } finally {
    db.close();
  }

  return success;
}

async function updateFlightsIfNeeded(
  api: FlightAPI,
  tailNumber: string,
  hoursThreshold = 6
): Promise<{ updated: boolean; success: boolean }> {
  const db = initializeDatabase();
  const needsUpdate = needsFlightCheck(db, tailNumber, hoursThreshold);
  db.close();

  if (needsUpdate) {
    const success = await updateFlightsForTailNumber(api, tailNumber);
    return { updated: true, success };
  }

  return { updated: false, success: true };
}

function createJitteredDelay(baseMs: number, jitterMs = 500): number {
  return baseMs + Math.random() * jitterMs;
}

let consecutiveApiFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_RESET_TIME = 30 * 60 * 1000; // 30 minutes
let circuitBreakerOpenedAt: number | null = null;

async function processPlanesInBatches(api: FlightAPI, planes: Aircraft[], batchSize = 3) {
  let updatedCount = 0;
  let apiCallCount = 0;

  if (circuitBreakerOpenedAt) {
    const timeSinceOpened = Date.now() - circuitBreakerOpenedAt;
    if (timeSinceOpened < CIRCUIT_BREAKER_RESET_TIME) {
      info(
        `Circuit breaker is open. Will retry in ${Math.round((CIRCUIT_BREAKER_RESET_TIME - timeSinceOpened) / 1000)}s`
      );
      return { updatedCount: 0, apiCallCount: 0 };
    }
    info("Circuit breaker reset, retrying API calls...");
    circuitBreakerOpenedAt = null;
    consecutiveApiFailures = 0;
  }

  const planesToUpdate: Aircraft[] = [];
  const db = initializeDatabase();

  try {
    for (const plane of planes) {
      if (!plane.TailNumber) continue;
      if (needsFlightCheck(db, plane.TailNumber)) {
        planesToUpdate.push(plane);
      }
    }
  } finally {
    db.close();
  }

  info(`${planesToUpdate.length} aircraft need flight updates out of ${planes.length} total`);

  if (planesToUpdate.length === 0) {
    info("No aircraft need flight updates at this time");
    return { updatedCount: 0, apiCallCount: 0 };
  }

  for (let i = 0; i < planesToUpdate.length; i += batchSize) {
    const batch = planesToUpdate.slice(i, i + batchSize);

    const batchPromises = batch.map(async (plane, index) => {
      try {
        const staggerDelay = createJitteredDelay(2000 + index * 2000, 500);
        await new Promise((resolve) => setTimeout(resolve, staggerDelay));

        const result = await updateFlightsIfNeeded(api, plane.TailNumber);

        if (result.updated) {
          if (result.success) {
            consecutiveApiFailures = 0;
          } else {
            consecutiveApiFailures++;
            if (consecutiveApiFailures >= MAX_CONSECUTIVE_FAILURES) {
              circuitBreakerOpenedAt = Date.now();
              error(
                `Circuit breaker opened after ${MAX_CONSECUTIVE_FAILURES} consecutive API failures`
              );
            }
          }
        }

        return {
          updated: result.updated,
          apiCall: result.updated,
          success: result.success,
          tailNumber: plane.TailNumber,
        };
      } catch (err) {
        error(`Error processing ${plane.TailNumber}`, err);
        consecutiveApiFailures++;
        if (consecutiveApiFailures >= MAX_CONSECUTIVE_FAILURES) {
          circuitBreakerOpenedAt = Date.now();
          error(
            `Circuit breaker opened after ${MAX_CONSECUTIVE_FAILURES} consecutive API failures`
          );
        }
        return {
          updated: false,
          apiCall: false,
          success: false,
          tailNumber: plane.TailNumber,
          error,
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);

    for (const result of batchResults) {
      if (result.updated) updatedCount++;
      if (result.apiCall) apiCallCount++;
    }

    if (i + batchSize < planesToUpdate.length) {
      const batchDelay = createJitteredDelay(5000, 3000);
      info(`Batch completed, waiting ${Math.round(batchDelay / 1000)}s before next batch...`);
      await new Promise((resolve) => setTimeout(resolve, batchDelay));
    }
  }

  return { updatedCount, apiCallCount };
}

export async function updateAllFlights() {
  const api = createFlightAPI();
  if (!api) {
    error("Failed to create flight API");
    return;
  }

  const db = initializeDatabase();
  const planes = getStarlinkPlanes(db);
  db.close();

  info(`Checking flight updates for ${planes.length} Starlink aircraft...`);
  info(`Data source: ${FLIGHT_DATA_SOURCE}`);

  const { updatedCount, apiCallCount } = await processPlanesInBatches(api, planes, 5);

  info(
    `Flight updates completed: ${updatedCount} aircraft updated, ${apiCallCount} API calls made`
  );
}

/**
 * Check flights for newly discovered planes (those with last_flight_check = 0)
 * This runs immediately after scraping to provide faster updates for new aircraft
 */
export async function checkNewPlanes() {
  const api = createFlightAPI();
  if (!api) {
    info("Flight API not available, skipping new plane flight checks");
    return;
  }

  const db = initializeDatabase();

  // Get planes that have never been checked (last_flight_check = 0)
  const newPlanes = db
    .query(
      `SELECT * FROM starlink_planes
       WHERE last_flight_check = 0 OR last_flight_check IS NULL`
    )
    .all() as Aircraft[];

  db.close();

  if (newPlanes.length === 0) {
    return;
  }

  info(`Found ${newPlanes.length} new plane(s), checking flights immediately...`);

  const { updatedCount, apiCallCount } = await processPlanesInBatches(api, newPlanes, 5);

  info(
    `New plane flight check completed: ${updatedCount} planes updated, ${apiCallCount} API calls made`
  );
}

export function startFlightUpdater() {
  const safeUpdateAllFlights = async () => {
    try {
      await updateAllFlights();
    } catch (err) {
      error("Unhandled error in flight updater", err);
    }
  };

  safeUpdateAllFlights();
  setInterval(safeUpdateAllFlights, 8 * 60 * 60 * 1000);
}

// Export individual functions for manual use
export { updateFlightsForTailNumber, updateFlightsIfNeeded };
