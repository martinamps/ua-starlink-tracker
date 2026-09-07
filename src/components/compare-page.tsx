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
import type { SubfleetBreakdown } from "../scripts/starlink-predictor";
import type { PerAirlineStat } from "../types";
import { FactsList, PhaseTable, type TypePhase } from "./airlines-page";
import { PageFooter, type PageLink, STATUS_TONE } from "./atoms";

const PANEL = "bg-surface border border-subtle rounded-lg p-5";

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
  const tone = STATUS_TONE[cfg.rollout.status];
  // A type-determined program has no honest single number: the denominator
  // includes families excluded from the program by design (QR's A380s and
  // A330s, HA's 717s), so "46% of fleet" understates the answer for a 777
  // passenger and overstates it for an A380 one. Those programs show the
  // per-family table INSTEAD — the blended figure is exactly the average the
  // predict path refuses to publish.
  const showBlended = fleet > 0 && !side.phases;
  return (
    <div className={`${PANEL} flex flex-col`}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <a
          href={`/airlines/${airlineSlug(cfg)}`}
          className="font-display text-lg font-semibold text-primary hover:text-accent transition-colors"
        >
          {cfg.name}
        </a>
        <span
          className="font-mono text-[10px] uppercase tracking-wide px-2 py-1 rounded-full shrink-0"
          style={{ color: tone.color, background: tone.bg }}
        >
          {cfg.rollout.statusLabel}
        </span>
      </div>

      {showBlended && (
        <>
          <div className="font-mono text-3xl font-semibold text-primary leading-none mb-1">
            {stat.starlink}
            <span className="text-base text-muted font-normal"> / {fleet}</span>
          </div>
          <div className="font-mono text-[11px] text-muted uppercase tracking-wider mb-2">
            aircraft equipped · {pct}% of fleet
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
            <div className="font-mono text-[11px] text-secondary mb-3">
              +{stat.installs30d} equipped in the last 30 days
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

      <p className="text-sm text-muted leading-relaxed mb-4">{cfg.rollout.phaseNote}</p>

      {side.phases ? null : side.breakdown.length > 0 ? (
        <div className="mb-4">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-1">
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
              <span className="font-mono text-[11px] text-secondary">
                {b.synthetic
                  ? `${Math.round(b.pct * 100)}%`
                  : `${b.equipped} / ${b.total} · ${Math.round(b.pct * 100)}%`}
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
            Check a {cfg.shortName} flight →
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
}: {
  site: SiteConfig;
  left: CompareSide;
  right: CompareSide;
  pageLinks?: PageLink[];
}) {
  const heading = `${left.cfg.shortName} vs ${right.cfg.shortName}: Starlink WiFi`;
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            {heading}
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-2xl mx-auto">
          Live install counts, per-fleet-group rates, and where each rollout stands — from the same
          tail-level data behind the dedicated trackers.
        </p>
      </header>

      <section className="relative w-full max-w-5xl mx-auto mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SidePanel side={left} />
          <SidePanel side={right} />
        </div>
        <p className="text-[11px] text-muted leading-relaxed mt-3 max-w-3xl">
          Where a percentage is shown it is a share of that airline's full tracked fleet — the same
          denominator its dedicated tracker publishes — so neither side is flattered. Airlines whose
          program is decided by aircraft type get the per-type table instead of a percentage,
          because their full-fleet denominator includes types the program deliberately excludes.
          Either way, whether a specific flight has Starlink depends on the aircraft assigned, not
          the airline average: check the flight number for a real answer.
        </p>
      </section>

      <section className="relative w-full max-w-3xl mx-auto mb-8">
        <div className={PANEL}>
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
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

      <section className="relative w-full max-w-3xl mx-auto mb-8 text-center">
        <a href="/airlines" className="font-mono text-xs text-secondary hover:text-accent">
          ← All airlines with Starlink
        </a>
      </section>

      <div className="mt-auto" />
      <PageFooter site={site} pageLinks={pageLinks} />
    </div>
  );
}
