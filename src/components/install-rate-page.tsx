import type { SiteConfig } from "../airlines/registry";
import { formatFactDate, rolloutTimeline } from "../airlines/rollout-facts";
import type { InstallRateStats, TargetProjection, TargetVerdict } from "../utils/install-rate";
import {
  CumulativeInstallsChart,
  MonthlyInstallsBars,
  PaceBullets,
} from "./charts/cumulative-installs";
import { nearestPaceGap, paceWindowSpan, paceWindowText } from "./charts/rollout-math";
import { type CiteStat, CiteThis } from "./cite-this";
import type { Link } from "./layout";
import { EYEBROW, PANEL, PageHeader, PageShell, SECTION, StatInline } from "./layout";
import { fmt, monthYear, pct, probLabel } from "./ui/format";
import { Pill, type Tone } from "./ui/tone";

export interface AirlineInstallRate {
  code: string;
  name: string;
  shortName: string;
  accentColor: string;
  statusLabel: string;
  phaseNote: string;
  /** THIS airline's own data-freshness date. Per airline, not per page: the
   * hub renders several tenants at once and each carries its own stamp. */
  asOfDate: string;
  /** What the count is of: "United Airlines aircraft", "Alaska and Hawaiian
   * Airbus aircraft", "Alaska-operated aircraft". */
  noun: string;
  stats: InstallRateStats;
}

interface InstallRatePageProps {
  site: SiteConfig;
  airlines: AirlineInstallRate[];
  pageLinks?: Link[];
  currentPath?: string;
  cite?: CiteStat | null;
}

const VERDICT_TONE: Record<TargetVerdict, { label: string; tone: Tone }> = {
  reached: { label: "Reached", tone: "success" },
  on_track: { label: "On track", tone: "success" },
  behind: { label: "Behind pace", tone: "danger" },
  no_data: { label: "Too early to call", tone: "warn" },
};

function targetStatus(p: TargetProjection): string {
  const due = `Due ${formatFactDate(p.target.deadline)}`;
  // equipped is a live row count and total a separately scraped meta value;
  // mid-reconcile they can disagree, and nothing is projected from that.
  if (p.rosterDisagrees) return `${due} · no projection (fleet counts out of sync)`;
  if (p.verdict === "reached") return `${due} · reached`;
  const parts = [due, `${fmt(p.remaining)} to go`];
  if (p.projectedMonth) parts.push(`at current pace: ${monthYear(p.projectedMonth)}`);
  else if (p.verdict === "behind") parts.push("more than four years out at current pace");
  return parts.join(" · ");
}

