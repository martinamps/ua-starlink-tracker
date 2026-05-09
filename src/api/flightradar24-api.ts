/**
 * FlightRadar24 API Client
 * Free API for fetching flight data by aircraft registration
 */

import { COUNTERS, metrics } from "../observability";
import type { Flight } from "../types";
import { error, info, warn } from "../utils/logger";
import { fr24Fetch } from "./fr24-browser-transport";

type FlightUpdate = Pick<
  Flight,
  "flight_number" | "departure_airport" | "arrival_airport" | "departure_time" | "arrival_time"
>;

interface FR24Flight {
  identification: {
    id: string | null;
    row: number;
    number: {
      default: string;
      alternative: string | null;
    };
    callsign: string | null;
  };
  status: {
    live: boolean;
    text: string;
    icon: string;
    generic: {
      status: {
        text: string;
        type: string;
        color: string;
      };
      eventTime: {
        utc: number;
        local: number;
      };
    };
  };
  aircraft: {
    model: {
      code: string;
      text: string;
    };
    registration: string;
  };
  airport: {
    origin: {
      code: {
        iata: string;
        icao: string;
      };
    } | null;
    destination: {
      code: {
        iata: string;
        icao: string;
      };
    } | null;
  };
  time: {
    scheduled: {
      departure: number | null;
      arrival: number | null;
    };
    real: {
      departure: number | null;
      arrival: number | null;
    };
    estimated: {
      departure: number | null;
      arrival: number | null;
    };
  };
}

interface FR24Response {
  result: {
    response: {
      data: FR24Flight[];
    };
  };
}

// Module-scope so ALL FlightRadar24API instances share one rate-limit clock.
// Four instances exist (server, mcp-server, flight-updater, scripts) — per-instance
// state meant 4x the intended request rate.
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000; // 2s between requests to avoid 402 rate limits

export class FlightRadar24API {
  private baseUrl = "https://api.flightradar24.com/common/v1";

  private async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    lastRequestTime = Date.now();
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    requestType = "flights"
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.waitForRateLimit();
        return await operation();
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        const isRateLimit = errorMessage.includes("402") || errorMessage.includes("429");

        if (isRateLimit) {
          metrics.increment(COUNTERS.VENDOR_REQUEST, {
            vendor: "fr24",
            type: requestType,
            status: "rate_limited",
          });
        }

