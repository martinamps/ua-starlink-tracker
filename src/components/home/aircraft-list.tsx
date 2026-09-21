/**
 * The homepage's equipped-aircraft list: search, subfleet filters, and each
 * tail's upcoming flights as pills. The list is server-rendered and capped;
 * src/client/aircraft-list.ts filters the rendered rows in place.
 */
import type { AirlineContent } from "../../airlines/content";
import { ensureAirlinePrefix } from "../../airlines/flight-number";
import { AIRLINES, type AirlineConfig } from "../../airlines/registry";
import { FILTER_ACTIVE, FILTER_BUTTON, FILTER_INACTIVE } from "../../client/aircraft-list";
import type { Aircraft, Flight } from "../../types";
import { toIata } from "../../utils/airport-code";
import { SectionTitle } from "../layout";
import { fmt, formatPillTime } from "../ui/format";

// SSR'ing every fleet row made the homepage a ~5 MB document with thousands of
// outbound links. The list is sorted freshest-first, so the first rows carry
// nearly all the value. Search and filters run over the rendered rows only, so
// chip counts describe those rows and a miss points at /fleet, which lists all.
const AIRCRAFT_LIST_CAP = 100;

// Pills per row before the "+N" button, by breakpoint: mobile, md, xl.
const PILLS_SM = 2;
const PILLS_MD = 4;
const PILLS_XL = 6;

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
    return pattern.test(fn) ? `/check-flight/${fn}` : null;
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
        // 24-hour like /check-flight/{fn}, so the two read as one clock.
        const when = formatPillTime(flight.departure_time);
        return (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: a tail can fly one number twice
            key={idx}
            href={href ?? `https://www.flightaware.com/live/flight/${flight.flight_number}`}
            {...(href ? {} : { target: "_blank", rel: "nofollow noopener noreferrer" as const })}
            data-flight-tooltip={tooltip}
            // The visible text is an airport pair and a clock; the label restates
            // it with the flight number for screen readers (WCAG 2.5.3).
            aria-label={`Flight ${tooltip}, ${dep} to ${arr}, departs ${when}`}
            className={`flight-pill ${visibility}`}
          >
            <span className="text-accent font-medium">{dep}</span>
            <span className="text-muted">→</span>
            <span className="text-accent font-medium">{arr}</span>
            <span className="text-muted text-[10px]">{when}</span>
          </a>
        );
      })}
      {mobileRemaining > 0 && (
        <button
          type="button"
          className={`expand-flights ${expandVisibility} items-center px-2 py-1 border border-accent/30 hover:border-accent rounded text-xs text-accent font-mono font-medium transition-all cursor-pointer hover:bg-accent/10`}
          aria-expanded="false"
        >
          <span className="pill-more">
            <span className="md:hidden">+{mobileRemaining}</span>
            {tabletRemaining > 0 && (
              <span className="hidden md:inline xl:hidden">+{tabletRemaining}</span>
            )}
            {desktopRemaining > 0 && <span className="hidden xl:inline">+{desktopRemaining}</span>}
          </span>
          <span className="pill-less">−</span>
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
    // The raw callsign plus the marketing number it maps to, via
    // ensureAirlinePrefix: a prefix strip made a G7-coded flight unfindable by
    // the UA number its pill advertises.
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

export function AircraftList({
  aircraft,
  content,
  airlineByTail,
  flightsByTail,
  permalinkAirline,
  showFleetLink,
  fleetTotal,
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
}) {
  const airlineOf = (p: Aircraft) => airlineByTail[p.TailNumber] || "UA";
  const permalink = permalinker(permalinkAirline, airlineByTail);
  const shown = aircraft.slice(0, AIRCRAFT_LIST_CAP);
  const capped = aircraft.length > shown.length;
  const subfleetCount = (key: string) =>
    shown.filter((p) => p.fleet === key || airlineOf(p) === key).length;

  return (
    <div className="relative mx-auto mb-8 w-full max-w-6xl overflow-hidden rounded-lg border border-subtle bg-surface">
      <SectionTitle className="px-4 md:px-6 pt-4 pb-0">Aircraft with Starlink</SectionTitle>
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
              className="w-full font-mono text-sm px-4 py-2 pl-9 pr-8 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-all"
            />
            <svg
              className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              role="img"
              aria-label="Search icon"
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
              <svg
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                role="img"
                aria-label="Clear"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <div
            id="search-count"
            aria-live="polite"
            data-default={capped ? `Latest ${fmt(shown.length)} of ${fmt(aircraft.length)}` : ""}
            className="hidden sm:flex items-center text-xs font-mono text-muted whitespace-nowrap"
          >
            {capped ? `Latest ${fmt(shown.length)} of ${fmt(aircraft.length)}` : null}
          </div>
          <div className="flex gap-1.5 sm:gap-2">
            <button
              type="button"
              id="filter-all"
              className={`${FILTER_BUTTON} ${FILTER_ACTIVE}`}
              data-filter="all"
            >
              ALL <span className="hidden sm:inline">({fmt(shown.length)})</span>
            </button>
            {content.subfleetFilters.length > 1 &&
              content.subfleetFilters.map((card) => (
                <button
                  key={card.key}
                  type="button"
                  id={`filter-${card.key}`}
                  className={`${FILTER_BUTTON} ${FILTER_INACTIVE}`}
                  data-filter={card.key}
                >
                  {card.label.toUpperCase()}{" "}
                  <span className="hidden sm:inline">({fmt(subfleetCount(card.key))})</span>
                </button>
              ))}
          </div>
        </div>
      </div>
      <div className="hidden md:grid md:grid-cols-12 gap-4 px-6 py-2.5 border-b border-subtle bg-surface-elevated/50 text-xs font-mono text-muted uppercase tracking-widest">
        <div className="col-span-3">Aircraft</div>
        <div className="col-span-2">Type</div>
        <div className="col-span-3">Operator</div>
        <div className="col-span-4">Upcoming Flights</div>
      </div>

      <div className="overflow-auto" style={{ maxHeight: "65vh" }}>
        {aircraft.length === 0 ? (
          <div className="p-12 text-center text-muted font-mono">No aircraft data available</div>
        ) : (
          <div className="divide-y divide-subtle">
            {shown.map((plane, idx) => {
              const airline = airlineOf(plane);
              const badge = content.rowBadge(plane, airline);
              const flights = flightsByTail[plane.TailNumber] || [];
              const index = searchIndex(flights, AIRLINES[airline]);
              return (
                <div
                  key={plane.TailNumber || idx}
                  className="aircraft-row group px-4 md:px-6 py-4 hover:bg-surface-elevated transition-all duration-200 cursor-default border-l-2 border-transparent hover:border-accent"
                  data-tail={plane.TailNumber.toLowerCase()}
                  data-aircraft={plane.Aircraft.toLowerCase()}
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
                        <div className="status-dot flex-shrink-0" />
                        <div>
                          <div className="font-mono text-base md:text-sm font-bold md:font-semibold text-primary group-hover:text-accent transition-colors">
                            {plane.TailNumber}
                          </div>
                          <div className="md:hidden font-mono text-xs text-secondary">
                            {plane.Aircraft}
                          </div>
                          {badge && (
                            <div className="hidden md:block text-xs font-mono text-muted uppercase">
                              {badge}
                            </div>
                          )}
                        </div>
                      </div>
                      {badge && (
                        <div className="md:hidden text-xs font-mono text-accent uppercase">
                          {badge}
                        </div>
                      )}
                    </div>

                    <div className="hidden md:block md:col-span-2">
                      <span className="font-mono text-sm text-secondary">{plane.Aircraft}</span>
                    </div>

                    <div className="md:col-span-3 text-xs md:text-sm text-muted mb-3 md:mb-0 pl-5 md:pl-0">
                      {plane.OperatedBy || "—"}
                    </div>

                    <div className="md:col-span-4 pt-3 md:pt-0 border-t md:border-t-0 border-subtle">
                      <FlightPills
                        tailNumber={plane.TailNumber}
                        flights={flights}
                        permalink={permalink}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
            <div id="list-empty" hidden className="px-4 md:px-6 py-10 text-center text-sm">
              <p className="text-secondary">No aircraft match.</p>
              {showFleetLink && (
                <p className="mt-1 text-muted">
                  {capped ? `This list holds the latest ${fmt(shown.length)}. ` : null}
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
      </div>
      {capped && (
        <div
          id="list-cap"
          className="px-4 md:px-6 py-3 border-t border-subtle text-center text-sm text-muted"
        >
          Showing {fmt(shown.length)} of {fmt(aircraft.length)}, most recently flown first. Search
          and filters cover these rows.
          {showFleetLink && (
            <>
              {" "}
              <a href="/fleet" className="text-accent hover:underline">
                See all →
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
