import React from "react";
import {
  AIRLINES,
  type AirlineConfig,
  SITES,
  type SiteConfig,
  airlineHomeUrl,
  liveAirlineSites,
  wifiPhaseFamilies,
} from "../airlines/registry";
import type { RolloutFactsStatus } from "../airlines/rollout-facts";
import type { PopularFlight } from "../database/database";
import type { PerAirlineStat, RecentInstall } from "../types";
import { denominatorIsPublishable } from "../utils/share-cards";
import { fmt, pct } from "./layout";

export type { PerAirlineStat };

/**
 * One-line cross-domain footer links, rendered on every site. Registry-derived
 * (live sites only) and plain followed links — the sister domains are the same
 * publisher, so no nofollow. The hub's /airlines link stays relative on the
 * hub itself.
 */
export function CrossSiteLinks({ site }: { site: SiteConfig }) {
  const sisters = liveAirlineSites().filter(({ site: s }) => s.key !== site.key);
  const hubHost = SITES.airline.canonicalHost;
  const airlinesHref = site.scope === "ALL" ? "/airlines" : `https://${hubHost}/airlines`;
  // data-cross-site-links marks the block as a deliberate cross-tenant
  // mention — the tenant-matrix canary sweep strips it before scanning.
  return (
    <div data-cross-site-links className="mt-3 text-xs text-muted">
      Also tracking:{" "}
      {sisters.map(({ site: s, airline }) => (
        <React.Fragment key={s.key}>
          <a
            href={`https://${s.canonicalHost}/`}
            className="text-secondary hover:text-primary transition-colors"
          >
            {airline.shortName} Starlink tracker
          </a>
          <span className="mx-1.5 text-subtle">·</span>
        </React.Fragment>
      ))}
      <a href={airlinesHref} className="text-secondary hover:text-primary transition-colors">
        All airlines with Starlink
      </a>
    </div>
  );
}

/**
 * Download link for the pre-rendered share-stat card. Renders nothing until
 * the nightly batch has produced the card (path is null when the file isn't
 * on disk) — a dead download link is worse than no button.
 */
export function ShareCardLink({ path }: { path?: string | null }) {
  if (!path) return null;
  return (
    <div className="relative text-center py-2">
      <a
        href={path}
        download
        className="inline-flex items-center gap-2 font-mono text-xs px-3 py-2 bg-surface border border-subtle rounded text-secondary hover:text-accent hover:border-accent transition-colors"
      >
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
      </a>
    </div>
  );
}

export interface PageLink {
  href: string;
  label: string;
}

/**
 * Internal nav for the secondary URL families (/newly-equipped, /install-rate,
 * /embed). They are sitemapped and indexable, so without an inbound href from
 * a real page they are orphans — no PageRank path in and no way for a human to
 * find them. The server builds this list from the same sitePages() filter the
 * sitemap uses (feature flag AND data gate), so a link here can never point at
 * a 404, and the current page is dropped so nothing self-links.
 */
export function PageNavLinks({ links }: { links?: PageLink[] }) {
  if (!links?.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
      {links.map((l, i) => (
        <React.Fragment key={l.href}>
          {i > 0 && <span className="text-subtle">·</span>}
          <a href={l.href} className="text-secondary hover:text-primary transition-colors">
            {l.label}
          </a>
        </React.Fragment>
      ))}
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
    <div className="bg-surface border border-subtle rounded-lg p-5" data-popular-flights>
      <div className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
        Popular flights
      </div>
      <div className="flex flex-wrap gap-2">
        {flights.map((f) => (
          <a
            key={f.flight_number}
            href={`/check-flight/${f.flight_number}`}
            className="font-mono text-sm px-2.5 py-1 rounded border border-subtle bg-surface-elevated text-secondary hover:border-accent hover:text-accent transition-colors"
          >
            {f.flight_number}
            {/* Arrow, not the en dash /routes uses for its own O-D labels — the
                route-pages guard treats a dashed pair as an unlinked route label. */}
            {f.origin && f.destination && (
              <span className="text-muted">
                {" "}
                {f.origin} → {f.destination}
              </span>
            )}
          </a>
        ))}
      </div>
      <p className="text-xs text-muted mt-4 leading-snug">
        The {airlineName} flights we see most. Each shows its Starlink history and a check by date.
      </p>
    </div>
  );
}

export const STATUS_TONE = {
  complete: { color: "#3fb950", bg: "rgba(63,185,80,.12)" },
  phase_done: { color: "#d4a72c", bg: "rgba(212,167,44,.12)" },
  in_progress: { color: "#58a6ff", bg: "rgba(88,166,255,.12)" },
} as const;

/**
 * One status vocabulary for every airline on the hub, /airlines and /compare.
 * The registry's free-text labels ("Regional fleet done", "Widebodies nearly
 * done") stay on detail pages; lists and tables speak only these words.
 */
export type Stage =
  | "Announced"
  | "Trial"
  | "Installing"
  | "Mostly done"
  | "Complete"
  | "Not Starlink";

