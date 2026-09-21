import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import {
  type RolloutTimeline,
  type TimelineSource,
  formatFactDate,
  rolloutTimeline,
} from "../airlines/rollout-facts";
import type { InstallRateStats } from "../utils/install-rate";
import type { PageLink } from "./atoms";
import {
  CumulativeInstallsChart,
  PaceBullets,
  nearestPaceGap,
  paceWindowText,
} from "./charts/cumulative-installs";
import { PageHeader, PageShell, Section, StatInline, fmt, pct } from "./layout";

/** The /timeline handler 404s for an airline without a timeline, the same
 * content gate /methodology uses. */
export function hasTimeline(code: string): boolean {
  return rolloutTimeline(code) !== null;
}

export function getTimeline(code: string): RolloutTimeline | null {
  return rolloutTimeline(code);
}

const SourceLine = ({ source }: { source: TimelineSource }) => (
  <p className="mt-1 text-xs text-muted">
    Source:{" "}
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted underline-offset-2 hover:text-accent"
    >
      {source.label}
    </a>
  </p>
);

const ENTRY = "grid gap-x-6 gap-y-1 py-4 first:pt-0 last:pb-0 sm:grid-cols-[8rem_1fr]";

interface TimelinePageProps {
  site: SiteConfig;
  stats: InstallRateStats;
  asOfDate: string;
  accent: string;
  pageLinks?: PageLink[];
  currentPath?: string;
}

export default function TimelinePage({
  site,
  stats,
  asOfDate,
  accent,
  pageLinks,
  currentPath,
}: TimelinePageProps) {
  const cfg = siteAirline(site);
  const timeline = rolloutTimeline(cfg.code) as RolloutTimeline;
  const gap = nearestPaceGap(stats);
  const showPace = site.features.installRatePage && stats.months.length > 0;
  const links = [
    ...(site.features.fleetPage ? [{ href: "/fleet", label: "Fleet" }] : []),
    ...(site.features.checkFlightPage ? [{ href: "/check-flight", label: "Check a flight" }] : []),
    ...(showPace ? [{ href: "/install-rate", label: "Install pace" }] : []),
  ];

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={<>{cfg.shortName} Starlink rollout timeline</>}
        dek={
          <>
            <StatInline n={stats.equipped} /> of <StatInline n={stats.total} /> {cfg.shortName}{" "}
            aircraft{stats.rosterDisagrees ? "" : ` (${pct(stats.equipped, stats.total)})`} have
            Starlink as of {asOfDate}.
          </>
        }
      >
        {links.length > 0 && (
          <p className="flex flex-wrap justify-center gap-x-2 text-sm">
            {links.map((l, i) => (
              <React.Fragment key={l.href}>
                {i > 0 && (
                  <span className="text-muted" aria-hidden="true">
                    ·
                  </span>
                )}
                <a href={l.href} className="text-accent hover:underline">
                  {l.label}
                </a>
              </React.Fragment>
            ))}
          </p>
        )}
      </PageHeader>

      {stats.months.length >= 2 && (
        <Section
          title="Progress"
          dek={
            stats.paceMonthly !== null ? (
              <>
                About <StatInline n={Math.round(stats.paceMonthly)} /> installs a month over{" "}
                {paceWindowText(stats)}.
                {gap && (
                  <>
                    {" "}
                    {fmt(gap.target.targetCount)} by {formatFactDate(gap.target.target.deadline)}{" "}
                    needs about <StatInline n={Math.round(gap.needed)} /> a month.
                  </>
                )}
              </>
            ) : undefined
          }
        >
          <CumulativeInstallsChart
            stats={stats}
            accent={accent}
            airlineName={cfg.name}
            milestones={timeline.milestones}
          />
          <div className="mt-6 border-t border-subtle pt-5">
            <PaceBullets stats={stats} accent={accent} />
          </div>
        </Section>
      )}

      <Section title="Milestones">
        <ol className="divide-y divide-[var(--color-border)]">
          {timeline.milestones.map((m) => (
            <li key={m.date} className={ENTRY}>
              <time dateTime={m.date} className="text-sm text-muted tabular-nums">
                {formatFactDate(m.date)}
              </time>
              <div>
                <h3 className="font-display text-base text-primary">{m.title}</h3>
                <p className="mt-0.5 text-sm text-secondary">{m.fact}</p>
                <SourceLine source={m.source} />
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        title="What's next"
        dek={<>{cfg.shortName}'s stated targets. Dates are the airline's, not ours.</>}
      >
        <ol className="divide-y divide-[var(--color-border)]">
          {timeline.targets.map((t) => (
            <li key={t.when} className={ENTRY}>
              <span className="text-sm text-muted">{t.when}</span>
              <div>
                <p className="text-sm text-primary">{t.fact}</p>
                <SourceLine source={t.source} />
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </PageShell>
  );
}
