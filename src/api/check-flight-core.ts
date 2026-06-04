/**
 * Single check-flight verdict engine. /api/check-flight, the hub's
 * /api/check-any-flight, and MCP check_flight are thin formatters over
 * resolveFlightVerdict — the date-window math, local-date matching, row
 * classification, FR24 fallback, and prediction ladder live only here.
 *
 * Date semantics: callers pass the traveler's printed LOCAL departure date.
 * The SQL window is widened to cover every UTC instant that can carry that
 * local date (UTC-12..UTC+14), then rows are filtered by the departure
 * airport's local date; unmapped airports keep the strict UTC window.
 */

import { buildAirlineFlightNumberVariants, ensureAirlinePrefix } from "../airlines/flight-number";
import type { AirlineConfig } from "../airlines/registry";
import type { FlightAssignmentRow, QatarScheduleRow } from "../database/database";
import type { ScopedReader } from "../database/reader";
import { predictFlight } from "../scripts/starlink-predictor";
import { matchesLocalDate } from "../utils/airport-tz";
import { error as logError } from "../utils/logger";
import { type FallbackSegment, lookupFlightTailVerdict } from "./flight-verdict";
import { Fr24UnavailableError } from "./flightradar24-api";
import { qatarEquipmentName } from "./qatar-status";

export interface FlightDateWindow {
  /** Strict UTC bounds of the calendar date — kept for FR24 fallback + days_out math. */
  start: number;
  end: number;
  /** Noon UTC of the date — anchor for FR24/route lookups and planner seeding. */
  mid: number;
  /** Widened SQL bounds: every UTC instant whose local date can equal the queried date. */
  queryStart: number;
  queryEnd: number;
  daysOut: number;
}

export function flightDateWindow(
  date: string,
  nowSec = Math.floor(Date.now() / 1000)
): FlightDateWindow | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const start = Math.floor(t / 1000);
  const end = start + 86400;
  return {
    start,
    end,
    mid: start + 43200,
    queryStart: start - 14 * 3600, // UTC+14: local date starts up to 14h before the UTC date
    queryEnd: end + 12 * 3600, // UTC-12: local date ends up to 12h after
    daysOut: Math.floor(start / 86400) - Math.floor(nowSec / 86400),
  };
}

type Prediction = ReturnType<typeof predictFlight>;

/** Why a row landed in the firm-no bucket. */
export type NegativeReason = "settled" | "verified_other";
export type ScheduledNoRow = FlightAssignmentRow & { negativeReason: NegativeReason };

/** Display name for the WiFi a firm-no row actually carries. */
export function negativeWifi(row: ScheduledNoRow): string {
  return row.negativeReason === "settled"
    ? (row.settled_wifi ?? "non-Starlink")
    : (row.verified_wifi ?? "non-Starlink");
}

export type FlightVerdict =
  | { kind: "invalid_date" }
  | { kind: "invalid_flight_number"; normalized: string }
  | {
      kind: "scheduled";
      window: FlightDateWindow;
      normalized: string;
      verified: FlightAssignmentRow[];
      unverified: FlightAssignmentRow[];
    }
  | {
      kind: "scheduled_no";
      window: FlightDateWindow;
      normalized: string;
      flights: ScheduledNoRow[];
      /** Swap detection degraded — the firm no stands, but FR24 couldn't be consulted. */
      fr24Error: boolean;
    }
  | { kind: "fr24"; window: FlightDateWindow; normalized: string; starlink: FallbackSegment[] }
  | { kind: "fr24_no"; window: FlightDateWindow; normalized: string; segments: FallbackSegment[] }
  | {
      kind: "type_no_data";
      window: FlightDateWindow;
      normalized: string;
      reason: string;
      fr24Error: boolean;
    }
  | {
      kind: "prediction";
      window: FlightDateWindow;
      normalized: string;
      pred: Prediction;
      fr24Error: boolean;
    }
  | {
      kind: "qatar";
      window: FlightDateWindow;
      normalized: string;
      hasStarlink: boolean | null;
      confidence: "verified" | "rolling" | "mixed";
      reason: string;
      rows: QatarScheduleRow[];
    }
  | { kind: "qatar_no_data"; window: FlightDateWindow; normalized: string };

/** Equipped rows merged for display, departure_time ascending. */
export function scheduledFlights(
  verdict: Extract<FlightVerdict, { kind: "scheduled" }>
): FlightAssignmentRow[] {
  return [...verdict.verified, ...verdict.unverified].sort(
    (a, b) => a.departure_time - b.departure_time
  );
}

