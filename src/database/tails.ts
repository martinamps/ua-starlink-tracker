/**
 * Readers behind /fleet/{tail}: everything the tables hold about one aircraft,
 * and the one rule for which tails have a page worth a search result.
 *
 * A tail has a page when the airline's roster or its Starlink listings name
 * it. The answer comes from the one equipped definition (sql/equipped.ts);
 * this file only adds the wording tiers a single plane needs (a sheet listing
 * our check contradicts, a reading with no listing behind it).
 *
 * Flights exist for tracked tails only: the updater follows the Starlink
 * roster, so a plane without Starlink has no schedule here and its page says
 * nothing about where it flies.
 */

import type { Database } from "bun:sqlite";
import { canonicalPermalinkFor, marketingFlightNumber } from "../airlines/flight-number";
import { AIRLINES } from "../airlines/registry";
import { normalizeWifiProvider } from "../observability/metrics";
import type { FaaRegistryRow, FirstFlight, FleetProgressTailRow, ReportedInstall } from "../types";
import { excludeMassWriteDays } from "../utils/install-rate";
import {
  CLEAN_OBSERVATION_WHERE,
  flyertalkFirstSyncDays,
  getDailyInstalls,
  getDepartureSlots,
  getFaaRegistryByTail,
  getFirstFlights,
  getFleetProgressTails,
  getListedNotCounted,
  isBulkRow,
} from "./database";
import { isEquipped, tailEvidence } from "./sql/equipped";
import { isCleanAirportPair } from "./sql/fragments";
import { DAY_SEC, TRAILING_WINDOW_DAYS, TRAILING_WINDOW_SEC, unixNow } from "./sql/windows";

/**
 * A US registration as a URL segment: N, then up to five characters. The
 * bound only keeps junk out of the lookup; the roster decides what exists.
 */
const TAIL_SEGMENT_RE = /^N[A-Z0-9]{1,5}$/;

/** How far ahead the page lists a tail's schedule: everything the cache holds. */
const TAIL_UPCOMING_SEC = 7 * DAY_SEC;

/**
 * The span "recent flights" covers. Six days, like the airport pages: the
 * assignment log is pruned seven local days back, so the seventh is partial.
 */
export const TAIL_RECENT_DAYS = 6;

/** The newest listing wins ties only after evidence: a row observed on
 * Starlink, then an unobserved one, then one observed on something else. The
 * same order equippedSql's EXISTS resolves duplicates in. */
const LISTING_ORDER = `CASE WHEN verified_wifi = 'Starlink' THEN 0 WHEN verified_wifi IS NULL THEN 1 ELSE 2 END, id`;

export type TailAnswerKind =
  /** Equipped, and observed carrying Starlink. */
  | "verified"
  /** Equipped by its listing; no observation of our own yet. */
  | "listed"
  /** The sheet lists it and no count includes it (sql/listed-not-counted.ts). */
  | "reported"
  /** Our check read Starlink, but no listing stands behind it. Not counted. */
  | "observed"
  /** Not equipped: settled or observed on something else. */
  | "other"
  | "unchecked";

interface TailClassInput {
  listing: { verified_wifi: string | null } | null;
  fleet: { starlink_status: string | null; verified_wifi: string | null } | null;
  /** In getListedNotCounted's "tail" scope: a sheet listing no count includes. */
  reported: boolean;
}

/** The page's answer tier, over the one evidence ranking. "verified" follows
 * the /fleet grid: either table observing Starlink on an equipped tail. */
export function classifyTail(i: TailClassInput): TailAnswerKind {
  const evidence = tailEvidence({ listed: i.listing, fleet: i.fleet });
  if (isEquipped(evidence)) {
    return evidence === "verified" || normalizeWifiProvider(i.fleet?.verified_wifi) === "starlink"
      ? "verified"
      : "listed";
  }
  if (i.reported) return "reported";
  if (evidence === "fleet_confirmed") return "observed";
  if (evidence === "settled_negative" || evidence === "verified_other") return "other";
  return namedOtherProvider(i.fleet?.verified_wifi) ? "other" : "unchecked";
}

/** A reading that names a provider (or "None") other than Starlink. */
function namedOtherProvider(raw: string | null | undefined): boolean {
  return ["viasat", "panasonic", "thales", "none"].includes(normalizeWifiProvider(raw));
}

/** The provider a non-equipped tail was read on, when a reading names one. */
export function otherProvider(i: Omit<TailClassInput, "reported">): string | null {
  const evidence = tailEvidence({ listed: i.listing, fleet: i.fleet });
  const raw =
    evidence === "verified_other" && namedOtherProvider(i.listing?.verified_wifi)
      ? i.listing?.verified_wifi
      : i.fleet?.verified_wifi;
  return namedOtherProvider(raw) ? (raw ?? null) : null;
}

