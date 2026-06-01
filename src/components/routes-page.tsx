import React from "react";
import { AIRLINES, type PageBrand, type SiteConfig } from "../airlines/registry";
import type { RouteSchedule } from "../types";

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

function RouteRows({ schedule }: { schedule: RouteSchedule }) {
  if (schedule.rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        No Starlink-equipped departures are in the schedule window right now. Tail assignments
        refresh continuously — check back shortly.
      </p>
    );
  }
  const max = schedule.rows[0].departures;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto_auto] sm:grid-cols-[7rem_1fr_auto_auto] gap-x-4 font-mono text-[10px] text-muted uppercase tracking-wider pb-1 border-b border-subtle">
        <span>Route</span>
        <span className="hidden sm:block" />
        <span className="text-right">Departures</span>
        <span className="text-right">Next</span>
      </div>
      {schedule.rows.map((r) => (
        <div
          key={`${r.origin}-${r.destination}`}
          className="grid grid-cols-[1fr_auto_auto] sm:grid-cols-[7rem_1fr_auto_auto] gap-x-4 items-center text-sm"
        >
          <span className="font-display font-semibold text-secondary tabular-nums">
            {r.origin}–{r.destination}
          </span>
          <span className="hidden sm:block h-2 bg-surface-elevated rounded overflow-hidden">
            <span
              className="block h-full bg-[var(--color-accent)] opacity-70"
              style={{ width: `${Math.max(4, (r.departures / max) * 100)}%` }}
            />
          </span>
          <span className="font-mono text-secondary text-right tabular-nums">
            {r.departures}
            {r.flight_numbers !== r.departures && (
              <span className="text-muted text-xs">
                {" "}
                on {r.flight_numbers} flight{r.flight_numbers === 1 ? "" : "s"}
              </span>
            )}
          </span>
          <span className="font-mono text-muted text-right text-xs">
            {relativeTime(r.next_departure)}
          </span>
        </div>
      ))}
    </div>
  );
}

interface RoutesPageProps {
  schedule: RouteSchedule;
  brand?: PageBrand;
  site?: SiteConfig;
}

export default function RoutesPage({ schedule, brand, site }: RoutesPageProps) {
  const scopeCode = site?.scope && site.scope !== "ALL" ? site.scope : null;
  const airlineName = scopeCode ? AIRLINES[scopeCode].name : "tracked airlines";
  const backLabel = brand?.title ?? "Starlink Tracker";
  const totalDepartures = schedule.totalDepartures;
  const asOf = new Date().toISOString().slice(11, 16);

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Where Starlink Is Flying
          </h1>
        </a>
        <p className="text-base text-secondary font-display">
          {totalDepartures > 0
            ? `${totalDepartures} departures on Starlink-equipped ${airlineName} aircraft scheduled over the ${schedule.windowLabel}`
            : `Live ${airlineName} Starlink departures by route`}
        </p>
      </header>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>
            Routes by scheduled Starlink departures · {schedule.windowLabel} · as of {asOf} UTC
          </div>
          <RouteRows schedule={schedule} />
          <p className="text-[11px] text-muted mt-4 leading-snug">
            Counted from live tail assignments: every departure in the {schedule.windowLabel} whose
            assigned aircraft is Starlink-equipped, showing the top {schedule.rows.length} routes.
            Routes not listed may still have Starlink — assignments publish about two days before
            departure. This is a count of Starlink service, not a share of all departures on the
            route.
          </p>
        </div>
      </section>

      <section className={`${SECTION} text-center`}>
        <p className="text-sm text-secondary">
          Planning a specific trip?{" "}
          <a href="/route-planner" className="text-accent hover:underline">
            Compare routes by Starlink probability
          </a>{" "}
          or{" "}
          <a href="/check-flight" className="text-accent hover:underline">
            check your flight number
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
