import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { ClientScriptTag } from "./flight-search-form";
import type { Link } from "./layout";
import { Chip, Eyebrow, PageHeader, PageShell, Panel, SectionTitle, buttonClass } from "./layout";

interface RoutePlannerPageProps {
  site: SiteConfig;
  pageLinks?: Link[];
  currentPath?: string;
  popularRoutes?: Array<{ origin: string; destination: string }>;
}

export default function RoutePlannerPage({
  site,
  pageLinks,
  currentPath,
  popularRoutes = [],
}: RoutePlannerPageProps) {
  const cfg = siteAirline(site);
  const airlineName = cfg.name;
  const shortName = cfg.shortName;

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title="Find the flights most likely to have Starlink"
        dek={<>Search {airlineName} nonstops and connections between any two airports.</>}
      />

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <Panel className="glow-accent">
          <form id="route-form" className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-4 items-end">
              <div className="flex-1">
                <Eyebrow as="label" htmlFor="origin" className="mb-2 block">
                  From
                </Eyebrow>
                <input
                  type="text"
                  id="origin"
                  name="origin"
                  placeholder="SFO"
                  maxLength={4}
                  className="airport-input w-full bg-base border border-subtle rounded px-3 py-3 text-primary font-mono text-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
                  required
                  autoComplete="off"
                />
              </div>

              <div className="hidden sm:flex items-center pb-3 text-muted">
                <svg
                  width="32"
                  height="12"
                  viewBox="0 0 32 12"
                  fill="none"
                  role="img"
                  aria-label="to"
                >
                  <path d="M0 6h28M24 2l6 4-6 4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>

              <div className="flex-1">
                <Eyebrow as="label" htmlFor="destination" className="mb-2 block">
                  To
                </Eyebrow>
                <input
                  type="text"
                  id="destination"
                  name="destination"
                  placeholder="JAX"
                  maxLength={4}
                  className="airport-input w-full bg-base border border-subtle rounded px-3 py-3 text-primary font-mono text-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
                  required
                  autoComplete="off"
                />
              </div>
            </div>
            <button type="submit" className={`${buttonClass("primary", "lg")} w-full`}>
              Find flights
            </button>
          </form>
          <p className="text-xs text-muted mt-3 text-center">
            Ranked by the odds of Starlink on each leg.
          </p>
        </Panel>
      </div>

      <div id="route-results" className="relative max-w-3xl mx-auto w-full mb-10" />

      <div className="relative max-w-2xl mx-auto w-full mb-10">
        <Panel>
          <SectionTitle className="mb-3">How it works</SectionTitle>
          <div className="space-y-3 text-sm text-secondary leading-relaxed">
            <p>
              Odds come from which aircraft each {shortName} flight has used recently. A connection
              can beat the nonstop when the nonstop usually gets an aircraft without Starlink.
            </p>
            <p>
              Aircraft can change.{" "}
              <a href="/check-flight" className="text-accent hover:underline">
                Check your flight
              </a>{" "}
              1–2 days out to confirm.
            </p>
          </div>
        </Panel>
      </div>

      {popularRoutes.length > 0 && (
        <section className="relative w-full max-w-4xl mx-auto mb-8">
          <Panel>
            <SectionTitle className="mb-3">Popular Starlink routes</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {popularRoutes.map((r) => (
                <Chip
                  key={`${r.origin}-${r.destination}`}
                  href={`/route-planner/${r.origin}/${r.destination}`}
                >
                  {r.origin} → {r.destination}
                </Chip>
              ))}
            </div>
          </Panel>
        </section>
      )}

      <ClientScriptTag name="route-planner" />
    </PageShell>
  );
}
