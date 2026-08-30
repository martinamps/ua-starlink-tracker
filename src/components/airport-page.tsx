import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { AirportSummary } from "../database/database";
import type { AirportInfo } from "../utils/airport-names";

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-4xl mx-auto mb-10";

function relativeTime(epochSec: number): string {
  const mins = Math.round((epochSec * 1000 - Date.now()) / 60000);
  if (mins <= 0) return "boarding now";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  return `in ${hrs}h`;
}

/**
 * The one-line answer an airport page exists to give.
 *
 * On a starlink-roster tenant the schedule table only holds departures flown
 * by roster aircraft, so totalDepartures is NOT a denominator and the verdict
 * publishes a count instead of a ratio. See ScheduleCoverage.
 */
export function airportVerdict(s: AirportSummary, info: AirportInfo, airlineName: string): string {
  if (s.coverage !== "whole-fleet") {
    if (s.equippedDepartures === 0) {
      return `No ${airlineName} departures from ${info.name} are scheduled on a Starlink-equipped aircraft in the ${s.windowLabel} yet. Aircraft assignments publish about two days out.`;
    }
    return s.equippedDepartures === 1
      ? `One ${airlineName} departure from ${info.name} in the ${s.windowLabel} is scheduled on a Starlink-equipped aircraft.`
      : `${s.equippedDepartures} ${airlineName} departures from ${info.name} in the ${s.windowLabel} are scheduled on Starlink-equipped aircraft.`;
  }
  if (s.totalDepartures === 0) {
    return `No ${airlineName} departures from ${info.name} are in the schedule window right now. Aircraft assignments publish about two days out.`;
  }
  if (s.equippedDepartures === 0) {
    return `None of the ${s.totalDepartures} tracked ${airlineName} departures from ${info.name} in the ${s.windowLabel} are on Starlink-equipped aircraft yet.`;
  }
  if (s.equippedDepartures === s.totalDepartures) {
    return s.totalDepartures === 1
      ? `The only tracked ${airlineName} departure from ${info.name} in the ${s.windowLabel} is on a Starlink-equipped aircraft.`
      : `All ${s.totalDepartures} tracked ${airlineName} departures from ${info.name} in the ${s.windowLabel} are on Starlink-equipped aircraft.`;
  }
  return `${s.equippedDepartures} of ${s.totalDepartures} tracked ${airlineName} departures from ${info.name} in the ${s.windowLabel} are on Starlink-equipped aircraft.`;
}

/**
 * What the equipped/total gap actually means — never "assignments haven't
 * published yet", which is the opposite of the truth: upcoming_flights.tail_number
 * is always populated, and a departure is missing because its tail isn't in the
 * table, not because it has no assignment.
 */
function provenanceNote(s: AirportSummary, airlineName: string): string {
  if (s.coverage !== "whole-fleet") {
    return `Counted from live tail assignments over the ${s.windowLabel}. ${airlineName} schedule data here covers the Starlink-equipped fleet, so this is a count of equipped departures — not a share of every ${airlineName} departure from ${s.airport}.`;
  }
  return `Counted from live tail assignments over the ${s.windowLabel}. The total covers every departure whose assigned tail the tracker holds; unequipped tails are refreshed on a slower cadence, so it can trail the published schedule.`;
}

const IATA_RE = /^[A-Z]{3}$/;

