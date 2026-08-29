import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { PageFooter } from "./atoms";

/** One dated rollout milestone. Adding a future milestone = one entry here. */
export interface TimelineMilestone {
  /** ISO date (YYYY-MM-DD) the milestone happened. */
  date: string;
  title: string;
  detail: string;
  /** Where the fact comes from — named plainly, no fabricated links. */
  source?: string;
}

/** A stated goal, kept apart from milestones so the page never presents an
 * airline's plan as an accomplished fact. */
export interface TimelineTarget {
  when: string;
  what: string;
  source: string;
}

interface AirlineTimeline {
  milestones: TimelineMilestone[];
  targets: TimelineTarget[];
}

// Per-airline rollout timelines, keyed like methodology-page's SOURCES so the
// route can gate on content (hasTimeline) and a feature flag flipped on
// without a story can't render an empty page. Milestones stay chronological;
// append new entries as they happen.
const TIMELINES: Record<string, AirlineTimeline> = {
  UA: {
    milestones: [
      {
        date: "2025-05-15",
        title: "First commercial Starlink flight",
        detail:
          "An Embraer E175 operated the first United revenue flight with Starlink WiFi live, opening the United Express regional rollout.",
        source: "United announcement",
      },
      {
        date: "2025-09-26",
        title: "First mainline STC — Boeing 737-800",
        detail:
          "The FAA granted the first supplemental type certificate covering Starlink on a United mainline type, clearing the 737-800 for installations.",
        source: "United / FAA certification news",
      },
      {
        date: "2025-10-15",
        title: "First mainline passenger flight — UA2940",
        detail:
          "UA2940 from Newark to Houston flew as the first mainline passenger flight with Starlink, on a Boeing 737-800.",
        source: "United announcement",
      },
      {
        date: "2026-02-02",
        title: "Regional fleet complete — 300+ aircraft",
        detail:
          "United finished the two-cabin regional fleet, putting Starlink on more than 300 United Express aircraft in under a year.",
        source: "United announcement",
      },
      {
        date: "2026-06-22",
        title: "First widebody passenger flight — UA14",
        detail:
          "UA14 from Newark to London Heathrow carried the first widebody passengers with Starlink, on 777-200 N37018.",
        source: "United announcement",
      },
      {
        date: "2026-07-15",
        title: "450 aircraft equipped — official",
        detail:
          "United reported more than 450 Starlink-equipped aircraft alongside its Q2 2026 results, with mainline installs running at several airframes a day.",
        source: "UAL Q2 2026 earnings",
      },
    ],
    targets: [
      {
        when: "End of 2026",
        what: "Close to 1,000 aircraft equipped.",
        source: "United guidance, 2026",
      },
      {
        when: "Summer 2027",
        what: "Every widebody equipped.",
        source: "United guidance, 2026",
      },
      {
        when: "End of 2027",
        what: "The full fleet — every United and United Express aircraft.",
        source: "United guidance, 2026",
      },
    ],
  },
};

/** True when TIMELINES documents this airline — the /timeline handler 404s
 * otherwise (same content-gating pattern as methodology's hasMethodology). */
export function hasTimeline(code: string): boolean {
  return code in TIMELINES;
}

export function getTimeline(code: string): AirlineTimeline | null {
  return TIMELINES[code] ?? null;
}

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

interface TimelinePageProps {
  site: SiteConfig;
  starlinkCount: number;
  totalCount: number;
  lastUpdated: string;
}

export default function TimelinePage({
  site,
  starlinkCount,
  totalCount,
  lastUpdated,
}: TimelinePageProps) {
  const cfg = siteAirline(site);
  const timeline = TIMELINES[cfg.code];
  const stamped = new Date(lastUpdated);
  const stampLabel = Number.isNaN(stamped.getTime())
    ? "today"
    : stamped.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const pct = totalCount > 0 ? Math.round((starlinkCount / totalCount) * 100) : 0;

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            {cfg.shortName} Starlink Rollout Timeline
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Every dated milestone in the {cfg.name} Starlink rollout — and where it stands today.
        </p>
      </header>

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-4">Milestones</h2>
          <ol className="space-y-5">
            {timeline.milestones.map((m) => (
              <li key={m.date} className="pl-4 border-l-2 border-subtle">
                <time dateTime={m.date} className="font-mono text-xs text-accent block">
                  {fmtDate(m.date)}
                </time>
                <div className="text-secondary font-medium font-display text-base mt-0.5">
                  {m.title}
                </div>
                <p className="text-sm text-muted leading-relaxed mt-1">{m.detail}</p>
                {m.source && (
                  <div className="font-mono text-[10px] text-muted uppercase tracking-wider mt-1">
                    Source: {m.source}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-1">
            Stated targets — not yet milestones
          </h2>
          <p className="text-sm text-muted leading-relaxed mb-4">
            What {cfg.name} says comes next. These are the airline's own goals, listed separately
            from the dated milestones above because plans can slip.
          </p>
          <ul className="space-y-3">
            {timeline.targets.map((t) => (
              <li key={t.when} className="pl-4 border-l-2 border-subtle">
                <span className="font-mono text-xs text-accent">{t.when}</span>
                <div className="text-sm text-secondary mt-0.5">{t.what}</div>
                <div className="font-mono text-[10px] text-muted uppercase tracking-wider mt-1">
                  Stated target · {t.source}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">Where it stands</h2>
          <p className="text-sm text-muted leading-relaxed">
            As of {stampLabel},{" "}
            <span className="text-secondary font-mono">
              {starlinkCount.toLocaleString("en-US")} of {totalCount.toLocaleString("en-US")}
            </span>{" "}
            {cfg.name} aircraft ({pct}%) have Starlink installed, verified continuously against{" "}
            {cfg.verifySite}. The{" "}
            <a href="/" className="text-accent hover:underline">
              live tracker
            </a>{" "}
            has the current count and every equipped tail.{" "}
            {site.features.fleetPage && (
              <>
                The{" "}
                <a href="/fleet" className="text-accent hover:underline">
                  fleet page
                </a>{" "}
                shows the rollout aircraft-by-aircraft.{" "}
              </>
            )}
            {site.features.checkFlightPage && (
              <>
                Flying soon?{" "}
                <a href="/check-flight" className="text-accent hover:underline">
                  Check your flight
                </a>{" "}
                by number and date.
              </>
            )}
          </p>
        </section>
      </div>

      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </div>

      <PageFooter site={site} />
    </div>
  );
}
