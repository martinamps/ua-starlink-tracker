import { aircraftName } from "../airlines/aircraft-families";
import { marketingFlightNumber } from "../airlines/flight-number";
import { AIRLINES, type SiteConfig } from "../airlines/registry";
import type { FirstFlight, PerAirlineStat, RecentInstall, ReportedInstall } from "../types";
import type { Link } from "./layout";
import { EYEBROW, PANEL, PageHeader, PageShell, SECTION } from "./layout";
import { tailHref } from "./tail-link";
import { monthDay, shortDate } from "./ui/format";

interface NewlyEquippedPageProps {
  site: SiteConfig;
  installs: RecentInstall[];
  /** Sheet listings our own check has not confirmed. Rendered apart from
   * `installs` and never counted; empty on every tenant without a sheet. */
  reported?: ReportedInstall[];
  airlines: PerAirlineStat[];
  /** First observed departure per tail; sparse — most tails have none yet. */
  firstFlights: Record<string, FirstFlight>;
  pageLinks?: Link[];
  currentPath?: string;
}

const OPERATOR_CASE: Record<string, string> = {
  skywest: "SkyWest",
  gojet: "GoJet",
  commutair: "CommutAir",
};

/** The operator as a reader names it, or null when it is just the airline the
 * row is grouped under. Roster strings arrive as FR24 spells them ("Skywest
 * dba UAX", "SkyWest floater"). */
export function operatorLabel(raw: string | null, airline: string): string | null {
  if (!raw || raw === airline) return null;
  const express = /\s+dba UAX$/i.test(raw);
  const base = raw.replace(/\s+dba UAX$/i, "").replace(/\s+floater$/i, "");
  const name = OPERATOR_CASE[base.toLowerCase()] ?? base;
  if (name === airline) return null;
  return express ? `${name} (United Express)` : name;
}

/** "UA3880 MIA → SFO": the marketing number the rest of the site uses, never
 * the stored ICAO callsign (UAL3880, GJS4616). */
export function firstFlightLabel(first: FirstFlight): string {
  const cfg = AIRLINES[first.airline];
  const fn = cfg ? marketingFlightNumber(cfg, first.flight_number) : first.flight_number;
  return `${fn} ${first.origin} → ${first.destination}`;
}

/** The tail, linked to its own page where this host has one. */
function TailName({
  site,
  row,
  tone,
}: { site: SiteConfig; row: RecentInstall; tone: "text-accent" | "text-secondary" }) {
  const href = tailHref(site, row.TailNumber, row.airline);
  return href ? (
    <a href={href} className={`font-mono text-sm ${tone} hover:underline`}>
      {row.TailNumber}
    </a>
  ) : (
    <span className={`font-mono text-sm ${tone}`}>{row.TailNumber}</span>
  );
}

function InstallRow({
  site,
  install,
  first,
  airlineName,
}: {
  site: SiteConfig;
  install: RecentInstall;
  first?: FirstFlight;
  airlineName: string;
}) {
  const operator = operatorLabel(install.OperatedBy, airlineName);
  return (
    <div
      id={install.TailNumber}
      className="py-2.5 border-b border-subtle last:border-0"
      style={{ scrollMarginTop: "5rem" }}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <TailName site={site} row={install} tone="text-accent" />
        <span className="text-xs text-secondary">{aircraftName(install.Aircraft)}</span>
        {operator && <span className="text-xs text-muted hidden sm:inline">{operator}</span>}
        <span className="text-xs text-muted tabular-nums ml-auto">
          Found {shortDate(install.DateFound.slice(0, 10))}
        </span>
      </div>
      {first && (
        // "observed", not bald "first": DateFound is when this tracker found
        // the tail equipped, not when the antenna went on, so the true first
        // flight is often unknowable. Same wording the syndicated feed uses.
        <div className="text-xs text-muted mt-1">
          First seen flying Starlink:{" "}
          <span className="font-mono text-secondary">{firstFlightLabel(first)}</span>,{" "}
          {monthDay(first.departed_at)}
        </div>
      )}
    </div>
  );
}

