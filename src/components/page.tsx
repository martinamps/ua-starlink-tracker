import type React from "react";
import type { AirlineContent, ContentStats, HubHomeLinks } from "../airlines/content";
import { ensureAirlinePrefix } from "../airlines/flight-number";
import { AIRLINES, type SiteConfig, siteAirline } from "../airlines/registry";
import type { PopularFlight } from "../database/database";
import type {
  Aircraft,
  AirportDepartures,
  FleetStats,
  Flight,
  PerAirlineStat,
  RecentInstall,
} from "../types";
import { denominatorIsPublishable } from "../utils/share-cards";
import { HeaderStatStrip, type PageLink, PopularFlightsLinks, ShareCardLink } from "./atoms";
import { Faq, homeFaqItems, homeFaqSections } from "./faq";
import { AirportBars } from "./home/rollout";
import { PageHeader, PageShell, Section, StatInline, fmt, pct } from "./layout";
import { PassengerBanner } from "./passenger-banner";
import { formatPillTime, longDate } from "./ui/format";

interface PageProps {
  total: number;
  starlink: Aircraft[];
  lastUpdated?: string;
  fleetStats?: FleetStats | null;
  site: SiteConfig;
  content: AirlineContent;
  airlineByTail?: Record<string, string>;
  perAirlineStats?: PerAirlineStat[];
  recentInstalls?: RecentInstall[];
  flightsByTail?: Record<string, Flight[]>;
  airportDepartures?: AirportDepartures;
  showPassengerBanner?: boolean;
  installs30d?: number;
  installsPerMonth?: number | null;
  /** Installs per rolling week, oldest first (rollout sparkline). */
  weeklyInstalls?: number[];
  /** Pre-rendered share card path; null until the nightly batch produced one. */
  shareCard?: string | null;
  pageLinks?: PageLink[];
  /** Most-observed flight numbers — crawlable inlinks into the permalink corpus. */
  popularFlights?: PopularFlight[];
  hubLinks?: HubHomeLinks;
}

/** The one ContentStats the homepage body and its FAQPage JSON-LD both render from. */
export function buildContentStats(input: {
  starlinkCount: number;
  totalCount: number;
  fleetStats?: FleetStats | null;
  installsPerMonth?: number | null;
  installs30d?: number;
  weeklyInstalls?: number[];
  lastUpdated?: string;
  perAirline?: PerAirlineStat[];
}): ContentStats {
  const { starlinkCount, totalCount } = input;
  return {
    starlinkCount,
    totalCount,
    percentage: totalCount > 0 ? ((starlinkCount / totalCount) * 100).toFixed(2) : "0.00",
    fleetStats: input.fleetStats,
    installsPerMonth: input.installsPerMonth,
    installs30d: input.installs30d,
    weeklyInstalls: input.weeklyInstalls,
    asOf: longDate(input.lastUpdated),
    perAirline: input.perAirline,
  };
}

/**
 * The one sentence AI answer engines should quote: dated (from the data's
 * lastUpdated, never request time), self-contained, plain server-rendered
 * text. Airline sites only — the hub has no single-fleet number. Where the
 * roster counts types the programme excludes, it states the count alone.
 */
function StatSentence({ site, stats }: { site: SiteConfig; stats: ContentStats }) {
  if (!stats.asOf || stats.totalCount === 0) return null;
  const cfg = siteAirline(site);
  const ratio = denominatorIsPublishable(
    stats.starlinkCount,
    stats.totalCount,
    cfg.rollout.rosterIsProgramScope
  );
  return (
    <p id="starlink-stat" className="text-sm text-secondary leading-relaxed">
      As of {stats.asOf}, <StatInline n={stats.starlinkCount} />
      {ratio ? (
        <>
          {" "}
          of {fmt(stats.totalCount)} {cfg.name} aircraft (
          {pct(stats.starlinkCount, stats.totalCount)}) have Starlink.
        </>
      ) : (
        <> {cfg.name} aircraft have Starlink.</>
      )}
      {stats.installs30d ? <> {fmt(stats.installs30d)} were added in the last 30 days.</> : null}
      {site.features.methodologyPage && (
        <>
          {" "}
          <a href="/methodology" className="text-accent hover:underline">
            How we verify
          </a>
        </>
      )}
    </p>
  );
}

// SSR'ing every fleet row made the homepage a ~5 MB document with thousands of
// outbound links. The list is sorted freshest-first, so the first rows carry
// nearly all the value; /fleet renders the complete fleet. Search/filter run
// over the SSR'd DOM and therefore cover only the rendered rows — the cap
// notice points anyone hunting a specific tail at /fleet.
const AIRCRAFT_LIST_CAP = 100;

