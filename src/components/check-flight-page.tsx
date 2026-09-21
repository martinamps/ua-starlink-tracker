import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import {
  type AnswerContext,
  type CheckFlightBody,
  type FlightAnswer,
  renderFlightAnswer,
} from "../client/flight-answer";
import type { PopularFlight } from "../database/database";
import { SEATBACK_LIVE_TV_COPY } from "../utils/aircraft-specs";
import { AIRPORT_TZ, airportTimezone } from "../utils/airport-tz";
import { article } from "../utils/grammar";
import { watchFeedEnabled } from "../utils/ics";
import { type PageLink, PopularFlightsLinks } from "./atoms";
import { Faq, type FaqEntry, JsonLd, breadcrumbJsonLd, jsonLdString } from "./faq";
import { ClientScriptTag, FlightSearchForm } from "./flight-search-form";
import { CHROME_EXTENSION_URL } from "./home/tools";
import {
  Chip,
  PageHeader,
  PageShell,
  Panel,
  Section,
  SectionTitle,
  StatInline,
  fmt,
} from "./layout";
import { formatDuration, shortDate, zonedDeparture } from "./ui/format";

export interface FlightRouteFact {
  departure_airport: string;
  arrival_airport: string;
  times: number;
  dur_sec: number | null;
  /** Newest evidence for this leg (unix seconds); null when the row carries none. */
  last_seen_at: number | null;
  /** Whether /route-planner/{dep}/{arr} serves; false renders the pair unlinked. */
  linkable: boolean;
}

export interface FlightUpcomingDeparture {
  departure_airport: string;
  arrival_airport: string;
  departure_time: number;
  /** YYYY-MM-DD at the departure airport: the date a traveller books and the
   * date the lookup answers for. Null when the airport's zone is unknown. */
  departure_local_date?: string | null;
  /** IANA zone of the departure airport, for rendering local clock time. */
  departure_tz?: string | null;
  tail_number: string;
  aircraft_type: string | null;
  /** The slot's current tail passes the equipped test the verdict uses. */
  starlink: boolean;
  wifiLabel: string;
}

/** Server-assembled facts for a /check-flight/{fn} permalink — the page's
 * unique crawlable substance; the client lookup flow layers on top. */
export interface FlightFacts {
  flightNumber: string;
  airlineName: string;
  /** United.com (or the carrier's verifier) checks of aircraft on this number,
   * whole log, not departures; see observedSince. */
  observedTotal: number;
  observedStarlink: number;
  /** Earliest check counted in observedTotal (unix seconds). */
  observedSince?: number | null;
  /** The per-flight model's answer: the same number /api/predict-flight and
   * MCP predict_flight_starlink give. Null for carriers without a model. */
  prediction?: {
    probability: number;
    n_observations: number;
    confidence: "high" | "medium" | "low";
  } | null;
  aircraftTypes: string[];
  /** Newest check that found Starlink on this number: a check time, not a departure. */
  lastStarlink: { tail: string; checked_at: number } | null;
  routes: FlightRouteFact[];
  upcoming: FlightUpcomingDeparture[];
  /** Other marketing flight numbers on this flight's primary route — sibling
   * permalinks, so the corpus links laterally instead of only via /routes. */
  siblings: string[];
  /** Newest sighting (unix sec) when the flight has gone quiet long enough to
   * say so on the page; null otherwise. */
  notObservedSince?: number | null;
  /** aircraftTypes with their /fleet/{slug} page, each page linked once. */
  aircraftTypeLinks?: Array<{ label: string; href: string | null }>;
}

/** A permalink segment that is not a flight number this site can answer for.
 * `query` is the offending segment (null when it could not be decoded), never
 * trusted — React escapes it at render. */
export interface InvalidFlightQuery {
  query: string | null;
  reason: "not-a-flight-number" | "other-carrier";
  airportHint: boolean;
}

/** The dated permalink's answer: the /api/check-flight body the server built
 * from the database, rendered by the same function the browser re-check uses. */
export interface DatedAnswer {
  flightNumber: string;
  date: string;
  daysOut: number;
  body: CheckFlightBody;
}

interface CheckFlightPageProps {
  site: SiteConfig;
  flight?: FlightFacts;
  invalid?: InvalidFlightQuery;
  dated?: DatedAnswer;
  /** Rendered on the generic (non-permalink) page only — permalinks link
   * laterally via siblings instead. */
  popular?: PopularFlight[];
  pageLinks?: PageLink[];
  currentPath?: string;
  /** FAQPage rich results are ignored on noindex URLs; keep the markup off them. */
  noindex?: boolean;
}

