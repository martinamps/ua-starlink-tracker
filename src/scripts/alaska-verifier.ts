/**
 * alaska-json verifier backend.
 *
 * Polls alaskaair.com/status/{flight}/{date}/__data.json for tails in
 * `united_fleet` whose `verifierBackend === 'alaska-json'` (HA + AS). For
 * Hawaiian, type→Starlink is deterministic so each check is a confirmation.
 * For Alaska, the endpoint has no wifi field (verified 2026-04: page
 * hardcodes `isHawaiian ? 'Starlink' : 'Wi-Fi'` client-side), so checks are
 * tail/type oracle observations with `wifi_provider=null` until Alaska
 * exposes a real signal. We log every observation so the precision harness
 * + tripwire can detect when that changes.
 */

import type { Database } from "bun:sqlite";
import { enabledAirlines } from "../airlines/registry";
import {
  alaskaTypeToStarlink,
  fetchAlaskaFlightStatus,
  hawaiianTypeToStarlink,
} from "../api/alaska-status";
import {
  getNextAlaskaVerifyTarget,
  getNextFlightForTail,
  initializeDatabase,
  logVerification,
  setFleetVerified,
  touchFleetVerifiedAt,
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
import { info, error as logError } from "../utils/logger";

const INTERVAL_MS = 90_000;

// IANA timezones for AS/HA-served airports. alaskaair.com/status/{flight}/{date}
// keys on the LOCAL scheduled departure date, so deriving the date from a UTC
// epoch needs the origin's tz. Default to AS's home tz for unknowns.
const AIRPORT_TZ: Record<string, string> = {
  // Hawaii (UTC-10, no DST)
  HNL: "Pacific/Honolulu",
  OGG: "Pacific/Honolulu",
  KOA: "Pacific/Honolulu",
  LIH: "Pacific/Honolulu",
  ITO: "Pacific/Honolulu",
  // Alaska (UTC-9/-8)
  ANC: "America/Anchorage",
  FAI: "America/Anchorage",
  JNU: "America/Anchorage",
  KTN: "America/Anchorage",
  SIT: "America/Anchorage",
  // Pacific (UTC-8/-7) — AS hubs + west coast
  SEA: "America/Los_Angeles",
  PDX: "America/Los_Angeles",
  SFO: "America/Los_Angeles",
  LAX: "America/Los_Angeles",
  SAN: "America/Los_Angeles",
  SJC: "America/Los_Angeles",
  OAK: "America/Los_Angeles",
  LAS: "America/Los_Angeles",
  // Mountain (UTC-7/-6)
  PHX: "America/Phoenix",
  DEN: "America/Denver",
  SLC: "America/Denver",
  // Central (UTC-6/-5)
  ORD: "America/Chicago",
  DFW: "America/Chicago",
  AUS: "America/Chicago",
  MSP: "America/Chicago",
  // Eastern (UTC-5/-4)
  JFK: "America/New_York",
  EWR: "America/New_York",
  BOS: "America/New_York",
  DCA: "America/New_York",
  IAD: "America/New_York",
  MIA: "America/New_York",
  MCO: "America/New_York",
};

export function airportTimezone(iata: string): string {
  return AIRPORT_TZ[iata.toUpperCase()] ?? "America/Los_Angeles";
}

export function localDateISO(epochSec: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochSec * 1000));
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function deriveWifi(airline: string, equipmentType: string | null): string | null {
  if (airline === "HA") {
    const v = hawaiianTypeToStarlink(equipmentType);
    return v === "Starlink" ? "Starlink" : v === "None" ? "None" : null;
  }
  return alaskaTypeToStarlink(equipmentType);
}