function ReportedRow({
  site,
  row,
  airlineName,
}: { site: SiteConfig; row: ReportedInstall; airlineName: string }) {
  const operator = operatorLabel(row.OperatedBy, airlineName);
  return (
    <div
      id={row.TailNumber}
      className="py-2.5 border-b border-subtle last:border-0"
      style={{ scrollMarginTop: "5rem" }}
    >
      <div className="flex items-baseline gap-3 flex-wrap">
        <TailName site={site} row={row} tone="text-secondary" />
        <span className="text-xs text-secondary">{aircraftName(row.Aircraft)}</span>
        {operator && <span className="text-xs text-muted hidden sm:inline">{operator}</span>}
        <span className="text-xs text-muted tabular-nums ml-auto">
          First seen {shortDate(row.DateFound.slice(0, 10))}
        </span>
      </div>
      <div className="text-xs text-muted mt-1">
        Not confirmed: our check still reads{" "}
        <span className="text-secondary">{row.observed_wifi}</span>
        {row.observed_at ? `, last checked ${monthDay(row.observed_at)}` : ""}.
      </div>
    </div>
  );
}

export default function NewlyEquippedPage({
  site,
  installs,
  reported = [],
  airlines,
  firstFlights,
  pageLinks,
  currentPath,
}: NewlyEquippedPageProps) {
  const scopeCode = site.scope !== "ALL" ? site.scope : null;
  const dek = scopeCode
    ? `The latest ${AIRLINES[scopeCode].shortName} aircraft to get Starlink, newest first.`
    : "The latest aircraft to get Starlink across tracked airlines, newest first.";
  const grouped = airlines
    .map((a) => ({ cfg: a, rows: installs.filter((i) => i.airline === a.code) }))
    .filter((g) => g.rows.length > 0);

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader title="Newly equipped aircraft" dek={dek} />

      <section className={SECTION}>
        <div className={PANEL}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className={EYEBROW}>Latest installs</div>
            <a
              href="/feed.xml"
              className="font-mono text-xs text-accent hover:underline"
              type="application/atom+xml"
            >
              Subscribe (Atom feed) →
            </a>
          </div>
          {grouped.length === 0 ? (
            <p className="text-sm text-muted">
              No new installs yet. Aircraft appear here the day we find them.
            </p>
          ) : (
            grouped.map((g) => (
              <div key={g.cfg.code} className="mb-4 last:mb-0">
                <div className="flex items-center gap-1.5 text-xs font-mono text-muted mb-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{
                      background:
                        g.cfg.accentText ?? g.cfg.accentColor ?? "var(--color-text-muted)",
                    }}
                  />
                  {g.cfg.name}
                </div>
                {g.rows.map((r) => (
                  <InstallRow
                    site={site}
                    key={r.TailNumber}
                    install={r}
                    first={firstFlights[r.TailNumber]}
                    airlineName={g.cfg.name}
                  />
                ))}
              </div>
            ))
          )}
          <p className="text-xs text-muted mt-4">
            Dates are when we first saw Starlink on the aircraft.
            {site.features.methodologyPage && (
              <>
                {" "}
                <a href="/methodology" className="text-accent hover:underline">
                  How we verify →
                </a>
              </>
            )}
          </p>
        </div>
      </section>

      {reported.length > 0 && (
        <section className={SECTION}>
          <div className={PANEL}>
            <div className={EYEBROW}>Reported, not yet confirmed</div>
            <p className="text-sm text-muted mb-3">
              The community fleet sheet lists these aircraft with Starlink, but our own check of the
              airline's site still shows another provider. They are not in our count. An airline's
              site can take several days to show a new install; each one moves to the list above
              when our check agrees.
            </p>
            {reported.map((r) => (
              <ReportedRow
                site={site}
                key={r.TailNumber}
                row={r}
                airlineName={airlines.find((a) => a.code === r.airline)?.name ?? r.airline}
              />
            ))}
            <p className="text-xs text-muted mt-4">
              Dates are when we first saw the listing on the sheet, which can be later than the day
              it was added.
            </p>
          </div>
        </section>
      )}
    </PageShell>
  );
}
