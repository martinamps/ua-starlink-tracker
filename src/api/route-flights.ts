/**
 * "Every flight on this route": the nonstop board behind the route pages, the
 * planner and GET /api/route-flights. For each marketed number seen on a pair
 * recently it gives that leg's Starlink odds (the same answer /api/check-flight
 * gives scoped to the leg), when it leaves, what it flies on this leg, and the
 * plane already assigned when there is one.
 *
 * Served from the DB only. The odds are a forecast, never a promise; the
 * board's one-line note says so once, not every row.
 */

import { aircraftName } from "../airlines/aircraft-families";
import type { AirlineConfig } from "../airlines/registry";
import {
  probLabel,
  zonedClock,
  zonedDeparture,
  zonedIsoDate,
  zonedMinutes,
  zonedWeekday,
} from "../components/ui/format";
import type { ScopedReader } from "../database/reader";
import type { RouteFlightLeg } from "../database/route-flights";
import {
  DAY_SEC,
  DEPARTURE_WINDOW_SEC,
  ROUTE_RECENT_SEC,
  isoDateDaysAgo,
  unixNow,
} from "../database/sql/windows";
import { LEG_MIN_DRAWS, carrierPrediction, predictLeg } from "../scripts/starlink-predictor";
import { airportTimezone, flightDateWindow, isRealIsoDate } from "../utils/airport-tz";
import { verdictSummary } from "./check-flight-core";

/** Below this many draws on the leg, its odds are the share of its aircraft types. */
export const ROUTE_BOARD_MIN_OBSERVATIONS = LEG_MIN_DRAWS;

/** Logged days a departure time needs before the board calls it usual. */
const USUAL_TIME_DAYS = 3;

/** A date the board answers for: yesterday through the booking horizon. */
const DATE_PAST_DAYS = 1;
const DATE_AHEAD_DAYS = 330;

export type AssignedStarlink = "verified" | "listed" | "none";

export interface RouteFlightAssignment {
  /** Departure-airport local date. */
  date: string;
  departure_time: number;
  tail_number: string;
  aircraft_type: string | null;
  starlink: AssignedStarlink;
  /** Already departed: the plane that flew, not one that will. */
  past: boolean;
  /** "Thu Oct 9 · N37525", or "Sat Oct 3 · flew on N37525". */
  label: string;
}

export interface RouteFlightRow {
  flight_number: string;
  /** Local clock time at the origin, no zone name: "8:15 AM". */
  typical_departure: string | null;
  /** "usually 8:15 AM", "next 2:30 PM" or "last seen 2:30 PM". */
  departure_label: string | null;
  /** Weekdays it was seen departing on this leg ("Mon"…"Sun"). */
  weekdays: string[];
  /** Days it was logged on this leg. */
  departures_logged: number;
  /** Logged on this leg on two or more days; one-offs are listed last. */
  established: boolean;
  /** With a date: seen on that weekday (true), only on others (false, listed last), unknown (null). */
  operates_on_date: boolean | null;
  probability: number | null;
  n_observations: number | null;
  confidence: string | null;
  /** "flight_history" from this leg's own draws, "aircraft_type" from type shares. */
  basis: "flight_history" | "aircraft_type";
  enough_history: boolean;
  /** The forecast: "93%", "~100%", "Not enough history". */
  odds_label: string;
  /** Aircraft it flies on this leg, most frequent first. */
  aircraft_types: string[];
  assignment: RouteFlightAssignment | null;
  /** The row in one line. */
  summary: string;
}

export interface RouteFlightBoard {
  origin: string;
  destination: string;
  airline: string;
  date: string | null;
  weekday: string | null;
  /** Any nonstop seen on the pair recently. */
  nonstop: boolean;
  min_observations: number;
  flights: RouteFlightRow[];
  note: string;
}

