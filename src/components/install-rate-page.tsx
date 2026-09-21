import type { SiteConfig } from "../airlines/registry";
import { formatFactDate, rolloutTimeline } from "../airlines/rollout-facts";
import type { InstallRateStats, TargetProjection, TargetVerdict } from "../utils/install-rate";
import type { PageLink } from "./atoms";
import {
  CumulativeInstallsChart,
  MonthlyInstallsBars,
  PaceBullets,
  nearestPaceGap,
  paceWindowText,
} from "./charts/cumulative-installs";
import { type CiteStat, CiteThis } from "./cite-this";
import { EYEBROW, PANEL, PageHeader, PageShell, SECTION, StatInline, fmt, pct } from "./layout";

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
  stats: InstallRateStats;
}

interface InstallRatePageProps {
  site: SiteConfig;
  airlines: AirlineInstallRate[];
  pageLinks?: PageLink[];
  currentPath?: string;
  cite?: CiteStat | null;
}

const VERDICT_TONE: Record<TargetVerdict, { label: string; color: string; bg: string }> = {
  reached: { label: "Reached", color: "#3fb950", bg: "rgba(63,185,80,.12)" },
  on_track: { label: "On track", color: "#3fb950", bg: "rgba(63,185,80,.12)" },
  behind: { label: "Behind pace", color: "#f85149", bg: "rgba(248,81,73,.12)" },
  no_data: { label: "Too early to call", color: "#d4a72c", bg: "rgba(212,167,44,.12)" },
};

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function targetStatus(p: TargetProjection): string {
  const due = `Due ${formatFactDate(p.target.deadline)}`;
  // equipped is a live row count and total a separately scraped meta value;
  // mid-reconcile they can disagree, and nothing is projected from that.
  if (p.rosterDisagrees) return `${due} · counts disagree, no projection`;
  if (p.verdict === "reached") return `${due} · reached`;
  const parts = [due, `${fmt(p.remaining)} to go`];
  if (p.projectedMonth) parts.push(`at current pace: ${monthLabel(p.projectedMonth)}`);
  else if (p.verdict === "behind") parts.push("more than four years out at current pace");
  return parts.join(" · ");
}

function TargetRow({ p, shortName }: { p: TargetProjection; shortName: string }) {
  const tone = VERDICT_TONE[p.verdict];
  return (
    <li className="border-b border-subtle py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-primary">
          {p.target.label}
          {p.derived && <span className="text-muted"> ({fmt(p.targetCount)})</span>}
        </span>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-xs"
          style={{ color: tone.color, background: tone.bg }}
        >
          {tone.label}
        </span>
      </div>
      <p className="mt-1 text-sm text-secondary">{targetStatus(p)}</p>
      {/* A target stated over two carriers is measured over those two, both
          halves of the ratio, so the page names the roster. */}
      {p.scope.label && (
        <p className="mt-1 text-sm text-secondary">
          Measured across {p.scope.label}: {fmt(p.scope.equipped)} of {fmt(p.scope.total)}.
        </p>
      )}
      {/* The count under a share-of-fleet target is our arithmetic, so it must
          never read as the airline's published figure. */}
      {p.derived && p.derivedFrom !== null && (
        <p className="mt-1 text-xs text-muted">
          {p.target.fractionOfTracked === 1
            ? `Fleet size is our count, not ${shortName}'s.`
            : `${Math.round((p.target.fractionOfTracked ?? 1) * 100)}% of our fleet count of ${fmt(p.derivedFrom)}, not a figure ${shortName} published.`}
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        Stated {formatFactDate(p.target.statedOn)}. Source:{" "}
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
        {a.name} aircraft{stats.rosterDisagrees ? "" : ` (${pct(stats.equipped, stats.total)})`}{" "}
        have Starlink.
        {stats.paceMonthly !== null && (
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
          {stats.paceMonthly !== null && stats.projections.length > 0 && (
            <div className="mt-6 border-t border-subtle pt-5">
              <div className={EYEBROW}>Pace needed vs. now</div>
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
    return `Is ${a.shortName} on pace? About ${fmt(gap.actual)} installs a month, against the ${fmt(gap.needed)} a month needed for ${fmt(gap.target.targetCount)} by ${formatFactDate(gap.target.target.deadline)}.`;
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
        title="Starlink install rate index"
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
          Pace averages up to the last three full months, and projections assume it holds. Seed data
          and one-day imports are left out.
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
