/**
 * Hub-only /compare/{a}-vs-{b}: two tracked airlines' Starlink rollouts side
 * by side. Everything renders from the registry, the DB roster (the same
 * per-subfleet penetration /api/compare-route serves), and dated
 * rollout-facts — no live lookups, no blended numbers across type-split
 * programs. Bounded space: only tracked-airline pairs exist, in one canonical
 * slug order.
 */

import { type AirlineConfig, type SiteConfig, airlineSlug } from "../airlines/registry";
import type { AirlineFactsEntry } from "../airlines/rollout-facts";
import type { TypeProgress } from "../database/database";
import type { SubfleetBreakdown } from "../scripts/starlink-predictor";
import type { PerAirlineStat } from "../types";
import { article } from "../utils/grammar";
import { FactsList, PhaseTable, type TypePhase } from "./airlines-page";
import { StagePill, trackedStage } from "./atoms";
import { TypeShareTable } from "./community-airline-page";
import type { Link } from "./layout";
import { ButtonLink, Eyebrow, PageHeader, PageShell, Panel, StatValue } from "./layout";
import { fmt, pct, probLabel } from "./ui/format";
import { Meter } from "./ui/meter";

export interface CompareSide {
  cfg: AirlineConfig;
  stat: PerAirlineStat;
  /** Canonical host of a live dedicated tracker; null → hub-only coverage. */
  trackerHost: string | null;
  /** Per-subfleet install rates from the roster (same block compareRoute
   * serves); empty when the roster has no penetration data. */
  breakdown: SubfleetBreakdown[];
  /** Type→phase table for type-determined programs (HA/QR); null otherwise.
   * Rendered instead of a single blended number — a flight's answer depends
   * on which family flies it. */
  phases: TypePhase[] | null;
  /** Per-programme-type counts for a community-source airline (AF) — also
   * rendered instead of a blended number. */
  typeProgress?: TypeProgress[] | null;
  /** The guide behind typeProgress is past its mark TTL. */
  typeProgressStale?: boolean;
  facts: AirlineFactsEntry | null;
  /** Flight-level lookup on the airline's own surface, when one exists. */
  checkFlightUrl: string | null;
  /** See AirlineOverview.scopeNote. */
  scopeNote?: string | null;
}

/** A rule-set share has no counts behind it: "All", "None", or the share. */
function syntheticShare(p: number): string {
  if (p >= 1) return "All";
  if (p <= 0) return "None";
  return probLabel(p);
}

function SidePanel({ side }: { side: CompareSide }) {
  const { cfg, stat } = side;
  // Full-fleet denominator: the same number each airline's own tracker
  // publishes, so the two sides are comparable and neither is flattered.
  const fleet = stat.total;
  // A type-determined program has no honest single number: the denominator
  // includes families excluded from the program by design (QR's A380s and
  // A330s, HA's 717s), so "46% of fleet" understates the answer for a 777
  // passenger and overstates it for an A380 one. Those programs show the
  // per-family table INSTEAD — the blended figure is exactly the average the
  // predict path refuses to publish.
  const showBlended = fleet > 0 && !side.phases && !side.typeProgress;
  return (
    <Panel className="flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-3">
        <a
          href={`/airlines/${airlineSlug(cfg)}`}
          className="font-display text-lg font-semibold text-primary hover:text-accent transition-colors"
        >
          {cfg.name}
        </a>
        <StagePill info={trackedStage(cfg, stat)} />
      </div>

      {showBlended && (
        <>
          <StatValue className="mb-1" unit={`of ${fmt(fleet)}`}>
            {fmt(stat.starlink)}
          </StatValue>
          <div className="text-sm text-secondary mb-2">
            have Starlink ({pct(stat.starlink, fleet)})
          </div>
          {side.scopeNote && <p className="text-xs text-muted mb-2">{side.scopeNote}</p>}
          <Meter
            share={stat.starlink / fleet}
            color={cfg.brand.accentColor}
            size="sm"
            className="mb-3"
          />
          {(stat.installs30d ?? 0) > 0 && (
            <div className="text-xs text-secondary mb-3">
              +{fmt(stat.installs30d ?? 0)} in the last 30 days
            </div>
          )}
        </>
      )}
      {side.phases ? <PhaseTable phases={side.phases} note={false} /> : null}
      {side.typeProgress ? (
        <TypeShareTable types={side.typeProgress} stale={side.typeProgressStale} compact />
      ) : null}

      <p className="text-sm text-muted leading-relaxed mb-4">{cfg.rollout.phaseNote}</p>

      {side.phases || side.typeProgress ? null : side.breakdown.length > 0 ? (
        <div className="mb-4">
          <Eyebrow className="mb-1">By fleet group</Eyebrow>
          {side.breakdown.map((b) => (
            <div
              key={b.key}
              className="flex items-center justify-between py-1.5 border-b border-subtle last:border-0"
            >
              <span className="font-mono text-xs text-primary">
                {b.label.replace(/\s*\((.*)\)$/, " $1")}
                {b.hint && <span className="text-muted"> ({b.hint})</span>}
              </span>
              <span className="font-mono text-xs text-secondary">
                {b.synthetic
                  ? syntheticShare(b.pct)
                  : `${fmt(b.equipped)} of ${fmt(b.total)} · ${pct(b.equipped, b.total)}`}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2">
        {side.trackerHost && (
          <ButtonLink href={`https://${side.trackerHost}/`} size="sm">
            {cfg.shortName} Starlink Tracker →
          </ButtonLink>
        )}
        {side.checkFlightUrl && (
          <ButtonLink href={side.checkFlightUrl} variant="secondary" size="sm">
            Check {article(cfg.shortName)} {cfg.shortName} flight →
          </ButtonLink>
        )}
      </div>
    </Panel>
  );
}

export default function ComparePage({
  site,
  left,
  right,
  pageLinks,
  currentPath,
}: {
  site: SiteConfig;
  left: CompareSide;
  right: CompareSide;
  pageLinks?: Link[];
  currentPath?: string;
}) {
  const heading = `${left.cfg.shortName} vs ${right.cfg.shortName}: Starlink Wi-Fi`;
  const sides = [left, right];
  const shares = sides.some((s) => s.stat.total > 0 && !s.phases && !s.typeProgress);
  const byType = sides.some((s) => s.phases || s.typeProgress);
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader title={heading} dek="Where each Starlink rollout stands, side by side." />

      <section className="relative w-full max-w-5xl mx-auto mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SidePanel side={left} />
          <SidePanel side={right} />
        </div>
        <p className="text-xs text-muted leading-relaxed mt-3 max-w-3xl">
          {shares && "Shares are of each airline's whole fleet. "}
          {byType && "Where the table is by type, your aircraft type decides it. "}
          Your flight depends on the aircraft assigned.
        </p>
      </section>

      <section className="relative w-full max-w-3xl mx-auto mb-8">
        <Panel>
          <Eyebrow className="mb-2">By route</Eyebrow>
          <p className="text-sm text-muted leading-relaxed">
            Compare airlines on a nonstop route with the{" "}
            <a href="/" className="text-accent hover:underline">
              homepage route comparer
            </a>
            .
          </p>
        </Panel>
      </section>

      {(left.facts || right.facts) && (
        <section className="relative w-full max-w-5xl mx-auto mb-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[left, right].map((side) =>
              side.facts ? (
                <FactsList key={side.cfg.code} entry={side.facts} />
              ) : (
                <div key={side.cfg.code} />
              )
            )}
          </div>
        </section>
      )}
    </PageShell>
  );
}