/** Yesterday through ~11 months out; anything else is a typo or a scrape. */
export function routeBoardDateOk(date: string, nowSec = unixNow()): boolean {
  if (!isRealIsoDate(date)) return false;
  return (
    date >= isoDateDaysAgo(DATE_PAST_DAYS, nowSec) &&
    date <= isoDateDaysAgo(-DATE_AHEAD_DAYS, nowSec)
  );
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

function assignmentOf(
  leg: RouteFlightLeg,
  zone: string | undefined,
  nowSec: number
): RouteFlightAssignment {
  const starlink: AssignedStarlink = leg.verified ? "verified" : leg.equipped ? "listed" : "none";
  const past = leg.departure_time <= nowSec;
  const day = `${zonedWeekday(leg.departure_time, zone)} ${zonedDeparture(leg.departure_time, zone).date}`;
  return {
    date: leg.dep_date,
    departure_time: leg.departure_time,
    tail_number: leg.tail_number,
    aircraft_type: leg.aircraft_type,
    starlink,
    past,
    label: past ? `${day} · flew on ${leg.tail_number}` : `${day} · ${leg.tail_number}`,
  };
}

interface Odds {
  probability: number | null;
  n_observations: number | null;
  confidence: string | null;
  basis: RouteFlightRow["basis"];
  enough_history: boolean;
  odds_label: string;
  aircraft: string[] | null;
}

const NO_HISTORY: Odds = {
  probability: null,
  n_observations: 0,
  confidence: null,
  basis: "flight_history",
  enough_history: false,
  odds_label: "Not enough history",
  aircraft: null,
};

/**
 * The leg's odds as /api/check-flight scoped to this origin and destination
 * gives them (predictLeg through verdictSummary), or the carrier's type share
 * where there is no flight-history model.
 */
function legOdds(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string,
  origin: string,
  destination: string,
  windowDate: string,
  nowSec: number
): Odds {
  const window = flightDateWindow(windowDate, nowSec);
  if (!window) return NO_HISTORY;
  if (cfg.flightHistoryModel) {
    const leg = predictLeg(reader, flightNumber, origin, destination, nowSec);
    if (!leg) return NO_HISTORY;
    const { basis, aircraft, ...pred } = leg;
    const s = verdictSummary({
      kind: "prediction",
      window,
      normalized: flightNumber,
      pred,
      fr24Error: false,
    });
    const p = s.probability ?? leg.probability;
    const history = basis === "leg_history";
    return {
      probability: p,
      n_observations: s.observations,
      confidence: pred.confidence,
      basis: history ? "flight_history" : "aircraft_type",
      enough_history: history,
      odds_label: history ? probLabel(p) : `~${probLabel(p)}`,
      aircraft,
    };
  }
  const s = verdictSummary({
    kind: "no_model",
    window,
    normalized: flightNumber,
    answer: carrierPrediction(cfg, reader, flightNumber),
    fr24Error: false,
  });
  return {
    probability: s.probability,
    n_observations: s.observations,
    confidence: s.confidence,
    basis: "aircraft_type",
    enough_history: s.probability !== null,
    odds_label: s.probability === null ? "Depends on aircraft" : `~${probLabel(s.probability)}`,
    aircraft: null,
  };
}

/** Display names of the types logged on the leg, most frequent first. */
function loggedTypes(days: readonly RouteFlightLeg[]): string[] {
  const counts = new Map<string, number>();
  for (const d of days) {
    if (!d.aircraft_type) continue;
    const name = aircraftName(d.aircraft_type);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name]) => name);
}

/** What a row is ranked on: the assigned plane when there is one, else the odds. */
function rankOdds(r: RouteFlightRow): number {
  const a = r.assignment;
  if (a && !a.past) return a.starlink === "none" ? 0 : 1;
  return r.probability ?? -1;
}

/** Listed first to last: regulars, flights not seen on the asked weekday, one-offs. */
function rankGroup(r: RouteFlightRow): number {
  if (!r.established) return 2;
  return r.operates_on_date === false ? 1 : 0;
}

function summaryOf(r: Omit<RouteFlightRow, "summary">): string {
  const odds =
    r.probability === null
      ? `${r.odds_label}.`
      : r.basis === "flight_history"
        ? `${r.odds_label} Starlink odds from ${r.n_observations} tracked flights.`
        : `${r.odds_label} Starlink odds by aircraft type.`;
  const a = r.assignment;
  if (!a) return odds;
  return `${odds} ${a.label} · ${a.starlink === "none" ? "No Starlink" : "Starlink"}.`;
}

