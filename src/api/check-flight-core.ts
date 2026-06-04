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

import {
  buildAirlineFlightNumberVariants,
  detectMarketingCarrier,
  ensureAirlinePrefix,
} from "../airlines/flight-number";
import { type AirlineConfig, enabledAirlines, publicAirlines } from "../airlines/registry";
import type { FlightAssignmentRow, QatarScheduleRow } from "../database/database";
import type { Scope, ScopedReader } from "../database/reader";
import {
  type CarrierPrediction,
  carrierPrediction,
  carrierPredictionTelemetry,
  predictFlight,
} from "../scripts/starlink-predictor";
import { type FlightDateWindow, flightDateWindow, matchesLocalDate } from "../utils/airport-tz";
import { error as logError } from "../utils/logger";
import { type FallbackSegment, lookupFlightTailVerdict } from "./flight-verdict";
import { Fr24UnavailableError } from "./flightradar24-api";
import { qatarEquipmentName } from "./qatar-status";

// flightDateWindow lives in airport-tz next to its partner matchesLocalDate;
// re-exported here so check-flight surfaces keep one import site.
export { flightDateWindow, type FlightDateWindow };

type Prediction = ReturnType<typeof predictFlight>;

// Outage caveat copy shared by the REST and MCP renderers so the two surfaces
// can't drift. FR24_OUTAGE_NOTE replaces "no assignment data / not yet
// published" claims; SWAP_DEGRADED_NOTE qualifies a firm no whose swap
// re-check couldn't run.
export const FR24_OUTAGE_NOTE =
  "We couldn't confirm the aircraft assignment right now — try again shortly.";
export const SWAP_DEGRADED_NOTE =
  "Note: aircraft-swap detection is degraded right now — the live assignment check couldn't run.";

/**
 * One carrier-resolution decision shared by the flight-number-taking API
 * surfaces it owns — REST /api/check-flight, /api/check-any-flight,
 * /api/predict-flight and MCP check_flight / predict_flight_starlink — whose
 * entry points are renderers over this (404 Response vs tool error). The
 * SEO/permalink routing (resolveFlightCfg in app.ts) is deliberately looser
 * and NOT covered.
 *
 *  - Pinned scope (tenant host / airline MCP scope): a flight number carrying
 *    ANOTHER registered airline's marketing prefix is refused — answering it
 *    under this carrier's branding is the cross-tenant leak. Digits-only,
 *    own-prefix, and operating-carrier (OO/SKW/YX…) numbers proceed.
 *  - Unpinned (hub): detect the marketing carrier across publicly-tracked
 *    airlines; undetectable numbers (incl. digits-only and shared operating
 *    prefixes) fail closed rather than defaulting to any carrier.
 *
 * `pinned: false` tells the caller to swap readers via carrierReader.
 * `not_tracked` carries what a renderer needs (the pinned carrier, if any,
 * and the publicly-tracked list) so renderers don't re-derive policy.
 */
export type CarrierDecision =
  | { outcome: "resolved"; cfg: AirlineConfig; pinned: boolean }
  | {
      outcome: "not_tracked";
      pinnedCfg: AirlineConfig | null;
      tracked: readonly AirlineConfig[];
    };

// Registry is process-static — snapshot the airline lists once.
const ENABLED_AIRLINES: readonly AirlineConfig[] = enabledAirlines();
const PUBLIC_AIRLINES: readonly AirlineConfig[] = publicAirlines();

export function decideCarrier(
  pinnedCfg: AirlineConfig | null,
  flightNumber: string
): CarrierDecision {
  if (pinnedCfg) {
    const marketing = detectMarketingCarrier(flightNumber, ENABLED_AIRLINES);
    if (marketing && marketing.code !== pinnedCfg.code) {
      return { outcome: "not_tracked", pinnedCfg, tracked: PUBLIC_AIRLINES };
    }
    return { outcome: "resolved", cfg: pinnedCfg, pinned: true };
  }
  const cfg = detectMarketingCarrier(flightNumber, PUBLIC_AIRLINES);
  if (!cfg) return { outcome: "not_tracked", pinnedCfg: null, tracked: PUBLIC_AIRLINES };
  return { outcome: "resolved", cfg, pinned: false };
}

/** The reader a resolved decision answers from: the pinned scope's own, or a
 * swap to the detected carrier's. Shared by the REST and MCP renderers so the
 * security-relevant swap isn't copy-pasted. */
export function carrierReader(
  decision: Extract<CarrierDecision, { outcome: "resolved" }>,
  pinnedReader: ScopedReader,
  getReader: (scope: Scope) => ScopedReader
): ScopedReader {
  return decision.pinned ? pinnedReader : getReader(decision.cfg.code);
}

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
      kind: "no_model";
      window: FlightDateWindow;
      normalized: string;
      /** Registry-driven answer for carriers without a flight-history model. */
      answer: CarrierPrediction;
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
    case "no_model":
      if (verdict.fr24Error) return { outcome: "error", confidence: "none" };
      return carrierPredictionTelemetry(verdict.answer);
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

  // Carriers without a flight-history model get the registry-driven answer
  // (type rules / subfleet penetration) — never another carrier's priors.
  if (!cfg.flightHistoryModel) {
    return {
      kind: "no_model",
      window,
      normalized,
      answer: carrierPrediction(cfg, reader, normalized),
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
