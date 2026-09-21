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
import { aircraftName } from "../airlines/aircraft-families";
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
  ROLLOUT_TONE,
  StagePill,
  factsStage,
  shareIsPublishable,
  trackedStage,
  trackingMethod,
} from "./atoms";
import {
  ButtonLink,
  Chip,
  Eyebrow,
  type Link,
  PageHeader,
  PageShell,
  Panel,
  SECTION,
  Section,
  StatValue,
  Td,
  Th,
} from "./layout";
import { fmt, pct } from "./ui/format";
import { Pill, TONE_TEXT, type Tone } from "./ui/tone";

const FACTS_TONE: Record<RolloutFactsStatus, Tone> = {
  complete: "success",
  installing: "info",
  announced: "warn",
  trial: "trial",
  not_starlink: "danger",
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
  /** The roster's name for the row ("787-8", "A320 and A321neo"); aircraftName(family) otherwise. */
  label?: string;
  phase: WifiPhase;
  /** Roster counts for the family, when known. */
  equipped?: number;
  total?: number;
}

const PHASE_LABEL: Record<WifiPhase, { text: string; tone: Tone }> = {
  confirmed: { text: "Starlink on every one", tone: "success" },
  rolling: { text: "Installing", tone: "warn" },
  // "No Starlink planned" claims the airline ruled the type out. For some of
  // these it did (HA's 717s); for others it has simply never said (QR's A380s
  // and A330s — the registry's own note is "no installation plan announced").
  // One phase covers both, so the label says only what both support.
  negative: { text: "Not in the programme", tone: "neutral" },
};

/** The answer for an airline whose Starlink status is decided by aircraft
 * type. It REPLACES the blended fleet percentage rather than sitting under it:
 * the full-fleet denominator counts families the program excludes by design
 * (QR's A380s and A330s, HA's 717s), so a single percentage is wrong in both
 * directions at once — the same average the predict path refuses to publish. */