function TargetRow({ p, shortName }: { p: TargetProjection; shortName: string }) {
  const verdict = VERDICT_TONE[p.verdict];
  return (
    <li className="border-b border-subtle py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-primary">
          {p.target.label}
          {p.derived && <span className="text-muted"> ({fmt(p.targetCount)})</span>}
        </span>
        <Pill tone={verdict.tone}>{verdict.label}</Pill>
      </div>
      <p className="mt-1 text-sm text-secondary">{targetStatus(p)}</p>
      {/* A target stated over two carriers is measured over those two, both
          halves of the ratio, so the page names the roster. */}
      {p.scope.label && (
        <p className="mt-1 text-sm text-secondary">
          {p.scope.label}: {fmt(p.scope.equipped)} of {fmt(p.scope.total)} have Starlink.
        </p>
      )}
      {/* The count under a share-of-fleet target is our arithmetic, so it must
          never read as the airline's published figure. */}
      {p.derived && p.derivedFrom !== null && (
        <p className="mt-1 text-xs text-muted">
          {p.target.fractionOfTracked === 1
            ? `Fleet size is our count, not ${shortName}'s.`
            : `${fmt(p.targetCount)} is ${probLabel(p.target.fractionOfTracked ?? 1).toLowerCase()} of our count of ${fmt(p.derivedFrom)}, not ${shortName}'s figure.`}
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        Stated {formatFactDate(p.target.statedOn)} ·{" "}
        <a
          href={p.target.source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          {p.target.source.title}
        </a>
      </p>
    </li>
  );
}

function AirlineSection({ a }: { a: AirlineInstallRate }) {
  const { stats } = a;
  const statId = `install-rate-stat-${a.code.toLowerCase()}`;
  const hasHistory = stats.months.length >= 2;
  const gap = nearestPaceGap(stats);
  return (
    <div className={PANEL}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg text-primary">
          <span
            className="h-2 w-2 flex-shrink-0 rounded-full"
            style={{ background: a.accentColor }}
          />
          {a.name}
        </h2>
        <span className="text-xs text-muted">{a.statusLabel}</span>
      </div>

      {/* The one sentence to quote, dated with THIS airline's own stamp: on the
          hub, one shared date once post-dated a stale airline by four months. */}
      <p id={statId} className="mb-4 text-sm text-secondary">
        As of {a.asOfDate}, <StatInline n={stats.equipped} /> of <StatInline n={stats.total} />{" "}
        {a.noun}
        {stats.rosterDisagrees ? "" : ` (${pct(stats.equipped, stats.total)})`} have Starlink.
        {/* With a target, the pace sits in the bullets below; say it once. */}
        {stats.paceMonthly !== null && !gap && (
          <>
            {" "}
            Installs have averaged about <StatInline n={Math.round(stats.paceMonthly)} /> a month
            over {paceWindowText(stats)}.
          </>
        )}
      </p>
      {stats.rosterDisagrees && (
        <p className="mb-4 text-xs text-muted">
          The install count is higher than the fleet count, so no share or projection is shown until
          the two sources agree.
        </p>
      )}

      {hasHistory ? (
        <>
          <CumulativeInstallsChart
            stats={stats}
            accent={a.accentColor}
            airlineName={a.name}
            milestones={rolloutTimeline(a.code)?.milestones}
          />
          {gap && (
            <div className="mt-6 border-t border-subtle pt-5">
              <div className={EYEBROW}>Pace needed vs. now ({paceWindowSpan(stats)})</div>
              <PaceBullets stats={stats} accent={a.accentColor} />
            </div>
          )}
          <div className="mt-6 border-t border-subtle pt-5">
            <div className={EYEBROW}>Installs per month</div>
            <MonthlyInstallsBars stats={stats} accent={a.accentColor} />
            {stats.excludedDays.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                Excludes{" "}
                {stats.excludedDays
                  .map(
                    (d) =>
                      `a one-day data import (${fmt(d.installs)} aircraft, ${formatFactDate(d.day)})`
                  )
                  .join(" and ")}
                .
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="mb-4 text-sm text-muted">No dated install history to chart yet.</p>
      )}

      {stats.projections.length > 0 && (
        <div className="mt-6 border-t border-subtle pt-5">
          <div className={EYEBROW}>Stated targets</div>
          <ul>
            {stats.projections.map((p) => (
              <TargetRow
                key={`${p.target.label}-${p.target.deadline}`}
                p={p}
                shortName={a.shortName}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function singleDek(a: AirlineInstallRate): string {
  const gap = nearestPaceGap(a.stats);
  if (gap) {
    return `${a.shortName} is installing about ${fmt(gap.actual)} aircraft a month. ${fmt(gap.target.targetCount)} by ${formatFactDate(gap.target.target.deadline)} needs ${fmt(gap.needed)}.`;
  }
  if (a.stats.paceMonthly !== null) {
    return `${a.shortName} is installing Starlink on about ${fmt(a.stats.paceMonthly)} aircraft a month.`;
  }
  return `How fast ${a.name} is installing Starlink, against its stated targets.`;
}

export default function InstallRatePage({
  site,
  airlines,
  pageLinks,
  currentPath,
  cite,
}: InstallRatePageProps) {
  const single = airlines.length === 1 ? airlines[0] : null;
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title="Starlink install pace"
        dek={
          single
            ? singleDek(single)
            : "Installs per month for each tracked airline, against the targets each has stated."
        }
      />

      <section className={`${SECTION} space-y-4`}>
        {airlines.map((a) => (
          <AirlineSection key={a.code} a={a} />
        ))}
      </section>

      <section className={SECTION}>
        <p className="text-center text-xs text-muted">
          Pace is the average of the last three full months; projections assume it holds.
          {site.features.methodologyPage && (
            <>
              {" "}
              <a href="/methodology" className="text-accent hover:underline">
                Methodology →
              </a>
            </>
          )}
        </p>
      </section>

      <CiteThis site={site} cite={cite} />
    </PageShell>
  );
}