        if (attempt < maxRetries) {
          const baseDelay = isRateLimit
            ? Math.min(120000, 2 ** attempt * 30000)
            : Math.min(30000, 2 ** attempt * 2000);
          const jitter = Math.random() * 1000;
          const delay = baseDelay + jitter;

          warn(
            `FR24 API error: ${errorMessage} - waiting ${Math.round(delay / 1000)}s before retry ${attempt + 1}/${maxRetries}`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Max retries exceeded");
  }

  /**
   * Get upcoming flights for a specific aircraft by registration/tail number
   */
  async getUpcomingFlights(tailNumber: string): Promise<FlightUpdate[]> {
    return this.retryWithBackoff(async () => {
      // FR24 API expects registration without the leading 'N' for some queries,
      // but works fine with the full registration
      const url = `${this.baseUrl}/flight/list.json?query=${tailNumber}&fetchBy=reg&page=1&limit=20`;

      const response = await fr24Fetch(url, 30000);

      if (!response.ok) {
        if (response.status === 404) {
          info(`No flights found for tail number: ${tailNumber}`);
          metrics.increment(COUNTERS.VENDOR_REQUEST, {
            vendor: "fr24",
            type: "flights",
            status: "success",
          });
          return [];
        }
        metrics.increment(COUNTERS.VENDOR_REQUEST, {
          vendor: "fr24",
          type: "flights",
          status: "error",
        });
        throw new Error(`FlightRadar24 API error: ${response.status}`);
      }

      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        vendor: "fr24",
        type: "flights",
        status: "success",
      });
      const data: FR24Response = JSON.parse(response.body);
      const flights = data.result?.response?.data || [];

      if (flights.length === 0) {
        return [];
      }

      const now = Math.floor(Date.now() / 1000);

      return flights
        .filter((flight) => {
          const departureTime =
            flight.time.scheduled.departure || flight.time.estimated.departure || 0;
          // Keep flights that haven't landed yet — including ones currently
          // airborne. Filtering on departure alone evicts in-progress flights
          // when updateFlights() does its DELETE+INSERT, which starves the
          // /fleet live-airborne pulse. Use the LATEST known arrival
          // (scheduled||estimated short-circuits on a past scheduled time
          // for delayed flights).
          const arrivalTime = Math.max(
            flight.time.scheduled.arrival ?? 0,
            flight.time.estimated.arrival ?? 0
          );
          return arrivalTime > now || departureTime > now;
        })
        .map((flight) => {
          // Use callsign (operating code like SKW4783) for FlightAware links, fallback to default
          const flightNumber =
            flight.identification.callsign ||
            flight.identification.number.alternative ||
            flight.identification.number.default ||
            "";

          return {
            flight_number: flightNumber,
            departure_airport:
              flight.airport.origin?.code.iata || flight.airport.origin?.code.icao || "",
            arrival_airport:
              flight.airport.destination?.code.iata || flight.airport.destination?.code.icao || "",
            departure_time: flight.time.scheduled.departure || flight.time.estimated.departure || 0,
            arrival_time: flight.time.scheduled.arrival || flight.time.estimated.arrival || 0,
          };
        })
        .filter((f) => f.departure_airport && f.arrival_airport) // Filter out incomplete flights
        .slice(0, 10); // Limit to 10 upcoming flights per aircraft
    });
  }

  /**
   * Look up what route(s) a flight NUMBER operates around a given date.
   * FR24 returns schedules ~1 week forward. We return all distinct routes
   * in a ±36h window around the target date (or all upcoming if no date).
   */
  async getFlightRoutes(
    flightNumber: string,
    targetDateUnix?: number
  ): Promise<Array<{ origin: string; destination: string; departure_time: number }>> {
    // Best-effort lookup for MCP hints — a failure degrades to "ask the user".
    // No retry wrapper, but still rate-limit + instrument so we stay a good citizen.
    const url = `${this.baseUrl}/flight/list.json?query=${encodeURIComponent(flightNumber)}&fetchBy=flight&page=1&limit=20`;

    await this.waitForRateLimit();

    let response: Awaited<ReturnType<typeof fr24Fetch>>;
    try {
      response = await fr24Fetch(url, 8000);
    } catch {
      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        vendor: "fr24",
        type: "routes",
        status: "error",
      });
      return [];
    }

    if (!response.ok) {
      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        vendor: "fr24",
        type: "routes",
        status: response.status === 402 || response.status === 429 ? "rate_limited" : "error",
      });
      return [];
    }

    const data: FR24Response = JSON.parse(response.body);
    const flights = data.result?.response?.data || [];

    metrics.increment(COUNTERS.VENDOR_REQUEST, {
      vendor: "fr24",
      type: "routes",
      status: flights.length > 0 ? "success" : "empty",
    });

    // Dedupe by (origin, destination), keep the departure closest to target date.
    // Capture duration so callers can show trip time even for mainline routes
    // (which don't appear in our Starlink-plane-only upcoming_flights table).
    type Route = {
      origin: string;
      destination: string;
      departure_time: number;
      duration_sec: number;
    };
    const routes = new Map<string, Route>();

    for (const f of flights) {
      const origin = f.airport.origin?.code.iata;
      const dest = f.airport.destination?.code.iata;
      const depTime = f.time.scheduled.departure || f.time.estimated.departure || 0;
      const arrTime = f.time.scheduled.arrival || f.time.estimated.arrival || 0;
      if (!origin || !dest || depTime === 0) continue;

      if (targetDateUnix && Math.abs(depTime - targetDateUnix) > 36 * 3600) continue;

      const key = `${origin}-${dest}`;
      const existing = routes.get(key);
      if (
        !existing ||
        (targetDateUnix &&
          Math.abs(depTime - targetDateUnix) < Math.abs(existing.departure_time - targetDateUnix))
      ) {
        routes.set(key, {
          origin,
          destination: dest,
          departure_time: depTime,
          duration_sec: arrTime > depTime ? arrTime - depTime : 0,
        });
      }
    }

    return [...routes.values()].sort((a, b) => a.departure_time - b.departure_time);
  }

  /**
   * Get individual flight assignments (tail numbers) for a flight number around
   * a target date. Unlike getFlightRoutes this does NOT dedupe by route — if
   * UA671 flies JAX→DEN then DEN→SBA on the same day, both are returned.
   * Best-effort: returns [] on any failure.
   */
  async getFlightAssignments(
    flightNumber: string,
    targetDateUnix: number
  ): Promise<
    Array<{
      origin: string;
      destination: string;
      departure_time: number;
      arrival_time: number;
      tail_number: string | null;
      aircraft_model: string | null;
    }>
  > {
    const url = `${this.baseUrl}/flight/list.json?query=${encodeURIComponent(flightNumber)}&fetchBy=flight&page=1&limit=25`;

    try {
      return await this.retryWithBackoff(
        async () => {
          const response = await fr24Fetch(url, 8000);

          if (!response.ok) {
            metrics.increment(COUNTERS.VENDOR_REQUEST, {
              vendor: "fr24",
              type: "assignments",
              status: response.status === 402 || response.status === 429 ? "rate_limited" : "error",
            });
            throw new Error(`FR24 assignments error: ${response.status}`);
          }

          metrics.increment(COUNTERS.VENDOR_REQUEST, {
            vendor: "fr24",
            type: "assignments",
            status: "success",
          });

          const data: FR24Response = JSON.parse(response.body);
          const flights = data.result?.response?.data || [];

          const out = [];
          for (const f of flights) {
            const origin = f.airport?.origin?.code?.iata;
            const dest = f.airport?.destination?.code?.iata;
            const depTime = f.time?.scheduled?.departure || f.time?.estimated?.departure || 0;
            const arrTime = f.time?.scheduled?.arrival || f.time?.estimated?.arrival || 0;
            if (!origin || !dest || depTime === 0) continue;
            if (Math.abs(depTime - targetDateUnix) > 24 * 3600) continue;

            out.push({
              origin,
              destination: dest,
              departure_time: depTime,
              arrival_time: arrTime,
              tail_number: f.aircraft?.registration || null,
              aircraft_model: f.aircraft?.model?.text || null,
            });
          }

          return out.sort((a, b) => a.departure_time - b.departure_time);
        },
        3,
        "assignments"
      );
    } catch {
      return [];
    }
  }

  /**
   * Get flight data for multiple aircraft in batch
   * More efficient than calling getUpcomingFlights for each one
   */
  async getFlightsForMultipleAircraft(
    tailNumbers: string[],
    onProgress?: (current: number, total: number, tailNumber: string) => void
  ): Promise<Map<string, FlightUpdate[]>> {
    const results = new Map<string, FlightUpdate[]>();

    for (let i = 0; i < tailNumbers.length; i++) {
      const tailNumber = tailNumbers[i];

      if (onProgress) {
        onProgress(i + 1, tailNumbers.length, tailNumber);
      }

      try {
        const flights = await this.getUpcomingFlights(tailNumber);
        results.set(tailNumber, flights);
      } catch (err) {
        error(`Error fetching flights for ${tailNumber}`, err);
        results.set(tailNumber, []);
      }
    }

    return results;
  }
}