const dateOverrides: Record<string, string> = {
  N127SY: "2025-03-07", // First Starlink installation per press release
};

export default function Page({
  total,
  starlink,
  lastUpdated,
  fleetStats,
  site,
  content,
  airlineByTail = {},
  perAirlineStats,
  recentInstalls,
  flightsByTail = {},
  airportDepartures,
  showPassengerBanner = false,
  installs30d,
  installsPerMonth,
  weeklyInstalls,
  shareCard,
  pageLinks,
  popularFlights = [],
  hubLinks,
}: PageProps) {
  // Apply date overrides to the aircraft data
  const applyDateOverrides = (data: Aircraft[]): Aircraft[] => {
    return data.map((aircraft) => {
      const tailNumber = aircraft.TailNumber;
      if (tailNumber && dateOverrides[tailNumber]) {
        // Make sure we're using PST for the override date to avoid timezone issues
        const overrideDate = new Date(`${dateOverrides[tailNumber]}T12:00:00-08:00`);
        return {
          ...aircraft,
          DateFound: overrideDate.toISOString().split("T")[0], // Format as YYYY-MM-DD
        };
      }
      return aircraft;
    });
  };

  // Server-side rendering uses props directly, no client state needed
  // Sort by most recently updated flight data (freshest data first)
  const starlinkData = applyDateOverrides(starlink).sort((a, b) => {
    const flightsA = flightsByTail[a.TailNumber] || [];
    const flightsB = flightsByTail[b.TailNumber] || [];
    const updatedA = flightsA[0]?.last_updated || 0;
    const updatedB = flightsB[0]?.last_updated || 0;
    return updatedB - updatedA;
  });
  const displayedAircraft = starlinkData.slice(0, AIRCRAFT_LIST_CAP);
  const stats = buildContentStats({
    starlinkCount: starlinkData.length,
    totalCount: total,
    fleetStats,
    installsPerMonth,
    installs30d,
    weeklyInstalls,
    lastUpdated,
    perAirline: perAirlineStats,
  });
  const airlineOf = (p: Aircraft) => airlineByTail[p.TailNumber] || "UA";
  const brand = site.brand;
  const features = site.features;
  // Hub never renders the flight-search form (checkFlightPage is off), so the
  // prefix is only read on airline-scoped sites.
  const searchCarrier = site.scope !== "ALL" ? siteAirline(site).iata : "";
  // Flight permalinks are airline-scoped: the hub has checkFlightPage off and
  // siteAirline() throws there, so pills stay outbound on sites without one.
  const permalinkAirline = features.checkFlightPage ? siteAirline(site) : null;
  // Mirrors parseCheckFlightPath's gate, so every link we emit is a URL the
  // permalink handler parses instead of 404ing or redirecting. Built once —
  // this runs against every pill on the page.
  const permalinkFnPattern = permalinkAirline
    ? new RegExp(`^${permalinkAirline.iata}\\d{1,4}$`)
    : null;

  /**
   * `/check-flight/{marketing number}` for a pill, or null when the pill can't
   * reach a real permalink and must keep its outbound link.
   *
   * The pill carries the OPERATING carrier's callsign (OO4757, SKW5366) but the
   * permalink is minted under the marketing code, so this goes through
   * ensureAirlinePrefix — never a bare prefix strip, which turns G74561 into
   * UA74561 instead of UA4561. Two gates keep it off dead URLs:
   * non-numeric callsigns (SKW394Y) normalize to themselves, and a foreign
   * carrier's number belongs to no permalink this site serves — both would land
   * on the noindex generic page rather than a flight, so they stay outbound.
   */
  const flightPermalink = (tailNumber: string, flightNumber: string): string | null => {
    if (!permalinkAirline || !permalinkFnPattern) return null;
    if ((airlineByTail[tailNumber] || permalinkAirline.code) !== permalinkAirline.code) return null;
    const fn = ensureAirlinePrefix(permalinkAirline, flightNumber);
    return permalinkFnPattern.test(fn) ? `/check-flight/${fn}` : null;
  };
  // Button counts describe the whole equipped fleet, so "Express (348)" agrees
  // with the rollout panel; the cap note under the list says how many rows the
  // filter can actually show.
  const subfleetCounts = Object.fromEntries(
    content.subfleetFilters.map((c) => [
      c.key,
      starlinkData.filter((p) => p.fleet === c.key || airlineOf(p) === c.key).length,
    ])
  );

  // Helper function to clean airport codes (remove ICAO prefixes)
  const cleanAirportCode = (code: string) => {
    if (code && code.length === 4) {
      if (code.startsWith("K")) return code.substring(1);
      if (code.startsWith("C")) return code.substring(1);
      if (code.startsWith("M")) return code.substring(1);
    }
    return code;
  };

  // Compact flight time with day, stated in UTC (e.g., "MON 14:30 UTC").
  //
  // departure_time is a UTC epoch, so formatting it without an explicit
  // timeZone renders it in whatever zone the SERVER happens to run in — a clock
  // that belongs to neither the traveller nor the airport, and that disagreed
  // with /check-flight/{fn}, which states the same departure as UTC. The pill
  // links there and its aria-label speaks this string as a departure claim, so
  // the zone has to be pinned and named. The 24-hour spelling is the permalink
  // page's, so the two pages read as one clock rather than two.
  const formatCompactTime = formatPillTime;

  // Compact inline flight pills for new table design (responsive + expandable)
  const renderFlightPills = (tailNumber: string) => {
    const flights = flightsByTail[tailNumber];

    if (!flights || flights.length === 0) {
      return <span className="text-muted text-xs italic font-mono">No flights scheduled</span>;
    }

    const containerId = `flights-${tailNumber}`;
    // Mobile: 2, Tablet: 4, Desktop: 6
    const mobileMax = 2;
    const tabletMax = 4;
    const desktopMax = 6;

    const renderPill = (flight: (typeof flights)[0], idx: number) => {
      const dep = cleanAirportCode(flight.departure_airport);
      const arr = cleanAirportCode(flight.arrival_airport);

      // Determine visibility classes
      let visibilityClass = "inline-flex"; // Always visible
      if (idx >= desktopMax) {
        visibilityClass = "hidden"; // Until the container is expanded
      } else if (idx >= tabletMax) {
        visibilityClass = "hidden xl:inline-flex"; // Desktop only (xl+)
      } else if (idx >= mobileMax) {
        visibilityClass = "hidden md:inline-flex"; // Tablet+ (md+)
      }

      // Every pill that can reach a permalink links to one. Deduping to one
      // anchor per flight number was considered and rejected: the anchor count
      // is identical either way (this converts links, it never adds any), so
      // the per-link equity denominator doesn't move — repeats to one URL are
      // consolidated anyway — and it would leave the same flight number
      // pointing at two different destinations in one row.
      const permalink = flightPermalink(tailNumber, flight.flight_number);
      // Hover text names the destination, so it shows the marketing number the
      // permalink is filed under rather than the operating callsign.
      const tooltip = permalink ? permalink.slice("/check-flight/".length) : flight.flight_number;
      const when = formatCompactTime(flight.departure_time);
      // The pill's visible text is an airport pair and a clock time — the flight
      // number lives only in a hover tooltip, which is a data attribute gated on
      // (hover: hover). So the link's own subject was reaching neither a screen
      // reader nor a crawler reading link text. The label restates the visible
      // text so speech-input targeting still works (WCAG 2.5.3).
      const label = `Flight ${tooltip}, ${dep} to ${arr}, departs ${when}`;

      return (
        <a
          key={idx}
          href={permalink ?? `https://www.flightaware.com/live/flight/${flight.flight_number}`}
          {...(permalink ? {} : { target: "_blank", rel: "nofollow noopener noreferrer" as const })}
          data-flight-tooltip={tooltip}
          aria-label={label}
          className={`flight-pill ${visibilityClass}`}
        >
          <span className="text-accent font-medium">{dep}</span>
          <span className="text-muted">→</span>
          <span className="text-accent font-medium">{arr}</span>
          <span className="text-muted text-[10px]">{when}</span>
        </a>
      );
    };

    const mobileRemaining = Math.max(0, flights.length - mobileMax);
    const tabletRemaining = Math.max(0, flights.length - tabletMax);
    const desktopRemaining = Math.max(0, flights.length - desktopMax);
    // One button for every breakpoint; the count it shows and whether it shows
    // at all follow the same md/xl cut points as the pills themselves.
    const expandVisibility =
      desktopRemaining > 0
        ? "inline-flex"
        : tabletRemaining > 0
          ? "inline-flex xl:hidden"
          : "inline-flex md:hidden";

    return (
      <div className="flex flex-wrap gap-1.5" id={containerId}>
        {flights.map((flight, idx) => renderPill(flight, idx))}
        {mobileRemaining > 0 && (
          <button
            type="button"
            className={`expand-flights ${expandVisibility} items-center px-2 py-1 border border-accent/30 hover:border-accent rounded text-xs text-accent font-mono font-medium transition-all cursor-pointer hover:bg-accent/10`}
            aria-expanded="false"
          >
            <span className="pill-more">
              <span className="md:hidden">+{mobileRemaining}</span>
              {tabletRemaining > 0 && (
                <span className="hidden md:inline xl:hidden">+{tabletRemaining}</span>
              )}
              {desktopRemaining > 0 && (
                <span className="hidden xl:inline">+{desktopRemaining}</span>
              )}
            </span>
            <span className="pill-less">−</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <PageShell
      site={site}
      currentPath="/"
      pageLinks={pageLinks}
      before={showPassengerBanner ? <PassengerBanner /> : null}
    >
      <PageHeader title={brand.title} dek={content.intro(stats)}>
        <HeaderStatStrip
          items={
            typeof content.headerStats === "function"
              ? content.headerStats(stats)
              : content.headerStats
          }
        />
      </PageHeader>

      {features.checkFlightPage && (
        <div className="relative max-w-xl mx-auto w-full mb-6">
          <form
            id="home-flight-search"
            method="GET"
            action="/check-flight"
            className="bg-surface rounded-lg border border-subtle p-3 sm:p-4"
          >
            <label
              htmlFor="home-flight-number"
              className="block text-xs font-mono text-muted uppercase tracking-wider mb-2 text-center"
            >
              Does your flight have Starlink?
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                id="home-flight-number"
                name="flight_number"
                placeholder={`${searchCarrier}881`}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                className="flex-1 min-w-0 bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
              />
              <input
                type="date"
                id="home-flight-date"
                name="date"
                className="bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent sm:w-40"
              />
              <button
                type="submit"
                className="px-5 py-2 bg-accent/20 border border-accent text-accent font-display font-semibold rounded hover:bg-accent/30 transition-colors cursor-pointer whitespace-nowrap"
              >
                Check
              </button>
            </div>
          </form>
          <script
            dangerouslySetInnerHTML={{
              __html: `
            document.addEventListener('DOMContentLoaded', function() {
              var form = document.getElementById('home-flight-search');
              if (!form) return;
              var carrierPrefix = ${JSON.stringify(searchCarrier)};
              form.addEventListener('submit', function(e) {
                var fn = document.getElementById('home-flight-number').value.trim().toUpperCase();
                if (!fn) { e.preventDefault(); return; }
                if (/^\\d+$/.test(fn)) fn = carrierPrefix + fn;
                var date = document.getElementById('home-flight-date').value;
                e.preventDefault();
                window.location.href = '/check-flight/' + encodeURIComponent(fn) + (date ? '/' + encodeURIComponent(date) : '');
              });
            });
          `,
            }}
          />
        </div>
      )}

      <content.Hero
        stats={stats}
        starlinkData={starlinkData}
        perAirlineStats={perAirlineStats}
        recentInstalls={recentInstalls}
        hubLinks={hubLinks}
        statSentence={site.scope !== "ALL" ? <StatSentence site={site} stats={stats} /> : null}
      />

      {content.answers && (
        <Faq
          id="answers"
          title="Quick answers"
          variant="grid"
          items={homeFaqItems(content.answers, stats)}
          structuredData={false}
        />
      )}

      <div className="relative mx-auto mb-8 w-full max-w-6xl overflow-hidden rounded-lg border border-subtle bg-surface">
        <h2 className="font-display text-xl text-primary px-4 md:px-6 pt-4 pb-0">
          Aircraft with Starlink
        </h2>
        {/* Integrated header with search and filters */}
        <div className="px-4 md:px-6 py-3 border-b border-subtle">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <input
                type="text"
                id="aircraft-search"
                placeholder="Search tail, route (sfo-lax), or combine terms..."
                className="w-full font-mono text-sm px-4 py-2 pl-9 pr-8 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 transition-all"
              />
              <svg
                className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                role="img"
                aria-label="Search icon"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <button
                type="button"
                id="search-clear"
                className="absolute right-2 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted hover:text-primary transition-colors hidden"
                aria-label="Clear search"
              >
                <svg
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  role="img"
                  aria-label="Clear"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <div
              id="search-count"
              className="hidden sm:flex items-center text-xs font-mono text-muted whitespace-nowrap"
            />
            <div className="flex gap-1.5 sm:gap-2">
              <button
                type="button"
                id="filter-all"
                className="filter-btn font-mono text-xs px-3 py-2 rounded border transition-all bg-accent/20 border-accent text-accent"
                data-filter="all"
              >
                ALL <span className="hidden sm:inline">({fmt(starlinkData.length)})</span>
              </button>
              {content.subfleetFilters.length > 1 &&
                content.subfleetFilters.map((card) => (
                  <button
                    key={card.key}
                    type="button"
                    id={`filter-${card.key}`}
                    className="filter-btn font-mono text-xs px-3 py-2 rounded border transition-all bg-transparent border-subtle text-secondary hover:border-accent/50 hover:text-accent"
                    data-filter={card.key}
                  >
                    {card.label.toUpperCase()}{" "}
                    <span className="hidden sm:inline">({fmt(subfleetCounts[card.key] || 0)})</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
        {/* Column headers - desktop only */}
        <div className="hidden md:grid md:grid-cols-12 gap-4 px-6 py-2.5 border-b border-subtle bg-surface-elevated/50 text-xs font-mono text-muted uppercase tracking-widest">
          <div className="col-span-3">Aircraft</div>
          <div className="col-span-2">Type</div>
          <div className="col-span-3">Operator</div>
          <div className="col-span-4">Upcoming Flights</div>
        </div>

        {/* Scrollable list */}
        <div className="overflow-auto" style={{ maxHeight: "65vh" }}>
          {starlinkData.length === 0 ? (
            <div className="p-12 text-center text-muted font-mono">No aircraft data available</div>
          ) : (
            <div className="divide-y divide-subtle">
              {displayedAircraft.map((plane, idx) => {
                const airline = airlineOf(plane);
                const badge = content.rowBadge(plane, airline);
                const flights = flightsByTail[plane.TailNumber] || [];
                const airportsStr = flights
                  .flatMap((f) => [
                    cleanAirportCode(f.departure_airport),
                    cleanAirportCode(f.arrival_airport),
                  ])
                  .join(" ")
                  .toLowerCase();
                const routesStr = flights
                  .flatMap((f) => {
                    const dep = cleanAirportCode(f.departure_airport).toLowerCase();
                    const arr = cleanAirportCode(f.arrival_airport).toLowerCase();
                    return [`${dep}-${arr}`, `${arr}-${dep}`];
                  })
                  .join(" ");
                // Index the raw callsign plus the marketing number it maps to.
                // The mapping is ensureAirlinePrefix, not a `/^[A-Z]+/` strip:
                // a strip turns G74561 into UA74561, so a G7-coded flight was
                // unfindable by the UA number the pill's label and href
                // advertise — the box would have said "no match" for the very
                // number the row was showing.
                const rowAirline = AIRLINES[airline];
                const flightNumbersStr = flights
                  .flatMap((f) => {
                    const marketing = rowAirline
                      ? ensureAirlinePrefix(rowAirline, f.flight_number)
                      : f.flight_number;
                    return marketing === f.flight_number
                      ? [f.flight_number]
                      : [f.flight_number, marketing];
                  })
                  .join(" ")
                  .toLowerCase();

                return (
                  <div
                    key={plane.TailNumber || idx}
                    className="aircraft-row group px-4 md:px-6 py-4 hover:bg-surface-elevated transition-all duration-200 cursor-default border-l-2 border-transparent hover:border-accent"
                    data-tail={plane.TailNumber.toLowerCase()}
                    data-aircraft={plane.Aircraft.toLowerCase()}
                    data-operator={(plane.OperatedBy || "").toLowerCase()}
                    data-fleet={plane.fleet}
                    data-airline={airline}
                    data-airports={airportsStr}
                    data-routes={routesStr}
                    data-flights={flightNumbersStr}
                  >
                    <div className="md:grid md:grid-cols-12 md:gap-4 md:items-center">
                      <div className="md:col-span-3 flex items-start md:items-center justify-between md:justify-start gap-3 mb-3 md:mb-0">
                        <div className="flex items-center gap-3">
                          <div className="status-dot flex-shrink-0" />
                          <div>
                            <div className="font-mono text-base md:text-sm font-bold md:font-semibold text-primary group-hover:text-accent transition-colors">
                              {plane.TailNumber}
                            </div>
                            <div className="md:hidden font-mono text-xs text-secondary">
                              {plane.Aircraft}
                            </div>
                            {badge && (
                              <div className="hidden md:block text-xs font-mono text-muted uppercase">
                                {badge}
                              </div>
                            )}
                          </div>
                        </div>
                        {badge && (
                          <div className="md:hidden text-xs font-mono text-accent uppercase">
                            {badge}
                          </div>
                        )}
                      </div>

                      <div className="hidden md:block md:col-span-2">
                        <span className="font-mono text-sm text-secondary">{plane.Aircraft}</span>
                      </div>

                      <div className="md:col-span-3 text-xs md:text-sm text-muted mb-3 md:mb-0 pl-5 md:pl-0">
                        {plane.OperatedBy || "—"}
                      </div>

                      <div className="md:col-span-4 pt-3 md:pt-0 border-t md:border-t-0 border-subtle">
                        {renderFlightPills(plane.TailNumber)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {starlinkData.length > displayedAircraft.length && (
          <div
            id="list-cap"
            className="px-4 md:px-6 py-3 border-t border-subtle text-center text-sm text-muted"
          >
            Showing {fmt(displayedAircraft.length)} of {fmt(starlinkData.length)}, most recently
            flown first. Search and filters cover these rows.
            {features.fleetPage && (
              <>
                {" "}
                <a href="/fleet" className="text-accent hover:underline">
                  See all →
                </a>
              </>
            )}
          </div>
        )}
      </div>

      {airportDepartures && airportDepartures.rows.length > 0 && (
        <Section
          id="airports"
          title="Starlink departures by airport"
          dek={`Top ${Math.min(12, airportDepartures.rows.length)} airports, ${airportDepartures.windowLabel}.`}
          wide
        >
          <AirportBars rows={airportDepartures.rows} />
        </Section>
      )}

      {/* Tools & Integrations — UA-specific (Chrome ext is UA-only, MCP only on UA host today) */}
      {(features.chromeExtension || features.mcpPage) && (
        <div id="integrations" className="relative mb-8 w-full max-w-3xl mx-auto scroll-mt-4">
          <h2 className="font-display text-xl text-primary">Tools and integrations</h2>
          <div className="mt-4 grid sm:grid-cols-2 gap-3">
            {features.chromeExtension && (
              <div
                id="chrome-extension"
                className="bg-surface rounded-lg border border-subtle p-5 flex flex-col scroll-mt-4"
              >
                <div className="flex items-start gap-3 mb-3">
                  <svg
                    className="w-8 h-8 flex-shrink-0"
                    viewBox="0 0 48 48"
                    xmlns="http://www.w3.org/2000/svg"
                    role="img"
                    aria-label="Chrome"
                  >
                    <defs>
                      <linearGradient
                        id="chrome-a"
                        x1="3.2173"
                        y1="15"
                        x2="44.7812"
                        y2="15"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop offset="0" stopColor="#d93025" />
                        <stop offset="1" stopColor="#ea4335" />
                      </linearGradient>
                      <linearGradient
                        id="chrome-b"
                        x1="20.7219"
                        y1="47.6791"
                        x2="41.5039"
                        y2="11.6837"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop offset="0" stopColor="#fcc934" />
                        <stop offset="1" stopColor="#fbbc04" />
                      </linearGradient>
                      <linearGradient
                        id="chrome-c"
                        x1="26.5981"
                        y1="46.5015"
                        x2="5.8161"
                        y2="10.506"
                        gradientUnits="userSpaceOnUse"
                      >
                        <stop offset="0" stopColor="#1e8e3e" />
                        <stop offset="1" stopColor="#34a853" />
                      </linearGradient>
                    </defs>
                    <circle cx="24" cy="23.9947" r="12" fill="#fff" />
                    <path
                      d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z"
                      fill="url(#chrome-a)"
                    />
                    <circle cx="24" cy="24" r="9.5" fill="#1a73e8" />
                    <path
                      d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z"
                      fill="url(#chrome-b)"
                    />
                    <path
                      d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z"
                      fill="url(#chrome-c)"
                    />
                  </svg>
                  <div>
                    <div className="font-display font-semibold text-primary text-sm">
                      Chrome Extension
                    </div>
                    <div className="text-xs text-muted">For Google Flights</div>
                  </div>
                </div>
                <p className="text-sm text-secondary leading-relaxed mb-4 flex-1">
                  See which flights have Starlink right in your Google Flights results.
                </p>
                <a
                  href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:underline font-mono"
                >
                  Add to Chrome →
                </a>
              </div>
            )}

            {features.mcpPage && (
              <div
                id="mcp"
                className="bg-surface rounded-lg border border-subtle p-5 flex flex-col scroll-mt-4"
              >
                <div className="flex items-start gap-3 mb-3">
                  <div className="w-8 h-8 flex-shrink-0 rounded bg-accent/20 border border-accent/40 flex items-center justify-center">
                    <svg
                      className="w-5 h-5 text-accent"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      role="img"
                      aria-label="AI"
                    >
                      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                    </svg>
                  </div>
                  <div>
                    <div className="font-display font-semibold text-primary text-sm">
                      MCP Server
                    </div>
                    <div className="text-xs text-muted">For Claude, Cursor & AI assistants</div>
                  </div>
                </div>
                <p className="text-sm text-secondary leading-relaxed mb-4 flex-1">
                  Ask your AI assistant to check a flight, estimate its Starlink odds or plan a
                  route, using this tracker's live data.
                </p>
                <a href="/mcp" className="text-xs text-accent hover:underline font-mono">
                  Setup instructions →
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Popular flights — server-rendered inlinks into the permalink corpus */}
      {features.checkFlightPage && popularFlights.length > 0 && (
        <div className="relative max-w-3xl mx-auto w-full mb-8">
          <PopularFlightsLinks
            flights={popularFlights}
            airlineName={site.scope !== "ALL" ? siteAirline(site).name : "tracked"}
          />
        </div>
      )}

      <Faq
        id="faq"
        title="More questions"
        variant="accordion"
        sections={homeFaqSections(content.faq, stats)}
        structuredData={false}
      />

      {stats.asOf && (
        <p className="relative mb-6 text-center text-xs text-muted">
          Data last updated {stats.asOf}
        </p>
      )}

      {/* Search, Filter, and Expand functionality */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            document.addEventListener('DOMContentLoaded', function() {
              // Search functionality
              var searchInput = document.getElementById('aircraft-search');
              var searchClear = document.getElementById('search-clear');
              var searchCount = document.getElementById('search-count');
              var rows = document.querySelectorAll('.aircraft-row');
              var filterBtns = document.querySelectorAll('.filter-btn');
              var currentFilter = 'all';
              var totalCount = rows.length;
              var baseClass = 'filter-btn font-mono text-xs px-3 py-2 rounded border transition-all';
              var activeStyle = 'bg-accent/20 border-accent text-accent';
              var inactiveStyle = 'bg-transparent border-subtle text-secondary hover:border-accent/50 hover:text-accent';

              function matchesTerm(term, row) {
                var tail = row.dataset.tail || '';
                var aircraft = row.dataset.aircraft || '';
                var operator = row.dataset.operator || '';
                var airports = row.dataset.airports || '';
                var routes = row.dataset.routes || '';
                var flights = row.dataset.flights || '';

                // Check for route patterns: full (sfo-lax), departure (sfo-), arrival (-lax)
                var fullRoute = term.match(/^([a-z]{3})-([a-z]{3})$/);
                var departureRoute = term.match(/^([a-z]{3})-$/);
                var arrivalRoute = term.match(/^-([a-z]{3})$/);

                if (fullRoute) {
                  return routes.includes(term);
                } else if (departureRoute) {
                  return routes.split(' ').some(function(r) { return r.startsWith(departureRoute[1] + '-'); });
                } else if (arrivalRoute) {
                  return routes.split(' ').some(function(r) { return r.endsWith('-' + arrivalRoute[1]); });
                } else {
                  return tail.includes(term) ||
                    aircraft.includes(term) ||
                    operator.includes(term) ||
                    airports.includes(term) ||
                    flights.includes(term);
                }
              }

              function applyInitialFilter() {
                var urlParams = new URLSearchParams(window.location.search);
                var initialFilter = urlParams.get('filter');
                if (!initialFilter) return;

                currentFilter = initialFilter;
                filterBtns.forEach(function(b) {
                  if (b.dataset.filter === currentFilter) {
                    b.className = baseClass + ' ' + activeStyle;
                  } else {
                    b.className = baseClass + ' ' + inactiveStyle;
                  }
                });
              }

              function filterRows() {
                var query = (searchInput?.value || '').toLowerCase().trim();
                var visibleCount = 0;

                // Split into terms for AND matching
                var terms = query.split(/\\s+/).filter(function(t) { return t.length > 0; });

                rows.forEach(function(row) {
                  var fleet = row.dataset.fleet || '';
                  var airline = row.dataset.airline || '';

                  var matchesSearch = terms.length === 0 || terms.every(function(term) {
                    return matchesTerm(term, row);
                  });

                  var matchesFilter = currentFilter === 'all' || fleet === currentFilter || airline === currentFilter;

                  if (matchesSearch && matchesFilter) {
                    row.style.display = '';
                    visibleCount++;
                  } else {
                    row.style.display = 'none';
                  }
                });

                // Update result count
                if (searchCount) {
                  if (query || currentFilter !== 'all') {
                    searchCount.textContent = visibleCount + ' of ' + totalCount;
                    searchCount.style.display = '';
                  } else {
                    searchCount.textContent = '';
                    searchCount.style.display = 'none';
                  }
                }

                // Toggle clear button visibility
                if (searchClear) {
                  searchClear.classList.toggle('hidden', !query);
                }

                // Update URL
                var url = new URL(window.location.href);
                if (query) {
                  url.searchParams.set('q', query);
                } else {
                  url.searchParams.delete('q');
                }
                if (currentFilter !== 'all') {
                  url.searchParams.set('filter', currentFilter);
                } else {
                  url.searchParams.delete('filter');
                }
                window.history.replaceState({}, '', url);
              }

              if (searchInput) {
                searchInput.addEventListener('input', filterRows);

                // Load initial query from URL
                var urlParams = new URLSearchParams(window.location.search);
                var initialQuery = urlParams.get('q');
                if (initialQuery) {
                  searchInput.value = initialQuery;
                }
              }

              applyInitialFilter();
              filterRows();

              // Clear button
              if (searchClear) {
                searchClear.addEventListener('click', function() {
                  if (searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                    filterRows();
                  }
                });
              }

              // Keyboard shortcut: / to focus search
              document.addEventListener('keydown', function(e) {
                if (e.key === '/' && document.activeElement !== searchInput &&
                    !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
                  e.preventDefault();
                  searchInput?.focus();
                }
                // Escape to clear and blur
                if (e.key === 'Escape' && document.activeElement === searchInput) {
                  searchInput.value = '';
                  searchInput.blur();
                  filterRows();
                }
              });

              // Filter buttons - use data attribute to track state
              filterBtns.forEach(function(btn) {
                btn.addEventListener('click', function() {
                  currentFilter = this.dataset.filter;

                  // Update button styles
                  filterBtns.forEach(function(b) {
                    if (b.dataset.filter === currentFilter) {
                      b.className = baseClass + ' ' + activeStyle;
                    } else {
                      b.className = baseClass + ' ' + inactiveStyle;
                    }
                  });

                  filterRows();
                });
              });

              // Expand/collapse flights
              document.addEventListener('click', function(e) {
                var btn = e.target.closest('.expand-flights');
                if (!btn) return;
                var container = btn.closest('[id^="flights-"]');
                if (!container) return;
                var expanded = container.hasAttribute('data-expanded');
                if (expanded) container.removeAttribute('data-expanded');
                else container.setAttribute('data-expanded', '');
                btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
              });

              // Flight badge tooltips - only on devices with hover (not touch/mobile)
              if (window.matchMedia('(hover: hover)').matches) {
                var tooltip = null;
                var currentPill = null;

                document.addEventListener('mouseover', function(e) {
                  var pill = e.target.closest('[data-flight-tooltip]');
                  if (pill && pill !== currentPill) {
                    // Remove old tooltip if exists
                    if (tooltip && tooltip.parentNode) {
                      tooltip.parentNode.removeChild(tooltip);
                    }

                    currentPill = pill;
                    var text = pill.dataset.flightTooltip;
                    if (!text) return;

                    // Create tooltip
                    tooltip = document.createElement('div');
                    tooltip.textContent = text;
                    tooltip.style.cssText = 'position:fixed;padding:4px 8px;background:var(--color-accent);color:#0a0f1a;font-size:11px;font-weight:600;font-family:JetBrains Mono,monospace;border-radius:4px;pointer-events:none;z-index:9999;white-space:nowrap;box-shadow:0 4px 6px rgba(0,0,0,0.3);';
                    document.body.appendChild(tooltip);

                    // Position above the element
                    var rect = pill.getBoundingClientRect();
                    tooltip.style.left = (rect.left + rect.width / 2 - tooltip.offsetWidth / 2) + 'px';
                    tooltip.style.top = (rect.top - tooltip.offsetHeight - 6) + 'px';
                  }
                });

                document.addEventListener('mouseout', function(e) {
                  var pill = e.target.closest('[data-flight-tooltip]');
                  if (!pill) return;

                  // Check if we're leaving to something outside the pill
                  var related = e.relatedTarget;
                  if (related && pill.contains(related)) return;

                  if (tooltip && tooltip.parentNode) {
                    tooltip.parentNode.removeChild(tooltip);
                    tooltip = null;
                  }
                  currentPill = null;
                });
              }
            });
          `,
        }}
      />

      <ShareCardLink path={shareCard} />
    </PageShell>
  );
}
