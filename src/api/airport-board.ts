/**
 * "Which flights from this airport have Starlink?": the model behind
 * /routes/{airport}. The next 48 hours of departures on equipped planes (the
 * airport's slice of what /routes counts), grouped by destination, plus what
 * Starlink planes flew from here over the last few days.
 *
 * Served from the DB only. The share is the one figure that leans on an
 * outside record (the DOT census), and it carries that record's month.
 */

import { aircraftName } from "../airlines/aircraft-families";
import type { AirlineConfig } from "../airlines/registry";
import { fmt, monthYear, zonedDeparture } from "../components/ui/format";
import type { ScopedReader } from "../database/reader";
import { DEPARTURE_WINDOW_HOURS, unixNow } from "../database/sql/windows";
import { airportTimezone } from "../utils/airport-tz";
import { article } from "../utils/grammar";

/**
 * An airport page indexes, and joins the sitemap, once Starlink planes have
 * flown this many departures from it over the history span (two a day). Below
 * that the page is a line or two that changes with one aircraft swap: useful
 * to the visitor a route page sent, not worth a search result.
 */
export const AIRPORT_INDEX_MIN_DEPARTURES = 12;

/** Rows in the chronological list; the rest are under their destination. */
export const AIRPORT_NEXT_DEPARTURES = 10;

export interface AirportBoardDeparture {
  flight_number: string;
  destination: string;
  departure_time: number;
  /** "Mon, Nov 23" and "8:15 AM CST", local to the airport. */
  day: string;
  time: string;
  tail_number: string;
  /** Display name ("737 MAX 8"), null when the type is unknown. */
  aircraft: string | null;
  /** "verified": Starlink confirmed on that plane; "listed": listed as installed. */
  starlink: "verified" | "listed";
}

export interface AirportBoardDestination {
  destination: string;
  /** Departures on Starlink planes in the window, soonest first. */
  departures: AirportBoardDeparture[];
  /** Flown by Starlink planes over the history span. */
  recent: number;
  /** /route-planner/{airport}/{destination} serves. */
  linkable: boolean;
}

export interface AirportShare {
  /** Starlink's domestic departures a day over the history span. */
  starlinkPerDay: number;
  /** Every domestic departure a day in the census month. */
  allPerDay: number;
  /** starlinkPerDay / allPerDay, never above 1. */
  ratio: number;
  /** "Aug 2026". */
  month: string;
}

export interface AirportBoard {
  airport: string;
  /** Short airline name ("United"). */
  airline: string;
  windowHours: number;
  /** Every Starlink departure in the window, soonest first. */
  departures: AirportBoardDeparture[];
  /** Most window departures first, then most flown lately. */
  destinations: AirportBoardDestination[];
  /** Departures Starlink planes flew from here over the last `days` days. */
  history: { days: number; starlink: number };
  share: AirportShare | null;
  indexable: boolean;
}

