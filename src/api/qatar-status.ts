/**
 * Qatar Airways flight status API client.
 *
 * `POST https://qoreservices.qatarairways.com/fltstatus-services/flight/getStatus`
 * is the same endpoint that fs.qatarairways.com calls. Two query modes:
 *
 *   by-flight: { flightNumber: "001", carrier: "QR", scheduledDate: "YYYY-MM-DD",
 *                departureStation: null, arrivalStation: null }
 *   by-route:  { departureStation: "DOH", arrivalStation: "LHR",
 *                scheduledDate: "YYYY-MM-DD" }
 *
 * The response carries `flights[].equipmentDetails.equipmentCode` (IATA 3-letter
 * type code, e.g. "77W", "351", "789"). It does NOT expose tail/registration —
 * Qatar's portal never renders that. So this is a per-flight equipment oracle,
 * not a per-tail wifi source like the United verifier.
 *
 * For Qatar that's enough: B777 + A350 are 100% Starlink (rollout complete
 * Q2/Dec 2025), B787 is rolling, A380/A330/narrowbody have no plan. The
 * equipment code per scheduled flight + date is the verdict.
 *
 * No auth, no captcha observed (10 rapid requests all returned 200), 500-1500ms
 * latency. fs.qatarairways.com itself is robots-allowed.
 */

import { COUNTERS, DISTRIBUTIONS, metrics, normalizeAirlineTag } from "../observability";
import { error as logError, warn } from "../utils/logger";

const API_URL = "https://qoreservices.qatarairways.com/fltstatus-services/flight/getStatus";
const UA_HEADER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export interface QatarFlight {
  flightNumber: string;
  /** IATA equipment code, e.g. "77W", "351", "789" */
  equipmentCode: string | null;
  departureAirport: string | null;
  arrivalAirport: string | null;
  /** "ARRIVED" | "DEPARTED" | "ENRT" | "SCHEDULED" | "CANCELLED" | "DIVERTED" | … */
  flightStatus: string | null;
  /** epoch seconds (UTC) */
  scheduledDeparture: number | null;
  scheduledArrival: number | null;
}

interface RawFlight {
  carrier?: { carrier?: string; flightNumber?: string };
  equipmentDetails?: { equipmentCode?: string };
  departureStation?: { airportCode?: string };
  arrivalStation?: { airportCode?: string };
  flightStatus?: string;
  flightNumber?: string;
  departureDateScheduledUTC?: string;
  arrivalDateScheduledUTC?: string;
}

interface RawResponse {
  flights?: RawFlight[];
  errorObject?: { errorName?: string }[];
  captchaRequired?: boolean;
}

function parseUtc(s: string | undefined): number | null {
  if (!s) return null;
  // Format: "Tue Apr 21 2026 22:50" — implicit UTC per the *UTC field name.
  const t = Date.parse(`${s} UTC`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function normalize(raw: RawFlight): QatarFlight {
  return {
    flightNumber: String(raw.flightNumber ?? raw.carrier?.flightNumber ?? ""),
    equipmentCode: raw.equipmentDetails?.equipmentCode ?? null,
    departureAirport: raw.departureStation?.airportCode ?? null,
    arrivalAirport: raw.arrivalStation?.airportCode ?? null,
    flightStatus: raw.flightStatus ?? null,
    scheduledDeparture: parseUtc(raw.departureDateScheduledUTC),
    scheduledArrival: parseUtc(raw.arrivalDateScheduledUTC),
  };
}

// p95 latency is ~300ms; 5s is already 16× that. 2 retries with short backoff
// shave a ~3.5% transient timeout rate (server-process contention at boot) to
// ~0.04% without meaningfully slowing the once-hourly ingest run.
const FETCH_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 1_500;

async function postStatus(
  body: object,
  queryType: "flight" | "route"
): Promise<RawResponse | null> {
  const start = Date.now();
  const tags = {
    vendor: "qatar",
    type: queryType,
    status: "error",
    airline: normalizeAirlineTag("QR"),
  };
  try {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
      }
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://fs.qatarairways.com",
            Referer: "https://fs.qatarairways.com/flightstatus/search",
            "User-Agent": UA_HEADER,
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          // 429/5xx are worth retrying; 4xx (other than 429) won't change.
          if (attempt < MAX_RETRIES && (res.status === 429 || res.status >= 500)) {
            lastErr = new Error(`HTTP ${res.status}`);
            continue;
          }
          tags.status = res.status === 429 ? "rate_limited" : "http_error";
          warn(`qatar-status HTTP ${res.status}`);
          return null;
        }
        const json = (await res.json()) as RawResponse;
        if (json.captchaRequired) {
          tags.status = "captcha";
          warn("qatar-status captcha required — endpoint behavior changed");
          return null;
        }
        tags.status = "success";
        return json;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          warn(`qatar-status attempt ${attempt + 1} failed, retrying: ${(err as Error)?.message}`);
        }
      }
    }
    logError("qatar-status fetch failed after retries", lastErr);
    return null;
  } finally {
    const duration = Date.now() - start;
    metrics.increment(COUNTERS.VENDOR_REQUEST, tags);
    metrics.distribution(DISTRIBUTIONS.VENDOR_DURATION_MS, duration, tags);
  }
}

