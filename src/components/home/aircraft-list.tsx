/**
 * The homepage's equipped-aircraft list: search, subfleet filters, and each
 * tail's upcoming flights as pills. The list is server-rendered and capped;
 * src/client/aircraft-list.ts filters the rendered rows in place.
 */
import { Fragment } from "react";
import { aircraftName } from "../../airlines/aircraft-families";
import type { AirlineContent } from "../../airlines/content";
import { ensureAirlinePrefix, isFlightZero } from "../../airlines/flight-number";
import {
  BY_TYPE_METHOD,
  BY_TYPE_TAB_NOTE,
  countedNames,
  listed,
  splitByMethod,
  trackingMethod,
} from "../../airlines/published-count";
import { AIRLINES, type AirlineConfig } from "../../airlines/registry";
import { FILTER_ACTIVE, FILTER_BUTTON, FILTER_INACTIVE } from "../../client/aircraft-list";
import type { Aircraft, Flight } from "../../types";
import { toIata } from "../../utils/airport-code";
import { Panel, SECTION_WIDE, SectionTitle, SkipLink, SkipTarget } from "../layout";
import { fmt, formatPillTime } from "../ui/format";

// SSR'ing every fleet row made the homepage a ~5 MB document with thousands of
// outbound links. The list is sorted freshest-first, so the first rows carry
// nearly all the value. Search and filters run over the rendered rows only: a
// tab still counts every aircraft of its kind (a count of the rendered rows
// read as "Hawaiian has none"), the note under the list says how many are
// shown, and a miss points at /fleet, which lists all.
const AIRCRAFT_LIST_CAP = 100;

// Keeps the arrow on the link's line where the note wraps.
const NBSP = "\u00a0";

// Pills per row before the "+N" button, by breakpoint: mobile, md, xl.
const PILLS_SM = 2;
const PILLS_MD = 4;
const PILLS_XL = 6;

/** The sheet's operator spelling for display: "Skywest dba UAX" → "SkyWest".
 * The Express badge already says United Express. */
export function operatorName(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/\s+(dba UAX|floater)$/i, "")
    .replace(/^Skywest\b/, "SkyWest")
    .trim();
}

/**
 * `/check-flight/{marketing number}` for a pill, or null when it can't reach a
 * real permalink and must keep its outbound link.
 *
 * The pill carries the OPERATING carrier's callsign (OO4757, SKW5366) but the
 * permalink is minted under the marketing code, so this goes through
 * ensureAirlinePrefix — never a bare prefix strip, which turns G74561 into
 * UA74561 instead of UA4561. Non-numeric callsigns (SKW394Y) normalize to
 * themselves and a foreign carrier's number belongs to no permalink this site
 * serves; both stay outbound rather than landing on the noindex generic page.
 */
function permalinker(airline: AirlineConfig | null, airlineByTail: Record<string, string>) {
  // Mirrors parseCheckFlightPath's gate. Built once: it runs against every pill.
  const pattern = airline ? new RegExp(`^${airline.iata}\\d{1,4}$`) : null;
  return (tailNumber: string, flightNumber: string): string | null => {
    if (!airline || !pattern) return null;
    if ((airlineByTail[tailNumber] || airline.code) !== airline.code) return null;
    const fn = ensureAirlinePrefix(airline, flightNumber);
    return pattern.test(fn) && !isFlightZero(fn) ? `/check-flight/${fn}` : null;
  };
}