/** Zone → concatenated IATA codes; a third the bytes of the flat map, and the
 * browser re-check needs every airport a flight might leave from. */
const AIRPORT_ZONES: Record<string, string> = (() => {
  const byZone: Record<string, string> = {};
  for (const [iata, zone] of Object.entries(AIRPORT_TZ)) byZone[zone] = (byZone[zone] ?? "") + iata;
  return byZone;
})();

/** The undated answer: how often this flight gets Starlink. Prefers the
 * model's number (the one the API and MCP quote) over the raw check tally. */
function usualSummary(flight: FlightFacts): string {
  const fn = flight.flightNumber;
  const pred = flight.prediction;
  if (pred && pred.n_observations > 0) {
    const pct = Math.round(pred.probability * 100);
    const share = pct < 1 ? "under 1%" : pct > 99 ? "over 99%" : `about ${pct}%`;
    const lead = pct >= 70 ? "Usually yes" : pct >= 30 ? "Sometimes" : "Usually no";
    return `${lead}: ${share} of recent ${fn} flights had Starlink.`;
  }
  const { observedStarlink: s, observedTotal: n } = flight;
  if (n > 0) {
    const r = s / n;
    const lead = r >= 0.7 ? "Usually yes" : r >= 0.3 ? "Sometimes" : "Usually no";
    return `${lead}: the aircraft had Starlink in ${fmt(s)} of ${fmt(n)} recent checks.`;
  }
  return `We haven't seen ${fn} yet.`;
}

function lastSeenLabel(sec: number | null): string | null {
  if (!sec || sec * 1000 > Date.now()) return null;
  return `last seen ${shortDate(sec)}`;
}

function answerContext(site: SiteConfig, dated: DatedAnswer): AnswerContext {
  const cfg = siteAirline(site);
  return {
    flightNumber: dated.flightNumber,
    date: dated.date,
    daysOut: dated.daysOut,
    nowSec: Math.floor(Date.now() / 1000),
    airlineName: cfg.name,
    zoneFor: (code) => airportTimezone(code),
    liveTv: site.features.liveTvPage ? SEATBACK_LIVE_TV_COPY : null,
    watchEnabled: watchFeedEnabled(site),
    routePlannerEnabled: site.features.routePlannerPage,
    host: site.canonicalHost,
  };
}

