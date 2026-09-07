import type { SiteConfig } from "../airlines/registry";
import type { InstallRateStats, TargetProjection, TargetVerdict } from "../utils/install-rate";
import { PageFooter, type PageLink } from "./atoms";

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-3xl mx-auto mb-8";

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
}

const VERDICT_TONE: Record<TargetVerdict, { label: string; color: string; bg: string }> = {
  reached: { label: "Reached", color: "#3fb950", bg: "rgba(63,185,80,.12)" },
  on_track: { label: "On track", color: "#3fb950", bg: "rgba(63,185,80,.12)" },
  behind: { label: "Behind pace", color: "#f85149", bg: "rgba(248,81,73,.12)" },
  no_data: { label: "Too early to call", color: "#d4a72c", bg: "rgba(212,167,44,.12)" },
};

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

function MonthChart({ stats, accent }: { stats: InstallRateStats; accent: string }) {
  // Last 18 months keeps the bars readable; the full series still drives pace.
  const months = stats.months.slice(-18);
  if (months.length < 2) return null;
  const max = Math.max(1, ...months.map((m) => m.installs));
  return (
    <div>
      <div className="flex items-end gap-[3px] h-24">
        {months.map((m) => (
          <div
            key={m.month}
            className="flex-1 rounded-t-sm"
            title={`${monthLabel(m.month)}: ${m.installs} install${m.installs === 1 ? "" : "s"}`}
            style={{
              height: `${Math.max(3, (m.installs / max) * 100)}%`,
              background: m.installs > 0 ? accent : "rgba(90,106,128,0.25)",
              opacity: m.installs > 0 ? 0.85 : 1,
            }}
          />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted mt-1">
        <span>{monthLabel(months[0].month)}</span>
        <span>{monthLabel(months[months.length - 1].month)}</span>
      </div>
    </div>
  );
}

function TargetRow({ p }: { p: TargetProjection }) {
  const tone = VERDICT_TONE[p.verdict];
  return (
    <div className="py-3 border-b border-subtle last:border-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-secondary font-medium">{p.target.label}</div>
        <span
          className="font-mono text-[10px] uppercase tracking-wide px-2 py-1 rounded-full shrink-0"
          style={{ color: tone.color, background: tone.bg }}
        >
          {tone.label}
        </span>
      </div>
      <div className="font-mono text-[11px] text-muted mt-1 leading-relaxed">
        By {p.target.deadline} · {p.targetCount.toLocaleString()} aircraft
        {p.rosterDisagrees ? (
          // Impossible inputs, named rather than projected from. equipped is a
          // live row count and total a separately scraped meta value; nothing
          // ties them to one snapshot, so mid-reconcile they can disagree.
          <> — roster and install counts disagree; not projecting</>
        ) : (
          <>
            {p.verdict === "reached"
              ? " — already there."
              : ` · ${p.remaining.toLocaleString()} to go`}
            {p.projectedMonth && p.verdict !== "reached" && (
              <> · straight-line arrival {monthLabel(p.projectedMonth)}</>
            )}
            {p.verdict === "behind" &&
              !p.projectedMonth &&
              " · at the current pace this doesn't land within a projectable horizon"}
          </>
        )}
      </div>
      {/* Numerator and denominator, from one roster, named. A target stated
          over two carriers has to show progress over those same two. */}
      <div className="font-mono text-[10px] text-muted mt-1 leading-relaxed">
        Progress: {p.scope.equipped.toLocaleString()} of {p.scope.total.toLocaleString()}
        {p.scope.label ? ` across ${p.scope.label}` : ""}
      </div>
      {/* The count under a fraction target is OUR arithmetic over OUR roster.
          Saying so keeps the sourced quote (the label) separable from the
          number, which the airline never published. */}
      {p.derived && p.derivedFrom !== null && (
        <div className="font-mono text-[10px] text-muted mt-1 leading-relaxed">
          Count derived here, not stated by the airline:{" "}
          {p.target.fractionOfTracked === 1
            ? `the ${p.derivedFrom.toLocaleString()} aircraft this tracker counts`
            : `${Math.round((p.target.fractionOfTracked ?? 1) * 100)}% of the ${p.derivedFrom.toLocaleString()} aircraft this tracker counts`}
          .
        </div>
      )}
      {/* When the airline said it, not just where. A target is only as current
          as the statement behind it, and a reader has no other way to tell a
          fresh commitment from a two-year-old one. */}
      <div className="font-mono text-[10px] text-muted mt-1">
        Target stated {p.target.statedOn} in{" "}
        <a
          href={p.target.source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {p.target.source.title}
        </a>
      </div>
    </div>
  );
}

/** "three complete months" is a claim about PACE_WINDOW, so derive it from the
 * window the pace was actually taken over — the copy said three while the
 * minimum is two, so a two-month tenant published a three-month average. */
function paceWindowWords(stats: InstallRateStats): string {
  const n = stats.paceWindowMonths;
  const word = ["zero", "one", "two", "three", "four", "five", "six"][n] ?? String(n);
  return n === 1 ? "complete month" : `${word} complete months`;
}

function AirlineSection({ a }: { a: AirlineInstallRate }) {
  const { stats } = a;
  const pct = stats.total > 0 ? Math.min(100, Math.round((stats.equipped / stats.total) * 100)) : 0;
  const statId = `install-rate-stat-${a.code.toLowerCase()}`;
  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: a.accentColor }}
          />
          <span className="font-display text-lg font-semibold text-primary">{a.name}</span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted">
          {a.statusLabel}
        </span>
      </div>

      {/* The one sentence to quote — dated with THIS airline's own stamp, not
          the serving reader's: on the hub, one shared date post-dated a stale
          airline's figures by four months. */}
      <p id={statId} className="text-sm text-secondary leading-relaxed mb-4">
        As of {a.asOfDate}, {stats.equipped.toLocaleString()} of {stats.total.toLocaleString()}{" "}
        tracked {a.name} aircraft{stats.rosterDisagrees ? "" : ` (${pct}%)`} have Starlink
        {stats.paceMonthly !== null ? (
          <>
            , with installs averaging{" "}
            <span className="text-primary font-mono">~{stats.paceMonthly}/month</span> over the last{" "}
            {paceWindowWords(stats)}
          </>
        ) : null}
        .
      </p>
      {stats.rosterDisagrees && (
        // No percentage at all rather than a wrong one: the fixture served
        // "102 of 6 tracked Alaska Airlines aircraft (1700%)" with a confident
        // verdict beside it.
        <p className="text-[11px] text-muted mb-4 leading-snug">
          The install count above exceeds the tracked roster, which is impossible — the two come
          from different sources and are mid-disagreement. No share and no projection are shown
          until they reconcile.
        </p>
      )}

      {stats.months.length >= 2 ? (
        <div className="mb-4">
          <div className={EYEBROW}>Installs per month (dated finds only)</div>
          <MonthChart stats={stats} accent={a.accentColor} />
          {stats.excludedDays.length > 0 && (
            <p className="text-[10px] text-muted mt-1.5 leading-snug">
              {stats.excludedDays.length === 1 ? "One day" : `${stats.excludedDays.length} days`}{" "}
              excluded as a bulk import (
              {stats.excludedDays.map((d) => `${d.day}: ${d.installs}`).join(", ")}) — too many
              aircraft on one date to be installs, so they'd read as a spike the fleet never had.
            </p>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-muted mb-4 leading-snug">
          No dated install history to chart — {a.phaseNote}
        </p>
      )}

      {stats.projections.length > 0 && (
        <div>
          <div className={EYEBROW}>Stated targets vs. observed pace</div>
          {stats.projections.map((p) => (
            <TargetRow key={`${p.target.label}-${p.target.deadline}`} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function InstallRatePage({ site, airlines, pageLinks }: InstallRatePageProps) {
  const single = airlines.length === 1 ? airlines[0] : null;
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Starlink Install Rate Index
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          {single
            ? `How fast ${single.name} is actually installing Starlink — and whether the stated targets hold at that pace.`
            : "How fast each tracked airline is actually installing Starlink — and whether their stated targets hold at that pace."}
        </p>
      </header>

      <section className={`${SECTION} space-y-4`}>
        {airlines.map((a) => (
          <AirlineSection key={a.code} a={a} />
        ))}
      </section>

      <section className={SECTION}>
        <p className="text-[11px] text-muted leading-snug text-center">
          Pace counts only dated, organically observed installs. Seed batches and type-rule
          backfills are excluded by source, and any single date carrying far more aircraft than the
          fleet installs in a day is dropped as an import and named above — so a data backfill
          doesn't read as an install spike. Projections are straight-line extrapolations of the
          trailing three complete months; below ~0.5 installs/month we say "too early to call"
          instead of projecting. Counts shown for "share of the fleet" targets are computed from
          this tracker's roster and labelled as such — only figures an airline actually published
          are attributed to it, with the date the airline stated it. A target stated over more than
          one carrier's fleet is measured against those carriers' combined roster on both sides of
          the ratio.
          {site.features.methodologyPage && (
            <>
              {" "}
              <a href="/methodology" className="text-accent hover:underline">
                How the underlying data is verified →
              </a>
            </>
          )}
        </p>
      </section>

      <PageFooter site={site} pageLinks={pageLinks} />
    </div>
  );
}