/**
 * A tail's page indexes, and joins the sitemap, when it says more than a type
 * and a "no": the plane has Starlink, the sheet reports it, or the install
 * pipeline names it. Every other tail is served to whoever asks and kept out
 * of search, like a thin airport or a type with no signal.
 */
export function tailIndexable(kind: TailAnswerKind, inPipeline: boolean): boolean {
  return kind === "verified" || kind === "listed" || kind === "reported" || inPipeline;
}

/** `n12345`, `12345` or `N12345/` → `N12345` when the airline has that tail; else null. */
export function resolveTail(db: Database, airline: string, segment: string): string | null {
  const upper = segment.toUpperCase();
  const tail = upper.startsWith("N") ? upper : `N${upper}`;
  if (!TAIL_SEGMENT_RE.test(tail)) return null;
  const found = db
    .query(
      `SELECT 1 FROM united_fleet WHERE tail_number = ?1 AND airline = ?2
       UNION ALL
       SELECT 1 FROM starlink_planes WHERE TailNumber = ?1 AND airline = ?2
       LIMIT 1`
    )
    .get(tail, airline);
  return found ? tail : null;
}

export interface TailListing {
  aircraft: string | null;
  operated_by: string | null;
  fleet: string | null;
  verified_wifi: string | null;
  verified_at: number | null;
  /** YYYY-MM-DD the row joined our list; null when unstamped. */
  found: string | null;
  /** The date is a bulk import's, so the plane was equipped on or before it. */
  foundApprox: boolean;
  /** Written by our own discovery rather than the airline's fleet sheet. */
  ownDiscovery: boolean;
}

export interface TailFleetRow {
  aircraft_type: string | null;
  fleet: string | null;
  operated_by: string | null;
  starlink_status: string | null;
  verified_wifi: string | null;
  verified_at: number | null;
  ship_number: string | null;
}

export interface TailCheck {
  checked_at: number;
  has_starlink: boolean;
  wifi_provider: string;
  flight_number: string | null;
}

export interface TailChecks {
  last: TailCheck | null;
  total: number;
  starlink: number;
  /** Oldest check on record (unix sec); null with none. */
  since: number | null;
}

export interface TailRecord {
  airline: string;
  tail: string;
  kind: TailAnswerKind;
  /** Named provider behind a "reported" or "other" answer. */
  otherWifi: string | null;
  /** The log's row for a "reported" tail: why it isn't counted. */
  reported: ReportedInstall | null;
  /** The row /fleet marks "sheet lists Starlink, not counted" from, held past
   * the log's window too, where the kind is "other": the page then still says
   * what the sheet lists, so it cannot answer a plain "No" under a marked cell. */
  sheetListing: ReportedInstall | null;
  listing: TailListing | null;
  fleet: TailFleetRow | null;
  checks: TailChecks;
  /** The install pipeline's row, only while the tail is not equipped. */
  pipeline: FleetProgressTailRow | null;
  firstFlight: FirstFlight | null;
  faa: FaaRegistryRow | null;
  indexable: boolean;
}

/** Days whose DateFound is an import's, not a find: one sheet-tab load stamps
 * a hundred tails under an ordinary gid, visible only by its shape. */
function massImportDays(db: Database, airline: string): Set<string> {
  return new Set(excludeMassWriteDays(getDailyInstalls(db, airline)).excluded.map((d) => d.day));
}