function FlightPills({
  tailNumber,
  flights,
  permalink,
}: {
  tailNumber: string;
  flights: Flight[];
  permalink: (tail: string, fn: string) => string | null;
}) {
  if (flights.length === 0) {
    return <span className="text-muted text-xs italic font-mono">No flights scheduled</span>;
  }
  const mobileRemaining = Math.max(0, flights.length - PILLS_SM);
  const tabletRemaining = Math.max(0, flights.length - PILLS_MD);
  const desktopRemaining = Math.max(0, flights.length - PILLS_XL);
  // One button for every breakpoint; the count it shows and whether it shows
  // at all follow the same md/xl cut points as the pills themselves.
  const expandVisibility =
    desktopRemaining > 0
      ? "inline-flex"
      : tabletRemaining > 0
        ? "inline-flex xl:hidden"
        : "inline-flex md:hidden";
  return (
    <div className="flex flex-wrap gap-1.5" id={`flights-${tailNumber}`}>
      {flights.map((flight, idx) => {
        const dep = toIata(flight.departure_airport);
        const arr = toIata(flight.arrival_airport);
        const visibility =
          idx >= PILLS_XL
            ? "hidden"
            : idx >= PILLS_MD
              ? "hidden xl:inline-flex"
              : idx >= PILLS_SM
                ? "hidden md:inline-flex"
                : "inline-flex";
        // Every pill that can reach a permalink links to one: the anchor count
        // is the same either way, and deduping would point one flight number at
        // two destinations in one row.
        const href = permalink(tailNumber, flight.flight_number);
        // The tooltip names the destination: the marketing number the
        // permalink is filed under rather than the operating callsign.
        const tooltip = href ? href.slice("/check-flight/".length) : flight.flight_number;
        // departure_time is a UTC epoch; the clock is pinned to UTC and named,
        // 24-hour like /check-flight/{fn}, so the two read as one clock. From md
        // up the column header names the zone, so the pill drops it.
        const clock = formatPillTime(flight.departure_time);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a tail can fly one number twice
          <Fragment key={idx}>
            <a
              href={href ?? `https://www.flightaware.com/live/flight/${flight.flight_number}`}
              {...(href ? {} : { target: "_blank", rel: "nofollow noopener noreferrer" as const })}
              data-flight-tooltip={tooltip}
              // The visible text is an airport pair and a clock; the label restates
              // it with the flight number for screen readers (WCAG 2.5.3).
              aria-label={`Flight ${tooltip}, ${dep} to ${arr}, departs ${clock} UTC`}
              className={`flight-pill ${visibility}`}
            >
              <span className="text-accent font-medium">{dep}</span>{" "}
              <span className="text-muted">→</span>{" "}
              <span className="text-accent font-medium">{arr}</span>{" "}
              <span className="text-muted text-[10px]">
                {clock}
                <span className="md:hidden"> UTC</span>
              </span>
            </a>{" "}
          </Fragment>
        );
      })}
      {mobileRemaining > 0 && (
        <button
          type="button"
          className={`expand-flights ${expandVisibility} items-center px-2 py-1 border border-accent/70 hover:border-accent rounded text-xs text-accent font-mono font-medium transition-all cursor-pointer hover:bg-accent/10`}
          aria-expanded="false"
        >
          <span className="pill-more">
            <span className="md:hidden">+{mobileRemaining}</span>
            {tabletRemaining > 0 && (
              <span className="hidden md:inline xl:hidden">+{tabletRemaining}</span>
            )}
            {desktopRemaining > 0 && <span className="hidden xl:inline">+{desktopRemaining}</span>}
            {/* Only the count for this width is displayed, so the button's
                name reads "+4 more flights" rather than a bare "+4". */}
            <span className="sr-only"> more flights</span>
          </span>
          <span className="pill-less">
            <span aria-hidden="true">−</span>
            <span className="sr-only">Show fewer flights</span>
          </span>
        </button>
      )}
    </div>
  );
}

/** The data-* strings the client filter matches against, lowercased. */
function searchIndex(flights: Flight[], rowAirline: AirlineConfig | undefined) {
  const pairs = flights.map((f) => [
    toIata(f.departure_airport).toLowerCase(),
    toIata(f.arrival_airport).toLowerCase(),
  ]);
  return {
    airports: pairs.flat().join(" "),
    routes: pairs.flatMap(([d, a]) => [`${d}-${a}`, `${a}-${d}`]).join(" "),
    // The raw callsign plus its marketing number (ensureAirlinePrefix), so a
    // G7-coded flight is findable by the UA number its pill shows.
    flights: flights
      .flatMap((f) => {
        const marketing = rowAirline
          ? ensureAirlinePrefix(rowAirline, f.flight_number)
          : f.flight_number;
        return marketing === f.flight_number ? [f.flight_number] : [f.flight_number, marketing];
      })
      .join(" ")
      .toLowerCase(),
  };
}

