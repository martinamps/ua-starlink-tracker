import React from "react";
import {
  AIRLINES,
  type AirlineConfig,
  airlineHomeUrl,
  wifiPhaseFamilies,
} from "../airlines/registry";
import type { RolloutFactsStatus } from "../airlines/rollout-facts";
import type { PopularFlight } from "../database/database";
import type { PerAirlineStat, RecentInstall } from "../types";
import { denominatorIsPublishable } from "../utils/share-cards";
import { ButtonLink, Chip, Eyebrow, Panel } from "./layout";
import { fmt, monthDay, pct } from "./ui/format";
import { Meter } from "./ui/meter";
import { Pill, type Tone } from "./ui/tone";

export type { PerAirlineStat };
export type { PageLink } from "./layout";

/**
 * Download link for the pre-rendered share-stat card. Renders nothing until
 * the nightly batch has produced the card (path is null when the file isn't
 * on disk) — a dead download link is worse than no button.
 */
export function ShareCardLink({ path }: { path?: string | null }) {
  if (!path) return null;
  return (
    <div className="relative text-center py-2">
      <ButtonLink href={path} download variant="secondary" size="sm" className="gap-2">
        <svg
          className="w-3.5 h-3.5"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Share this stat — download the card
      </ButtonLink>
    </div>
  );
}

/**
 * Server-rendered inlinks into the /check-flight/{fn} permalink corpus, shared
 * by /, /check-flight, and /routes. The corpus is otherwise reachable only via
 * the sitemap, which crawlers treat as discovery, not endorsement — these
 * blocks give the most-observed flight pages real crawl depth. Anchor text
 * carries the route so the link targets the qualified "does UA123 have
 * starlink" intent, not the bare flight-status query.
 */
export function PopularFlightsLinks({
  flights,
  airlineName,
}: {
  flights: PopularFlight[];
  airlineName: string;
}) {
  if (flights.length === 0) return null;
  return (
    <Panel data-popular-flights="">
      <Eyebrow>Popular flights</Eyebrow>
      <div className="flex flex-wrap gap-2">
        {flights.map((f) => (
          <Chip key={f.flight_number} href={`/check-flight/${f.flight_number}`}>
            {f.flight_number}
            {/* Arrow, not the en dash /routes uses for its own O-D labels — the
                route-pages guard treats a dashed pair as an unlinked route label. */}
            {f.origin && f.destination && (
              <span className="text-muted">
                {" "}
                {f.origin} → {f.destination}
              </span>
            )}
          </Chip>
        ))}
      </div>
      <p className="text-xs text-muted mt-4 leading-snug">
        The {airlineName} flights we see most. Each shows its Starlink history and a check by date.
      </p>
    </Panel>
  );
}

export const ROLLOUT_TONE: Record<AirlineConfig["rollout"]["status"], Tone> = {
  complete: "success",
  phase_done: "warn",
  in_progress: "info",
};

/**
 * One status vocabulary for every airline on the hub, /airlines and /compare.
 * The registry's free-text labels ("Regional fleet done", "Widebodies nearly
 * done") stay on detail pages; lists and tables speak only these words.
 */
type Stage = "Announced" | "Trial" | "Installing" | "Mostly done" | "Complete" | "Not Starlink";

const STAGE_TONE: Record<Stage, Tone> = {
  Announced: "warn",
  Trial: "trial",
  Installing: "info",
  "Mostly done": "info",
  Complete: "success",
  "Not Starlink": "danger",
};

export interface StageInfo {
  stage: Stage;
  /** The stage, qualified where it covers only part of the fleet: "Complete (Airbus fleet)". */
  label: string;
}

// Where a finished programme deliberately leaves types out, the stage names
// what was finished rather than implying the whole fleet.
const COMPLETE_SCOPE: Partial<Record<string, string>> = { HA: "Airbus fleet" };

export function completeScope(code: string | undefined): string | undefined {
  return code ? COMPLETE_SCOPE[code] : undefined;
}

/** Can this airline's equipped/total ratio be published? Same rule the share
 * card and /badge.svg follow, so no surface quotes a share another refuses. */
export function shareIsPublishable(cfg: AirlineConfig, stat: PerAirlineStat): boolean {
  return denominatorIsPublishable(stat.starlink, stat.total, cfg.rollout.rosterIsProgramScope);
}

export function trackedStage(cfg: AirlineConfig, stat: PerAirlineStat): StageInfo {
  if (shareIsPublishable(cfg, stat)) {
    const share = stat.starlink / stat.total;
    const stage: Stage = share >= 1 ? "Complete" : share >= 0.6 ? "Mostly done" : "Installing";
    return { stage, label: stage };
  }
  const stage: Stage =
    cfg.rollout.status === "complete"
      ? "Complete"
      : cfg.rollout.status === "phase_done"
        ? "Mostly done"
        : "Installing";
  const scope = stage === "Complete" ? COMPLETE_SCOPE[cfg.code] : undefined;
  return { stage, label: scope ? `${stage} (${scope})` : stage };
}

export function factsStage(status: RolloutFactsStatus): StageInfo {
  const stage: Stage = {
    announced: "Announced",
    trial: "Trial",
    installing: "Installing",
    complete: "Complete",
    not_starlink: "Not Starlink",
  }[status] as Stage;
  return { stage, label: stage };
}

export function StagePill({ info }: { info: StageInfo }) {
  return <Pill tone={STAGE_TONE[info.stage]}>{info.label}</Pill>;
}

/** How an airline's Starlink status is decided: per aircraft, by aircraft
 * type, or from a community-curated list. Only "tail" earns "plane by plane". */
