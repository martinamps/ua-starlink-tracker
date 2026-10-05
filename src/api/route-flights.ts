/**
 * "Every flight on this route": the nonstop board behind the route pages, the
 * planner and GET /api/route-flights. For each marketed number seen on a pair
 * recently it states the Starlink odds the flight's own check-flight answer
 * gives (same predictor, same number), when it usually leaves, what it usually
 * flies, and the tail already assigned when one is.
 *
 * Served from the DB only. The odds are per flight number, never a promise;
 * the board's one-line note says so once, not every row.
 */

import { aircraftName } from "../airlines/aircraft-families";
import type { AirlineConfig } from "../airlines/registry";
import { probLabel, zonedDeparture, zonedIsoDate } from "../components/ui/format";
import type { ScopedReader } from "../database/reader";
import type { RouteFlightLeg } from "../database/route-flights";
import { DAY_SEC, DEPARTURE_WINDOW_SEC, unixNow } from "../database/sql/windows";
import { carrierPrediction, predictFlight } from "../scripts/starlink-predictor";
import { airportTimezone, flightDateWindow, isRealIsoDate } from "../utils/airport-tz";
import { verdictSummary } from "./check-flight-core";

/** Below this many observed draws a flight's percentage is mostly the prior. */
export const ROUTE_BOARD_MIN_OBSERVATIONS = 3;

/** "Recently" on a pair: the assignment log's own retention. Numbers last
 * seen longer ago are mostly schedule changes that now fly another pair. */
export const ROUTE_BOARD_RECENT_DAYS = 7;

/** Fewer logged days than this can't show that a weekday is missing. */
const WEEKDAY_EVIDENCE_DAYS = 5;

const MAX_TYPES = 3;

export type AssignedStarlink = "verified" | "listed" | "none";

export interface RouteFlightAssignment {
  /** Departure-airport local date. */
  date: string;
  departure_time: number;
  tail_number: string;
  aircraft_type: string | null;
  starlink: AssignedStarlink;
  /** "Thu Oct 9 · N37525 · Starlink"; `starlink` says verified or listed. */
  label: string;
}

export interface RouteFlightRow {
  flight_number: string;
  /** Most common recent local departure time at the origin, e.g. "6:30 AM PDT". */
  typical_departure: string | null;
  /** Weekdays it was seen departing ("Mon"…"Sun"), from logged departures. */
  weekdays: string[];
  /** Departures behind typical_departure and weekdays. */
  departures_logged: number;
  /** With a date: seen on that weekday (true), seen only on others (false), unknown (null). */
  operates_on_date: boolean | null;
  probability: number | null;
  n_observations: number | null;
  confidence: string | null;
  /** "flight_history" for the per-flight predictor, "aircraft_type" for registry shares. */
  basis: "flight_history" | "aircraft_type";
  enough_history: boolean;
  /** Short odds label for a table cell: "93%", "~100%", "Not enough history". */
  odds_label: string;
  /** Aircraft families it usually gets, most frequent first. */
  aircraft_types: string[];
  assignment: RouteFlightAssignment | null;
  /** The row in one line: odds, their basis, and the next assigned plane. */
  summary: string;
}

export interface RouteFlightBoard {
  origin: string;
  destination: string;
  airline: string;
  date: string | null;
  weekday: string | null;
  /** Any nonstop seen on the pair recently, before the date filter. */
  nonstop: boolean;
  min_observations: number;
  flights: RouteFlightRow[];
  note: string;
}

const weekdayOf = (sec: number, zone: string | null | undefined) =>
  zonedDeparture(sec, zone).day.split(",")[0];

