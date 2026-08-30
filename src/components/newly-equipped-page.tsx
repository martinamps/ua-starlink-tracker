import React from "react";
import { AIRLINES, type SiteConfig } from "../airlines/registry";
import type { FirstFlight, PerAirlineStat, RecentInstall } from "../types";
import { PageFooter, type PageLink } from "./atoms";

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-3xl mx-auto mb-8";

interface NewlyEquippedPageProps {
  site: SiteConfig;
  installs: RecentInstall[];
  airlines: PerAirlineStat[];
  /** Observed first revenue departure per tail; sparse — most tails have none yet. */
  firstFlights: Record<string, FirstFlight>;
  pageLinks?: PageLink[];
}

function installDate(d: string): string {
  return new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function InstallRow({ install, first }: { install: RecentInstall; first?: FirstFlight }) {
  return (
    <div
      id={install.TailNumber}
      className="py-2.5 border-b border-subtle last:border-0"
      style={{ scrollMarginTop: "5rem" }}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-mono text-sm text-accent">{install.TailNumber}</span>
        <span className="font-mono text-xs text-secondary">{install.Aircraft}</span>
        {install.OperatedBy && (
          <span className="font-mono text-[10px] text-muted hidden sm:inline">
            {install.OperatedBy}
          </span>
        )}
        <span className="font-mono text-[10px] text-muted ml-auto">
          found {installDate(install.DateFound)}
        </span>
      </div>
      {first && (
        <div className="font-mono text-[11px] text-muted mt-1">
          First Starlink revenue flight:{" "}
          <span className="text-secondary">
            {first.flight_number} {first.origin} → {first.destination}
          </span>{" "}
          on{" "}
          {new Date(first.departed_at * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
        </div>
      )}
    </div>
  );
}

export default function NewlyEquippedPage({
  site,
  installs,
  airlines,
  firstFlights,
  pageLinks,
}: NewlyEquippedPageProps) {
  const scopeCode = site.scope !== "ALL" ? site.scope : null;
  const airlineName = scopeCode ? AIRLINES[scopeCode].name : "tracked airlines";
  const grouped = airlines
    .map((a) => ({ cfg: a, rows: installs.filter((i) => i.airline === a.code) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Newly Equipped Aircraft
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Every {airlineName} aircraft as it joins the Starlink-equipped fleet — newest first, with
          its first observed Starlink revenue flight once it departs.
        </p>
      </header>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className={EYEBROW}>Latest installs</div>
            <a
              href="/feed.xml"
              className="font-mono text-[11px] text-accent hover:underline"
              type="application/atom+xml"
            >
              Subscribe (Atom feed) →
            </a>
          </div>
          {grouped.length === 0 ? (
            <p className="text-sm text-muted">
              No dated installs on record right now. Aircraft appear here the day we find them newly
              equipped — bulk imports and seed data are excluded so this log only carries real,
              dated finds.
            </p>
          ) : (
            grouped.map((g) => (
              <div key={g.cfg.code} className="mb-4 last:mb-0">
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted mb-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: g.cfg.accentColor || "#5a6a80" }}
                  />
                  {g.cfg.name}
                </div>
                {g.rows.map((r) => (
                  <InstallRow key={r.TailNumber} install={r} first={firstFlights[r.TailNumber]} />
                ))}
              </div>
            ))
          )}
          <p className="text-[11px] text-muted mt-4 leading-snug">
            Dates are when this tracker first observed the install, not when the antenna went on.
            Writing about the rollout? The{" "}
            <a href="/feed.xml" className="text-accent hover:underline">
              Atom feed
            </a>{" "}
            carries these entries as they land
            {site.features.methodologyPage ? (
              <>
                {" "}
                — see the{" "}
                <a href="/methodology" className="text-accent hover:underline">
                  methodology
                </a>{" "}
                for how installs are verified
              </>
            ) : null}
            .
          </p>
        </div>
      </section>

      <PageFooter site={site} pageLinks={pageLinks} />
    </div>
  );
}
