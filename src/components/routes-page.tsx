import React from "react";
import { AIRLINES, type SiteConfig } from "../airlines/registry";
import type { PopularFlight } from "../database/database";
import type { AirportDepartures, RouteSchedule, RouteScheduleRow } from "../types";
import { airportTimezone } from "../utils/airport-tz";
import { PopularFlightsLinks } from "./atoms";
import { AirportBars } from "./home/rollout";
import type { Link } from "./layout";
import { PageHeader, PageShell, Panel, Section, SectionTitle, Td, Th } from "./layout";
import { fmt, utcDateTime, zonedDeparture } from "./ui/format";
import { Meter } from "./ui/meter";

interface RouteLeg {
  origin: string;
  destination: string;
  departures: number;
  next: number;
}

interface MergedRoute {
  key: string;
  a: string;
  b: string;
  /** Busier direction first. */
  legs: RouteLeg[];
  departures: number;
  next: RouteLeg;
}

/**
 * A↔B as one row. The schedule is capped at its busiest directions, so a
 * reverse leg outside the cap is simply absent: the row then shows the one
 * direction it has rather than inventing a zero.
 */
function mergeDirections(rows: RouteScheduleRow[]): MergedRoute[] {
  const byPair = new Map<string, RouteLeg[]>();
  for (const r of rows) {
    const [a, b] = [r.origin, r.destination].sort();
    const key = `${a}-${b}`;
    const legs = byPair.get(key) ?? [];
    legs.push({
      origin: r.origin,
      destination: r.destination,
      departures: r.departures,
      next: r.next_departure,
    });
    byPair.set(key, legs);
  }
  return [...byPair]
    .map(([key, legs]) => {
      legs.sort((x, y) => y.departures - x.departures || x.origin.localeCompare(y.origin));
      const next = legs.reduce((m, l) => (l.next < m.next ? l : m));
      return {
        key,
        a: legs[0].origin,
        b: legs[0].destination,
        legs,
        departures: legs.reduce((s, l) => s + l.departures, 0),
        next,
      };
    })
    .sort((x, y) => y.departures - x.departures || x.key.localeCompare(y.key));
}

function RoutesTable({ routes, linkable }: { routes: MergedRoute[]; linkable: boolean }) {
  const max = routes[0]?.departures ?? 0;
  const leg = (l: RouteLeg, primary: boolean) => {
    const label = primary ? (
      <>
        {l.origin} → {l.destination}
      </>
    ) : (
      <>
        {l.origin}→{l.destination}
      </>
    );
    return linkable ? (
      <a
        href={`/route-planner/${l.origin}/${l.destination}`}
        className={`font-mono hover:text-accent transition-colors ${primary ? "text-primary" : "text-secondary"}`}
      >
        {label}
      </a>
    ) : (
      <span className="font-mono">{label}</span>
    );
  };
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <Th>Route</Th>
          <Th>Starlink flights</Th>
          <Th numeric>Next departure</Th>
        </tr>
      </thead>
      <tbody>
        {routes.map((r) => {
          const at = zonedDeparture(r.next.next, airportTimezone(r.next.origin));
          return (
            <tr key={r.key}>
              <Td className="pr-3 align-top">
                {r.legs.length === 1 ? (
                  <div className="text-primary whitespace-nowrap">{leg(r.legs[0], true)}</div>
                ) : (
                  <>
                    <div className="font-mono text-primary whitespace-nowrap">
                      {r.a} ⇄ {r.b}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                      {r.legs.map((l) => (
                        <span key={l.origin} className="whitespace-nowrap">
                          {leg(l, false)} <span className="tabular-nums">{fmt(l.departures)}</span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </Td>
              <Td className="w-full pr-3 align-top">
                <div className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-right font-semibold text-primary">
                    {fmt(r.departures)}
                  </span>
                  <Meter
                    share={max > 0 ? Math.max(0.03, r.departures / max) : 0}
                    className="w-full min-w-8"
                  />
                </div>
              </Td>
              <Td numeric className="align-top text-secondary">
                <div className="whitespace-nowrap">{at.date}</div>
                <div className="whitespace-nowrap text-xs text-muted">
                  {at.time}
                  {r.legs.length > 1 && (
                    <span className="hidden sm:inline"> from {r.next.origin}</span>
                  )}
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface RoutesPageProps {
  schedule: RouteSchedule;
  airports?: AirportDepartures;
  site: SiteConfig;
  popularFlights?: PopularFlight[];
  pageLinks?: Link[];
  currentPath?: string;
  /** The data's own freshness stamp, never request time. */
  updatedAt?: string | null;
}

export default function RoutesPage({
  updatedAt,
  schedule,
  airports,
  site,
  popularFlights = [],
  pageLinks,
  currentPath,
}: RoutesPageProps) {
  const scopeCode = site?.scope && site.scope !== "ALL" ? site.scope : null;
  const airlineName = scopeCode ? AIRLINES[scopeCode].name : "tracked airlines";
  const shortName = scopeCode ? AIRLINES[scopeCode].shortName : null;
  const total = schedule.totalDepartures;
  const routes = mergeDirections(schedule.rows);
  const linkable = site.features.routePlannerPage;

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title="Where Starlink is flying"
        dek={
          total > 0
            ? `${fmt(total)} ${shortName ? `${shortName} ` : ""}Starlink flights in the ${schedule.windowLabel}.`
            : `No ${airlineName} Starlink flights are assigned in the ${schedule.windowLabel} yet.`
        }
      />

      {routes.length > 0 && (
        <section className="relative mx-auto mb-8 grid w-full max-w-6xl gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <SectionTitle>Busiest Starlink routes</SectionTitle>
            <p className="mt-1 text-sm text-secondary text-pretty">
              Both directions combined. Times are local to the departure airport.
            </p>
            <Panel pad="sm" className="mt-4">
              <RoutesTable routes={routes} linkable={linkable} />
              <p className="mt-4 text-xs text-muted text-pretty">
                Based on aircraft assigned so far. Assignments firm up about two days out, so a
                route missing here may still have Starlink.
                {updatedAt ? ` Data updated ${utcDateTime(updatedAt)}.` : ""}
              </p>
            </Panel>
          </div>
          {airports && airports.rows.length > 0 && (
            <div className="min-w-0">
              <SectionTitle>Busiest airports</SectionTitle>
              <p className="mt-1 text-sm text-secondary">Starlink departures, next 48 hours.</p>
              <Panel pad="sm" className="mt-4">
                <AirportBars rows={airports.rows} columns={1} />
              </Panel>
            </div>
          )}
        </section>
      )}

      {popularFlights.length > 0 && (
        <Section wide bare>
          <PopularFlightsLinks flights={popularFlights} airlineName={airlineName} />
        </Section>
      )}

      <section className="relative mx-auto mb-8 w-full max-w-6xl text-center">
        <p className="text-sm text-secondary">
          Planning a trip?{" "}
          <a href="/route-planner" className="text-accent hover:underline">
            Find the flights most likely to have Starlink
          </a>{" "}
          or{" "}
          <a href="/check-flight" className="text-accent hover:underline">
            check your flight
          </a>
          .
        </p>
      </section>
    </PageShell>
  );
}
