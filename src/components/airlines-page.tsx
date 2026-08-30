/**
 * Hub-only /airlines surfaces: the cross-airline comparison index, the
 * per-airline rollout pages, and content-level facts pages for airlines we
 * don't track at tail level (including explicit "not Starlink" pages).
 * Tracked airlines render from the registry + DB stats; everything else
 * renders from src/airlines/rollout-facts.ts — dated claims with source
 * links, never live scraping. When a dedicated tracker site is live, these
 * pages funnel to it rather than compete with it.
 */

import type React from "react";
import {
  type AirlineConfig,
  type SiteConfig,
  type WifiPhase,
  airlineHomeUrl,
  airlineSlug,
} from "../airlines/registry";
import {
  type AirlineFactsEntry,
  type RolloutFact,
  type RolloutFactsStatus,
  factStamp,
  factsStamp,
  formatFactDate,
} from "../airlines/rollout-facts";
import type { PerAirlineStat } from "../types";
import { PageFooter, STATUS_TONE } from "./atoms";

const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-3xl mx-auto mb-8";

// Same visual language as STATUS_TONE, extended for the facts statuses the
// registry doesn't have (announced, trial, not-Starlink).
const FACTS_TONE: Record<RolloutFactsStatus, { color: string; bg: string }> = {
  complete: STATUS_TONE.complete,
  installing: STATUS_TONE.in_progress,
  announced: STATUS_TONE.phase_done,
  trial: { color: "#a78bfa", bg: "rgba(167,139,250,.12)" },
  not_starlink: { color: "#f47067", bg: "rgba(244,112,103,.12)" },
};

export interface AirlineOverview {
  cfg: AirlineConfig;
  stat: PerAirlineStat;
  /** Canonical host of the airline's live dedicated tracker; null → hub-only. */
  trackerHost: string | null;
}

/** Links down to the tracked-airline surfaces, rendered on facts pages so
 * flight-level intent lands on a site that can actually answer it. */
export interface TrackedLink {
  name: string;
  href: string;
}

/** One row of a type-determined program's answer: the whole family is in, out,
 * or mid-install. */
export interface TypePhase {
  family: string;
  phase: WifiPhase;
}

const PHASE_LABEL: Record<WifiPhase, { text: string; tone: "yes" | "mid" | "no" }> = {
  confirmed: { text: "Starlink — whole type", tone: "yes" },
  rolling: { text: "Mid-installation", tone: "mid" },
  negative: { text: "No Starlink planned", tone: "no" },
};

const TONE_CLASS = {
  yes: "text-green-400",
  mid: "text-amber-400",
  no: "text-muted",
} as const;

/** The answer for an airline whose Starlink status is decided by aircraft
 * type. It REPLACES the blended fleet percentage rather than sitting under it:
 * the full-fleet denominator counts families the program excludes by design
 * (QR's A380s and A330s, HA's 717s), so a single percentage is wrong in both
 * directions at once — the same average the predict path refuses to publish. */
export function PhaseTable({ phases }: { phases: TypePhase[] }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-1">
        By aircraft type
      </div>
      {phases.map(({ family, phase }) => {
        const p = PHASE_LABEL[phase];
        return (
          <div
            key={family}
            className="flex items-center justify-between py-1.5 border-b border-subtle last:border-0"
          >
            <span className="font-mono text-xs text-primary">{family}</span>
            <span className={`font-mono text-[11px] ${TONE_CLASS[p.tone]}`}>{p.text}</span>
          </div>
        );
      })}
      <p className="text-[11px] text-muted leading-relaxed mt-2">
        This program is decided by aircraft type, so there is no single fleet percentage worth
        quoting — which aircraft flies your route is the answer.
      </p>
    </div>
  );
}

function fleetShare(stat: PerAirlineStat): { fleet: number; pct: number } {
  // % over the FULL fleet so it reads as "odds on a random flight". `total` is
  // the same denominator the airline's own tracker publishes; fleetTotal counts
  // only the tails we hold rows for, which is smaller and would make the hub
  // quote a higher percentage than the tenant site for the same airline.
  const fleet = stat.total;
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

function FactsStatusPill({ entry }: { entry: AirlineFactsEntry }) {
  const tone = FACTS_TONE[entry.status];
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-wide px-2 py-1 rounded-full shrink-0"
      style={{ color: tone.color, background: tone.bg }}
    >
      {entry.statusLabel}
    </span>
  );
}

