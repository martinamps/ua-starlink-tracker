/**
 * "Which flights from this airport have Starlink?": the model behind
 * /routes/{airport}. The next 48 hours of departures on equipped planes (the
 * airport's slice of what /routes counts), grouped by destination, plus what
 * Starlink planes flew from here over the last few days.
 *
 * Served from the DB only. It prints counts and never a share of the
 * airport's departures: the schedule tables hold Starlink planes alone, and
 * the one stored record of every departure (the DOT census) is months old,
 * which moves an airport's total by a quarter or more between seasons.
 */

import { aircraftName } from "../airlines/aircraft-families";
import { TITLE_MAX } from "../airlines/aircraft-pages";
import type { AirlineConfig } from "../airlines/registry";
import { fmt, zonedDeparture } from "../components/ui/format";
import { countOnLocalDay, nextLocalDay } from "../database/airports";
import type { ScopedReader } from "../database/reader";
import { DEPARTURE_WINDOW_HOURS, unixNow } from "../database/sql/windows";
import { airportWithCode } from "../utils/airport-names";
import { airportTimezone } from "../utils/airport-tz";
import { article } from "../utils/grammar";
import { AIRPORT_RANK_MIN_DEPARTURES } from "./airport-ranking";

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

export interface AirportBoard {
  airport: string;
  /** The city and airport beside the code, "Chicago O'Hare (ORD)"; the code
   * alone for an airport we hold no name for. */
  place: string;
  /** False for an airport with no mapped timezone: its times print in UTC,
   * and the page has to say so. */
  localTimes: boolean;
  /** Short airline name ("United"). */
  airline: string;
  windowHours: number;
  /** Every Starlink departure in the window, soonest first. */
  departures: AirportBoardDeparture[];
  /** Most window departures first, then most flown lately. */
  destinations: AirportBoardDestination[];
  /** Departures Starlink planes flew from here over the last `days` days. */
  history: { days: number; starlink: number };
  /**
   * The airport's next local day (YYYY-MM-DD), the Starlink departures in
   * `departures` that leave on it, and where that puts the airport among those
   * ranked on /routes (null under the ranking's minimum). Null for an airport
   * with no mapped timezone.
   */
  day: { date: string; departures: number; rank: number | null; ranked: number } | null;
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

  const date = nextLocalDay(airport, nowSec);

  return {
    airport,
    place: airportWithCode(airport),
    localTimes: Boolean(zone),
    airline: cfg.shortName,
    windowHours: DEPARTURE_WINDOW_HOURS,
    departures,
    destinations,
    history: { days: history.days, starlink: flown?.starlink ?? 0 },
    day: date
      ? dayStanding(reader, airport, date, countOnLocalDay(airport, date, departures))
      : null,
    indexable: (flown?.starlink ?? 0) >= AIRPORT_INDEX_MIN_DEPARTURES,
  };
}

/**
 * The day's count with its place among the ranked airports. The rank is read
 * off the other airports' counts, so it agrees with this page's own number
 * even when the shared ranking was built a minute earlier.
 */
function dayStanding(
  reader: ScopedReader,
  airport: string,
  date: string,
  departures: number
): NonNullable<AirportBoard["day"]> {
  const others = reader
    .getAirportDayCounts()
    .filter((c) => c.airport !== airport && c.departures >= AIRPORT_RANK_MIN_DEPARTURES);
  const ranks = departures >= AIRPORT_RANK_MIN_DEPARTURES;
  return {
    date,
    departures,
    rank: ranks ? others.filter((c) => c.departures > departures).length + 1 : null,
    ranked: others.length + (ranks ? 1 : 0),
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

/** The page's lead: the window's count, or the plainest true thing without one. */
export function airportDek(board: AirportBoard): string {
  const { place, airline, windowHours, history } = board;
  const n = board.departures.length;
  const window = `the next ${windowHours} hours`;
  if (n > 0) {
    const m = board.destinations.filter((d) => d.departures.length > 0).length;
    return `${fmt(n)} ${airline} ${plural(n, "departure")} from ${place} in ${window} ${n === 1 ? "is on a Starlink plane" : "are on Starlink planes"}, to ${fmt(m)} ${plural(m, "destination")}.`;
  }
  const none = `No Starlink plane is assigned to ${article(airline)} ${airline} departure from ${place} in ${window}`;
  if (history.starlink > 0) {
    return `${none}. Starlink planes flew ${fmt(history.starlink)} from here in the last ${history.days} days.`;
  }
  return `${none}, and none flew from here in the last ${history.days} days.`;
}

/**
 * The page's question as its <title>. A long place name ("Houston Bush
 * Intercontinental (IAH)") takes a shorter wording rather than a cut-off one.
 */
export function airportTitle(board: AirportBoard): string {
  const { airline, place } = board;
  return (
    [
      airportQuestion(board),
      `${airline} Flights With Starlink From ${place}`,
      `Starlink Flights From ${place}`,
    ].find((t) => t.length <= TITLE_MAX) ?? `Starlink Flights From ${board.airport}`
  );
}

/** The question the H1 asks, with the carrier, as on the route pages. */
export function airportQuestion(board: AirportBoard): string {
  return `Which ${board.airline} Flights From ${board.place} Have Starlink?`;
}

/**
 * The search snippet: the lead, and the next flight when there is one and it
 * fits whole under `max`. The destination gives up its city before the
 * sentence is dropped: a snippet that ends mid-flight says less than the lead.
 */
export function airportMetaDescription(board: AirportBoard, max: number): string {
  const lead = airportDek(board);
  const next = board.departures[0];
  if (!next) return lead;
  const sentence = (to: string) =>
    `${lead} The next is ${next.flight_number} to ${to} on ${next.day} at ${next.time}.`;
  return (
    [sentence(airportWithCode(next.destination)), sentence(next.destination)].find(
      (t) => t.length <= max
    ) ?? lead
  );
}