function DestinationRows({ summary }: { summary: AirportSummary }) {
  const showShare = summary.coverage === "whole-fleet";
  const rows = summary.destinations.filter(
    (r) => IATA_RE.test(r.destination) && r.destination !== summary.airport
  );
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        No routes in the schedule window right now — assignments publish about two days before
        departure.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 font-mono text-[10px] text-muted uppercase tracking-wider pb-1 border-b border-subtle">
        <span>Route</span>
        <span className="text-right">
          {showShare ? "Starlink / departures" : "Starlink departures"}
        </span>
        <span className="text-right">Next</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.destination}
          className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center text-sm"
        >
          <a
            href={`/route-planner/${summary.airport}/${r.destination}`}
            className="font-display font-semibold text-secondary tabular-nums hover:text-accent transition-colors"
          >
            {summary.airport}–{r.destination}
          </a>
          <span className="font-mono text-right tabular-nums">
            <span className={r.equipped > 0 ? "text-accent" : "text-muted"}>{r.equipped}</span>
            {showShare && <span className="text-muted"> / {r.departures}</span>}
          </span>
          <span className="font-mono text-muted text-right text-xs">
            {relativeTime(r.next_departure)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Tail links point at /tail/{registration} from the sibling roadmap/tail-pages
 * branch. `tailPages` stays off until that route exists, so this page never
 * ships a link per departure into a 404. */
function UpcomingDepartures({
  summary,
  tailPages,
}: {
  summary: AirportSummary;
  tailPages: boolean;
}) {
  if (summary.upcoming.length === 0) {
    return (
      <p className="text-sm text-muted">
        No Starlink-equipped departures in the window yet — tail assignments refresh continuously.
      </p>
    );
  }
  const tailClass = "font-mono text-xs text-muted text-right hidden sm:block";
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-4 font-mono text-[10px] text-muted uppercase tracking-wider pb-1 border-b border-subtle">
        <span>Flight</span>
        <span>To</span>
        <span className="text-right hidden sm:block">Aircraft</span>
        <span className="text-right">Departs</span>
      </div>
      {summary.upcoming.map((f) => (
        <div
          key={`${f.flight_number}-${f.departure_time}`}
          className="grid grid-cols-[auto_1fr_auto_auto] gap-x-4 items-center text-sm"
        >
          <a
            href={`/check-flight/${f.flight_number}`}
            className="font-mono text-accent hover:underline"
          >
            {f.flight_number}
          </a>
          <span className="font-mono text-secondary">{f.destination}</span>
          {tailPages ? (
            <a
              href={`/tail/${f.tail_number}`}
              title={f.aircraft_type ?? undefined}
              className={`${tailClass} hover:text-accent transition-colors`}
            >
              {f.tail_number}
            </a>
          ) : (
            <span title={f.aircraft_type ?? undefined} className={tailClass}>
              {f.tail_number}
            </span>
          )}
          <span className="font-mono text-muted text-right text-xs">
            {relativeTime(f.departure_time)}
          </span>
        </div>
      ))}
    </div>
  );
}

interface AirportPageProps {
  summary: AirportSummary;
  info: AirportInfo;
  /** The hub leaderboard for this airport has rows right now. The handler 404s
   * an empty board, so the link only exists when the board does. */
  hubBoardHasRows: boolean;
  /** Data-freshness stamp for the live window (UTC HH:MM), same as /routes. */
  asOf: string;
  site: SiteConfig;
}

