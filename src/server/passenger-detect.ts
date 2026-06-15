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

// Single-fire send() guard so a >4s response can't double-beacon (timeout
// then onboard_api would land in different dedupe buckets).
export const PROBE_SNIPPET = `<script>(function(){try{
var done=0,send=function(o){if(done)return;done=1;try{navigator.sendBeacon&&navigator.sendBeacon("/api/passenger-probe",JSON.stringify(o))}catch(e){}};
setTimeout(function(){send({source:"probe",outcome:"timeout"})},4000);
fetch("${PROBE_CONNECT_ORIGINS[0]}/api/auth/token",{credentials:"omit",cache:"no-store"})
 .then(function(r){return r.ok?r.json().then(function(d){return{ok:1,d:d}}):{ok:0,status:r.status}})
 .then(function(r){
   if(r.ok&&r.d&&r.d.flightInfo){var f=r.d.flightInfo;
     send({source:"probe",outcome:"onboard_api",claimed_flight:(f.airlineCode||"")+(f.flightNumber||""),claimed_tail:f.tailNumber||null,claimed_date:f.flightDate||null});
   }else{send({source:"probe",outcome:r.ok?"onboard_noflight":"onboard_http_"+r.status});}
 })
 .catch(function(e){var m=String(e&&e.message||e);
   send({source:"probe",outcome:m.indexOf("CSP")>=0||m.indexOf("Content Security")>=0?"csp_blocked":m.indexOf("CORS")>=0||m.indexOf("cross-origin")>=0?"cors_blocked":"fetch_error"});
 });
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

  // Dedupe stops one device (or one fabricated curl loop) from stuffing the
  // table; rate-limiting per IP is already applied by the /api/* meter.
  if (passengerReportSeenRecently(db, ipPrefix, claimedTail, DEDUPE_WINDOW_SEC)) {
    return "duplicate";
  }

  metrics.increment(COUNTERS.PASSENGER_PROBE, {
    outcome,
    in_geofeed: inGeofeed ? "1" : "0",
    airline: normalizeAirlineTag(carrier?.code ?? null),
  });

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
