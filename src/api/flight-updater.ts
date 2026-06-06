import "dotenv/config";
import {
  getAllStarlinkPlanes,
  getNextFleetTailNeedingFlights,
  getStarlinkTailsByCheckAge,
  initializeDatabase,
  needsFlightCheck,
  updateFlights,
  updateLastFlightCheck,
} from "../database/database";
import { withSpan } from "../observability";
import type { Aircraft, Flight } from "../types";
import { FLIGHT_DATA_SOURCE } from "../utils/constants";
import { type JobHandle, type JobRunContext, startJob } from "../utils/job-runner";
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

// Distinguishes vendor outages (Cloudflare blocks, timeouts) from app bugs in DD.
function classifyUpdateError(err: unknown): string {
  const msg = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).toLowerCase();
  if (/cloudflare|403|blocked|captcha|rate.?limit|429/.test(msg)) return "vendor_block";
  if (/timeout|timed.?out|aborted|econnreset|etimedout|socket/.test(msg)) return "timeout";
  if (/json|parse|unexpected.?token|invalid.?response/.test(msg)) return "parse_error";
  return "unknown";
}

async function updateFlightsForTailNumber(api: FlightAPI, tailNumber: string): Promise<boolean> {
  return withSpan(
    "flight_updater.update_tail",
    async (span) => {
      span.setTag("tail_number", tailNumber);
      let success = false;
      const db = initializeDatabase();

      try {
        info(`Fetching upcoming flights for ${tailNumber}`);
        const flights = await api.getUpcomingFlights(tailNumber);

        span.setTag("flights.count", flights.length);

        if (flights.length === 0) {
          info(
            `No upcoming flights found for ${tailNumber}; preserving cache and engaging backoff`
          );
          updateLastFlightCheck(db, tailNumber, false);
        } else {
          info(`Found ${flights.length} upcoming flights for ${tailNumber}`);
          updateFlights(db, tailNumber, flights);
          updateLastFlightCheck(db, tailNumber, true);
          info(`Successfully updated ${flights.length} upcoming flights for ${tailNumber}`);
          success = true;
        }
      } catch (err) {
        error(`Failed to update flights for ${tailNumber}`, err);
        span.setTag("error", true);
        span.setTag("error.type", classifyUpdateError(err));

        try {
          updateLastFlightCheck(db, tailNumber, false);
        } catch (updateError) {
          error(`Failed to update last check status for ${tailNumber}`, updateError);
        }
      } finally {
        db.close();
      }

      return success;
    },
    { tail_number: tailNumber }
  );
}

async function updateFlightsIfNeeded(
  api: FlightAPI,
  tailNumber: string
): Promise<{ updated: boolean; success: boolean }> {
  const db = initializeDatabase();
  const needsUpdate = needsFlightCheck(db, tailNumber);
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

// Wall-clock circuit breaker (opens for 30 min) shared by the trickle loop
// and the manual bulk path — distinct from job-runner's tick-count
// createOutageBreaker, which has different reset semantics.
let consecutiveApiFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_RESET_TIME = 30 * 60 * 1000; // 30 minutes
let circuitBreakerOpenedAt: number | null = null;

// Per-tail backoff for the alaska-json fleet fallback so a stored/maintenance
// tail with no FR24 flights doesn't pin the queue.
const FLEET_TAIL_ATTEMPT_TTL_MS = 60 * 60 * 1000;
const fleetTailAttempts = new Map<string, number>();
function recentlyAttemptedFleetTails(): string[] {
  const cutoff = Date.now() - FLEET_TAIL_ATTEMPT_TTL_MS;
  for (const [t, at] of fleetTailAttempts) if (at < cutoff) fleetTailAttempts.delete(t);
  return [...fleetTailAttempts.keys()];
}
function markFleetTailAttempted(tail: string) {
  fleetTailAttempts.set(tail, Date.now());
}

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
  // Include mismatched planes so they keep getting fresh flight data for re-verification
  const planes = getAllStarlinkPlanes(db);
  db.close();

  info(`Checking flight updates for ${planes.length} Starlink aircraft...`);
  info(`Data source: ${FLIGHT_DATA_SOURCE}`);

  const { updatedCount, apiCallCount } = await processPlanesInBatches(api, planes, 5);

  info(
    `Flight updates completed: ${updatedCount} aircraft updated, ${apiCallCount} API calls made`
  );
}

/**
 * Report newly discovered planes (last_flight_check = 0) waiting in the
 * trickle queue. Enqueue-only: rows insert at last_flight_check=0, which
 * sorts first in getStarlinkTailsByCheckAge and passes needsFlightCheck
 * unconditionally, so the 22.5s trickle picks them up on its next ticks.
 * Fetching here used to race the trickle on the identical tails (duplicate
 * simultaneous FR24 calls + diluted circuit breaker).
 */