export function buildAirportBoard(
  cfg: AirlineConfig,
  reader: ScopedReader,
  airport: string,
  nowSec = unixNow()
): AirportBoard {
  const zone = airportTimezone(airport);
  const departures: AirportBoardDeparture[] = reader
    .getAirportStarlinkDepartures(airport)
    .filter((d) => d.departure_time >= nowSec)
    .map((d) => {
      const at = zonedDeparture(d.departure_time, zone);
      return {
        flight_number: d.flight_number,
        destination: d.destination,
        departure_time: d.departure_time,
        day: at.day,
        time: at.time,
        tail_number: d.tail_number,
        aircraft: d.aircraft_type ? aircraftName(d.aircraft_type) : null,
        starlink: d.verified ? "verified" : "listed",
      };
    });

  const history = reader.getAirportHistory();
  const flown = history.airports.get(airport);
  const recent = new Map((flown?.destinations ?? []).map((d) => [d.destination, d.starlink]));

  const byDestination = new Map<string, AirportBoardDeparture[]>();
  for (const d of departures) {
    const list = byDestination.get(d.destination);
    if (list) list.push(d);
    else byDestination.set(d.destination, [d]);
  }
  const destinations: AirportBoardDestination[] = [
    ...new Set([...byDestination.keys(), ...recent.keys()]),
  ]
    .map((destination) => {
      const inWindow = byDestination.get(destination) ?? [];
      return {
        destination,
        departures: inWindow,
        recent: recent.get(destination) ?? 0,
        // A pair in the schedule always serves; one only the log holds may not.
        linkable: inWindow.length > 0 || reader.routeHasData(airport, destination),
      };
    })
    .sort(
      (a, b) =>
        b.departures.length - a.departures.length ||
        b.recent - a.recent ||
        a.destination.localeCompare(b.destination)
    );

  const census = reader.getAirportCensus();
  const performed = census?.performed.get(airport) ?? 0;
  let share: AirportShare | null = null;
  // Under a departure a day the census month is a handful of flights, and a
  // ratio against it is noise.
  if (census && flown && flown.domestic > 0 && performed >= census.daysInMonth) {
    const starlinkPerDay = flown.domestic / history.days;
    const allPerDay = performed / census.daysInMonth;
    // More Starlink departures than the census had departures at all: the
    // schedule has changed since that month (a seasonal station, a new route),
    // so the month is no denominator for this week.
    if (starlinkPerDay <= allPerDay) {
      share = {
        starlinkPerDay,
        allPerDay,
        ratio: starlinkPerDay / allPerDay,
        month: monthYear(census.month),
      };
    }
  }

  return {
    airport,
    airline: cfg.shortName,
    windowHours: DEPARTURE_WINDOW_HOURS,
    departures,
    destinations,
    history: { days: history.days, starlink: flown?.starlink ?? 0 },
    share,
    indexable: (flown?.starlink ?? 0) >= AIRPORT_INDEX_MIN_DEPARTURES,
  };
}

/** Airports whose page indexes: the sitemap's list, by the page's own rule. */
export function indexableAirports(reader: ScopedReader): string[] {
  return [...reader.getAirportHistory().airports]
    .filter(
      ([airport, e]) => e.starlink >= AIRPORT_INDEX_MIN_DEPARTURES && reader.airportHasData(airport)
    )
    .map(([airport]) => airport)
    .sort();
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** A daily rate: whole above ten, one decimal below, so 0.5 a day is not "1". */
export const perDayLabel = (n: number) => fmt(n, n >= 10 ? 0 : 1);

/**
 * The share in words. The two rates come from different months, so it is
 * "about", and buildAirportBoard leaves it off where they disagree outright.
 */
export function shareLabel(share: AirportShare): string {
  if (share.ratio < 0.01) return "Under 1%";
  return `About ${Math.round(share.ratio * 100)}%`;
}

/** The page's lead: the window's count, or the plainest true thing without one. */
export function airportDek(board: AirportBoard): string {
  const { airport, airline, windowHours, history } = board;
  const n = board.departures.length;
  const window = `the next ${windowHours} hours`;
  if (n > 0) {
    const m = board.destinations.filter((d) => d.departures.length > 0).length;
    return `${fmt(n)} ${airline} ${plural(n, "departure")} from ${airport} in ${window} ${n === 1 ? "is on a Starlink plane" : "are on Starlink planes"}, to ${fmt(m)} ${plural(m, "destination")}.`;
  }
  const none = `No Starlink plane is assigned to ${article(airline)} ${airline} departure from ${airport} in ${window}`;
  if (history.starlink > 0) {
    return `${none}. Starlink planes flew ${fmt(history.starlink)} from here in the last ${history.days} days.`;
  }
  return `${none}, and none flew from here in the last ${history.days} days.`;
}

/** The search snippet: the lead, and the next flight when there is one. */
export function airportMetaDescription(board: AirportBoard): string {
  const next = board.departures[0];
  if (!next) return airportDek(board);
  return `${airportDek(board)} The next is ${next.flight_number} to ${next.destination} on ${next.day} at ${next.time}.`;
}
