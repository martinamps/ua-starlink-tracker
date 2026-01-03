/**
 * FlightRadar24 API Client
 * Free API for fetching flight data by aircraft registration
 */

import { COUNTERS, metrics } from "../observability";
import type { Flight } from "../types";
import { normalizeFlightNumber } from "../utils/constants";
import { error, info, warn } from "../utils/logger";

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

export class FlightRadar24API {
  private baseUrl = "https://api.flightradar24.com/common/v1";
  private lastRequestTime = 0;
  private minRequestInterval = 2000; // 2s between requests to avoid 402 rate limits

  private async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
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
        const isRateLimit = errorMessage.includes("402");

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

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
      });

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
        throw new Error(`FlightRadar24 API error: ${response.status} ${response.statusText}`);
      }

      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        vendor: "fr24",
        type: "flights",
        status: "success",
      });
      const data: FR24Response = await response.json();
      const flights = data.result?.response?.data || [];

      if (flights.length === 0) {
        return [];
      }

      const now = Math.floor(Date.now() / 1000);

      return flights
        .filter((flight) => {
          // Get the scheduled or estimated departure time
          const departureTime =
            flight.time.scheduled.departure || flight.time.estimated.departure || 0;
          // Only include future flights
          return departureTime > now;
        })
        .map((flight) => {
          // Extract and normalize flight number to UA prefix
          const flightNumber = flight.identification.number.default || "";

          return {
            flight_number: normalizeFlightNumber(flightNumber),
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