export async function checkNewPlanes(db: ReturnType<typeof initializeDatabase>): Promise<number> {
  return withSpan(
    "flight_updater.check_new_planes",
    async (span) => {
      span.setTag("job.type", "background");

      const row = db
        .query(
          `SELECT COUNT(*) AS cnt FROM starlink_planes
           WHERE last_flight_check = 0 OR last_flight_check IS NULL`
        )
        .get() as { cnt: number };
      const enqueued = row.cnt;

      span.setTag("new_planes_count", enqueued);

      if (enqueued > 0) {
        info(`${enqueued} new plane(s) queued for the trickle updater (last_flight_check=0)`);
      }
      return enqueued;
    },
    { "job.type": "background" }
  );
}

/**
 * Trickle-based flight updater
 * Instead of bulk updates every 8 hours, continuously updates 1 plane at a time
 * Much more polite to APIs and avoids rate limiting
 */
export function startFlightUpdater(): JobHandle | undefined {
  const INTERVAL_MS = 22.5 * 1000;
  const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

  const api = createFlightAPI();
  if (!api) {
    error("Failed to create flight API, flight updater disabled");
    return undefined;
  }

  let lastHeartbeat = Date.now();
  let totalUpdates = 0;
  let totalErrors = 0;

  const runSingleUpdate = async (ctx: JobRunContext) => {
    // Check circuit breaker
    if (circuitBreakerOpenedAt) {
      const timeSinceOpened = Date.now() - circuitBreakerOpenedAt;
      if (timeSinceOpened < CIRCUIT_BREAKER_RESET_TIME) {
        return; // Silently skip while circuit breaker is open
      }
      info("Circuit breaker reset, resuming flight updates...");
      circuitBreakerOpenedAt = null;
      consecutiveApiFailures = 0;
    }

    try {
      await withSpan(
        "flight_updater.run",
        async (span) => {
          span.setTag("job.type", "background");

          const db = initializeDatabase();

          // Stalest-first so no airline starves behind the UA/AS DateFound-ordered block.
          const tails = getStarlinkTailsByCheckAge(db);
          let tailToUpdate: string | null = null;

          for (const tail of tails) {
            if (needsFlightCheck(db, tail)) {
              tailToUpdate = tail;
              break;
            }
          }

          // alaska-json airlines need upcoming_flights for verification but their unknowns
          // aren't in starlink_planes — pick one when the primary queue is empty.
          if (!tailToUpdate) {
            const recent = recentlyAttemptedFleetTails();
            tailToUpdate = getNextFleetTailNeedingFlights(db, recent);
            if (tailToUpdate) markFleetTailAttempted(tailToUpdate);
          }

          db.close();

          if (!tailToUpdate) {
            // No planes need updates right now
            return;
          }

          span.setTag("tail_number", tailToUpdate);

          // Update this plane
          const success = await updateFlightsForTailNumber(api, tailToUpdate);

          // Abandoned (stuck-escaped) runs settling late must not feed the
          // breaker/counters the successor reads — stacked orphans settling in
          // a burst could open the breaker against a healthy API.
          if (!ctx.isCurrent()) {
            span.setTag("result", "abandoned");
            return;
          }

          if (success) {
            consecutiveApiFailures = 0;
            totalUpdates++;
            span.setTag("result", "success");
          } else {
            consecutiveApiFailures++;
            totalErrors++;
            span.setTag("result", "failure");
            if (consecutiveApiFailures >= MAX_CONSECUTIVE_FAILURES) {
              circuitBreakerOpenedAt = Date.now();
              error(
                `Circuit breaker opened after ${MAX_CONSECUTIVE_FAILURES} consecutive API failures`
              );
            }
          }

          // Heartbeat logging
          const now = Date.now();
          if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
            info(`Flight updater heartbeat: ${totalUpdates} updates, ${totalErrors} errors`);
            lastHeartbeat = now;
          }
        },
        { "job.type": "background" }
      );
    } catch (err) {
      error("Error in flight updater", err);
      if (ctx.isCurrent()) {
        consecutiveApiFailures++;
        totalErrors++;
      }
    }
  };

  // A wedged vendor call held the in-progress flag for 19h on 2026-05-20 —
  // the runner's stuck-run escape is load-bearing here.
  const handle = startJob({
    name: "flight_updater",
    intervalMs: INTERVAL_MS,
    initialDelayMs: 15 * 1000,
    run: runSingleUpdate,
  });

  info(`Flight updater started (trickle mode, every ${INTERVAL_MS / 1000}s)`);
  return handle;
}

// Export individual functions for manual use
export { updateFlightsForTailNumber, updateFlightsIfNeeded };