function FlightFactBlocks({
  flight,
  scheduledOnDate,
}: {
  flight: FlightFacts;
  scheduledOnDate: boolean;
}) {
  const fn = flight.flightNumber;
  const hasHistory =
    flight.observedTotal > 0 || flight.aircraftTypes.length > 0 || flight.lastStarlink !== null;
  const pred = flight.prediction;
  return (
    <>
      {flight.upcoming.length > 0 && (
        <Section
          title={`Next ${fn} departures`}
          dek="Aircraft can change up to departure. Check your date above for the current answer."
        >
          <ul className="divide-y divide-subtle text-sm">
            {flight.upcoming.map((u) => (
              <li
                key={`${u.tail_number}-${u.departure_time}`}
                className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="text-primary">
                    {u.departure_airport} → {u.arrival_airport}
                    <span className="text-secondary">
                      {" · "}
                      {
                        zonedDeparture(
                          u.departure_time,
                          u.departure_tz ?? airportTimezone(u.departure_airport)
                        ).full
                      }
                    </span>
                  </div>
                  <div className="text-muted">
                    <span className="font-mono">{u.tail_number}</span>
                    {u.aircraft_type ? ` · ${u.aircraft_type}` : ""}
                  </div>
                </div>
                <span
                  className={`shrink-0 whitespace-nowrap ${u.starlink ? "text-success" : "text-muted"}`}
                >
                  {u.starlink ? "Starlink" : u.wifiLabel}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {hasHistory && (
        <Section title={`${fn} Starlink history`}>
          <div className="space-y-2 text-sm leading-relaxed text-secondary">
            {pred && pred.n_observations > 0 && (
              <p>
                <StatInline>{Math.round(pred.probability * 100)}%</StatInline> of recent {fn}{" "}
                flights had a Starlink aircraft, from <StatInline n={pred.n_observations} /> flights
                observed.
              </p>
            )}
            {flight.observedTotal > 0 && (
              <p>
                Starlink found in <StatInline n={flight.observedStarlink} /> of{" "}
                <StatInline n={flight.observedTotal} /> Wi-Fi checks of aircraft flying {fn}
                {flight.observedSince ? ` since ${shortDate(flight.observedSince)}` : ""}.
              </p>
            )}
            {flight.lastStarlink && (
              <p>
                Last verified on Starlink: {shortDate(flight.lastStarlink.checked_at)} (
                <span className="font-mono">{flight.lastStarlink.tail}</span>).
              </p>
            )}
            {flight.aircraftTypes.length > 0 && (
              <p>
                Aircraft seen on {fn}:{" "}
                {(
                  flight.aircraftTypeLinks ??
                  flight.aircraftTypes.map((label) => ({ label, href: null }))
                ).map((t, i) => (
                  <React.Fragment key={t.label}>
                    {i > 0 && ", "}
                    {t.href ? (
                      <a href={t.href} className="text-accent hover:underline">
                        {t.label}
                      </a>
                    ) : (
                      t.label
                    )}
                  </React.Fragment>
                ))}
                .
              </p>
            )}
          </div>
        </Section>
      )}

      {flight.routes.length > 0 && (
        <Section title={`Routes ${fn} flies`}>
          {flight.notObservedSince && !scheduledOnDate ? (
            <p className="mb-3 text-sm text-muted">
              Last seen {shortDate(flight.notObservedSince)}.
            </p>
          ) : null}
          <ul className="divide-y divide-subtle text-sm">
            {flight.routes.map((r) => {
              const lastSeen = lastSeenLabel(r.last_seen_at);
              return (
                <li
                  key={`${r.departure_airport}-${r.arrival_airport}`}
                  className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="text-primary">
                      {r.departure_airport} → {r.arrival_airport}
                      {r.dur_sec ? (
                        <span className="text-secondary"> · {formatDuration(r.dur_sec)}</span>
                      ) : null}
                    </div>
                    <div className="text-muted">
                      Seen {fmt(r.times)} time{r.times === 1 ? "" : "s"}
                      {lastSeen ? ` · ${lastSeen}` : ""}
                    </div>
                  </div>
                  {r.linkable ? (
                    <a
                      href={`/route-planner/${r.departure_airport}/${r.arrival_airport}`}
                      className="shrink-0 whitespace-nowrap text-accent hover:underline"
                    >
                      Plan this route
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {flight.siblings.length > 0 && flight.routes[0] && (
        <Section
          title="Other flights on this route"
          dek={`${flight.routes[0].departure_airport} to ${flight.routes[0].arrival_airport}. Each flight number has its own aircraft history.`}
        >
          <div className="flex flex-wrap gap-2">
            {flight.siblings.map((s) => (
              <Chip key={s} href={`/check-flight/${s}`}>
                {s}
              </Chip>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function InvalidQueryNotice({
  invalid,
  example,
  shortName,
  showRoutePlanner,
}: {
  invalid: InvalidFlightQuery;
  example: string;
  shortName: string;
  showRoutePlanner: boolean;
}) {
  const quoted = invalid.query ? `“${invalid.query}”` : "That";
  return (
    <div className="mb-4 rounded border border-subtle bg-surface-elevated p-4 text-sm">
      <p className="text-primary">
        {invalid.reason === "other-carrier"
          ? `${quoted} isn't ${article(shortName)} ${shortName} flight number. This site covers ${shortName} flights only.`
          : `${quoted} isn't a flight number.`}
      </p>
      <p className="mt-1 text-secondary">
        Flight numbers look like <span className="font-mono">{example}</span>: a two-letter airline
        code and 1–4 digits.
      </p>
      {invalid.airportHint && showRoutePlanner && (
        <p className="mt-2 text-secondary">
          Looking for an airport or a route? Try the{" "}
          <a href="/route-planner" className="text-accent hover:underline">
            route planner
          </a>
          .
        </p>
      )}
    </div>
  );
}

export default function CheckFlightPage({
  site,
  flight,
  invalid,
  dated,
  popular = [],
  pageLinks,
  currentPath,
  noindex = false,
}: CheckFlightPageProps) {
  const cfg = siteAirline(site);
  const airlineName = flight?.airlineName ?? cfg.name;
  const host = site.canonicalHost;
  const fn = flight?.flightNumber ?? dated?.flightNumber;
  const flightExample = fn ?? `${cfg.iata}123`;
  const shortName = cfg.shortName;

  const ctx = dated ? answerContext(site, dated) : null;
  const answer: FlightAnswer | null = dated && ctx ? renderFlightAnswer(dated.body, ctx) : null;
  // A prediction near departure may firm up from the API's live schedule
  // lookup, which the server render deliberately skips.
  const refresh = !!dated && !!answer && !answer.firm && dated.daysOut >= -1 && dated.daysOut <= 2;

  const accuracyCopy =
    cfg.verifierBackend === "united"
      ? "We check each aircraft's Wi-Fi on united.com and match aircraft to flights using flight schedule data."
      : cfg.verifierBackend === "alaska-json"
        ? `We combine ${shortName}'s own status data, public fleet data and the aircraft seen on each flight.`
        : "We combine public fleet data, rollout updates and the aircraft seen on each flight.";
  const faq: FaqEntry[] = [
    {
      q: `How do I check if ${fn ?? `my ${shortName} flight`} has Starlink?`,
      a: fn
        ? `Pick your travel date above. About 2 days before departure, ${airlineName} assigns the aircraft, and the answer comes from that aircraft. Earlier than that, you get a probability based on the aircraft that recently flew ${fn}.`
        : `Enter your flight number (for example ${flightExample}) and travel date above. We check the aircraft scheduled for that flight against our list of Starlink aircraft.`,
    },
    {
      q: "How accurate is this?",
      a: `${accuracyCopy} Aircraft can change up to departure, so check again the day before you fly.`,
    },
  ];

  const title = invalid
    ? "That isn't a flight number"
    : fn
      ? `Does ${fn} have Starlink Wi-Fi?`
      : `Check your ${airlineName} flight for Starlink Wi-Fi`;
  const dek = invalid
    ? `Enter ${article(shortName)} ${shortName} flight number to check it.`
    : answer
      ? undefined
      : flight
        ? `${usualSummary(flight)} Pick a date for a firm answer.`
        : "Enter your flight number and date to see whether your aircraft has Starlink.";

  const scheduledOnDate = answer?.firm === true;
  const crumbs = [
    { name: site.brand.title, path: "/" },
    { name: "Check a flight", path: "/check-flight" },
    ...(flight
      ? [{ name: flight.flightNumber, path: `/check-flight/${flight.flightNumber}` }]
      : []),
  ];

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader title={title} dek={dek} />

      {answer && (
        <section className="relative mx-auto mb-6 w-full max-w-3xl" aria-live="polite">
          <div
            id="flight-answer"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: renderFlightAnswer escapes every value
            dangerouslySetInnerHTML={{ __html: answer.html }}
          />
        </section>
      )}

      <section className="relative mx-auto mb-8 w-full max-w-3xl">
        {answer && <SectionTitle className="mb-3">Check another date or flight</SectionTitle>}
        <Panel>
          {invalid && (
            <InvalidQueryNotice
              invalid={invalid}
              example={flightExample}
              shortName={shortName}
              showRoutePlanner={site.features.routePlannerPage}
            />
          )}
          <FlightSearchForm
            site={site}
            id="check-flight-form"
            flightNumber={fn}
            date={dated?.date}
            prefillDate
            withScript={false}
          />
          {site.features.intentPages && (
            <p className="mt-4 text-sm text-muted">
              New here?{" "}
              <a href="/how-to-check" className="text-accent hover:underline">
                How the check works
              </a>
              .{" "}
              <a href="/is-starlink-free" className="text-accent hover:underline">
                Starlink Wi-Fi is free
              </a>
              .
            </p>
          )}
        </Panel>
      </section>

      {flight && <FlightFactBlocks flight={flight} scheduledOnDate={scheduledOnDate} />}
      {!flight && popular.length > 0 && (
        <section className="relative mx-auto mb-8 w-full max-w-3xl">
          <PopularFlightsLinks flights={popular} airlineName={cfg.name} />
        </section>
      )}

      <Section title="Other ways to check">
        <ul className="space-y-2 text-sm leading-relaxed text-secondary">
          <li>
            Know your tail number? Search it on the{" "}
            <a href="/" className="text-accent hover:underline">
              homepage
            </a>
            .
          </li>
          {site.features.chromeExtension && (
            <li>
              Shopping on Google Flights? The free{" "}
              <a
                href={CHROME_EXTENSION_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Chrome extension
              </a>{" "}
              marks {shortName} flights that have Starlink.
            </li>
          )}
          {flight && site.features.fleetPage && (
            <li>
              See every {airlineName} aircraft on the{" "}
              <a href="/fleet" className="text-accent hover:underline">
                fleet page
              </a>
              .
            </li>
          )}
        </ul>
      </Section>

      <Faq items={faq} structuredData={!noindex} />

      <JsonLd data={breadcrumbJsonLd(host, crumbs)} />
      {dated && (
        <script
          type="application/json"
          id="check-flight-config"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by jsonLdString
          dangerouslySetInnerHTML={{
            __html: jsonLdString({
              ...ctx,
              zoneFor: undefined,
              nowSec: undefined,
              refresh,
              zones: refresh ? AIRPORT_ZONES : {},
            }),
          }}
        />
      )}
      <ClientScriptTag name="check-flight" />
    </PageShell>
  );
}