export function buildRouteFlightBoard(
  cfg: AirlineConfig,
  reader: ScopedReader,
  origin: string,
  destination: string,
  opts: { date?: string | null; nowSec?: number } = {}
): RouteFlightBoard {
  const nowSec = opts.nowSec ?? unixNow();
  const date = opts.date && routeBoardDateOk(opts.date, nowSec) ? opts.date : null;
  const zone = airportTimezone(origin);
  const weekday = date ? zonedWeekday(Date.parse(`${date}T12:00:00Z`) / 1000, "UTC") : null;

  const legsByFlight = new Map<string, RouteFlightLeg[]>();
  for (const l of reader.getRouteFlightLegs(origin, destination, nowSec)) {
    const list = legsByFlight.get(l.flight_number);
    if (list) list.push(l);
    else legsByFlight.set(l.flight_number, [l]);
  }

  // Recent = logged this week or in the live schedule, or sighted in the
  // route cache within the week before the airline's newest observation.
  const anchor = reader.getObservationAnchor() || nowSec;
  const lastSeen = reader.getRouteFlightLastSeen(origin, destination);
  const sightings = new Map<string, number>();
  for (const f of reader.getRouteFlightNumbers(origin, destination).flightNumbers) {
    if (f.scheduled === 1 || anchor - (lastSeen.get(f.flight_number) ?? 0) <= ROUTE_RECENT_SEC) {
      sightings.set(f.flight_number, f.times);
    }
  }
  const numbers = new Set<string>([...legsByFlight.keys(), ...sightings.keys()]);

  const today = zone ? zonedIsoDate(nowSec, zone) : isoDateDaysAgo(0, nowSec);
  const rows: Array<RouteFlightRow & { minutes: number }> = [];
  for (const fn of numbers) {
    const days = latestPerDay(legsByFlight.get(fn) ?? []);
    const upcoming = days.find((d) => d.departure_time > nowSec);
    const newest = upcoming ?? days.at(-1);
    const clock = newest ? zonedClock(newest.departure_time, zone) : null;
    const departureLabel = !newest
      ? null
      : days.length >= USUAL_TIME_DAYS
        ? `usually ${clock}`
        : newest.departure_time > nowSec
          ? `next ${clock}`
          : `last seen ${clock}`;
    const weekdays = [...new Set(days.map((d) => zonedWeekday(d.departure_time, zone)))];
    const operates = weekday === null || days.length === 0 ? null : weekdays.includes(weekday);

    const shown = date
      ? days.find((d) => d.dep_date === date)
      : days.find(
          (d) => d.departure_time > nowSec && d.departure_time <= nowSec + DEPARTURE_WINDOW_SEC
        );
    const assignment = shown ? assignmentOf(shown, zone, nowSec) : null;
    const odds = legOdds(cfg, reader, fn, origin, destination, date ?? today, nowSec);
    const row: Omit<RouteFlightRow, "summary"> = {
      flight_number: fn,
      typical_departure: clock,
      departure_label: departureLabel,
      weekdays,
      departures_logged: days.length,
      // Two logged days, or a leg history (ADS-B included) that a one-off
      // can't build. The route cache's count only speaks for a number the log
      // never caught: it re-stamps one departure many times.
      established:
        days.length >= 2 ||
        (odds.basis === "flight_history" &&
          (odds.n_observations ?? 0) >= ROUTE_BOARD_MIN_OBSERVATIONS) ||
        (days.length === 0 && (sightings.get(fn) ?? 0) >= 2),
      operates_on_date: operates,
      probability: odds.probability,
      n_observations: odds.n_observations,
      confidence: odds.confidence,
      basis: odds.basis,
      enough_history: odds.enough_history,
      odds_label: odds.odds_label,
      aircraft_types: odds.aircraft ?? loggedTypes(days),
      assignment,
    };
    rows.push({
      ...row,
      summary: summaryOf(row),
      minutes: newest ? zonedMinutes(newest.departure_time, zone) : DAY_SEC,
    });
  }

  rows.sort(
    (a, b) =>
      rankGroup(a) - rankGroup(b) ||
      rankOdds(b) - rankOdds(a) ||
      a.minutes - b.minutes ||
      a.flight_number.localeCompare(b.flight_number)
  );

  const bases = new Set(rows.map((r) => r.basis));
  const source =
    bases.size === 2
      ? "recent flights and aircraft type"
      : bases.has("aircraft_type")
        ? "aircraft type"
        : "recent flights";
  return {
    origin,
    destination,
    airline: cfg.shortName,
    date,
    weekday,
    nonstop: numbers.size > 0,
    min_observations: ROUTE_BOARD_MIN_OBSERVATIONS,
    flights: rows.map(({ minutes: _, ...r }) => r),
    note: `Odds come from ${source}. Planes can be swapped before departure.`,
  };
}
