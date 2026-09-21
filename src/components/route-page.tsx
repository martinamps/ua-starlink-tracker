import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { RouteSummary } from "../database/database";
import { airportTimezone } from "../utils/airport-tz";
import type { PageLink } from "./atoms";
import { Chip, PageHeader, PageShell, Section, Td, Th, aircraftName, fmt } from "./layout";
import { formatDuration, monthDay, zonedDeparture } from "./ui/format";

/** One physical Starlink departure on the pair, under its marketing number. */
export interface RouteDeparture {
  flight_number: string;
  departure_time: number;
  tail_number: string;
  aircraft_type: string | null;
  /** Starlink confirmed on the tail by our checks, not just listed as equipped. */
  verified: boolean;
}

/** Departure clock at the origin airport; unmapped airports read UTC. */
export function localDeparture(iata: string, sec: number): { date: string; time: string } {
  return zonedDeparture(sec, airportTimezone(iata));
}

/** A historical number seen once is as likely a data-source artifact (a
 * diversion, a mis-keyed express number) as a flight on this route. */
const HISTORY_MIN_SIGHTINGS = 2;

function listed(fns: RouteSummary["flightNumbers"]) {
  return fns.filter((f) => f.scheduled === 1 || f.times >= HISTORY_MIN_SIGHTINGS);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The one-sentence answer the page exists to give. upcoming_flights only holds
 * departures on tracked Starlink tails, so there is no honest denominator: the
 * answer counts Starlink flights and never claims a share of the route.
 * `departures`, when given, is the list the page renders, so the sentence and
 * the table can never disagree.
 */
export function routeVerdict(
  route: RouteSummary,
  airlineName: string,
  departures?: RouteDeparture[]
): string {
  const pair = `from ${route.origin} to ${route.destination}`;
  const k = departures ? departures.length : route.equippedDepartures;
  if (k > 0) {
    const head = `${fmt(k)} Starlink flight${k === 1 ? "" : "s"} ${pair} in the ${route.windowLabel}`;
    if (!departures) return `${head}.`;
    const day = (d: RouteDeparture) => localDeparture(route.origin, d.departure_time).date;
    if (k === 1) return `${head}: ${departures[0].flight_number} on ${day(departures[0])}.`;
    if (k <= 3) {
      return `${head}: ${joinList(departures.map((d) => `${d.flight_number} (${day(d)})`))}.`;
    }
    const next = departures[0];
    const at = localDeparture(route.origin, next.departure_time);
    return `${head}. The next is ${next.flight_number} on ${at.date} at ${at.time}.`;
  }
  // Lead with what we durably know. The schedule window is only 48h, so a
  // route with real history spends most of its life "empty" — opening on the
  // negative made ~43% of the corpus read as a no-data page.
  const fns = listed(route.flightNumbers);
  if (fns.length > 0) {
    const sample = fns.slice(0, 3).map((f) => f.flight_number);
    const more = fns.length > 3 ? ` and ${fmt(fns.length - 3)} more` : "";
    const list = more ? `${sample.join(", ")}${more}` : joinList(sample);
    return `${airlineName} flies ${route.origin} to ${route.destination} as ${list}. No Starlink aircraft is assigned in the ${route.windowLabel}. Aircraft are assigned about two days out.`;
  }
  return `No Starlink flights ${pair} in the ${route.windowLabel}. Aircraft are assigned about two days out.`;
}

function DeparturesTable({
  route,
  departures,
}: { route: RouteSummary; departures: RouteDeparture[] }) {
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>Flight</Th>
            <Th>Departs</Th>
            <Th>Aircraft</Th>
            <Th numeric>Starlink</Th>
          </tr>
        </thead>
        <tbody>
          {departures.map((d) => {
            const at = localDeparture(route.origin, d.departure_time);
            return (
              <tr key={`${d.flight_number}-${d.departure_time}`}>
                <Td className="pr-3 whitespace-nowrap">
                  <a
                    href={`/check-flight/${d.flight_number}`}
                    className="font-mono text-primary hover:text-accent transition-colors"
                  >
                    {d.flight_number}
                  </a>
                </Td>
                <Td className="pr-3 text-secondary">
                  <span className="whitespace-nowrap">{at.date}</span>{" "}
                  <span className="whitespace-nowrap text-muted">{at.time}</span>
                </Td>
                <Td className="pr-3 text-secondary">
                  <span className="whitespace-nowrap">{aircraftName(d.aircraft_type)}</span>{" "}
                  <span className="hidden sm:inline font-mono text-xs text-muted">
                    {d.tail_number}
                  </span>
                </Td>
                <Td numeric className="whitespace-nowrap">
                  {d.verified ? (
                    <span className="text-primary">Verified</span>
                  ) : (
                    <span className="text-secondary">Expected</span>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-4 text-xs text-muted text-pretty">
        Verified means our checks confirmed Starlink on that aircraft. Expected means it is listed
        as equipped but not yet confirmed. Aircraft can change, so check your flight the day before.
      </p>
    </>
  );
}

function FlightNumbers({
  route,
  lastSeen,
  nowSec,
}: {
  route: RouteSummary;
  lastSeen: Map<string, number>;
  nowSec: number;
}) {
  const scheduled = route.flightNumbers.filter((f) => f.scheduled === 1);
  const history = route.flightNumbers
    .filter((f) => f.scheduled !== 1 && f.times >= HISTORY_MIN_SIGHTINGS)
    .map((f) => ({ ...f, seen: lastSeen.get(f.flight_number) ?? null }))
    .sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0) || b.times - a.times);
  const seenOnce = route.flightNumbers.length - scheduled.length - history.length;

  if (scheduled.length === 0 && history.length === 0) {
    return (
      <p className="text-sm text-muted">
        No flight numbers recorded on this route yet. They fill in as departures are observed.
      </p>
    );
  }
  return (
    <div className="space-y-5">
      {scheduled.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm text-secondary">In the schedule now</h3>
          <div className="flex flex-wrap gap-2">
            {scheduled.map((f) => (
              <Chip key={f.flight_number} href={`/check-flight/${f.flight_number}`}>
                {f.flight_number}
              </Chip>
            ))}
          </div>
        </div>
      )}
      {history.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm text-secondary">Seen before</h3>
          <div className="flex flex-wrap gap-2">
            {history.map((f) => (
              <Chip key={f.flight_number} href={`/check-flight/${f.flight_number}`}>
                {f.flight_number}
                {f.seen && (
                  <span className="font-sans text-xs text-muted">
                    {" "}
                    · last seen {monthDay(f.seen, nowSec)}
                  </span>
                )}
              </Chip>
            ))}
          </div>
        </div>
      )}
      {seenOnce > 0 && (
        <p className="text-xs text-muted">
          {fmt(seenOnce)} more flight number{seenOnce === 1 ? "" : "s"} seen only once, not listed.
        </p>
      )}
    </div>
  );
}

interface RoutePageProps {
  route: RouteSummary;
  site: SiteConfig;
  /** Upcoming Starlink departures on the pair, departure time ascending. */
  departures?: RouteDeparture[];
  /** Newest route-cache sighting per flight number (unix sec). */
  lastSeen?: Map<string, number>;
  /** The server's routeHasData answer for destination→origin; the reverse-leg
   * link renders only when that page serves. */
  reverseLinkable?: boolean;
  pageLinks?: PageLink[];
  currentPath?: string;
}

export default function RoutePage({
  route,
  site,
  departures = [],
  lastSeen = new Map(),
  reverseLinkable = false,
  pageLinks,
  currentPath,
}: RoutePageProps) {
  const cfg = siteAirline(site);
  const airlineName = cfg.name;
  const duration = formatDuration(route.durationSec);
  const nowSec = Math.floor(Date.now() / 1000);
  const plannerHref = `/route-planner?origin=${route.origin}&destination=${route.destination}`;

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={
          <>
            {route.origin} to {route.destination} Starlink WiFi
          </>
        }
        dek={routeVerdict(route, airlineName, departures)}
      />

      {departures.length > 0 && (
        <Section
          title="Upcoming Starlink flights"
          dek={`Next 48 hours. Times are local to ${route.origin}.`}
        >
          <DeparturesTable route={route} departures={departures} />
        </Section>
      )}

      <Section
        title="Flight numbers on this route"
        dek={duration ? `Flight time is about ${duration}.` : undefined}
      >
        <FlightNumbers route={route} lastSeen={lastSeen} nowSec={nowSec} />
      </Section>

      <section className="relative mx-auto mb-8 w-full max-w-3xl text-center">
        {reverseLinkable ? (
          <p className="text-sm text-secondary">
            Flying back?{" "}
            <a
              href={`/route-planner/${route.destination}/${route.origin}`}
              className="text-accent hover:underline"
            >
              {route.destination} to {route.origin}
            </a>
            , or{" "}
            <a href={plannerHref} className="text-accent hover:underline">
              plan a trip with connections
            </a>
            .
          </p>
        ) : (
          <p className="text-sm text-secondary">
            <a href={plannerHref} className="text-accent hover:underline">
              Plan a trip with connections
            </a>
            .
          </p>
        )}
      </section>
    </PageShell>
  );
}