async function checkOne(db: Database, airline: "AS" | "HA"): Promise<string> {
  const target = getNextAlaskaVerifyTarget(db, airline);
  if (!target) return "no_target";

  const flight = getNextFlightForTail(db, target.tail_number);
  if (!flight) {
    touchFleetVerifiedAt(db, target.tail_number);
    return "no_flight";
  }

  const flightNum = flight.flight_number.replace(/[^0-9]/g, "");
  const tz = airportTimezone(flight.departure_airport);
  const dateLocal = localDateISO(flight.departure_time, tz);

  let status = await fetchAlaskaFlightStatus(flightNum, dateLocal, airline);
  let dateUsed = dateLocal;
  if (!status) {
    // tz-map gaps or schedule-vs-published date skew — try the prior local day
    // before recording a failure/swap.
    const prev = shiftDate(dateLocal, -1);
    status = await fetchAlaskaFlightStatus(flightNum, prev, airline);
    if (status) dateUsed = prev;
  }

  const tailConfirmed = status?.tailNumber === target.tail_number ? 1 : status ? 0 : null;
  const equipmentType = status?.equipmentType ?? target.aircraft_type;
  const wifi = tailConfirmed === 1 ? deriveWifi(airline, equipmentType) : null;
  const hasStarlink = wifi === "Starlink" ? true : wifi === "None" ? false : null;

  logVerification(db, {
    tail_number: target.tail_number,
    source: "alaska",
    has_starlink: hasStarlink,
    wifi_provider: wifi,
    aircraft_type: equipmentType,
    flight_number: flight.flight_number,
    error: status ? null : "fetch_failed",
    tail_confirmed: tailConfirmed,
    airline,
  });

  if (tailConfirmed === 1 && wifi !== null) {
    setFleetVerified(db, target.tail_number, wifi, wifi === "Starlink" ? "confirmed" : "negative");
  } else {
    touchFleetVerifiedAt(db, target.tail_number);
  }

  const result = status ? (tailConfirmed === 1 ? "success" : "aircraft_mismatch") : "error";
  metrics.increment(COUNTERS.VERIFICATION_CHECK, {
    fleet: normalizeFleet(target.fleet),
    aircraft_type: normalizeAircraftType(equipmentType),
    wifi_provider: normalizeWifiProvider(wifi),
    result,
    source: "alaska",
    airline: normalizeAirlineTag(airline),
  });

  info(
    `alaska-verifier ${airline} ${target.tail_number} ${flight.flight_number}@${dateUsed}(${tz}) → ${
      status
        ? `tail=${status.tailNumber} type=${equipmentType} wifi=${wifi ?? "unknown"}`
        : "fetch_failed"
    }`
  );

  return result;
}

export function startAlaskaVerifier(): void {
  const targets = enabledAirlines()
    .filter((a) => a.verifierBackend === "alaska-json")
    .map((a) => a.code as "AS" | "HA");
  if (targets.length === 0) {
    info("alaska-verifier: no enabled airlines with verifierBackend=alaska-json; not starting");
    return;
  }
  info(
    `alaska-verifier: starting (${INTERVAL_MS / 1000}s interval, airlines: ${targets.join(",")})`
  );

  let cursor = 0;
  const tick = () => {
    const airline = targets[cursor % targets.length];
    cursor++;
    return withSpan(
      "alaska_verifier.run",
      async (span) => {
        span.setTag("airline", normalizeAirlineTag(airline));
        try {
          const db = initializeDatabase();
          try {
            const result = await checkOne(db, airline);
            span.setTag("result", result);
          } finally {
            db.close();
          }
        } catch (e) {
          span.setTag("error", true);
          logError(`alaska-verifier ${airline} tick failed`, e);
        }
      },
      { "job.type": "background" }
    );
  };

  setTimeout(tick, 30_000);
  setInterval(tick, INTERVAL_MS);
}

if (import.meta.main) {
  const airline = (process.argv[2] as "AS" | "HA") || "AS";
  const db = initializeDatabase();
  checkOne(db, airline)
    .then((r) => {
      console.log(`result: ${r}`);
      db.close();
    })
    .catch((e) => {
      logError("alaska-verifier CLI failed", e);
      db.close();
      process.exit(1);
    });
}