const STAGE_TONE: Record<Stage, { color: string; bg: string }> = {
  Announced: STATUS_TONE.phase_done,
  Trial: { color: "#a78bfa", bg: "rgba(167,139,250,.12)" },
  Installing: STATUS_TONE.in_progress,
  "Mostly done": STATUS_TONE.in_progress,
  Complete: STATUS_TONE.complete,
  "Not Starlink": { color: "#f47067", bg: "rgba(244,112,103,.12)" },
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
  const tone = STAGE_TONE[info.stage];
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ color: tone.color, background: tone.bg }}
    >
      {info.label}
    </span>
  );
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
        const share = publishable ? Math.min(100, (stat.starlink / stat.total) * 100) : 0;
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
                <div
                  className="h-2 overflow-hidden rounded-full bg-surface-elevated"
                  role="img"
                  aria-label={`${cfg.name}: ${fmt(stat.starlink)} of ${fmt(stat.total)} aircraft (${pct(stat.starlink, stat.total)})`}
                >
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${share}%`, background: stat.accentText ?? stat.accentColor }}
                  />
                </div>
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
    <div className="bg-surface border border-subtle rounded-lg p-5">
      <div className="text-xs font-mono text-muted uppercase tracking-wider mb-3">
        Recent installs
      </div>
      {grouped.length === 0 ? (
        <div className="text-xs text-muted font-mono">No recent installs</div>
      ) : (
        <>
          {grouped.map((g) => (
            <div key={g.cfg.code} className="mb-3 last:mb-0">
              <div className="flex items-center gap-1.5 text-xs font-mono text-muted mb-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: g.cfg.accentText ?? g.cfg.accentColor ?? "#7a8ba2" }}
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
                      {new Date(r.DateFound).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      })}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * Universal flight-number check input. Renders an inert form; client-side
 * script in hub.tsx fetches /api/check-any-flight and renders the result.
 * Compact variant — secondary action below route compare.
 */
export function FlightCheckInput() {
  return (
    <div className="bg-surface border border-subtle rounded-lg p-3">
      <div className="text-xs font-mono text-muted uppercase tracking-wider mb-2">
        Already booked? Check a flight
      </div>
      <form id="hub-check-flight" className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          name="flight_number"
          placeholder="UA1736, HA51, AS118, QR1…"
          className="flex-1 font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent"
          required
        />
        <input
          type="date"
          name="date"
          className="font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary focus:outline-none focus:border-accent"
          required
        />
        <button
          type="submit"
          className="font-mono text-sm px-4 py-2 bg-accent/20 border border-accent rounded text-accent hover:bg-accent/30 transition-colors"
        >
          Check
        </button>
      </form>
      <div id="hub-check-result" className="mt-2 text-sm font-mono hidden" />
    </div>
  );
}

// Preset chips: pick city pairs that exercise the comparison — mainland routes
// with UA-vs-AS overlap, plus one Hawai'i route where HA is the answer.
const PRESET_ROUTES: { o: string; d: string }[] = [
  { o: "SEA", d: "SFO" },
  { o: "DEN", d: "SAN" },
  { o: "SFO", d: "HNL" },
];

export function RouteComparePanel() {
  return (
    <div className="bg-surface border border-subtle rounded-lg p-5">
      <div className="text-xs font-mono text-muted uppercase tracking-wider mb-1">
        Starlink odds by airline
      </div>
      <div className="text-xs font-mono text-muted leading-relaxed mb-3">
        Share of each carrier's planes on this nonstop route that have Starlink today.
      </div>
      <form id="hub-compare-route" className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          name="origin"
          placeholder="From (SFO)"
          maxLength={3}
          className="flex-1 font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent uppercase"
          required
        />
        <input
          type="text"
          name="destination"
          placeholder="To (HNL)"
          maxLength={3}
          className="flex-1 font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent uppercase"
          required
        />
        <button
          type="submit"
          className="font-mono text-sm px-4 py-2 bg-accent/20 border border-accent rounded text-accent hover:bg-accent/30 transition-colors"
        >
          Compare
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {PRESET_ROUTES.map((r) => (
          <button
            key={`${r.o}-${r.d}`}
            type="button"
            data-preset-origin={r.o}
            data-preset-dest={r.d}
            className="hub-route-preset font-mono text-xs px-2.5 py-1.5 bg-surface-elevated border border-subtle rounded text-secondary hover:text-accent hover:border-accent transition-colors"
          >
            {r.o} → {r.d}
          </button>
        ))}
      </div>
      <div id="hub-compare-result" className="mt-3 hidden" />
      <div
        id="hub-compare-footer"
        className="mt-3 text-xs font-mono text-muted leading-relaxed hidden"
      >
        Carrier missing? It only shows up once one of its Starlink planes has flown here.{" "}
        {/* Static href must be a real page: /route-planner 404s on the hub, and
            crawlers see this SSR value — client JS only rewrites it to the
            per-route URL after a comparison runs. */}
        <a
          id="hub-compare-rp"
          href={`https://${SITES.united.canonicalHost}/route-planner`}
          className="text-accent hover:underline"
        >
          Route Planner →
        </a>
      </div>
    </div>
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
      <span className="text-green-400 font-mono">✓</span>
    ) : status === "pending" ? (
      <span className="text-amber-400 font-mono">…</span>
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
      <div
        className={`text-xs font-mono ${status === "starlink" ? "text-green-400" : "text-muted"}`}
      >
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