export function trackingMethod(cfg: AirlineConfig): "tail" | "type" | "community" {
  if (cfg.communitySource) return "community";
  return wifiPhaseFamilies(cfg.code) ? "type" : "tail";
}

/**
 * One row per tracked airline: name, standard stage, and a bar where the
 * fleet share is publishable. Where it isn't (the roster counts types the
 * programme excludes) the row gives the count and the airline's own note, never
 * a ratio that would make a finished rollout look two-thirds done.
 */
export function AirlineProgressList({ stats }: { stats: PerAirlineStat[] }) {
  const rows = stats
    .map((stat) => ({ stat, cfg: AIRLINES[stat.code] }))
    .filter((r): r is { stat: PerAirlineStat; cfg: AirlineConfig } => Boolean(r.cfg))
    .sort((a, b) => b.stat.starlink - a.stat.starlink);
  return (
    <ul className="divide-y divide-subtle">
      {rows.map(({ stat, cfg }) => {
        const publishable = shareIsPublishable(cfg, stat);
        return (
          <li key={cfg.code} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-3">
              <a
                href={stat.href || "#"}
                className="font-display text-base text-primary hover:text-accent transition-colors"
              >
                {cfg.name}
              </a>
              <StagePill info={trackedStage(cfg, stat)} />
            </div>
            {publishable ? (
              <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-3">
                <Meter
                  share={stat.starlink / stat.total}
                  color={stat.accentText ?? stat.accentColor}
                  label={`${cfg.name}: ${fmt(stat.starlink)} of ${fmt(stat.total)} aircraft (${pct(stat.starlink, stat.total)})`}
                />
                <span className="text-sm text-secondary tabular-nums whitespace-nowrap">
                  {fmt(stat.starlink)} of {fmt(stat.total)} · {pct(stat.starlink, stat.total)}
                </span>
              </div>
            ) : (
              <p className="mt-1 text-sm text-secondary">
                <strong className="font-semibold text-primary tabular-nums">
                  {fmt(stat.starlink)}
                </strong>{" "}
                aircraft with Starlink. {stat.phaseNote}
              </p>
            )}
            {(stat.installs30d ?? 0) > 0 && (
              <p className="mt-1 text-xs text-muted">
                +{fmt(stat.installs30d ?? 0)} in the last 30 days
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function RecentInstallsFeed({
  items,
  airlines,
}: { items: RecentInstall[]; airlines: PerAirlineStat[] }) {
  // Group once per airline — the per-row airline name was 90%+ "United Airlines".
  const grouped = airlines
    .map((a) => ({ cfg: a, rows: items.filter((i) => i.airline === a.code) }))
    .filter((g) => g.rows.length > 0);
  return (
    <Panel>
      <Eyebrow>Recent installs</Eyebrow>
      {grouped.length === 0 ? (
        <div className="text-xs text-muted font-mono">No recent installs</div>
      ) : (
        <>
          {grouped.map((g) => (
            <div key={g.cfg.code} className="mb-3 last:mb-0">
              <div className="flex items-center gap-1.5 text-xs font-mono text-muted mb-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{
                    background: g.cfg.accentText ?? g.cfg.accentColor ?? "var(--color-text-muted)",
                  }}
                />
                {g.cfg.name}
              </div>
              <div className="space-y-1">
                {g.rows.map((r) => (
                  <a
                    key={r.TailNumber}
                    href={airlineHomeUrl(g.cfg.code, { q: r.TailNumber })}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-elevated transition-colors group"
                  >
                    <span className="font-mono text-xs text-primary group-hover:text-accent transition-colors w-16">
                      {r.TailNumber}
                    </span>
                    <span className="font-mono text-xs text-muted flex-1 truncate">
                      {r.Aircraft}
                    </span>
                    {r.OperatedBy && (
                      <span className="font-mono text-xs text-secondary truncate hidden sm:inline">
                        {r.OperatedBy}
                      </span>
                    )}
                    <span className="font-mono text-xs text-muted w-12 text-right">
                      {monthDay(r.DateFound)}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}

export function TypeBreakdownRow({
  type,
  count,
  status,
  note,
}: {
  type: string;
  count?: number;
  status: "starlink" | "none" | "pending";
  note?: string;
}) {
  const icon =
    status === "starlink" ? (
      <span className="text-success font-mono">✓</span>
    ) : status === "pending" ? (
      <span className="text-warn font-mono">…</span>
    ) : (
      <span className="text-muted font-mono">—</span>
    );
  const label =
    status === "starlink"
      ? "Starlink"
      : status === "pending"
        ? note || "Planned"
        : note || "No Wi-Fi";
  return (
    <div className="flex items-center justify-between py-3 px-4 border-b border-subtle last:border-0">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <div className="font-mono text-sm text-primary">{type}</div>
          {count !== undefined && (
            <div className="text-xs font-mono text-muted">{count} aircraft</div>
          )}
        </div>
      </div>
      <div className={`text-xs font-mono ${status === "starlink" ? "text-success" : "text-muted"}`}>
        {label}
      </div>
    </div>
  );
}

export function HeaderStatStrip({ items }: { items: React.ReactNode[] }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 sm:gap-x-6 text-xs sm:text-sm font-mono text-muted">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static per-airline list, never reorders
        <React.Fragment key={i}>
          {/* Separators only where the strip fits one line: on a phone it wraps,
              and a dot would start or end a line on its own. */}
          {i > 0 && (
            <span className="hidden sm:inline text-subtle" aria-hidden="true">
              ·
            </span>
          )}
          {it}
        </React.Fragment>
      ))}
    </div>
  );
}
