/**
 * FlightRadar24 API Client
 * Free API for fetching flight data by aircraft registration
 */

import { COUNTERS, metrics } from "../observability";
import type { Flight } from "../types";
import { info, warn } from "../utils/logger";
import { fr24Fetch } from "./fr24-browser-transport";

type FlightUpdate = Pick<
  Flight,
  "flight_number" | "departure_airport" | "arrival_airport" | "departure_time" | "arrival_time"
>;

/** FR24 transport/HTTP/parse failure — never "no data published". Callers
 * catch exactly this so DB errors can't masquerade as vendor outages. */
export class Fr24UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fr24UnavailableError";
  }
}

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
export const MIN_REQUEST_INTERVAL = 2000; // 2s between requests to avoid 402 rate limits

// The slot is claimed synchronously: reading lastRequestTime, sleeping, then
// stamping it let concurrent callers read the same stamp and fire together
// (2,184 FR24 calls/hr against a nominal 1,800 on 2026-09-03). Returns null,
// claiming nothing, when the slot is further out than the caller can wait.
export function reserveFr24Slot(
  nowMs = Date.now(),
  maxWaitMs = Number.POSITIVE_INFINITY
): number | null {
  const slot = Math.max(nowMs, lastRequestTime + MIN_REQUEST_INTERVAL);
  if (slot - nowMs > maxWaitMs) return null;
  lastRequestTime = slot;
  return slot - nowMs;
}

// Tests share one process-wide slot clock; without this a test's timing
// depends on how many slots earlier files happened to claim.
export function resetFr24SlotClock(): void {
  lastRequestTime = 0;
}

export const FR24_QUEUE_SHED_MESSAGE = "shed: queue";

// FR24 lists a registration's flights newest-first. Capping that list unsorted
// kept a busy regional tail's furthest-future legs and dropped the leg in the
// air plus the next several hours (310 of 561 UA tails sat at the old cap of 10,
// 256 of them with their first row over an hour after the refresh; prod
// snapshot 2026-08-29).
export const FR24_UPCOMING_CAP = 16;

type Fr24Fetch = typeof fr24Fetch;

export class FlightRadar24API {
  private baseUrl = "https://api.flightradar24.com/common/v1";

  constructor(private fetchFr24: Fr24Fetch = fr24Fetch) {}

