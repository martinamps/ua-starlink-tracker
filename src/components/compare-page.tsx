/**
 * Hub-only /compare/{a}-vs-{b}: two tracked airlines' Starlink rollouts side
 * by side. Everything renders from the registry, the DB roster (the same
 * per-subfleet penetration /api/compare-route serves), and dated
 * rollout-facts — no live lookups, no blended numbers across type-split
 * programs. Bounded space: only tracked-airline pairs exist, in one canonical
 * slug order.
 */

import type React from "react";
import { type AirlineConfig, type SiteConfig, airlineSlug } from "../airlines/registry";
import type { AirlineFactsEntry } from "../airlines/rollout-facts";
import type { TypeProgress } from "../database/database";
import type { SubfleetBreakdown } from "../scripts/starlink-predictor";
import type { PerAirlineStat } from "../types";
import { article } from "../utils/grammar";
import { FactsList, PhaseTable, type TypePhase } from "./airlines-page";
import { type PageLink, StagePill, trackedStage } from "./atoms";
import { TypeShareTable } from "./community-airline-page";
import { PANEL, PageHeader, PageShell, fmt } from "./layout";

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
  facts: AirlineFactsEntry | null;
  /** Flight-level lookup on the airline's own surface, when one exists. */
  checkFlightUrl: string | null;
}

function pctOf(stat: PerAirlineStat): { fleet: number; pct: number } {
  // Full-fleet denominator — the same number each airline's own tracker
  // publishes, so the two sides are comparable and neither is flattered.
  const fleet = stat.total;
  return { fleet, pct: fleet > 0 ? Math.round((stat.starlink / fleet) * 100) : 0 };
}

function SidePanel({ side }: { side: CompareSide }) {
  const { cfg, stat } = side;
  const { fleet, pct } = pctOf(stat);
  // A type-determined program has no honest single number: the denominator
  // includes families excluded from the program by design (QR's A380s and
  // A330s, HA's 717s), so "46% of fleet" understates the answer for a 777
  // passenger and overstates it for an A380 one. Those programs show the
  // per-family table INSTEAD — the blended figure is exactly the average the
  // predict path refuses to publish.
  const showBlended = fleet > 0 && !side.phases && !side.typeProgress;
  return (
    <div className={`${PANEL} flex flex-col`}>
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
          <div className="font-display text-3xl text-primary leading-none mb-1 tabular-nums">
            {fmt(stat.starlink)}
            <span className="text-base text-muted"> of {fmt(fleet)}</span>
          </div>
          <div className="text-sm text-secondary mb-2">
            aircraft have Starlink · {pct}% of the fleet
          </div>
          <div className="h-1.5 rounded bg-surface-elevated overflow-hidden mb-3">
            <div
              className="h-full rounded"
              style={{
                width: `${Math.min(100, pct)}%`,
                background: cfg.brand.accentColor,
                boxShadow: `0 0 6px ${cfg.brand.accentColor}90`,
              }}
            />
          </div>
          {(stat.installs30d ?? 0) > 0 && (
            <div className="text-xs text-secondary mb-3">
              +{fmt(stat.installs30d ?? 0)} in the last 30 days
            </div>
          )}
        </>
      )}
      {fleet === 0 && (
        <p className="text-sm text-muted mb-3">
          No per-aircraft counts yet — coverage begins as {cfg.shortName} installation data lands.
        </p>
      )}

      {side.phases ? <PhaseTable phases={side.phases} /> : null}
      {side.typeProgress ? <TypeShareTable types={side.typeProgress} compact /> : null}

      <p className="text-sm text-muted leading-relaxed mb-4">{cfg.rollout.phaseNote}</p>

      {side.phases || side.typeProgress ? null : side.breakdown.length > 0 ? (
        <div className="mb-4">
          <div className="text-xs font-mono text-muted uppercase tracking-wider mb-1">
            By fleet group
          </div>
          {side.breakdown.map((b) => (
            <div
              key={b.key}
              className="flex items-center justify-between py-1.5 border-b border-subtle last:border-0"
            >
              <span className="font-mono text-xs text-primary">
                {b.label}
                {b.hint && <span className="text-muted"> ({b.hint})</span>}
              </span>
              <span className="font-mono text-xs text-secondary">
                {b.synthetic
                  ? `${Math.round(b.pct * 100)}%`
                  : `${fmt(b.equipped)} of ${fmt(b.total)} · ${Math.round(b.pct * 100)}%`}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2">
        {side.trackerHost && (
          <a
            href={`https://${side.trackerHost}/`}
            className="font-mono text-xs px-3 py-1.5 bg-accent/20 border border-accent rounded text-accent hover:bg-accent/30 transition-colors"
          >
            Full {cfg.shortName} tracker →
          </a>
        )}
        {side.checkFlightUrl && (
          <a
            href={side.checkFlightUrl}
            className="font-mono text-xs px-3 py-1.5 bg-surface-elevated border border-subtle rounded text-secondary hover:text-accent hover:border-accent transition-colors"
          >
            Check {article(cfg.shortName)} {cfg.shortName} flight →
          </a>
        )}
      </div>
    </div>
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
  pageLinks?: PageLink[];
  currentPath?: string;
}) {
  const heading = `${left.cfg.shortName} vs ${right.cfg.shortName}: Starlink WiFi`;
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={heading}
        dek="Install counts, rates by fleet group and where each rollout stands, side by side."
      />

      <section className="relative w-full max-w-5xl mx-auto mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SidePanel side={left} />
          <SidePanel side={right} />
        </div>
        <p className="text-xs text-muted leading-relaxed mt-3 max-w-3xl">
          Percentages are shares of each airline's whole fleet, the same figure its own tracker
          shows. Airlines that decide Starlink by aircraft type get a per-type table instead,
          because their fleets include types that aren't in the programme. Either way, your flight's
          answer depends on the aircraft assigned, so check the flight number.
        </p>
      </section>

      <section className="relative w-full max-w-3xl mx-auto mb-8">
        <div className={PANEL}>
          <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">
            Flying a specific route?
          </div>
          <p className="text-sm text-muted leading-relaxed">
            The{" "}
            <a href="/" className="text-accent hover:underline">
              route comparer on the homepage
            </a>{" "}
            scores a nonstop city pair per airline — which carrier's planes on that exact route have
            Starlink today.
          </p>
        </div>
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
