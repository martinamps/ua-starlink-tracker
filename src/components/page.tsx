/**
 * Every tenant's homepage: header, flight search, the airline's own hero
 * (content/), the answer block, the aircraft list, airports, tools, popular
 * flights and the FAQ. The pieces live in home/; this file orders them.
 */
import type { AirlineContent, ContentStats, HubHomeLinks } from "../airlines/content";
import { type SiteConfig, siteAirline } from "../airlines/registry";
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
import { HeaderStatStrip, PopularFlightsLinks, ShareCardLink } from "./atoms";
import { Faq, homeFaqItems, homeFaqSections } from "./faq";
import { FlightSearchForm } from "./flight-search-form";
import { AircraftList } from "./home/aircraft-list";
import { AirportBars } from "./home/rollout";
import { ToolsSection } from "./home/tools";
import { ClientScriptTag } from "./layout";
import type { Link } from "./layout";
import { Eyebrow, PageHeader, PageShell, Panel, Section, StatInline } from "./layout";
import { PassengerBanner } from "./passenger-banner";
import { fmt, longDate, pct } from "./ui/format";

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
  installsPaceWindow?: string;
  /** Installs per calendar week, oldest first (rollout sparkline). */
  weeklyInstalls?: number[];
  /** Pre-rendered share card path; null until the nightly batch produced one. */
  shareCard?: string | null;
  pageLinks?: Link[];
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
  installsPaceWindow?: string;
  installs30d?: number;
  weeklyInstalls?: number[];
  lastUpdated?: string;
  perAirline?: PerAirlineStat[];
}): ContentStats {
  const { starlinkCount, totalCount } = input;
  return {
    starlinkCount,
    totalCount,
    fleetStats: input.fleetStats,
    installsPerMonth: input.installsPerMonth,
    installsPaceWindow: input.installsPaceWindow,
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

// The first install, per United's press release; the sheet's own date is later.
const DATE_OVERRIDES: Record<string, string> = { N127SY: "2025-03-07" };

/** Freshest flight data first, with the known date corrections applied. */
function orderedAircraft(starlink: Aircraft[], flightsByTail: Record<string, Flight[]>) {
  const updated = (a: Aircraft) => flightsByTail[a.TailNumber]?.[0]?.last_updated || 0;
  return starlink
    .map((a) =>
      DATE_OVERRIDES[a.TailNumber] ? { ...a, DateFound: DATE_OVERRIDES[a.TailNumber] } : a
    )
    .sort((a, b) => updated(b) - updated(a));
}

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
  installsPaceWindow,
  weeklyInstalls,
  shareCard,
  pageLinks,
  popularFlights = [],
  hubLinks,
}: PageProps) {
  const aircraft = orderedAircraft(starlink, flightsByTail);
  const stats = buildContentStats({
    starlinkCount: aircraft.length,
    totalCount: total,
    fleetStats,
    installsPerMonth,
    installsPaceWindow,
    installs30d,
    weeklyInstalls,
    lastUpdated,
    perAirline: perAirlineStats,
  });
  const features = site.features;
  // The hub has checkFlightPage off and siteAirline() throws there.
  const airline = features.checkFlightPage ? siteAirline(site) : null;

  return (
    <PageShell
      site={site}
      currentPath="/"
      pageLinks={pageLinks}
      before={showPassengerBanner ? <PassengerBanner site={site} /> : null}
    >
      <PageHeader title={site.brand.title} dek={content.intro(stats)}>
        <HeaderStatStrip
          items={
            typeof content.headerStats === "function"
              ? content.headerStats(stats)
              : content.headerStats
          }
        />
      </PageHeader>

      {airline && (
        <div className="relative max-w-xl mx-auto w-full mb-6">
          <Panel pad="sm">
            <Eyebrow as="h2" className="mb-2 text-center">
              Does your flight have Starlink?
            </Eyebrow>
            <FlightSearchForm site={site} id="home-flight-search" hideLabels withScript={false} />
          </Panel>
        </div>
      )}

      <content.Hero
        site={site}
        stats={stats}
        starlinkData={aircraft}
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
          wide
          items={homeFaqItems(content.answers, stats)}
          structuredData={false}
        />
      )}

      <AircraftList
        aircraft={aircraft}
        content={content}
        airlineByTail={airlineByTail}
        flightsByTail={flightsByTail}
        permalinkAirline={airline}
        showFleetLink={features.fleetPage}
        fleetTotal={total}
      />

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

      <ToolsSection site={site} />

      {airline && popularFlights.length > 0 && (
        <Section bare wide>
          <PopularFlightsLinks flights={popularFlights} airlineName={airline.name} />
        </Section>
      )}

      <Faq
        id="faq"
        title="More questions"
        variant="accordion"
        wide
        sections={homeFaqSections(content.faq, stats)}
        structuredData={false}
      />

      {stats.asOf && (
        <p className="relative mb-6 text-center text-xs text-muted">
          Data last updated {stats.asOf}
        </p>
      )}

      <ShareCardLink path={shareCard} />
      <ClientScriptTag name="home" />
    </PageShell>
  );
}
