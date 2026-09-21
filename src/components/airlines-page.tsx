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
import {
  type PageLink,
  STATUS_TONE,
  StagePill,
  factsStage,
  shareIsPublishable,
  trackedStage,
  trackingMethod,
} from "./atoms";
import {
  PANEL,
  PageHeader,
  SECTION,
  Section,
  PageShell as Shell,
  Td,
  Th,
  aircraftName,
  fmt,
  pct,
} from "./layout";

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
  /** Roster counts for the family, when known. */
  equipped?: number;
  total?: number;
}

const PHASE_LABEL: Record<WifiPhase, { text: string; tone: "yes" | "mid" | "no" }> = {
  confirmed: { text: "Starlink on every one", tone: "yes" },
  rolling: { text: "Installing", tone: "mid" },
  // "No Starlink planned" claims the airline ruled the type out. For some of
  // these it did (HA's 717s); for others it has simply never said (QR's A380s
  // and A330s — the registry's own note is "no installation plan announced").
  // One phase covers both, so the label says only what both support.
  negative: { text: "Not in the programme", tone: "no" },
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
      <div className="text-xs font-mono text-muted uppercase tracking-wider mb-1">
        By aircraft type
      </div>
      {phases.map(({ family, phase, equipped, total }) => {
        const p = PHASE_LABEL[phase];
        return (
          <div
            key={family}
            data-family={family}
            className="flex items-center justify-between gap-3 py-1.5 border-b border-subtle last:border-0 text-sm"
          >
            <span className="text-primary">
              {aircraftName(family)}
              {total !== undefined && (
                <span className="text-muted tabular-nums">
                  {" "}
                  · {phase === "negative" ? fmt(total) : `${fmt(equipped ?? 0)} of ${fmt(total)}`}
                </span>
              )}
            </span>
            <span className={TONE_CLASS[p.tone]}>{p.text}</span>
          </div>
        );
      })}
      <p className="text-xs text-muted leading-relaxed mt-2">
        Starlink here is decided by aircraft type, so the aircraft on your flight is the answer
        rather than a fleet percentage.
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

export function StatusPill({ cfg }: { cfg: AirlineConfig }) {
  const tone = STATUS_TONE[cfg.rollout.status];
  return (
    <span
      className="font-mono text-xs uppercase tracking-wide px-2 py-1 rounded-full shrink-0"
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
      className="font-mono text-xs uppercase tracking-wide px-2 py-1 rounded-full shrink-0"
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
      <div className="font-mono text-xs text-muted">
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
        {fact.source.mirror && (
          <>
            {" · "}
            <a
              href={fact.source.mirror}
              target="_blank"
              rel="noopener noreferrer"
              className="text-secondary hover:underline"
            >
              archived copy
            </a>
          </>
        )}
      </div>
    </li>
  );
}

export function FactsList({ entry }: { entry: AirlineFactsEntry }) {
  const stamp = factsStamp(entry);
  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-xs font-mono text-muted uppercase tracking-wider">
          {entry.name}: dated facts
        </span>
        <span className="font-mono text-xs text-muted">
          {stamp.label} {formatFactDate(stamp.date)}
        </span>
      </div>
      <ul className="list-none p-0 m-0">
        {entry.facts.map((f) => (
          <FactRow key={f.fact} fact={f} />
        ))}
      </ul>
      <p className="text-xs text-muted leading-relaxed mt-2">
        Each fact above shows the date it was true and links its source.
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

export function PageShell({
  site,
  heading,
  sub,
  children,
  pageLinks,
  currentPath,
}: {
  site: SiteConfig;
  heading: string;
  sub: string;
  children: React.ReactNode;
  pageLinks?: PageLink[];
  currentPath?: string;
}) {
  return (
    <Shell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader title={heading} dek={sub} />
      {children}
    </Shell>
  );
}

// Programmes first, in how far along they are; negatives get their own table
// so "does X have Starlink — no" lands on an explicit answer, not an absence.
const PROGRAMME_ORDER: RolloutFactsStatus[] = ["complete", "installing", "announced", "trial"];

const METHOD_LABEL = {
  tail: "Plane by plane",
  type: "By aircraft type",
  community: "Community fleet list",
} as const;

function EquippedCell({ o }: { o: AirlineOverview }) {
  const { cfg, stat } = o;
  if (stat.total === 0) return <span className="text-muted">No data yet</span>;
  if (shareIsPublishable(cfg, stat)) {
    return (
      <>
        {fmt(stat.starlink)} of {fmt(stat.total)}{" "}
        <span className="text-muted">({pct(stat.starlink, stat.total)})</span>
      </>
    );
  }
  return <>{fmt(stat.starlink)}</>;
}

export function AirlinesIndexPage({
  site,
  airlines,
  roster,
  comparisons,
  pageLinks,
  currentPath,
}: {
  site: SiteConfig;
  airlines: AirlineOverview[];
  /** Content-level entries WITHOUT tail-level tracking (tracked airlines
   * render in the first table; their facts live on their detail pages). */
  roster: AirlineFactsEntry[];
  /** Head-to-head /compare pages. This index is their only HTML entry point —
   * without these links the pair pages are sitemap-only orphans. */
  comparisons: TrackedLink[];
  pageLinks?: PageLink[];
  currentPath?: string;
}) {
  const programmes = PROGRAMME_ORDER.flatMap((s) => roster.filter((e) => e.status === s));
  const negatives = roster.filter((e) => e.status === "not_starlink");
  const perPlane = airlines
    .filter((o) => trackingMethod(o.cfg) === "tail")
    .map((o) => o.cfg.shortName);
  const byType = airlines.some((o) => trackingMethod(o.cfg) === "type");
  return (
    <PageShell
      site={site}
      pageLinks={pageLinks}
      currentPath={currentPath}
      heading="Which airlines have Starlink Wi-Fi?"
      sub={`${airlines.length + roster.length} airlines, from finished fleets to firm no's. We count ${perPlane.join(" and ")} plane by plane.`}
    >
      <Section title="Tracked here" wide>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Airline</Th>
                <Th>Status</Th>
                <Th optional>Counted</Th>
                <Th numeric>With Starlink</Th>
                <Th numeric optional>
                  Last 30 days
                </Th>
              </tr>
            </thead>
            <tbody>
              {airlines.map((o) => (
                <tr key={o.cfg.code}>
                  <Td>
                    <a
                      href={`/airlines/${airlineSlug(o.cfg)}`}
                      className="text-primary hover:text-accent transition-colors"
                    >
                      {o.cfg.name}
                    </a>
                    {o.trackerHost && (
                      <a
                        href={`https://${o.trackerHost}/`}
                        className="block text-xs text-accent hover:underline"
                      >
                        {o.cfg.shortName} Starlink Tracker →
                      </a>
                    )}
                  </Td>
                  <Td>
                    <StagePill info={trackedStage(o.cfg, o.stat)} />
                  </Td>
                  <Td optional className="text-secondary">
                    {METHOD_LABEL[trackingMethod(o.cfg)]}
                  </Td>
                  <Td numeric className="whitespace-nowrap text-primary">
                    <EquippedCell o={o} />
                  </Td>
                  <Td numeric optional className="text-secondary">
                    {(o.stat.installs30d ?? 0) > 0 ? `+${fmt(o.stat.installs30d ?? 0)}` : "–"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {byType && (
          <p className="mt-3 text-xs text-muted">
            Where Starlink is decided by aircraft type, the count assumes every aircraft of a
            finished type has it, so it can run ahead of the airline's own figure (Qatar reported
            150 in August 2026). No fleet share is shown for those airlines because their rosters
            include types that aren't in the programme.
          </p>
        )}
      </Section>

      {comparisons.length > 0 && (
        <Section
          title="Head to head"
          dek="Install counts and rollout status for two airlines, side by side."
        >
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
        </Section>
      )}

      {programmes.length > 0 && (
        <Section
          title="Other Starlink airlines"
          dek="Status from each airline's own announcements, dated and sourced on its page."
          wide
        >
          <RosterTable entries={programmes} />
        </Section>
      )}

      {negatives.length > 0 && (
        <Section
          title="Airlines without Starlink"
          dek="Airlines people ask about that chose a different system, or have announced nothing."
          wide
        >
          <RosterTable entries={negatives} />
        </Section>
      )}
    </PageShell>
  );
}

function RosterTable({ entries }: { entries: AirlineFactsEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>Airline</Th>
            <Th>Status</Th>
            <Th optional>Summary</Th>
            <Th numeric>As of</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const stamp = factsStamp(e);
            return (
              <tr key={e.slug}>
                <Td className="align-top">
                  <a
                    href={`/airlines/${e.slug}`}
                    className="text-primary hover:text-accent transition-colors"
                  >
                    {e.name}
                  </a>
                </Td>
                <Td className="align-top">
                  <StagePill info={factsStage(e.status)} />
                </Td>
                <Td optional className="align-top text-secondary">
                  {e.summary}
                </Td>
                <Td numeric className="align-top whitespace-nowrap text-muted">
                  {formatFactDate(stamp.date)}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AirlineDetailPage({
  site,
  overview,
  facts,
  phases,
  pageLinks,
  currentPath,
}: {
  site: SiteConfig;
  overview: AirlineOverview;
  /** Dated, sourced milestones for this airline (rollout-facts entry). */
  facts?: AirlineFactsEntry | null;
  /** Type→phase table for type-determined programs; null otherwise. Present →
   * this page publishes it INSTEAD of a blended fleet percentage. */
  phases?: TypePhase[] | null;
  pageLinks?: PageLink[];
  currentPath?: string;
}) {
  const { cfg, stat } = overview;
  const { fleet, pct } = fleetShare(stat);
  const showBlended = fleet > 0 && !phases;
  return (
    <PageShell
      site={site}
      pageLinks={pageLinks}
      currentPath={currentPath}
      heading={`${cfg.name} Starlink WiFi`}
      sub={`${cfg.rollout.statusLabel} — ${cfg.rollout.phaseNote}`}
    >
      <section className={SECTION}>
        <div className={PANEL}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <span className="text-xs font-mono text-muted uppercase tracking-wider">
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
  pageLinks,
  currentPath,
}: {
  site: SiteConfig;
  entry: AirlineFactsEntry;
  trackedLinks: TrackedLink[];
  pageLinks?: PageLink[];
  currentPath?: string;
}) {
  return (
    <PageShell
      site={site}
      pageLinks={pageLinks}
      currentPath={currentPath}
      heading={factsHeadline(entry)}
      sub={entry.summary}
    >
      {entry.status === "not_starlink" && entry.insteadOf && (
        <section className={SECTION}>
          <div className={PANEL}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs font-mono text-muted uppercase tracking-wider">
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
            {/* Describes the program state the dated facts above establish. The
                older wording asserted a fleet-wide negative ("no X aircraft
                flies with Starlink today") that carried neither a date nor a
                source — the one thing this file's own doctrine forbids. */}
            <p className="text-sm text-muted leading-relaxed">
              Nothing to track tail-by-tail yet — {entry.shortName}'s program is committed, and no
              equipped aircraft has been announced in the sources above. When installs begin, this
              page grows into a live tracker like the ones below: per-aircraft status, install pace,
              and flight-level answers.
            </p>
          </div>
        </section>
      )}

      {trackedLinks.length > 0 && (
        <section className={SECTION}>
          <div className={PANEL}>
            <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">
              Tracked live
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
    </PageShell>
  );
}
