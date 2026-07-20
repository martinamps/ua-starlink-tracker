/**
 * Hub-only /airlines surfaces: the cross-airline comparison index and the
 * per-airline rollout pages. Everything renders from the registry + DB stats —
 * no airline the registry doesn't know, no live scraping. When a dedicated
 * tracker site is live, these pages funnel to it rather than compete with it.
 */

import type React from "react";
import {
  type AirlineConfig,
  type SiteConfig,
  airlineHomeUrl,
  airlineSlug,
} from "../airlines/registry";
import type { PerAirlineStat } from "../types";
import { PageFooter, STATUS_TONE } from "./atoms";

const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-3xl mx-auto mb-8";

export interface AirlineOverview {
  cfg: AirlineConfig;
  stat: PerAirlineStat;
  /** Canonical host of the airline's live dedicated tracker; null → hub-only. */
  trackerHost: string | null;
}

function fleetShare(stat: PerAirlineStat): { fleet: number; pct: number } {
  // % over the FULL fleet (same convention as the hub status cards) so it
  // reads as "odds on a random flight".
  const fleet = stat.fleetTotal ?? stat.total;
  return { fleet, pct: fleet > 0 ? Math.round((stat.starlink / fleet) * 100) : 0 };
}

function StatusPill({ cfg }: { cfg: AirlineConfig }) {
  const tone = STATUS_TONE[cfg.rollout.status];
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-wide px-2 py-1 rounded-full shrink-0"
      style={{ color: tone.color, background: tone.bg }}
    >
      {cfg.rollout.statusLabel}
    </span>
  );
}

function TrackerCta({
  overview,
  prominent = false,
}: { overview: AirlineOverview; prominent?: boolean }) {
  const { cfg, trackerHost } = overview;
  // No live dedicated site and not on the hub homepage either (publicInHub
  // false) → nothing honest to funnel to yet.
  if (!trackerHost && !cfg.publicInHub) return null;
  const href = trackerHost ? `https://${trackerHost}/` : airlineHomeUrl(cfg.code);
  const label = trackerHost
    ? `Full ${cfg.shortName} tracker → ${trackerHost}`
    : `Live ${cfg.shortName} data on the hub tracker →`;
  return prominent ? (
    <a
      href={href}
      className="inline-block font-mono text-sm px-4 py-2 bg-accent/20 border border-accent rounded text-accent hover:bg-accent/30 transition-colors"
    >
      {label}
    </a>
  ) : (
    <a href={href} className="font-mono text-xs text-accent hover:underline whitespace-nowrap">
      {label}
    </a>
  );
}

function PageShell({
  site,
  heading,
  sub,
  children,
}: {
  site: SiteConfig;
  heading: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            {heading}
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-2xl mx-auto">{sub}</p>
      </header>

      {children}

      <div className="relative text-center mt-auto mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </div>
      <PageFooter site={site} />
    </div>
  );
}

export function AirlinesIndexPage({
  site,
  airlines,
}: {
  site: SiteConfig;
  airlines: AirlineOverview[];
}) {
  return (
    <PageShell
      site={site}
      heading="Which Airlines Have Starlink WiFi?"
      sub="Every airline with a Starlink rollout we track — fleet counts, percent equipped, and where each install program stands."
    >
      <section className={SECTION}>
        <div className="space-y-4">
          {airlines.map((o) => {
            const { cfg, stat } = o;
            const { fleet, pct } = fleetShare(stat);
            return (
              <div key={cfg.code} className={PANEL}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <a
                    href={`/airlines/${airlineSlug(cfg)}`}
                    className="font-display text-lg font-semibold text-primary hover:text-accent transition-colors"
                  >
                    {cfg.name}
                  </a>
                  <StatusPill cfg={cfg} />
                </div>
                {fleet > 0 ? (
                  <div className="font-mono text-sm text-secondary mb-2">
                    <span className="text-accent font-semibold">{stat.starlink}</span>
                    <span className="text-muted"> of {fleet} aircraft equipped · </span>
                    <span className="text-primary">{pct}%</span>
                    {(stat.installs30d ?? 0) > 0 && (
                      <span className="text-muted"> · +{stat.installs30d} in 30 days</span>
                    )}
                  </div>
                ) : (
                  <div className="font-mono text-sm text-muted mb-2">
                    Per-aircraft tracking begins as installation data lands.
                  </div>
                )}
                <p className="text-sm text-muted leading-relaxed mb-3">{cfg.rollout.phaseNote}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <a
                    href={`/airlines/${airlineSlug(cfg)}`}
                    className="font-mono text-xs text-secondary hover:text-accent transition-colors"
                  >
                    {cfg.shortName} rollout details →
                  </a>
                  <TrackerCta overview={o} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </PageShell>
  );
}

export function AirlineDetailPage({
  site,
  overview,
}: {
  site: SiteConfig;
  overview: AirlineOverview;
}) {
  const { cfg, stat } = overview;
  const { fleet, pct } = fleetShare(stat);
  return (
    <PageShell
      site={site}
      heading={`${cfg.name} Starlink WiFi`}
      sub={`${cfg.rollout.statusLabel} — ${cfg.rollout.phaseNote}`}
    >
      <section className={SECTION}>
        <div className={PANEL}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <span className="text-[10px] font-mono text-muted uppercase tracking-wider">
              Rollout status
            </span>
            <StatusPill cfg={cfg} />
          </div>
          {fleet > 0 ? (
            <div className="font-mono text-2xl font-semibold text-primary mb-1">
              {stat.starlink}
              <span className="text-base text-muted font-normal">
                {" "}
                / {fleet} aircraft · {pct}%
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted">
              No per-aircraft data yet — this page updates as {cfg.shortName} installation data
              lands.
            </p>
          )}
          {(stat.installs30d ?? 0) > 0 && (
            <div className="font-mono text-xs text-secondary mb-1">
              +{stat.installs30d} aircraft equipped in the last 30 days
            </div>
          )}
          <p className="text-sm text-muted leading-relaxed mt-3">
            Status per aircraft comes from fleet rosters and flight schedules, cross-checked against{" "}
            {cfg.verifySite} and official rollout announcements.
            {cfg.brand.pressReleaseUrl && (
              <>
                {" "}
                <a
                  href={cfg.brand.pressReleaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  {cfg.shortName}'s Starlink announcement →
                </a>
              </>
            )}
          </p>
        </div>
      </section>

      <section className={`${SECTION} text-center`}>
        <TrackerCta overview={overview} prominent />
      </section>

      <section className={`${SECTION} text-center`}>
        <a href="/airlines" className="font-mono text-xs text-secondary hover:text-accent">
          ← All airlines with Starlink
        </a>
      </section>
    </PageShell>
  );
}