export function AirportPage({ summary, info, hubBoardHasRows, asOf, site }: AirportPageProps) {
  const cfg = siteAirline(site);
  const isHub = cfg.hubAirports.includes(summary.airport);
  const showShare = summary.coverage === "whole-fleet";

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight">
          {info.city} Starlink Flights · {summary.airport}
        </h1>
        <p className="text-base text-secondary font-display max-w-2xl mx-auto">
          {airportVerdict(summary, info, cfg.name)}
        </p>
      </header>

      <section className={SECTION}>
        <div className={PANEL}>
          <div
            className={EYEBROW}
          >{`${info.name} · ${summary.windowLabel} · as of ${asOf} UTC`}</div>
          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                Starlink departures
              </dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {summary.equippedDepartures}
                {showShare && (
                  <span className="text-muted text-base font-normal">
                    /{summary.totalDepartures}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">Routes</dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {summary.destinations.length}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                {cfg.shortName} hub
              </dt>
              <dd className="font-display text-2xl font-bold text-primary">
                {isHub ? "Yes" : "No"}
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted mt-4 leading-snug">
            {provenanceNote(summary, cfg.name)}
          </p>
        </div>
      </section>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>
            {cfg.shortName} routes from {summary.airport} by Starlink departures
          </div>
          <DestinationRows summary={summary} />
        </div>
      </section>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>Next Starlink departures from {summary.airport}</div>
          <UpcomingDepartures summary={summary} tailPages={site.features.tailPages} />
        </div>
      </section>

      {summary.allDestinations.length > 0 && (
        <section className={SECTION}>
          <div className={PANEL}>
            <div className={EYEBROW}>
              Every {cfg.shortName} route from {summary.airport} on record
            </div>
            <div className="flex flex-wrap gap-2">
              {summary.allDestinations.map((d) => (
                <a
                  key={d}
                  href={`/route-planner/${summary.airport}/${d}`}
                  className="font-mono text-xs px-2.5 py-1 rounded border border-subtle bg-surface-elevated text-secondary hover:border-accent hover:text-accent transition-colors"
                >
                  {summary.airport}–{d}
                </a>
              ))}
            </div>
            <p className="text-[11px] text-muted mt-4 leading-snug">
              From the observed route history, not just the live window — follow any pair for its
              Starlink record and current schedule.
            </p>
          </div>
        </section>
      )}

      <section className={`${SECTION} text-center`}>
        <p className="text-sm text-secondary">
          {isHub && site.features.rankingsPages && hubBoardHasRows && (
            <>
              <a
                href={`/rankings/hub-${summary.airport.toLowerCase()}`}
                className="text-accent hover:underline"
              >
                {summary.airport} Starlink route leaderboard
              </a>
              {" · "}
            </>
          )}
          <a href="/airports" className="text-accent hover:underline">
            All airports
          </a>
          {" · "}
          <a href="/routes" className="text-accent hover:underline">
            Live routes
          </a>
        </p>
      </section>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm mt-auto">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </footer>
    </div>
  );
}

export interface AirportIndexEntry {
  iata: string;
  info: AirportInfo;
  /** Equipped departures in the live window; 0 when outside the current top-30. */
  equipped: number;
}

interface AirportsIndexPageProps {
  airports: AirportIndexEntry[];
  asOf: string;
  site: SiteConfig;
}

export function AirportsIndexPage({ airports, asOf, site }: AirportsIndexPageProps) {
  const cfg = siteAirline(site);
  const active = airports.filter((a) => a.equipped > 0);
  const rest = airports.filter((a) => a.equipped === 0);
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight">
          {cfg.shortName} Starlink Flights by Airport
        </h1>
        <p className="text-base text-secondary font-display">
          Where {cfg.name} Starlink departures leave from, airport by airport
        </p>
      </header>

      {active.length > 0 && (
        <section className={SECTION}>
          <div className={PANEL}>
            <div className={EYEBROW}>{`Starlink departures scheduled now · as of ${asOf} UTC`}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
              {active.map((a) => (
                <a
                  key={a.iata}
                  href={`/airport/${a.iata}`}
                  className="flex items-baseline justify-between gap-3 py-1 rounded hover:bg-surface-elevated transition-colors text-sm"
                >
                  <span className="font-display text-secondary hover:text-accent">
                    <span className="font-mono text-accent">{a.iata}</span> · {a.info.city}
                  </span>
                  <span className="font-mono text-xs text-muted tabular-nums">
                    {a.equipped} departure{a.equipped === 1 ? "" : "s"}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>Every airport in the tracked network</div>
          {rest.length === 0 && active.length === 0 ? (
            <p className="text-sm text-muted">No airport data yet — check back shortly.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {rest.map((a) => (
                <a
                  key={a.iata}
                  href={`/airport/${a.iata}`}
                  title={a.info.name}
                  className="font-mono text-xs px-2.5 py-1 rounded border border-subtle bg-surface-elevated text-secondary hover:border-accent hover:text-accent transition-colors"
                >
                  {a.iata}
                </a>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted mt-4 leading-snug">
            Airports listed by live Starlink departures over the next 48 hours, then every other
            airport {cfg.name} serves in the tracked route data. Airports without scheduled equipped
            departures can still see one — assignments publish about two days out.
          </p>
        </div>
      </section>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm mt-auto">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </footer>
    </div>
  );
}
