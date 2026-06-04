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
import { AIRLINES, enabledAirlines, providerLabel, verifierSourceTag } from "../airlines/registry";
import { fetchAlaskaFlightStatus } from "../api/alaska-status";
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
import { airportTimezone, localDateISO } from "../utils/airport-tz";
import { info, error as logError } from "../utils/logger";

const INTERVAL_MS = 90_000;

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Adapter: registry verdict → the wifi-provider keyspace the log/fleet store.
function deriveWifi(airline: "AS" | "HA", equipmentType: string | null): string | null {
  if (!equipmentType) return null;
  return providerLabel(AIRLINES[airline].typeDeterministicWifi?.(equipmentType) ?? null);
}

export async function checkOne(
  db: Database,
  airline: "AS" | "HA",
  fetchStatus: typeof fetchAlaskaFlightStatus = fetchAlaskaFlightStatus
): Promise<string> {
  const target = getNextAlaskaVerifyTarget(db, airline);
  if (!target) return "no_target";

  const flight = getNextFlightForTail(db, target.tail_number);
  if (!flight) {
    touchFleetVerifiedAt(db, target.tail_number);
    return "no_flight";
  }

  const flightNum = flight.flight_number.replace(/[^0-9]/g, "");
  // Default to AS's home tz for unmapped airports (pre-existing behavior).
  const tz = airportTimezone(flight.departure_airport) ?? "America/Los_Angeles";
  const dateLocal = localDateISO(flight.departure_time, tz);

  // fetchStatus throws on transport failure and returns null when the fetch
  // succeeded but no flight is published — two different states.
  let status: Awaited<ReturnType<typeof fetchAlaskaFlightStatus>> = null;
  let dateUsed = dateLocal;
  let fetchFailed = false;
  try {
    status = await fetchStatus(flightNum, dateLocal, airline);
    if (!status) {
      // tz-map gaps or schedule-vs-published date skew — try the prior local
      // day before recording a not-published observation.
      const prev = shiftDate(dateLocal, -1);
      status = await fetchStatus(flightNum, prev, airline);
      if (status) dateUsed = prev;
    }
  } catch (e) {
    fetchFailed = true;
    logError(`alaska-verifier ${airline} fetch failed for ${flightNum}@${dateLocal}`, e);
  }

  const tailConfirmed = status?.tailNumber === target.tail_number ? 1 : status ? 0 : null;
  const equipmentType = status?.equipmentType ?? target.aircraft_type;
  const wifi = tailConfirmed === 1 ? deriveWifi(airline, equipmentType) : null;
  const hasStarlink = wifi === "Starlink" ? true : wifi === "None" ? false : null;

  const sourceTag = verifierSourceTag(AIRLINES[airline]);
  logVerification(db, {
    tail_number: target.tail_number,
    source: sourceTag,
    has_starlink: hasStarlink,
    wifi_provider: wifi,
    aircraft_type: equipmentType,
    flight_number: flight.flight_number,
    error: status ? null : fetchFailed ? "fetch_failed" : "not_published",
    tail_confirmed: tailConfirmed,
    airline,
  });

  if (tailConfirmed === 1 && wifi !== null) {
    setFleetVerified(db, target.tail_number, wifi, wifi === "Starlink" ? "confirmed" : "negative");
  } else if (!fetchFailed) {
    // Real but inconclusive observation (mismatch / no wifi oracle / nothing
    // published for the flight) — defer ~7 days.
    touchFleetVerifiedAt(db, target.tail_number);
  }
  // Transport failure: leave verified_at untouched so the next tick retries —
  // the whole queue fails equally during an outage, so nothing starves, and
  // an outage hour must not cycle the roster 7 days out.

  const result = fetchFailed
    ? "error"
    : status
      ? tailConfirmed === 1
        ? "success"
        : "aircraft_mismatch"
      : "not_published";
  metrics.increment(COUNTERS.VERIFICATION_CHECK, {
    fleet: normalizeFleet(target.fleet),
    aircraft_type: normalizeAircraftType(equipmentType),
    wifi_provider: normalizeWifiProvider(wifi),
    result,
    source: sourceTag,
    airline: normalizeAirlineTag(airline),
  });

  info(
    `alaska-verifier ${airline} ${target.tail_number} ${flight.flight_number}@${dateUsed}(${tz}) → ${
      status
        ? `tail=${status.tailNumber} type=${equipmentType} wifi=${wifi ?? "unknown"}`
        : fetchFailed
          ? "fetch_failed"
          : "not_published"
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
  const tick = async () => {
    const airline = targets[cursor % targets.length];
    cursor++;
    // Most ticks find nothing to verify — skip span creation on no-op runs.
    let target: ReturnType<typeof getNextAlaskaVerifyTarget> = null;
    try {
      const db = initializeDatabase();
      try {
        target = getNextAlaskaVerifyTarget(db, airline);
      } finally {
        db.close();
      }
    } catch (e) {
      logError(`alaska-verifier ${airline} pre-check failed`, e);
      return;
    }
    if (!target) return;

    return withSpan(
      "airline_verifier.run",
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