/** One dated, sourced claim — the "as of" stamp is the product. */
function FactRow({ fact }: { fact: RolloutFact }) {
  const stamp = factStamp(fact);
  return (
    <li className="py-3 border-b border-subtle last:border-0">
      <p className="text-sm text-secondary leading-relaxed mb-1">{fact.fact}</p>
      <div className="font-mono text-[11px] text-muted">
        {stamp.label} <span className="text-primary">{formatFactDate(stamp.date)}</span>
        {" · "}
        <a
          href={fact.source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {fact.source.label} →
        </a>
      </div>
    </li>
  );
}

export function FactsList({ entry }: { entry: AirlineFactsEntry }) {
  const stamp = factsStamp(entry);
  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[10px] font-mono text-muted uppercase tracking-wider">
          {entry.name} — the record, with receipts
        </span>
        <span className="font-mono text-[10px] text-muted">
          {stamp.label} {formatFactDate(stamp.date)}
        </span>
      </div>
      <ul className="list-none p-0 m-0">
        {entry.facts.map((f) => (
          <FactRow key={f.fact} fact={f} />
        ))}
      </ul>
      <p className="text-[11px] text-muted leading-relaxed mt-2">
        Every claim above carries the date it was true and the source that says so. No number on
        this page is published without both.
      </p>
    </div>
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

// The index groups content-level entries by where each program actually
// stands; negatives get their own section so "does X have Starlink — no"
// intent lands on an explicit answer, not an absence.
const ROSTER_SECTIONS: Array<{ status: RolloutFactsStatus; heading: string; note?: string }> = [
  { status: "installing", heading: "Installing now" },
  { status: "complete", heading: "Rollout complete" },
  { status: "announced", heading: "Announced — not flying yet" },
  { status: "trial", heading: "Trials" },
  {
    status: "not_starlink",
    heading: "Not Starlink — what they chose instead",
    note: "Airlines people ask about that picked a different system (or none). The answer is no — here's what they actually run.",
  },
];

function RosterRow({ entry }: { entry: AirlineFactsEntry }) {
  const stamp = factsStamp(entry);
  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <a
          href={`/airlines/${entry.slug}`}
          className="font-display text-lg font-semibold text-primary hover:text-accent transition-colors"
        >
          {entry.name}
        </a>
        <FactsStatusPill entry={entry} />
      </div>
      <p className="text-sm text-muted leading-relaxed mb-2">{entry.summary}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <a
          href={`/airlines/${entry.slug}`}
          className="font-mono text-xs text-secondary hover:text-accent transition-colors"
        >
          {entry.shortName} details, with sources →
        </a>
        <span className="font-mono text-[10px] text-muted">
          {stamp.label} {formatFactDate(stamp.date)}
        </span>
      </div>
    </div>
  );
}

export function AirlinesIndexPage({
  site,
  airlines,
  roster,
  comparisons,
}: {
  site: SiteConfig;
  airlines: AirlineOverview[];
  /** Content-level entries WITHOUT tail-level tracking (tracked airlines
   * render as live cards above; their facts live on their detail pages). */
  roster: AirlineFactsEntry[];
  /** Head-to-head /compare pages. This index is their only HTML entry point —
   * without these links the pair pages are sitemap-only orphans. */
  comparisons: TrackedLink[];
}) {
  return (
    <PageShell
      site={site}
      heading="Which Airlines Have Starlink WiFi?"
      sub="Every Starlink rollout — and every notable airline that said no — with fleet counts where we track tail-by-tail, and dated, sourced status for the rest."
    >
      <section className={SECTION}>
        <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
          Tracked tail-by-tail
        </div>
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

      {comparisons.length > 0 && (
        <section className={SECTION}>
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
            Head to head
          </div>
          <div className={PANEL}>
            <p className="text-sm text-muted leading-relaxed mb-3">
              Two airlines on the same route? These pages put their install counts, per-fleet-group
              rates, and rollout timelines side by side.
            </p>
            <div className="flex flex-wrap gap-2">
              {comparisons.map((c) => (
                <a
                  key={c.href}
                  href={c.href}
                  className="font-mono text-xs px-3 py-1.5 bg-surface-elevated border border-subtle rounded text-secondary hover:text-accent hover:border-accent transition-colors"
                >
                  {c.name} →
                </a>
              ))}
            </div>
          </div>
        </section>
      )}

      {ROSTER_SECTIONS.map(({ status, heading, note }) => {
        const entries = roster.filter((e) => e.status === status);
        if (entries.length === 0) return null;
        return (
          <section key={status} className={SECTION}>
            <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
              {heading}
            </div>
            {note && <p className="text-xs text-muted leading-relaxed mb-3">{note}</p>}
            <div className="space-y-4">
              {entries.map((e) => (
                <RosterRow key={e.slug} entry={e} />
              ))}
            </div>
          </section>
        );
      })}
    </PageShell>
  );
}

export function AirlineDetailPage({
  site,
  overview,
  facts,
  phases,
}: {
  site: SiteConfig;
  overview: AirlineOverview;
  /** Dated, sourced milestones for this airline (rollout-facts entry). */
  facts?: AirlineFactsEntry | null;
  /** Type→phase table for type-determined programs; null otherwise. Present →
   * this page publishes it INSTEAD of a blended fleet percentage. */
  phases?: TypePhase[] | null;
}) {
  const { cfg, stat } = overview;
  const { fleet, pct } = fleetShare(stat);
  const showBlended = fleet > 0 && !phases;
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
          {showBlended && (
            <div className="font-mono text-2xl font-semibold text-primary mb-1">
              {stat.starlink}
              <span className="text-base text-muted font-normal">
                {" "}
                / {fleet} aircraft · {pct}%
              </span>
            </div>
          )}
          {fleet === 0 && (
            <p className="text-sm text-muted">
              No per-aircraft data yet — this page updates as {cfg.shortName} installation data
              lands.
            </p>
          )}
          {phases && <PhaseTable phases={phases} />}
          {showBlended && (stat.installs30d ?? 0) > 0 && (
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

      {facts && (
        <section className={SECTION}>
          <FactsList entry={facts} />
        </section>
      )}

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

/** Question-form H1 for a facts page; entry.headline overrides. */
export function factsHeadline(entry: AirlineFactsEntry): string {
  if (entry.headline) return entry.headline;
  switch (entry.status) {
    case "complete":
      return `Does ${entry.shortName} Have Starlink? Yes — Rollout Complete`;
    case "installing":
      return `Does ${entry.shortName} Have Starlink? Yes — Rollout Under Way`;
    case "announced":
      return `Does ${entry.shortName} Have Starlink? Not Yet — It's Committed`;
    case "trial":
      return `Does ${entry.shortName} Have Starlink? Trial Aircraft Only`;
    case "not_starlink":
      // A bare "No" is a verified claim. We can only verify it where the
      // airline announced something else; where we have simply found no
      // announcement, the headline says exactly that — and matches the body,
      // which tells the reader to treat the negative as unconfirmed.
      return entry.negative === "unannounced"
        ? `Does ${entry.shortName} Have Starlink? No Deal Announced`
        : `Does ${entry.shortName} Have Starlink? No`;
  }
}

export function AirlineFactsPage({
  site,
  entry,
  trackedLinks,
}: {
  site: SiteConfig;
  entry: AirlineFactsEntry;
  trackedLinks: TrackedLink[];
}) {
  return (
    <PageShell site={site} heading={factsHeadline(entry)} sub={entry.summary}>
      {entry.status === "not_starlink" && entry.insteadOf && (
        <section className={SECTION}>
          <div className={PANEL}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[10px] font-mono text-muted uppercase tracking-wider">
                What they run instead
              </span>
              <FactsStatusPill entry={entry} />
            </div>
            <p className="text-sm text-secondary leading-relaxed">{entry.insteadOf}</p>
          </div>
        </section>
      )}

      <section className={SECTION}>
        {entry.status !== "not_starlink" && (
          <div className="flex items-center justify-end mb-2">
            <FactsStatusPill entry={entry} />
          </div>
        )}
        <FactsList entry={entry} />
      </section>

      {entry.status === "announced" && (
        <section className={SECTION}>
          <div className={PANEL}>
            <p className="text-sm text-muted leading-relaxed">
              Nothing to track tail-by-tail yet — no {entry.shortName} aircraft flies with Starlink
              today. When installs begin, this page grows into a live tracker like the ones below:
              per-aircraft status, install pace, and flight-level answers.
            </p>
          </div>
        </section>
      )}

      {trackedLinks.length > 0 && (
        <section className={SECTION}>
          <div className={PANEL}>
            <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
              Tracked live, tail-by-tail
            </div>
            <p className="text-sm text-muted leading-relaxed mb-3">
              Flying one of these instead? We track their Starlink rollouts aircraft-by-aircraft —
              check a specific flight number and date:
            </p>
            <div className="flex flex-wrap gap-2">
              {trackedLinks.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  className="font-mono text-xs px-3 py-1.5 bg-surface-elevated border border-subtle rounded text-secondary hover:text-accent hover:border-accent transition-colors"
                >
                  {l.name} →
                </a>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className={`${SECTION} text-center`}>
        <a href="/airlines" className="font-mono text-xs text-secondary hover:text-accent">
          ← All airlines with Starlink
        </a>
      </section>
    </PageShell>
  );
}