/**
 * Fetch all QR flights matching a 3-digit flight number on a given date (DOH
 * local — the API treats `scheduledDate` as the operating-day key, which for
 * QR0xx out of DOH equals DOH local; westbound returns can resolve to the
 * prior local day, so callers may want to retry day-1 on FS_NOT_FOUND).
 */
export async function fetchByFlight(
  flightNumber: number | string,
  dateISO: string
): Promise<QatarFlight[] | null> {
  const fn = String(flightNumber).replace(/\D/g, "").padStart(3, "0");
  const r = await postStatus(
    {
      departureStation: null,
      arrivalStation: null,
      scheduledDate: dateISO,
      flightNumber: fn,
      carrier: "QR",
    },
    "flight"
  );
  if (!r) return null;
  if (r.errorObject?.length) {
    // FS_NOT_FOUND is the normal "no flight on that date" — don't log noise.
    if (!r.errorObject.some((e) => e.errorName === "FS_NOT_FOUND")) {
      warn(
        `qatar-status by-flight QR${fn}/${dateISO}: ${r.errorObject.map((e) => e.errorName).join(",")}`
      );
    }
    return [];
  }
  return (r.flights ?? []).map(normalize);
}

/**
 * Fetch all QR flights on a route on a given date. Returns one row per
 * scheduled flight number (a route may run several daily flights with
 * different equipment).
 */
export async function fetchByRoute(
  origin: string,
  destination: string,
  dateISO: string
): Promise<QatarFlight[] | null> {
  const r = await postStatus(
    {
      departureStation: origin.toUpperCase(),
      arrivalStation: destination.toUpperCase(),
      scheduledDate: dateISO,
    },
    "route"
  );
  if (!r) return null;
  if (r.errorObject?.length) {
    if (!r.errorObject.some((e) => e.errorName === "FS_NOT_FOUND")) {
      warn(
        `qatar-status by-route ${origin}-${destination}/${dateISO}: ${r.errorObject.map((e) => e.errorName).join(",")}`
      );
    }
    return [];
  }
  return (r.flights ?? []).map(normalize);
}

export type QatarWifi = "Starlink" | "Rolling" | "None";

/**
 * Map an IATA equipment code to QR's published Starlink state. Source of truth:
 *
 *   - Boeing 777-300ER (77W) + 777-200LR (77L): rollout complete Q2 2025
 *     (qatarairways.com/press-releases — "all 54 Boeing 777s")
 *   - Airbus A350-900 (351, 359) + A350-1000 (35K): rollout complete Dec 2025
 *     ("entire A350 fleet within record-breaking eight months")
 *   - Boeing 787-8 (788) + 787-9 (789): rolling — 3+ tails as of Jan 2026,
 *     end-2026 target. Equipment alone cannot decide individual flights.
 *   - Airbus A380 (388), A330 (332/333), A320 family (320/321/21N), 737 MAX
 *     (38M, 73H): no installation plan announced.
 *
 * "Rolling" callers should render as "may have Starlink" rather than a
 * yes/no — the answer flips per-tail and we have no per-tail signal yet.
 *
 * Why two A350-900 codes? QR's API returns 351 for some flights and 359 for
 * others (both A350-900). We treat them identically.
 */
export function qatarEquipmentToWifi(equipmentCode: string | null | undefined): QatarWifi {
  if (!equipmentCode) return "None";
  const c = equipmentCode.toUpperCase();
  if (c === "77W" || c === "77L") return "Starlink";
  if (c === "351" || c === "359" || c === "35K") return "Starlink";
  if (c === "788" || c === "789") return "Rolling";
  // 77F / 77X / 74Y are Qatar Cargo freighters — no passenger service. Their
  // Starlink status is moot but we return None so they sort with non-equipped
  // aircraft if a freighter slip past the ingester filter.
  return "None";
}

/**
 * True for IATA equipment codes Qatar uses on freighter aircraft (Qatar Cargo).
 * The flight-status API exposes both passenger and freighter schedules; we
 * filter freighters at ingest because they're not bookable by passengers.
 */
export function isQatarFreighterEquipment(equipmentCode: string | null | undefined): boolean {
  if (!equipmentCode) return false;
  const c = equipmentCode.toUpperCase();
  return c === "77F" || c === "77X" || c === "74Y" || c === "74F";
}

export function qatarEquipmentName(equipmentCode: string | null | undefined): string {
  if (!equipmentCode) return "Unknown";
  switch (equipmentCode.toUpperCase()) {
    case "77W":
      return "Boeing 777-300ER";
    case "77L":
      return "Boeing 777-200LR";
    case "351":
    case "359":
      return "Airbus A350-900";
    case "35K":
      return "Airbus A350-1000";
    case "788":
      return "Boeing 787-8";
    case "789":
      return "Boeing 787-9";
    case "388":
      return "Airbus A380-800";
    case "332":
      return "Airbus A330-200";
    case "333":
      return "Airbus A330-300";
    case "320":
      return "Airbus A320";
    case "321":
      return "Airbus A321";
    case "21N":
      return "Airbus A321neo";
    case "38M":
    case "73H":
      return "Boeing 737 MAX 8";
    case "77F":
    case "77X":
      return "Boeing 777 Freighter";
    case "74Y":
    case "74F":
      return "Boeing 747 Freighter";
    default:
      return equipmentCode;
  }
}