/** Response-facing confidence label for firm-yes verdicts. */
export function verdictConfidence(
  verdict: Extract<FlightVerdict, { kind: "scheduled" } | { kind: "fr24" }>
): "verified" | "likely" {
  const allVerified =
    verdict.kind === "scheduled"
      ? verdict.unverified.length === 0
      : verdict.starlink.every((s) => s.confidence === "verified");
  return allVerified ? "verified" : "likely";
}

export interface VerdictTelemetry {
  outcome: "verified_yes" | "verified_no" | "predicted" | "no_data" | "error";
  confidence: "high" | "medium" | "low" | "none";
}

/** One outcome/confidence mapping for FLIGHT_LOOKUP_RESULT so REST and MCP tags can't drift. */
export function verdictTelemetry(
  verdict: Exclude<FlightVerdict, { kind: "invalid_date" } | { kind: "invalid_flight_number" }>
): VerdictTelemetry {
  switch (verdict.kind) {
    case "scheduled":
      return {
        outcome: "verified_yes",
        confidence: verdictConfidence(verdict) === "verified" ? "high" : "medium",
      };
    case "scheduled_no":
      return { outcome: "verified_no", confidence: "high" };
    case "fr24":
      return verdictConfidence(verdict) === "verified"
        ? { outcome: "verified_yes", confidence: "high" }
        : { outcome: "predicted", confidence: "medium" };
    case "fr24_no":
      return { outcome: "verified_no", confidence: "medium" };
    case "prediction": {
      const informative = verdict.pred.n_observations > 0;
      return {
        outcome: verdict.fr24Error ? "error" : informative ? "predicted" : "no_data",
        confidence: informative ? verdict.pred.confidence : "none",
      };
    }
    case "type_no_data":
      return { outcome: verdict.fr24Error ? "error" : "no_data", confidence: "none" };
    case "qatar_no_data":
      return { outcome: "no_data", confidence: "none" };
    case "qatar":
      return verdict.confidence === "verified"
        ? { outcome: verdict.hasStarlink ? "verified_yes" : "verified_no", confidence: "high" }
        : { outcome: "predicted", confidence: "low" };
  }
}

export interface ResolveDeps {
  now?: number;
  /** Override the FR24 reverse lookup; pass null to disable it (hub check-any-flight). */
  lookupTail?: typeof lookupFlightTailVerdict | null;
  predict?: typeof predictFlight;
}

