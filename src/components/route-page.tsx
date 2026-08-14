import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { RouteSummary } from "../database/database";

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-4xl mx-auto mb-10";

export function formatDuration(sec: number | null): string | null {
  if (!sec || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The one-line answer the page exists to give. */
export function routeVerdict(route: RouteSummary, airlineName: string): string {
  if (route.totalDepartures === 0) {
    return `No ${airlineName} departures are in the schedule window for ${route.origin} → ${route.destination} right now. Aircraft assignments publish about two days out.`;
  }
  if (route.equippedDepartures === 0) {
    return `None of the ${route.totalDepartures} scheduled ${route.origin} → ${route.destination} departures in the ${route.windowLabel} are on a Starlink-equipped aircraft.`;
  }
  if (route.equippedDepartures === route.totalDepartures) {
    return `All ${route.totalDepartures} scheduled ${route.origin} → ${route.destination} departures in the ${route.windowLabel} are on Starlink-equipped aircraft.`;
  }
  return `${route.equippedDepartures} of ${route.totalDepartures} scheduled ${route.origin} → ${route.destination} departures in the ${route.windowLabel} are on Starlink-equipped aircraft.`;
}

function FlightNumbers({ route, airlineName }: { route: RouteSummary; airlineName: string }) {
  if (route.flightNumbers.length === 0) {
    return (
      <p className="text-sm text-muted">
        No flight numbers recorded on this route yet. The route cache fills in as departures are
        observed.
      </p>
    );
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {route.flightNumbers.map((f) => (
          <a
            key={f.flight_number}
            href={`/check-flight/${f.flight_number}`}
            className="font-mono text-sm px-2.5 py-1 rounded border border-subtle bg-surface-elevated text-secondary hover:border-accent hover:text-accent transition-colors"
          >
            {f.flight_number}
            {f.scheduled === 1 && <span className="text-accent"> ·</span>}
          </a>
        ))}
      </div>
      <p className="text-[11px] text-muted mt-4 leading-snug">
        Every {airlineName} flight number observed on {route.origin} → {route.destination}. A dot
        marks numbers currently in the schedule window; the rest are from the observed route
        history. Follow any number for its per-flight Starlink record.
      </p>
    </>
  );
}

interface RoutePageProps {
  route: RouteSummary;
  site: SiteConfig;
}

export default function RoutePage({ route, site }: RoutePageProps) {
  const cfg = siteAirline(site);
  const airlineName = cfg.name;
  const backLabel = site.brand.title;
  const duration = formatDuration(route.durationSec);
  const scheduledCount = route.flightNumbers.filter((f) => f.scheduled === 1).length;

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight">
          {route.origin} to {route.destination} Starlink WiFi
        </h1>
        <p className="text-base text-secondary font-display max-w-2xl mx-auto">
          {routeVerdict(route, airlineName)}
        </p>
      </header>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>Route at a glance</div>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                Starlink departures
              </dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {route.equippedDepartures}
                <span className="text-muted text-base font-normal">/{route.totalDepartures}</span>
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                Flight numbers
              </dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {route.flightNumbers.length}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                In schedule
              </dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {scheduledCount}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-mono text-muted uppercase tracking-wider">
                Block time
              </dt>
              <dd className="font-display text-2xl font-bold text-primary tabular-nums">
                {duration ?? "—"}
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted mt-4 leading-snug">
            Counted from live tail assignments over the {route.windowLabel}. A route with no
            equipped departures today can still get one — assignments publish about two days before
            departure.
          </p>
        </div>
      </section>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>
            {airlineName} flights on {route.origin}–{route.destination}
          </div>
          <FlightNumbers route={route} airlineName={airlineName} />
        </div>
      </section>

      <section className={`${SECTION} text-center`}>
        <p className="text-sm text-secondary">
          Want the reverse leg?{" "}
          <a
            href={`/route-planner/${route.destination}/${route.origin}`}
            className="text-accent hover:underline"
          >
            {route.destination} to {route.origin}
          </a>
          , or{" "}
          <a href="/route-planner" className="text-accent hover:underline">
            compare a full itinerary
          </a>
          .
        </p>
      </section>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm mt-auto">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {backLabel}
        </a>
      </footer>
    </div>
  );
}
