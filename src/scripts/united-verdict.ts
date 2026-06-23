/**
 * Shared united.com verdict core for starlink-verifier and fleet-discovery.
 *
 * classifyCheckResult is pure: scrape result + expected tail → typed verdict,
 * no I/O. applyUnitedObservation is the single write path for that verdict
 * (log rows, swap-capture settle, consensus-gated verified_wifi — one
 * transaction). Keeping the trust ladder in one place pins the invariant
 * behind the 1.7k false-on-error audit rows: an error result NEVER writes a
 * negative observation — enforced structurally on result.error, not on the
 * checker happening to null out hasStarlink.
 */

import type { Database } from "bun:sqlite";
import { AIRLINES, OBSERVED_WIFI_SOURCES, verifierSourceTag } from "../airlines/registry";
import {
  type WifiConsensus,
  computeWifiConsensus,
  consensusToFleetStatus,
  getShipToTailMap,
  logVerification,
  setFleetVerified,
  updateVerifiedWifi,
} from "../database/database";
import { info, warn } from "../utils/logger";
import type { StarlinkCheckResult } from "./united-starlink-checker";

export const UNITED_SOURCE = verifierSourceTag(AIRLINES.UA);

/**
 * Logger pair for the shared log lines. The logger tags records by call-site
 * file, so callers must pass arrow wrappers defined in their own module to
 * keep their original logger tag (log-keyed monitors depend on it).
 */
export interface VerdictLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const ownLog: VerdictLog = { info: (m) => info(m), warn: (m) => warn(m) };

/**
 * One category per matrix cell; callers map category → mode-specific metric
 * tag with a Record instead of re-deriving the boolean ladder.
 * Precedence: mismatch > error > provider shape. The trusted set is exactly
 * {trusted_starlink, trusted_other, tail_unknown_positive}.
 */
export type UnitedCheckCategory =
  | "trusted_starlink"
  | "trusted_other"
  | "tail_unknown_positive" // no tail on page, but positive Starlink — positive-only trust
  | "unattributable" // no tail on page + non-Starlink provider — cannot attribute
  | "tail_unknown" // no tail on page, no usable provider
  | "no_provider" // tail confirmed but page had no/empty provider
  | "mismatch"
  | "error";

const TRUSTED_CATEGORIES: ReadonlySet<UnitedCheckCategory> = new Set([
  "trusted_starlink",
  "trusted_other",
  "tail_unknown_positive",
]);

export interface UnitedVerdict {
  expectedTail: string;
  /** Tail from the page, or ship-number-resolved tail. */
  resolvedTail: string | null;
  category: UnitedCheckCategory;
  tailMismatch: boolean;
  tailUnknown: boolean;
  /** Non-Starlink result with no tail extracted — cannot be attributed. */
  untrustedNonStarlink: boolean;
  /** Safe to attribute to expectedTail and feed the consensus settle. */
  trusted: boolean;
  /** Raw provider from the page (for logging/metrics; may be unattributable). */
  wifiProvider: string | null;
  /** Verification-log row for the intended tail. */
  observation: {
    has_starlink: boolean | null;
    wifi_provider: string | null;
    tail_confirmed: 0 | 1 | null;
    error: string | null;
  };
  /** On a confirmed swap with a usable, error-free result, the captured tail's row. */
  swapCapture: {
    tail_number: string;
    has_starlink: boolean | null;
    wifi_provider: string | null;
    aircraft_type: string | null;
  } | null;
}

export function classifyCheckResult(
  result: StarlinkCheckResult,
  expectedTail: string,
  shipToTail: ReadonlyMap<string, string>
): UnitedVerdict {
  let resolvedTail = result.tailNumber;
  if (!resolvedTail && result.shipNumber) {
    resolvedTail = shipToTail.get(result.shipNumber) ?? null;
  }

  const tailMismatch = !!resolvedTail && resolvedTail.toUpperCase() !== expectedTail.toUpperCase();
  // No tail on the page means we can't rule out an aircraft swap. Only trust
  // a POSITIVE Starlink result then (can't falsely hide a plane, only falsely
  // show one — less bad).
  const tailUnknown = !resolvedTail;
  const untrustedNonStarlink =
    tailUnknown && !!result.wifiProvider && result.wifiProvider !== "Starlink";

  let category: UnitedCheckCategory;
  if (tailMismatch) {
    category = "mismatch";
  } else if (result.error) {
    category = "error";
  } else if (!result.wifiProvider) {
    category = tailUnknown ? "tail_unknown" : "no_provider";
  } else if (untrustedNonStarlink) {
    category = "unattributable";
  } else if (tailUnknown) {
    category = "tail_unknown_positive";
  } else {
    category = result.wifiProvider === "Starlink" ? "trusted_starlink" : "trusted_other";
  }
  const trusted = TRUSTED_CATEGORIES.has(category);

  return {
    expectedTail,
    resolvedTail,
    category,
    tailMismatch,
    tailUnknown,
    untrustedNonStarlink,
    trusted,
    wifiProvider: result.wifiProvider,
    observation: {
      // Structural false-on-error guard: an error result NEVER carries an
      // observation, even when the checker also populated hasStarlink (the
      // 1.7k-row audit class).
      has_starlink:
        result.error || tailMismatch || untrustedNonStarlink ? null : result.hasStarlink,
      wifi_provider: tailMismatch || untrustedNonStarlink ? null : result.wifiProvider,
      tail_confirmed: tailMismatch ? 0 : tailUnknown ? null : 1,
      error: tailMismatch
        ? `Aircraft mismatch: flight has ${resolvedTail}`
        : untrustedNonStarlink
          ? "Tail not extracted — cannot attribute non-Starlink result"
          : result.error || null,
    },
    // Same guard for the swap side: an errored scrape is not a trustworthy
    // observation for the captured tail either.
    swapCapture:
      !result.error && tailMismatch && resolvedTail && result.wifiProvider
        ? {
            tail_number: resolvedTail,
            has_starlink: result.hasStarlink,
            wifi_provider: result.wifiProvider,
            aircraft_type: result.aircraftType ?? null,
          }
        : null,
  };
}