/**
 * "89 of the 134 United and Alaska aircraft counted on this site, and 11 of
 * Hawaiian's 42 on our fleet list, counted by aircraft type, not checked plane
 * by plane": the rows a capped list shows, each kind against its own whole.
 * The two wholes are never added: only one of them is a count of aircraft.
 */
function capParts(
  aircraft: Aircraft[],
  shown: Aircraft[],
  airlineOf: (p: Aircraft) => string
): string | null {
  const per = (rows: Aircraft[]) => {
    const n = new Map<string, number>();
    for (const p of rows) n.set(airlineOf(p), (n.get(airlineOf(p)) ?? 0) + 1);
    return n;
  };
  const all = per(aircraft);
  const inView = per(shown);
  const split = splitByMethod([...all].map(([code, starlink]) => ({ code, starlink, total: 0 })));
  if (split.byType.length === 0 || split.counted.starlink === 0) return null;
  const of = (n: number) => (n === 0 ? "none" : fmt(n));
  const shownByType = split.byType.reduce((s, b) => s + (inView.get(b.cfg.code) ?? 0), 0);
  return [
    `${of(shown.length - shownByType)} of the ${fmt(split.counted.starlink)} ${countedNames(split)} aircraft counted on this site`,
    `${listed(
      split.byType.map(
        (b) => `${of(inView.get(b.cfg.code) ?? 0)} of ${b.cfg.shortName}'s ${fmt(b.sum)}`
      )
    )} on our fleet list, ${BY_TYPE_METHOD}`,
  ].join(", and ");
}

export function AircraftList({
  aircraft,
  content,
  airlineByTail,
  flightsByTail,
  permalinkAirline,
  showFleetLink,
  fleetTotal,
  tailPages = false,
  title = "Aircraft with Starlink",
}: {
  /** Every equipped tail, freshest flight data first. */
  aircraft: Aircraft[];
  content: AirlineContent;
  airlineByTail: Record<string, string>;
  flightsByTail: Record<string, Flight[]>;
  /** The site's airline where flight permalinks exist; null keeps pills outbound. */
  permalinkAirline: AirlineConfig | null;
  showFleetLink: boolean;
  /** Every aircraft /fleet lists, equipped or not: where a missed search falls back to. */
  fleetTotal: number;
  /** /fleet/{tail} serves for the permalink airline's planes. */
  tailPages?: boolean;
  /** Names the scope where it is narrower than the page's headline count. */
  title?: string;
}) {
  const airlineOf = (p: Aircraft) => airlineByTail[p.TailNumber] || "UA";
  const permalink = permalinker(permalinkAirline, airlineByTail);
  const shown = aircraft.slice(0, AIRCRAFT_LIST_CAP);
  const capped = aircraft.length > shown.length;
  const subfleetCount = (key: string) =>
    aircraft.filter((p) => p.fleet === key || airlineOf(p) === key).length;
  // A list over several airlines may hold one known by aircraft type: its tab
  // says so, and no figure adds its rows to the aircraft counted one by one.
  const byTypeKeys = new Set(
    content.subfleetFilters
      .map((f) => f.key)
      .filter((key) => AIRLINES[key] && trackingMethod(AIRLINES[key]) === "type")
  );
  const mixed = byTypeKeys.size > 0 && byTypeKeys.size < content.subfleetFilters.length;
  // Past the cap such a list says how many rows it shows of each kind, apart.
  const shownParts = mixed && capped ? capParts(aircraft, shown, airlineOf) : null;
  const countLabel = !capped
    ? ""
    : shownParts
      ? `${fmt(shown.length)} shown`
      : `${fmt(shown.length)} of ${fmt(aircraft.length)}`;

  return (
    <Panel pad="none" className={`${SECTION_WIDE} overflow-hidden`}>
      {/* Each row is a link, its flight pills and a "+N" button: without this a
          keyboard heading for what follows walks every one of them. */}
      {shown.length > 0 && <SkipLink to="aircraft-list-end">Skip the aircraft list</SkipLink>}
      <SectionTitle className="px-4 md:px-6 pt-4 pb-0">{title}</SectionTitle>
      <div className="px-4 md:px-6 py-3 border-b border-subtle">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <label htmlFor="aircraft-search" className="sr-only">
              Search aircraft by tail, route, airport or flight number
            </label>
            <input
              type="text"
              id="aircraft-search"
              placeholder="Tail, route (sfo-lax) or flight"
              className="w-full font-mono text-xs sm:text-sm px-4 py-2 pl-9 pr-8 bg-surface-elevated border border-neutral rounded text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-all"
            />
            <svg
              className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <button
              type="button"
              id="search-clear"
              className="absolute right-2 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted hover:text-primary transition-colors hidden"
              aria-label="Clear search"
            >
              <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>{" "}
          <div
            id="search-count"
            aria-live="polite"
            data-default={countLabel}
            className="hidden sm:flex items-center text-xs font-mono text-muted whitespace-nowrap"
          >
            {countLabel || null}
          </div>{" "}
          <div className="flex gap-1.5 sm:gap-2">
            <button
              type="button"
              id="filter-all"
              className={`${FILTER_BUTTON} ${FILTER_ACTIVE}`}
              aria-pressed="true"
              data-filter="all"
              data-count={shown.length}
            >
              ALL
              {mixed ? null : <span className="hidden sm:inline"> ({fmt(aircraft.length)})</span>}
            </button>{" "}
            {content.subfleetFilters.length > 1 &&
              content.subfleetFilters.map((card) => (
                <Fragment key={card.key}>
                  <button
                    type="button"
                    id={`filter-${card.key}`}
                    className={`${FILTER_BUTTON} ${FILTER_INACTIVE}`}
                    aria-pressed="false"
                    data-filter={card.key}
                  >
                    {card.label.toUpperCase()}{" "}
                    <span className="hidden sm:inline">
                      ({fmt(subfleetCount(card.key))}
                      {byTypeKeys.has(card.key) ? ` ${BY_TYPE_TAB_NOTE}` : ""})
                    </span>
                  </button>{" "}
                </Fragment>
              ))}
          </div>
        </div>
      </div>{" "}
      <div className="hidden md:grid md:grid-cols-12 gap-4 px-6 py-2.5 border-b border-subtle bg-surface-elevated/50 text-xs font-mono text-muted uppercase tracking-widest">
        <div className="col-span-3">Aircraft</div> <div className="col-span-2">Type</div>{" "}
        <div className="col-span-3">Operator</div>{" "}
        <div className="col-span-4">Upcoming flights (UTC)</div>
      </div>{" "}
      <div className="overflow-auto" style={{ maxHeight: "65vh" }}>
        {aircraft.length === 0 ? (
          <div className="p-12 text-center text-muted font-mono">
            No aircraft have Starlink yet.
          </div>
        ) : (
          <div className="divide-y divide-subtle">
            {shown.map((plane, idx) => {
              const airline = airlineOf(plane);
              const badge = content.rowBadge(plane, airline);
              const flights = flightsByTail[plane.TailNumber] || [];
              const index = searchIndex(flights, AIRLINES[airline]);
              return (
                <Fragment key={plane.TailNumber || idx}>
                  <div
                    className="js-aircraft-row group px-4 md:px-6 py-4 hover:bg-surface-elevated transition-all duration-200 cursor-default border-l-2 border-transparent hover:border-accent"
                    data-tail={plane.TailNumber.toLowerCase()}
                    data-aircraft={`${plane.Aircraft} ${aircraftName(plane.Aircraft)}`.toLowerCase()}
                    data-operator={(plane.OperatedBy || "").toLowerCase()}
                    data-fleet={plane.fleet}
                    data-airline={airline}
                    data-airports={index.airports}
                    data-routes={index.routes}
                    data-flights={index.flights}
                  >
                    <div className="md:grid md:grid-cols-12 md:gap-4 md:items-center">
                      <div className="md:col-span-3 flex items-start md:items-center justify-between md:justify-start gap-3 mb-3 md:mb-0">
                        <div className="flex items-center gap-3">
                          <div className="status-dot flex-shrink-0" />{" "}
                          <div>
                            <div className="font-mono text-base md:text-sm font-bold md:font-semibold text-primary group-hover:text-accent transition-colors">
                              {tailPages && airline === permalinkAirline?.code ? (
                                <a href={`/fleet/${plane.TailNumber}`} className="hover:underline">
                                  {plane.TailNumber}
                                </a>
                              ) : (
                                plane.TailNumber
                              )}
                            </div>{" "}
                            <div className="md:hidden font-mono text-xs text-secondary">
                              {aircraftName(plane.Aircraft)}
                            </div>{" "}
                            {badge && (
                              <div className="hidden md:block text-xs font-mono text-muted uppercase">
                                {badge}
                              </div>
                            )}
                          </div>
                        </div>{" "}
                        {badge && (
                          <div className="md:hidden text-xs font-mono text-accent uppercase">
                            {badge}
                          </div>
                        )}
                      </div>{" "}
                      <div className="hidden md:block md:col-span-2">
                        <span className="font-mono text-sm text-secondary">
                          {aircraftName(plane.Aircraft)}
                        </span>
                      </div>{" "}
                      <div className="md:col-span-3 text-xs md:text-sm text-muted mb-3 md:mb-0 pl-5 md:pl-0">
                        {badge && plane.OperatedBy === AIRLINES[airline]?.name
                          ? null
                          : operatorName(plane.OperatedBy) || "—"}
                      </div>{" "}
                      <div className="md:col-span-4 pt-3 md:pt-0 border-t md:border-t-0 border-subtle">
                        <FlightPills
                          tailNumber={plane.TailNumber}
                          flights={flights}
                          permalink={permalink}
                        />
                      </div>
                    </div>
                  </div>{" "}
                </Fragment>
              );
            })}
            <div id="list-empty" hidden className="px-4 md:px-6 py-10 text-center text-sm">
              <p className="text-secondary">No aircraft match.</p>{" "}
              {showFleetLink && (
                <p className="mt-1 text-muted">
                  <a
                    id="list-empty-fleet"
                    href="/fleet"
                    data-href="/fleet"
                    className="text-accent hover:underline"
                  >
                    Search all {fmt(fleetTotal)} aircraft on the fleet page
                  </a>
                </p>
              )}
            </div>
          </div>
        )}
      </div>{" "}
      {/* A paragraph, so index.html's rule underlines the accent link in it. */}
      {capped && (
        <p
          id="list-cap"
          className="px-4 md:px-6 py-3 border-t border-subtle text-center text-sm text-muted"
        >
          {shownParts
            ? `The ${fmt(shown.length)} most recently flown: ${shownParts}.`
            : `The ${fmt(shown.length)} most recently flown of ${fmt(aircraft.length)}.`}{" "}
          Search covers only these.
          {showFleetLink && (
            <>
              {" "}
              <a href="/fleet" className="text-accent">
                See all{NBSP}→
              </a>
            </>
          )}
        </p>
      )}{" "}
      {shown.length > 0 && (
        <SkipTarget id="aircraft-list-end">End of the aircraft list.</SkipTarget>
      )}
    </Panel>
  );
}