  // Uncapped, the Nth concurrent caller sleeps ~2s×(N-1) behind every slot
  // already claimed in this process — past the extension's 10s fetch timeout.
  private async waitForRateLimit(maxWaitMs?: number) {
    const waitMs = reserveFr24Slot(Date.now(), maxWaitMs);
    if (waitMs === null) throw new Fr24UnavailableError(FR24_QUEUE_SHED_MESSAGE);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    requestType = "flights",
    maxWaitMs?: number
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.waitForRateLimit(maxWaitMs);
        return await operation();
      } catch (error: any) {
        if (error instanceof Fr24UnavailableError) throw error;
        const errorMessage = error?.message || String(error);
        // FR24 throttles a busy session with bare 400s (not 429): every retry
        // inside the same window fails, the same query succeeds minutes later.
        // Space those retries like rate limits instead of hammering at 2-8s.
        const throttleCode = errorMessage.match(/error: (400|402|429)$/)?.[1];
        const isRateLimit = throttleCode !== undefined;

        if (isRateLimit) {
          metrics.increment(COUNTERS.VENDOR_REQUEST, {
            vendor: "fr24",
            type: requestType,
            status: "rate_limited",
            http_status: throttleCode,
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
  async getUpcomingFlights(
    tailNumber: string,
    flightNumberSource: FlightNumberSource = "callsign"
  ): Promise<FlightUpdate[]> {
    return this.retryWithBackoff(async () => {
      // FR24 API expects registration without the leading 'N' for some queries,
      // but works fine with the full registration
      const url = `${this.baseUrl}/flight/list.json?query=${tailNumber}&fetchBy=reg&page=1&limit=25`;

      const response = await this.fetchFr24(url, 30000);

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
          http_status: String(response.status),
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

      return parseUpcomingFlights(flights, Math.floor(Date.now() / 1000), undefined, {
        flightNumberSource,
      });
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

    let response: Awaited<ReturnType<Fr24Fetch>>;
    try {
      response = await this.fetchFr24(url, 8000);
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
        http_status: String(response.status),
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
   * Throws Fr24UnavailableError after retries are exhausted: an FR24 outage
   * must stay distinguishable from "no assignment published" (= empty array).
   */
  async getFlightAssignments(
    flightNumber: string,
    targetDateUnix: number,
    opts: { maxRetries?: number; maxWaitMs?: number } = {}
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
          const response = await this.fetchFr24(url, 8000);

          if (!response.ok) {
            metrics.increment(COUNTERS.VENDOR_REQUEST, {
              vendor: "fr24",
              type: "assignments",
              status: response.status === 402 || response.status === 429 ? "rate_limited" : "error",
              http_status: String(response.status),
            });
            throw new Error(`FR24 assignments error: ${response.status}`);
          }

          // Parse before counting success: a 200 Cloudflare interstitial is
          // still a vendor failure.
          const data: FR24Response = JSON.parse(response.body);
          metrics.increment(COUNTERS.VENDOR_REQUEST, {
            vendor: "fr24",
            type: "assignments",
            status: "success",
          });
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
        // The request path passes 0: a throttle retry sleeps 30s inline, which
        // is what stretched one /api/check-flight span to 34.5s on 2026-09-06.
        opts.maxRetries ?? 1,
        "assignments",
        opts.maxWaitMs
      );
    } catch (err) {
      if (err instanceof Fr24UnavailableError) throw err;
      throw new Fr24UnavailableError(err instanceof Error ? err.message : String(err));
    }
  }
}

export type FR24ListFlight = Pick<FR24Flight, "identification" | "airport" | "time">;

export type FlightNumberSource = "callsign" | "marketing";

const NUMERIC_FLIGHT = /^[A-Z0-9]{2,3}\d{1,4}$/;

/**
 * upcoming_flights.flight_number for one FR24 leg. "callsign" keeps the
 * operating code (SKW4783) for FlightAware links. "marketing" is for carriers
 * whose callsigns are alphanumeric (AFR26CE) and match no marketed number:
 * number.default, or null to drop a leg that carries none.
 */
export function pickFlightNumber(
  flight: Pick<FR24Flight, "identification">,
  source: FlightNumberSource
): string | null {
  const id = flight.identification;
  if (source === "marketing") return id.number.default || null;
  // An ATC callsign with a letter suffix (SKW302M for UA5352) matches no
  // marketed number, so the departure was invisible to every flight lookup.
  if (id.callsign && !NUMERIC_FLIGHT.test(id.callsign)) {
    const numbered = [id.number.alternative, id.number.default].find(
      (n): n is string => !!n && NUMERIC_FLIGHT.test(n)
    );
    if (numbered) return numbered;
  }
  return id.callsign || id.number.alternative || id.number.default || "";
}

/** Not-yet-landed legs (airborne ones included), nearest departure first, capped. */
export function parseUpcomingFlights(
  flights: FR24ListFlight[],
  nowSec: number,
  cap = FR24_UPCOMING_CAP,
  opts: { flightNumberSource?: FlightNumberSource } = {}
): FlightUpdate[] {
  const source = opts.flightNumberSource ?? "callsign";
  return flights
    .filter((flight) => {
      const departureTime = flight.time.scheduled.departure || flight.time.estimated.departure || 0;
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
      return arrivalTime > nowSec || departureTime > nowSec;
    })
    .map((flight) => ({
      flight_number: pickFlightNumber(flight, source),
      departure_airport: flight.airport.origin?.code.iata || flight.airport.origin?.code.icao || "",
      arrival_airport:
        flight.airport.destination?.code.iata || flight.airport.destination?.code.icao || "",
      departure_time: flight.time.scheduled.departure || flight.time.estimated.departure || 0,
      arrival_time: flight.time.scheduled.arrival || flight.time.estimated.arrival || 0,
    }))
    .filter(
      (f): f is FlightUpdate =>
        f.flight_number !== null && Boolean(f.departure_airport && f.arrival_airport)
    )
    .sort((a, b) => a.departure_time - b.departure_time)
    .slice(0, cap);
}
