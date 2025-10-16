import "dotenv/config";
import {
  getStarlinkPlanes,
  initializeDatabase,
  needsFlightCheck,
  updateFlights,
  updateLastFlightCheck,
} from "../database/database";
import type { Aircraft } from "../types";
import { FlightAwareAPI } from "./flightaware-api";

async function updateFlightsForTailNumber(
  api: FlightAwareAPI,
  tailNumber: string
): Promise<boolean> {
  let success = false;
  const db = initializeDatabase();

  try {
    console.log(`Fetching upcoming flights for ${tailNumber}`);
    const flights = await api.getUpcomingFlights(tailNumber);

    if (flights.length === 0) {
      console.log(`No upcoming flights found for ${tailNumber}`);
    } else {
      console.log(`Found ${flights.length} upcoming flights for ${tailNumber}`);
    }

    updateFlights(db, tailNumber, flights);
    updateLastFlightCheck(db, tailNumber, true);

    console.log(`Successfully updated ${flights.length} upcoming flights for ${tailNumber}`);
    success = true;
  } catch (error) {
    console.error(`Failed to update flights for ${tailNumber}:`, error);

    try {
      updateLastFlightCheck(db, tailNumber, false);
    } catch (updateError) {
      console.error(`Failed to update last check status for ${tailNumber}:`, updateError);
    }
  } finally {
    db.close();
  }

  return success;
}

async function updateFlightsIfNeeded(
  api: FlightAwareAPI,
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

  console.log(`Skipping ${tailNumber} - checked recently`);
  return { updated: false, success: true };
}

function createJitteredDelay(baseMs: number, jitterMs = 500): number {
  return baseMs + Math.random() * jitterMs;
}

// Circuit breaker to prevent API hammering during outages
let consecutiveApiFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_RESET_TIME = 30 * 60 * 1000; // 30 minutes
let circuitBreakerOpenedAt: number | null = null;

async function processPlanesInBatches(api: FlightAwareAPI, planes: Aircraft[], batchSize = 3) {
  let updatedCount = 0;
  let apiCallCount = 0;

  if (circuitBreakerOpenedAt) {
    const timeSinceOpened = Date.now() - circuitBreakerOpenedAt;
    if (timeSinceOpened < CIRCUIT_BREAKER_RESET_TIME) {
      console.log(
        `Circuit breaker is open. Will retry in ${Math.round((CIRCUIT_BREAKER_RESET_TIME - timeSinceOpened) / 1000)}s`
      );
      return { updatedCount: 0, apiCallCount: 0 };
    }
    console.log("Circuit breaker reset, retrying API calls...");
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

  console.log(
    `${planesToUpdate.length} aircraft need flight updates out of ${planes.length} total`
  );

  if (planesToUpdate.length === 0) {
    console.log("No aircraft need flight updates at this time");
    return { updatedCount: 0, apiCallCount: 0 };
  }

  for (let i = 0; i < planesToUpdate.length; i += batchSize) {
    const batch = planesToUpdate.slice(i, i + batchSize);

    const batchPromises = batch.map(async (plane, index) => {
      try {
        // Stagger requests: 1-2s, 3-4s, 5-6s per batch item
        const staggerDelay = createJitteredDelay(1000 + index * 2000, 1000);
        await new Promise((resolve) => setTimeout(resolve, staggerDelay));

        const result = await updateFlightsIfNeeded(api, plane.TailNumber);

        if (result.updated) {
          if (result.success) {
            consecutiveApiFailures = 0;
          } else {
            consecutiveApiFailures++;
            if (consecutiveApiFailures >= MAX_CONSECUTIVE_FAILURES) {
              circuitBreakerOpenedAt = Date.now();
              console.error(
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
      } catch (error) {
        console.error(`Error processing ${plane.TailNumber}:`, error);
        consecutiveApiFailures++;
        if (consecutiveApiFailures >= MAX_CONSECUTIVE_FAILURES) {
          circuitBreakerOpenedAt = Date.now();
          console.error(
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
      const batchDelay = createJitteredDelay(5000, 2000);
      console.log(
        `Batch completed, waiting ${Math.round(batchDelay / 1000)}s before next batch...`
      );
      await new Promise((resolve) => setTimeout(resolve, batchDelay));
    }
  }

  return { updatedCount, apiCallCount };
}

export async function updateAllFlights() {
  const apiKey = process.env.AEROAPI_KEY;
  if (!apiKey) {
    console.error("AEROAPI_KEY environment variable not set");
    return;
  }

  const db = initializeDatabase();
  const planes = getStarlinkPlanes(db);
  db.close();

  const api = new FlightAwareAPI(apiKey);

  console.log(`Checking flight updates for ${planes.length} Starlink aircraft...`);

  const { updatedCount, apiCallCount } = await processPlanesInBatches(api, planes, 3);

  console.log(
    `Flight updates completed: ${updatedCount} aircraft updated, ${apiCallCount} API calls made`
  );
}

/**
 * Check flights for newly discovered planes (those with last_flight_check = 0)
 * This runs immediately after scraping to provide faster updates for new aircraft
 */
export async function checkNewPlanes() {
  const apiKey = process.env.AEROAPI_KEY;
  if (!apiKey) {
    console.log("AEROAPI_KEY not set, skipping new plane flight checks");
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

  console.log(`🔍 Found ${newPlanes.length} new plane(s), checking flights immediately...`);

  const api = new FlightAwareAPI(apiKey);
  const { updatedCount, apiCallCount } = await processPlanesInBatches(api, newPlanes, 3);

  console.log(
    `✅ New plane flight check completed: ${updatedCount} planes updated, ${apiCallCount} API calls made`
  );
}

export function startFlightUpdater() {
  const safeUpdateAllFlights = async () => {
    try {
      await updateAllFlights();
    } catch (error) {
      console.error("Unhandled error in flight updater:", error);
    }
  };

  safeUpdateAllFlights();
  setInterval(safeUpdateAllFlights, 8 * 60 * 60 * 1000);
}

// Export individual functions for manual use
export { updateFlightsForTailNumber, updateFlightsIfNeeded };