export async function resolveFlightVerdict(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string,
  date: string,
  deps: ResolveDeps = {}
): Promise<FlightVerdict> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const window = flightDateWindow(date, now);
  if (!window) return { kind: "invalid_date" };

  const normalized = ensureAirlinePrefix(cfg, flightNumber);
  // Real flight numbers are 1-4 digits; an unbounded number would let callers
  // drive arbitrary FR24 lookups through the public surfaces.
  const numPart = normalized.match(/(\d+)$/)?.[1];
  if (!numPart || numPart.length > 4) {
    return { kind: "invalid_flight_number", normalized };
  }

  if (cfg.code === "QR") return resolveQatarVerdict(reader, normalized, date, window);

  const variants = buildAirlineFlightNumberVariants(cfg, normalized);

  // Query is last_updated DESC, so dedupe by departure_time keeps the
  // most-recent row after an aircraft swap; then keep only rows whose
  // departure-airport local date matches the queried date.
  const seen = new Set<number>();
  const rows = reader
    .getFlightAssignments(variants, window.queryStart, window.queryEnd)
    .filter((r) => {
      if (seen.has(r.departure_time)) return false;
      seen.add(r.departure_time);
      return true;
    })
    .filter((r) =>
      matchesLocalDate(date, r.departure_airport, r.departure_time, window.start, window.end)
    );

  // settled_negative (united_fleet 'negative') outranks the spreadsheet row,
  // whatever verified_wifi says — same rule as database.ts equippedFilter.
  const verified: FlightAssignmentRow[] = [];
  const unverified: FlightAssignmentRow[] = [];
  const nonStarlink: ScheduledNoRow[] = [];
  for (const r of rows) {
    if (r.settled_negative) {
      nonStarlink.push({ ...r, negativeReason: "settled" });
    } else if (r.verified_wifi !== null && r.verified_wifi !== "Starlink") {
      nonStarlink.push({ ...r, negativeReason: "verified_other" });
    } else if (r.verified_wifi === "Starlink") {
      verified.push(r);
    } else {
      unverified.push(r);
    }
  }

  if (verified.length > 0 || unverified.length > 0) {
    return { kind: "scheduled", window, normalized, verified, unverified };
  }

  // FR24 runs whenever there are no equipped rows: with firm-no rows it can
  // still discover an aircraft swap onto a Starlink tail; with no rows at all
  // it is the primary fallback.
  let fr24Error = false;
  if (deps.lookupTail !== null) {
    const lookup = deps.lookupTail ?? lookupFlightTailVerdict;
    let segments: FallbackSegment[] | null = null;
    try {
      segments = await lookup(reader, normalized, date, window.start, window.end, now);
    } catch (err) {
      // FR24 outage ≠ "no assignment published" — never a confident no.
      // Anything else (e.g. a DB error) must not masquerade as an outage.
      if (!(err instanceof Fr24UnavailableError)) throw err;
      fr24Error = true;
      logError(`FR24 lookup failed for ${normalized} ${date}; degrading to prediction path`, err);
    }
    if (segments !== null) {
      const starlink = segments.filter((s) => s.hasStarlink);
      if (starlink.length > 0) {
        return { kind: "fr24", window, normalized, starlink };
      }
      // Segments whose tail we know nothing about are not a "no" — only a
      // verified non-Starlink tail is. With our own firm-no rows in hand,
      // prefer those (they carry per-row reasons); otherwise fr24_no.
      if (nonStarlink.length === 0 && segments.some((s) => s.hasStarlink === false)) {
        return { kind: "fr24_no", window, normalized, segments };
      }
    }
  }

  if (nonStarlink.length > 0) {
    return { kind: "scheduled_no", window, normalized, flights: nonStarlink, fr24Error };
  }

  // Type-determined airlines (e.g. HA) have no per-flight probability model —
  // the answer is "check the aircraft type", not a fleet prior.
  if (cfg.routeTypeRule) {
    return {
      kind: "type_no_data",
      window,
      normalized,
      reason: `No schedule data; ${cfg.name} Starlink status is type-determined — check the aircraft type on your booking.`,
      fr24Error,
    };
  }

  const predict = deps.predict ?? predictFlight;
  return { kind: "prediction", window, normalized, pred: predict(reader, normalized), fr24Error };
}

function resolveQatarVerdict(
  reader: ScopedReader,
  normalized: string,
  date: string,
  window: FlightDateWindow
): FlightVerdict {
  const numeric = normalized.replace(/^[A-Z]+/, "");
  // Match both unpadded and zero-padded forms ("QR1" and "QR001") since the
  // ingester writes "QR1" but users may type either.
  const padded = `QR${numeric.padStart(3, "0")}`;
  const stripped = `QR${String(Number.parseInt(numeric, 10) || 0)}`;
  const variants = Array.from(new Set([normalized, padded, stripped]));
  const rows = reader
    .getQatarScheduleByFlight(variants, window.queryStart, window.queryEnd)
    .filter(
      (r) =>
        r.departure_time !== null &&
        matchesLocalDate(
          date,
          r.departure_airport ?? "",
          r.departure_time,
          window.start,
          window.end
        )
    );

  if (rows.length === 0) return { kind: "qatar_no_data", window, normalized };

  const verdicts = rows.map((r) => r.wifi_verdict);
  const allStarlink = verdicts.every((v) => v === "Starlink");
  const anyRolling = verdicts.some((v) => v === "Rolling");
  const allNone = verdicts.every((v) => v === "None");
  const distinctEquipment = [...new Set(rows.map((r) => qatarEquipmentName(r.equipment_code)))];

  let hasStarlink: boolean | null;
  let confidence: "verified" | "rolling" | "mixed";
  let reason: string;
  if (allStarlink) {
    hasStarlink = true;
    confidence = "verified";
    reason = `${distinctEquipment.join(", ")} — Qatar Airways completed Starlink installation on this aircraft type.`;
  } else if (allNone) {
    hasStarlink = false;
    confidence = "verified";
    reason = `${distinctEquipment.join(", ")} — not part of Qatar's Starlink rollout.`;
  } else if (anyRolling) {
    hasStarlink = null;
    confidence = "rolling";
    reason = `${distinctEquipment.join(", ")} — Qatar's 787 Starlink rollout is in progress; this aircraft may or may not be equipped yet.`;
  } else {
    hasStarlink = null;
    confidence = "mixed";
    reason = `Mixed equipment scheduled (${distinctEquipment.join(", ")}) — outcome depends on which aircraft operates.`;
  }

  return { kind: "qatar", window, normalized, hasStarlink, confidence, reason, rows };
}
