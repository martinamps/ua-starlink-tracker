/**
 * Passenger-verify dark launch. Detects whether a request's cf-connecting-ip
 * is in Starlink's geofeed, and for matching visitors injects a no-UI probe
 * that beacons whether onboard.united.com's flight API resolves from their
 * browser. Everything client-sent is treated as untrusted claim; the only
 * server-observed signal is the IP. PASSENGER_VERIFY env: "off" disables
 * everything, "on" would surface UI (not built yet), default = probe only.
 */

import { createHash } from "node:crypto";
import {
  buildAirlineFlightNumberVariants,
  detectMarketingCarrier,
  ensureAirlinePrefix,
} from "../airlines/flight-number";
import { looksLikeValidTailNumber } from "../airlines/registry";
import {
  getStarlinkPrefixes,
  isFlightAirborne,
  passengerReportSeenRecently,
  recordPassengerReport,
} from "../database/database";
import type { Database } from "../database/reader";
import { COUNTERS, metrics, normalizeAirlineTag, normalizeProbeOutcome } from "../observability";
import { PROBE_CONNECT_ORIGINS } from "../utils/constants";
import { PrefixSet, dedupePrefix } from "../utils/ip-prefix";
import { info } from "../utils/logger";

export const PASSENGER_VERIFY_MODE = process.env.PASSENGER_VERIFY ?? "probe";
export const passengerVerifyEnabled = PASSENGER_VERIFY_MODE !== "off";

/** Single audience gate for both the auto-probe snippet and the visible banner. */
export function isPassengerVerifyAudience(onStarlinkIp: boolean, siteScope: string): boolean {
  return passengerVerifyEnabled && onStarlinkIp && siteScope === "UA";
}
const DEDUPE_WINDOW_SEC = 6 * 3600;
const RELOAD_TTL_MS = 10 * 60 * 1000;

export class StarlinkIpDetector {
  private prefixes: PrefixSet;
  private loadedAt = Date.now();

  constructor(private readonly db: Database) {
    this.prefixes = new PrefixSet(getStarlinkPrefixes(db));
  }

  /** Self-refreshes from the table at most once per RELOAD_TTL — the daily
   * geofeed job has no back-channel into the app, so this is how new prefixes
   * land in the matcher without exposing a reload hook on App. */
  match(ip: string): boolean {
    if (Date.now() - this.loadedAt > RELOAD_TTL_MS) {
      this.prefixes = new PrefixSet(getStarlinkPrefixes(this.db));
      this.loadedAt = Date.now();
      info(`passenger-detect: reloaded ${this.prefixes.size} Starlink prefixes`);
    }
    return this.prefixes.contains(ip);
  }
}

// Browsers report a CORS reject as a bare TypeError, so the only readable
// signal is opaque resolve vs reject — that's all we beacon.
export const PROBE_SNIPPET = `<script>(function(){try{
var done=0,send=function(o){if(done)return;done=1;try{navigator.sendBeacon&&navigator.sendBeacon("/api/passenger-probe",JSON.stringify(o))}catch(e){}};
setTimeout(function(){send({source:"probe",outcome:"timeout"})},4000);
fetch("${PROBE_CONNECT_ORIGINS[0]}/api/auth/token",{mode:"no-cors",credentials:"omit",cache:"no-store"})
 .then(function(){send({source:"probe",outcome:"onboard_reachable"})})
 .catch(function(){send({source:"probe",outcome:"onboard_unreachable"})});
}catch(e){}})();</script>`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ProbeBody {
  source?: unknown;
  outcome?: unknown;
  claimed_flight?: unknown;
  claimed_tail?: unknown;
  claimed_date?: unknown;
  router_id?: unknown;
}

function clampString(v: unknown, max: number, re?: RegExp): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, max);
  if (s === "") return null;
  return re && !re.test(s) ? null : s;
}

export function handlePassengerProbe(
  db: Database,
  ip: string,
  inGeofeed: boolean,
  userAgent: string | null,
  body: ProbeBody
): "duplicate" | "stored" {
  const ipPrefix = dedupePrefix(ip) ?? ip;

  const source = clampString(body.source, 16, /^(probe|manual)$/) ?? "probe";
  const outcome = normalizeProbeOutcome(clampString(body.outcome, 32));
  const claimedFlightRaw = clampString(body.claimed_flight, 8)?.toUpperCase() ?? null;
  const carrier = claimedFlightRaw ? detectMarketingCarrier(claimedFlightRaw) : null;
  const claimedFlight = carrier ? ensureAirlinePrefix(carrier, claimedFlightRaw!) : null;
  const claimedTailRaw = clampString(body.claimed_tail, 10);
  const claimedTail =
    claimedTailRaw && looksLikeValidTailNumber(claimedTailRaw.toUpperCase())
      ? claimedTailRaw.toUpperCase()
      : null;
  const claimedDate = clampString(body.claimed_date, 10, DATE_RE);
  const routerId = clampString(body.router_id, 64);
  const uaHash = userAgent
    ? createHash("sha256").update(userAgent).digest("hex").slice(0, 16)
    : null;

  // Metric first so deduped beacons stay visible in DD; the dedupe key
  // includes source so the auto-probe row can never swallow a manual submit.
  metrics.increment(COUNTERS.PASSENGER_PROBE, {
    outcome,
    source,
    in_geofeed: inGeofeed ? "1" : "0",
    airline: normalizeAirlineTag(carrier?.code ?? null),
  });

  if (passengerReportSeenRecently(db, ipPrefix, source, claimedTail, DEDUPE_WINDOW_SEC)) {
    return "duplicate";
  }

  const variants =
    carrier && claimedFlight ? buildAirlineFlightNumberVariants(carrier, claimedFlight) : [];
  recordPassengerReport(db, {
    ip,
    ip_prefix: ipPrefix,
    in_geofeed: inGeofeed,
    source,
    outcome,
    claimed_flight: claimedFlight,
    claimed_tail: claimedTail,
    claimed_date: claimedDate,
    router_id: routerId,
    ua_hash: uaHash,
    airborne_match: inGeofeed && isFlightAirborne(db, variants),
  });
  return "stored";
}
