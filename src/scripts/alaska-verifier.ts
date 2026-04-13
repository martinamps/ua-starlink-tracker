#!/usr/bin/env bun
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
  logVerification,
  setFleetVerified,
} from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability";
import { info, error as logError } from "../utils/logger";

const INTERVAL_MS = 90_000;

function deriveWifi(airline: string, equipmentType: string | null): string | null {
  if (airline === "HA") {
    const v = hawaiianTypeToStarlink(equipmentType);
    return v === "Starlink" ? "Starlink" : v === "None" ? "None" : null;
  }
  return alaskaTypeToStarlink(equipmentType);
}

async function checkOne(db: Database, airline: "AS" | "HA"): Promise<void> {
  const target = getNextAlaskaVerifyTarget(db, airline);
  if (!target) return;

  const flight = getNextFlightForTail(db, target.tail_number);
  if (!flight) {
    setFleetVerified(db, target.tail_number, null);
    return;
  }

  const flightNum = flight.flight_number.replace(/[^0-9]/g, "");
  const dateISO = new Date(flight.departure_time * 1000).toISOString().slice(0, 10);

  const status = await fetchAlaskaFlightStatus(flightNum, dateISO, airline);
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
    setFleetVerified(
      db,
      target.tail_number,
      wifi,
      wifi === "Starlink" ? "confirmed" : wifi === "None" ? "negative" : undefined
    );
  } else {
    setFleetVerified(db, target.tail_number, null);
  }

  metrics.increment(COUNTERS.VERIFICATION_CHECK, {
    airline: normalizeAirlineTag(airline),
    source: "alaska",
    result: status ? (tailConfirmed === 1 ? "confirmed" : "swap") : "error",
  });

  info(
    `alaska-verifier ${airline} ${target.tail_number} ${flight.flight_number}@${dateISO} → ${
      status
        ? `tail=${status.tailNumber} type=${equipmentType} wifi=${wifi ?? "unknown"}`
        : "fetch_failed"
    }`
  );
}

export function startAlaskaVerifier(db: Database): void {
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
    try {
      await checkOne(db, airline);
    } catch (e) {
      logError(`alaska-verifier ${airline} tick failed`, e);
    }
  };

  setTimeout(tick, 30_000);
  setInterval(tick, INTERVAL_MS);
}