/** classifyCheckResult with the lazy ship-map fetch + resolve log both callers need. */
export function classifyUnitedCheck(
  db: Database,
  result: StarlinkCheckResult,
  expectedTail: string,
  log: VerdictLog = ownLog
): UnitedVerdict {
  const shipMap =
    !result.tailNumber && result.shipNumber
      ? getShipToTailMap(db)
      : (new Map() as ReadonlyMap<string, string>);
  const verdict = classifyCheckResult(result, expectedTail, shipMap);
  if (verdict.resolvedTail && !result.tailNumber) {
    log.info(`Resolved ship #${result.shipNumber} → ${verdict.resolvedTail}`);
  }
  return verdict;
}

/**
 * Write a classified united.com observation in one transaction: log row(s),
 * swap-capture settle, and the consensus-gated starlink_planes.verified_wifi
 * update — no divergence window between the log and the settle. Returns the
 * intended tail's consensus (null when the result wasn't trusted) so
 * discovery mode can derive united_fleet status from the same settle.
 */
export function applyUnitedObservation(
  db: Database,
  verdict: UnitedVerdict,
  opts: { flightNumber: string | null; aircraftType: string | null; log?: VerdictLog }
): WifiConsensus | null {
  const log = opts.log ?? ownLog;

  return db.transaction(() => {
    if (verdict.tailMismatch) {
      log.warn(
        `Aircraft mismatch: expected ${verdict.expectedTail} but flight has ${verdict.resolvedTail} — skipping verification update`
      );
    }

    logVerification(db, {
      tail_number: verdict.expectedTail,
      airline: "UA",
      source: UNITED_SOURCE,
      has_starlink: verdict.observation.has_starlink,
      wifi_provider: verdict.observation.wifi_provider,
      aircraft_type: opts.aircraftType,
      flight_number: opts.flightNumber,
      tail_confirmed: verdict.observation.tail_confirmed,
      error: verdict.observation.error,
    });

    if (verdict.swapCapture) {
      logVerification(db, {
        tail_number: verdict.swapCapture.tail_number,
        airline: "UA",
        source: UNITED_SOURCE,
        has_starlink: verdict.swapCapture.has_starlink,
        wifi_provider: verdict.swapCapture.wifi_provider,
        aircraft_type: verdict.swapCapture.aircraft_type,
        flight_number: opts.flightNumber,
        tail_confirmed: 1,
        error: null,
      });
      // Swap-captured tails never get a direct check soon — needsVerification
      // sees the log entry above and skips them — so settle their consensus
      // here or they'd be stuck accumulating obs forever.
      settleConsensus(db, verdict.swapCapture.tail_number, log, " (swap-captured)");
    }

    if (!verdict.trusted) {
      if (verdict.untrustedNonStarlink) {
        log.warn(
          `${verdict.expectedTail}: got "${verdict.wifiProvider}" but couldn't confirm tail number — skipping update to avoid false negative`
        );
      }
      return null;
    }

    // The log row above is already in the window, so consensus includes this
    // check. Gating the column write on the 30-day consensus means one flaky
    // scrape can't hide a plane.
    return settleConsensus(db, verdict.expectedTail, log);
  })();
}

function settleConsensus(db: Database, tail: string, log: VerdictLog, tag = ""): WifiConsensus {
  const consensus = computeWifiConsensus(db, tail, { sources: OBSERVED_WIFI_SOURCES });
  const status = consensusToFleetStatus(consensus.verdict);
  if (status !== null) {
    updateVerifiedWifi(db, tail, consensus.verdict);
    setFleetVerified(db, tail, consensus.verdict, status);
    log.info(`${tail}${tag}: verified_wifi → ${consensus.verdict} (${consensus.reason})`);
  } else {
    // Ambiguous — clear to NULL so the check-flight filter
    // (IS NULL OR = 'Starlink') falls through to spreadsheet trust.
    updateVerifiedWifi(db, tail, null);
    log.info(`${tail}${tag}: consensus ambiguous, verified_wifi cleared (${consensus.reason})`);
  }
  return consensus;
}

/**
 * Shared checker-failure row (the checker threw — no page observation).
 * Unified format: flight_number is the UA-prefixed number when known
 * (discovery previously logged null) and aircraft_type is whatever the
 * caller knows about the plane (the verifier previously logged null).
 */
export function logUnitedCheckFailure(
  db: Database,
  tailNumber: string,
  errorMessage: string,
  opts: { flightNumber: string | null; aircraftType: string | null }
): void {
  logVerification(db, {
    tail_number: tailNumber,
    airline: "UA",
    source: UNITED_SOURCE,
    has_starlink: null,
    wifi_provider: null,
    aircraft_type: opts.aircraftType,
    flight_number: opts.flightNumber,
    error: errorMessage,
  });
}