/** The verifier's own readings of the tail: clean, and confirmed to be this plane. */
function tailChecks(db: Database, airline: string, tail: string): TailChecks {
  const where = `tail_number = ? AND airline = ? AND tail_confirmed = 1 AND ${CLEAN_OBSERVATION_WHERE}`;
  const agg = db
    .query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(has_starlink), 0) AS starlink, MIN(checked_at) AS since
       FROM starlink_verification_log WHERE ${where}`
    )
    .get(tail, airline) as { total: number; starlink: number; since: number | null };
  const last = db
    .query(
      `SELECT checked_at, has_starlink, wifi_provider, flight_number
       FROM starlink_verification_log WHERE ${where}
       ORDER BY checked_at DESC LIMIT 1`
    )
    .get(tail, airline) as {
    checked_at: number;
    has_starlink: number;
    wifi_provider: string;
    flight_number: string | null;
  } | null;
  return {
    last: last ? { ...last, has_starlink: last.has_starlink === 1 } : null,
    total: agg.total,
    starlink: agg.starlink,
    since: agg.since,
  };
}

export function getTailRecord(
  db: Database,
  airline: string,
  tail: string,
  nowSec = unixNow()
): TailRecord | null {
  const fleet = db
    .query(
      `SELECT aircraft_type, fleet, operated_by, starlink_status, verified_wifi, verified_at, ship_number
       FROM united_fleet WHERE tail_number = ? AND airline = ?`
    )
    .get(tail, airline) as TailFleetRow | null;
  const row = db
    .query(
      `SELECT aircraft, OperatedBy AS operated_by, fleet, verified_wifi, verified_at,
              DateFound AS found, sheet_gid
       FROM starlink_planes WHERE TailNumber = ? AND airline = ?
       ORDER BY ${LISTING_ORDER} LIMIT 1`
    )
    .get(tail, airline) as
    | (Omit<TailListing, "foundApprox" | "ownDiscovery"> & { sheet_gid: string | null })
    | null;
  if (!fleet && !row) return null;

  const found = /^\d{4}-\d{2}-\d{2}/.test(row?.found ?? "")
    ? (row?.found ?? "").slice(0, 10)
    : null;
  const listing: TailListing | null = row
    ? {
        aircraft: row.aircraft,
        operated_by: row.operated_by,
        fleet: row.fleet,
        verified_wifi: row.verified_wifi,
        verified_at: row.verified_at,
        found,
        foundApprox:
          found !== null &&
          (isBulkRow(row.sheet_gid, found, flyertalkFirstSyncDays(db)) ||
            massImportDays(db, airline).has(found)),
        ownDiscovery: row.sheet_gid === "discovery",
      }
    : null;

  const reportedRow =
    getListedNotCounted(db, airline, { scope: "tail", now: nowSec }).find(
      (r) => r.TailNumber === tail
    ) ?? null;
  const kind = classifyTail({ listing, fleet, reported: reportedRow !== null });
  const equipped = kind === "verified" || kind === "listed";
  const sheetListing =
    reportedRow ??
    (row && !equipped
      ? (getListedNotCounted(db, airline, { now: nowSec }).find((r) => r.TailNumber === tail) ??
        null)
      : null);
  const pipeline = equipped
    ? null
    : (getFleetProgressTails(db, airline).find((r) => r.tail === tail) ?? null);
  return {
    airline,
    tail,
    kind,
    otherWifi:
      kind === "reported"
        ? (reportedRow?.observed_wifi ?? null)
        : otherProvider({ listing, fleet }),
    reported: kind === "reported" ? reportedRow : null,
    sheetListing,
    listing,
    fleet,
    checks: tailChecks(db, airline, tail),
    pipeline,
    firstFlight: equipped ? (getFirstFlights(db, [tail], airline)[0] ?? null) : null,
    faa: getFaaRegistryByTail(db, tail),
    indexable: tailIndexable(kind, pipeline !== null),
  };
}

export interface TailFlight {
  /** The marketed number ("UA5212"), as the rest of the site prints it. */
  flight_number: string;
  /** /check-flight/{flight_number} serves. */
  linkable: boolean;
  origin: string;
  destination: string | null;
  departure_time: number;
}

function tailFlight(
  airline: string,
  raw: { flight_number: string; origin: string; destination: string | null; departure_time: number }
): TailFlight {
  const cfg = AIRLINES[airline];
  const fn = cfg ? marketingFlightNumber(cfg, raw.flight_number) : raw.flight_number;
  return {
    flight_number: fn,
    linkable: cfg ? canonicalPermalinkFor(cfg).test(fn) : false,
    origin: raw.origin,
    destination: raw.destination,
    departure_time: raw.departure_time,
  };
}

/** The tail's scheduled departures still ahead, soonest first, one row per departure. */
export function getTailUpcomingFlights(
  db: Database,
  airline: string,
  tail: string,
  nowSec = unixNow()
): TailFlight[] {
  return getDepartureSlots(db, airline, {
    from: nowSec,
    to: nowSec + TAIL_UPCOMING_SEC,
    tail,
  }).map((r) =>
    tailFlight(airline, {
      flight_number: r.slot_flight ?? r.flight_number,
      origin: r.departure_airport,
      destination: r.arrival_airport,
      departure_time: r.departure_time,
    })
  );
}

/**
 * Departures the tail really flew over the last TAIL_RECENT_DAYS, newest
 * first. The assignment log names the flight and the pair; departure_log says
 * the plane left on it (a leg swapped away before departure is never
 * archived). One row per departure, however many spellings logged it.
 */
export const TAIL_RECENT_SQL = `SELECT fal.flight_number, fal.departure_airport AS origin,
       fal.arrival_airport AS destination, fal.departure_time
  FROM flight_assignment_log fal
  WHERE fal.tail_number = ? AND fal.departure_time > ? AND fal.departure_time <= ?
    AND fal.airline = ?
    AND EXISTS (
      SELECT 1 FROM departure_log dl
      WHERE dl.tail_number = fal.tail_number AND dl.departed_at = fal.departure_time
        AND dl.airport = fal.departure_airport
    )
  ORDER BY fal.departure_time DESC, fal.flight_number`;

export function getTailRecentFlights(
  db: Database,
  airline: string,
  tail: string,
  nowSec = unixNow()
): TailFlight[] {
  const rows = db
    .query(TAIL_RECENT_SQL)
    .all(tail, nowSec - TAIL_RECENT_DAYS * DAY_SEC, nowSec, airline) as Array<{
    flight_number: string;
    origin: string;
    destination: string | null;
    departure_time: number;
  }>;
  const seen = new Set<string>();
  const out: TailFlight[] = [];
  for (const r of rows) {
    const key = `${r.origin}|${r.departure_time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tailFlight(airline, r));
  }
  return out;
}