/** "6:30 AM PDT" → minutes after midnight, for ordering equal odds by time. */
function clockMinutes(label: string | null): number {
  const m = label?.match(/(\d{1,2}):(\d{2})\s*([AP])M/i);
  if (!m) return Number.POSITIVE_INFINITY;
  return ((Number(m[1]) % 12) + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + Number(m[2]);
}

function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** One leg per flight and local day: the tail seen last, so a swap replaces it. */
function latestPerDay(legs: readonly RouteFlightLeg[]): RouteFlightLeg[] {
  const best = new Map<string, RouteFlightLeg>();
  for (const l of legs) {
    const prev = best.get(l.dep_date);
    if (!prev || l.last_seen > prev.last_seen) best.set(l.dep_date, l);
  }
  return [...best.values()].sort((a, b) => a.departure_time - b.departure_time);
}

function assignmentOf(leg: RouteFlightLeg, zone: string | undefined): RouteFlightAssignment {
  const starlink: AssignedStarlink = leg.verified ? "verified" : leg.equipped ? "listed" : "none";
  return {
    date: leg.dep_date,
    departure_time: leg.departure_time,
    tail_number: leg.tail_number,
    aircraft_type: leg.aircraft_type,
    starlink,
    label: [
      zonedDeparture(leg.departure_time, zone).day.replace(",", ""),
      leg.tail_number,
      starlink === "none" ? "No Starlink" : "Starlink",
    ].join(" · "),
  };
}

interface Odds {
  probability: number | null;
  n_observations: number | null;
  confidence: string | null;
  basis: RouteFlightRow["basis"];
  enough_history: boolean;
  odds_label: string;
  sentence: string;
}

/**
 * The odds a flight's own check-flight answer would give, read through
 * verdictSummary so the board and /api/check-flight cannot disagree.
 */
function flightOdds(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string,
  dateForWindow: string
): Odds {
  const window = flightDateWindow(dateForWindow);
  if (!window) throw new Error(`invalid board date ${dateForWindow}`);
  if (cfg.flightHistoryModel) {
    const pred = predictFlight(reader, flightNumber);
    const s = verdictSummary({
      kind: "prediction",
      window,
      normalized: flightNumber,
      pred,
      fr24Error: false,
    });
    const n = s.observations ?? 0;
    const enough = s.probability !== null && n >= ROUTE_BOARD_MIN_OBSERVATIONS;
    return {
      probability: s.probability,
      n_observations: n,
      confidence: pred.confidence,
      basis: "flight_history",
      enough_history: enough,
      odds_label:
        enough && s.probability !== null ? probLabel(s.probability) : "Not enough history",
      sentence:
        enough && s.probability !== null
          ? `${probLabel(s.probability)} Starlink odds from ${n} flights.`
          : `Not enough history (${n} flight${n === 1 ? "" : "s"}).`,
    };
  }
  const answer = carrierPrediction(cfg, reader, flightNumber);
  const s = verdictSummary({
    kind: "no_model",
    window,
    normalized: flightNumber,
    answer,
    fr24Error: false,
  });
  return {
    probability: s.probability,
    n_observations: s.observations,
    confidence: s.confidence,
    basis: "aircraft_type",
    enough_history: s.probability !== null,
    odds_label: s.probability === null ? "Depends on aircraft" : `~${probLabel(s.probability)}`,
    sentence:
      s.probability === null
        ? "Starlink depends on the aircraft type."
        : `~${probLabel(s.probability)} Starlink odds by aircraft type.`,
  };
}

export function buildRouteFlightBoard(
  cfg: AirlineConfig,
  reader: ScopedReader,
  origin: string,
  destination: string,
  opts: { date?: string | null; nowSec?: number } = {}
): RouteFlightBoard {
  const nowSec = opts.nowSec ?? unixNow();
  const date = opts.date && isRealIsoDate(opts.date) ? opts.date : null;
  const zone = airportTimezone(origin);
  const weekday = date ? weekdayOf(Date.parse(`${date}T12:00:00Z`) / 1000, "UTC") : null;

  const legsByFlight = new Map<string, RouteFlightLeg[]>();
  for (const l of reader.getRouteFlightLegs(origin, destination)) {
    const list = legsByFlight.get(l.flight_number);
    if (list) list.push(l);
    else legsByFlight.set(l.flight_number, [l]);
  }

  // Recent = in the live schedule, logged this week, or sighted in the route
  // cache within the same week of the airline's newest observation.
  const anchor = reader.getObservationAnchor() || nowSec;
  const lastSeen = reader.getRouteFlightLastSeen(origin, destination);
  const numbers = new Set<string>(legsByFlight.keys());
  for (const f of reader.getRouteFlightNumbers(origin, destination).flightNumbers) {
    const seen = lastSeen.get(f.flight_number) ?? 0;
    if (f.scheduled === 1 || anchor - seen <= ROUTE_BOARD_RECENT_DAYS * DAY_SEC) {
      numbers.add(f.flight_number);
    }
  }

  const today = zone
    ? zonedIsoDate(nowSec, zone)
    : new Date(nowSec * 1000).toISOString().slice(0, 10);
  const rows: Array<RouteFlightRow & { sortMinutes: number }> = [];
  for (const fn of numbers) {
    const days = latestPerDay(legsByFlight.get(fn) ?? []);
    const departed = days.filter((d) => d.departure_time <= nowSec);
    const timed = departed.length > 0 ? departed : days;
    const typical = mostCommon(timed.map((d) => zonedDeparture(d.departure_time, zone).time));
    const weekdays = [...new Set(days.map((d) => weekdayOf(d.departure_time, zone)))];
    const operates =
      weekday === null || days.length === 0
        ? null
        : weekdays.includes(weekday)
          ? true
          : days.length >= WEEKDAY_EVIDENCE_DAYS
            ? false
            : null;
    if (operates === false) continue;

    const types = mostCommonList(days.map((d) => d.aircraft_type).filter(Boolean) as string[]);
    const upcoming = date
      ? days.find((d) => d.dep_date === date)
      : days.find(
          (d) => d.departure_time > nowSec && d.departure_time <= nowSec + DEPARTURE_WINDOW_SEC
        );
    const assignment = upcoming ? assignmentOf(upcoming, zone) : null;

    const odds = flightOdds(cfg, reader, fn, date ?? today);
    rows.push({
      flight_number: fn,
      typical_departure: typical,
      weekdays,
      departures_logged: days.length,
      operates_on_date: operates,
      probability: odds.probability,
      n_observations: odds.n_observations,
      confidence: odds.confidence,
      basis: odds.basis,
      enough_history: odds.enough_history,
      odds_label: odds.odds_label,
      aircraft_types: types,
      assignment,
      summary: assignment ? `${odds.sentence} Next: ${assignment.label}.` : odds.sentence,
      sortMinutes: clockMinutes(typical),
    });
  }

  rows.sort(
    (a, b) =>
      Number(b.enough_history) - Number(a.enough_history) ||
      (b.probability ?? -1) - (a.probability ?? -1) ||
      a.sortMinutes - b.sortMinutes ||
      a.flight_number.localeCompare(b.flight_number)
  );

  return {
    origin,
    destination,
    airline: cfg.name,
    date,
    weekday,
    nonstop: numbers.size > 0,
    min_observations: ROUTE_BOARD_MIN_OBSERVATIONS,
    flights: rows.map(({ sortMinutes: _, ...r }) => r),
    note: `Odds come from ${cfg.flightHistoryModel ? "recent flights" : "aircraft type"}. Planes can be swapped before departure.`,
  };
}

/** Distinct display names, most frequent first. */
function mostCommonList(raw: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const r of raw) {
    const name = aircraftName(r);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TYPES)
    .map(([name]) => name);
}