export function PhaseTable({ phases }: { phases: TypePhase[] }) {
  return (
    <div className="mb-4">
      <Eyebrow className="mb-1">By aircraft type</Eyebrow>
      {phases.map(({ family, label, phase, equipped, total }) => {
        const p = PHASE_LABEL[phase];
        return (
          <div
            key={family}
            data-family={family}
            className="flex items-center justify-between gap-3 py-1.5 border-b border-subtle last:border-0 text-sm"
          >
            <span className="text-primary">
              {label ?? aircraftName(family)}
              {total !== undefined && (
                <span className="text-muted tabular-nums">
                  {" "}
                  · {phase === "negative" ? fmt(total) : `${fmt(equipped ?? 0)} of ${fmt(total)}`}
                </span>
              )}
            </span>
            <span className={TONE_TEXT[p.tone]}>{p.text}</span>
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

export function StatusPill({ cfg }: { cfg: AirlineConfig }) {
  return <Pill tone={ROLLOUT_TONE[cfg.rollout.status]}>{cfg.rollout.statusLabel}</Pill>;
}

function FactsStatusPill({ entry }: { entry: AirlineFactsEntry }) {
  return <Pill tone={FACTS_TONE[entry.status]}>{entry.statusLabel}</Pill>;
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
    <Panel>
      <div className="flex items-center justify-between gap-2 mb-1">
        <Eyebrow as="span" className="">
          {entry.name}: dated facts
        </Eyebrow>
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
    </Panel>
  );
}

function TrackerCta({ overview }: { overview: AirlineOverview }) {
  const { cfg, trackerHost } = overview;
  // No live dedicated site and not on the hub homepage either (publicInHub
  // false) → nothing honest to funnel to yet.
  if (!trackerHost && !cfg.publicInHub) return null;
  const href = trackerHost ? `https://${trackerHost}/` : airlineHomeUrl(cfg.code);
  const label = trackerHost
    ? `Full ${cfg.shortName} tracker → ${trackerHost}`
    : `Live ${cfg.shortName} data on the hub tracker →`;
  return <ButtonLink href={href}>{label}</ButtonLink>;
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
  pageLinks?: Link[];
  currentPath?: string;
}) {
  const programmes = PROGRAMME_ORDER.flatMap((s) => roster.filter((e) => e.status === s));
  const negatives = roster.filter((e) => e.status === "not_starlink");
  const perPlane = airlines
    .filter((o) => trackingMethod(o.cfg) === "tail")
    .map((o) => o.cfg.shortName);
  const byType = airlines.some((o) => trackingMethod(o.cfg) === "type");
  return (
    <PageShell site={site} pageLinks={pageLinks} currentPath={currentPath}>
      <PageHeader
        title="Which airlines have Starlink Wi-Fi?"
        dek={`${airlines.length + roster.length} airlines, from finished fleets to firm no's. We count ${perPlane.join(" and ")} plane by plane.`}
      />
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
              <Chip key={c.href} href={c.href} size="sm">
                {c.name} →
              </Chip>
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
  pageLinks?: Link[];
  currentPath?: string;
}) {
  const { cfg, stat } = overview;
  // The full-fleet denominator the airline's own tracker publishes; fleetTotal
  // counts only tails we hold rows for and would quote a higher share.
  const fleet = stat.total;
  const showBlended = fleet > 0 && !phases;
  return (
    <PageShell site={site} pageLinks={pageLinks} currentPath={currentPath}>
      <PageHeader
        title={`${cfg.name} Starlink WiFi`}
        dek={`${cfg.rollout.statusLabel} — ${cfg.rollout.phaseNote}`}
      />
      <section className={SECTION}>
        <Panel>
          <div className="flex items-center justify-between gap-2 mb-3">
            <Eyebrow as="span" className="">
              Rollout status
            </Eyebrow>
            <StatusPill cfg={cfg} />
          </div>
          {showBlended && (
            <StatValue
              className="mb-2"
              unit={`of ${fmt(fleet)} aircraft · ${pct(stat.starlink, fleet)}`}
            >
              {fmt(stat.starlink)}
            </StatValue>
          )}
          {fleet === 0 && (
            <p className="text-sm text-muted">
              No per-aircraft data yet — this page updates as {cfg.shortName} installation data
              lands.
            </p>
          )}
          {phases && <PhaseTable phases={phases} />}
          {showBlended && (stat.installs30d ?? 0) > 0 && (
            <div className="text-xs text-secondary mb-1">
              +{fmt(stat.installs30d ?? 0)} aircraft equipped in the last 30 days
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
        </Panel>
      </section>

      {facts && (
        <section className={SECTION}>
          <FactsList entry={facts} />
        </section>
      )}

      <section className={`${SECTION} text-center`}>
        <TrackerCta overview={overview} />
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
  pageLinks?: Link[];
  currentPath?: string;
}) {
  return (
    <PageShell site={site} pageLinks={pageLinks} currentPath={currentPath}>
      <PageHeader title={factsHeadline(entry)} dek={entry.summary} />
      {entry.status === "not_starlink" && entry.insteadOf && (
        <section className={SECTION}>
          <Panel>
            <div className="flex items-center justify-between gap-2 mb-2">
              <Eyebrow as="span" className="">
                What they run instead
              </Eyebrow>
              <FactsStatusPill entry={entry} />
            </div>
            <p className="text-sm text-secondary leading-relaxed">{entry.insteadOf}</p>
          </Panel>
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
          <Panel>
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
          </Panel>
        </section>
      )}

      {trackedLinks.length > 0 && (
        <section className={SECTION}>
          <Panel>
            <Eyebrow className="mb-2">Tracked live</Eyebrow>
            <p className="text-sm text-muted leading-relaxed mb-3">
              Flying one of these instead? We track their Starlink rollouts aircraft-by-aircraft —
              check a specific flight number and date:
            </p>
            <div className="flex flex-wrap gap-2">
              {trackedLinks.map((l) => (
                <Chip key={l.href} href={l.href} size="sm">
                  {l.name} →
                </Chip>
              ))}
            </div>
          </Panel>
        </section>
      )}
    </PageShell>
  );
}