export interface TailDepartures {
  days: number;
  total: number;
  /** Most departures first. */
  airports: Array<{ airport: string; departures: number }>;
}

/** Where the tail left from over departure_log's own retention. */
export function getTailDepartures(
  db: Database,
  airline: string,
  tail: string,
  nowSec = unixNow()
): TailDepartures {
  const airports = db
    .query(
      `SELECT airport, COUNT(*) AS departures FROM departure_log
       WHERE tail_number = ? AND departed_at > ? AND departed_at <= ? AND airline = ?
       GROUP BY airport ORDER BY departures DESC, airport`
    )
    .all(tail, nowSec - TRAILING_WINDOW_SEC, nowSec, airline) as Array<{
    airport: string;
    departures: number;
  }>;
  return {
    days: TRAILING_WINDOW_DAYS,
    total: airports.reduce((s, a) => s + a.departures, 0),
    airports,
  };
}

/** A route page exists only for a clean IATA pair. */
export function tailFlightPair(f: TailFlight): { origin: string; destination: string } | null {
  return f.destination && isCleanAirportPair(f.origin, f.destination)
    ? { origin: f.origin, destination: f.destination }
    : null;
}

export interface TailIndexEntry {
  tail: string;
  kind: TailAnswerKind;
  indexable: boolean;
  /** YYYY-MM-DD the tail joined our list, when that date is a real find. */
  found: string | null;
}

/**
 * Every tail that has a page, classified by the page's own rule in one pass:
 * the sitemap, llms.txt and the report's counts read this, so none of them
 * can disagree with the page about which tails index.
 */
export function getTailIndex(db: Database, airline: string, nowSec = unixNow()): TailIndexEntry[] {
  const fleet = new Map(
    (
      db
        .query(
          "SELECT tail_number, starlink_status, verified_wifi FROM united_fleet WHERE airline = ?"
        )
        .all(airline) as Array<{
        tail_number: string;
        starlink_status: string | null;
        verified_wifi: string | null;
      }>
    ).map((r) => [r.tail_number, r])
  );
  const listings = new Map<
    string,
    { verified_wifi: string | null; found: string | null; sheet_gid: string | null }
  >();
  for (const r of db
    .query(
      `SELECT TailNumber AS tail, verified_wifi, DateFound AS found, sheet_gid
       FROM starlink_planes WHERE airline = ? ORDER BY TailNumber, ${LISTING_ORDER}`
    )
    .all(airline) as Array<{
    tail: string;
    verified_wifi: string | null;
    found: string | null;
    sheet_gid: string | null;
  }>) {
    if (!listings.has(r.tail)) listings.set(r.tail, r);
  }
  const reported = new Set(
    getListedNotCounted(db, airline, { scope: "tail", now: nowSec }).map((r) => r.TailNumber)
  );
  const pipeline = new Set(getFleetProgressTails(db, airline).map((r) => r.tail));
  const massDays = massImportDays(db, airline);
  const firstSyncDays = flyertalkFirstSyncDays(db);

  return [...new Set([...fleet.keys(), ...listings.keys()])]
    .filter((tail) => TAIL_SEGMENT_RE.test(tail))
    .sort()
    .map((tail) => {
      const listing = listings.get(tail) ?? null;
      const kind = classifyTail({
        listing,
        fleet: fleet.get(tail) ?? null,
        reported: reported.has(tail),
      });
      const equipped = kind === "verified" || kind === "listed";
      const day = /^\d{4}-\d{2}-\d{2}/.test(listing?.found ?? "")
        ? (listing?.found ?? "").slice(0, 10)
        : null;
      const real =
        day !== null && !massDays.has(day) && !isBulkRow(listing?.sheet_gid, day, firstSyncDays);
      return {
        tail,
        kind,
        indexable: tailIndexable(kind, !equipped && pipeline.has(tail)),
        found: equipped && real ? day : null,
      };
    });
}
