import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { LeaderboardDef, LeaderboardRow } from "../server/rankings";

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-4xl mx-auto mb-10";

function relativeTime(epochSec: number): string {
  const mins = Math.round((epochSec * 1000 - Date.now()) / 60000);
  if (mins <= 0) return "boarding now";
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  return `in ${hrs}h`;
}

function LeaderboardRows({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-4 font-mono text-[10px] text-muted uppercase tracking-wider pb-1 border-b border-subtle">
        <span>#</span>
        <span>Route</span>
        <span className="text-right">Starlink / departures</span>
        <span className="text-right">Next</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={`${r.origin}-${r.destination}`}
          className="grid grid-cols-[auto_1fr_auto_auto] gap-x-4 items-center text-sm"
        >
          <span className="font-mono text-xs text-muted w-5 tabular-nums">{i + 1}</span>
          <a
            href={`/route-planner/${r.origin}/${r.destination}`}
            className="font-display font-semibold text-secondary tabular-nums hover:text-accent transition-colors"
          >
            {r.origin}–{r.destination}
          </a>
          <span className="font-mono text-right tabular-nums">
            <span className="text-accent">{r.equipped}</span>
            <span className="text-muted"> / {r.departures}</span>
            <span className={`text-xs ml-2 ${r.pct === 100 ? "text-accent" : "text-muted"}`}>
              {r.pct}%
            </span>
          </span>
          <span className="font-mono text-muted text-right text-xs">
            {relativeTime(r.next_departure)}
          </span>
        </div>
      ))}
    </div>
  );
}

interface LeaderboardPageProps {
  def: LeaderboardDef;
  rows: LeaderboardRow[];
  site: SiteConfig;
}

export function LeaderboardPage({ def, rows, site }: LeaderboardPageProps) {
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight">
          {def.heading}
        </h1>
        <p className="text-base text-secondary font-display max-w-2xl mx-auto">{def.lede}</p>
      </header>

      <section className={SECTION}>
        <div className={PANEL}>
          <div className={EYEBROW}>
            {rows.length} route{rows.length === 1 ? "" : "s"} · ranked from live tail assignments
          </div>
          <LeaderboardRows rows={rows} />
          <p className="text-[11px] text-muted mt-4 leading-snug">{def.note}</p>
        </div>
      </section>

      <section className={`${SECTION} text-center`}>
        <p className="text-sm text-secondary">
          <a href="/rankings" className="text-accent hover:underline">
            All leaderboards
          </a>
          {" · "}
          <a href="/routes" className="text-accent hover:underline">
            Every live Starlink route
          </a>
        </p>
      </section>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm mt-auto">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </footer>
    </div>
  );
}

export interface RankingsIndexEntry {
  def: LeaderboardDef;
  count: number;
  /** Top route preview, when the board has one. */
  top: LeaderboardRow | null;
}

interface RankingsIndexPageProps {
  boards: RankingsIndexEntry[];
  site: SiteConfig;
}

export function RankingsIndexPage({ boards, site }: RankingsIndexPageProps) {
  const cfg = siteAirline(site);
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight">
          {cfg.shortName} Starlink Route Rankings
        </h1>
        <p className="text-base text-secondary font-display">
          100% Starlink routes, the best transcons, and per-hub leaderboards — from live tail
          assignments
        </p>
      </header>

      <section className={SECTION}>
        {boards.length === 0 ? (
          <div className={PANEL}>
            <p className="text-sm text-muted">
              No leaderboards have data in the current schedule window — tail assignments publish
              about two days out. Check back shortly.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {boards.map(({ def, count, top }) => (
              <a
                key={def.slug}
                href={`/rankings/${def.slug}`}
                className="block bg-surface border border-subtle rounded-lg p-5 hover:border-accent transition-colors"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-display text-lg font-semibold text-primary">
                    {def.heading}
                  </span>
                  <span className="font-mono text-xs text-muted tabular-nums shrink-0">
                    {count} route{count === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="text-sm text-secondary mt-1">{def.lede}</p>
                {top && (
                  <p className="font-mono text-xs text-muted mt-2">
                    #1 right now:{" "}
                    <span className="text-accent">
                      {top.origin}–{top.destination}
                    </span>{" "}
                    — {top.equipped} of {top.departures} departures equipped
                  </p>
                )}
              </a>
            ))}
          </div>
        )}
      </section>

      <section className={`${SECTION} text-center`}>
        <p className="text-sm text-secondary">
          Looking for the raw table?{" "}
          <a href="/routes" className="text-accent hover:underline">
            Every route with Starlink departures
          </a>
          .
        </p>
      </section>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm mt-auto">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </footer>
    </div>
  );
}
