import { type SiteConfig, siteAirline } from "../airlines/registry";
import {
  type AnswerContext,
  type FlightAnswer,
  datePassed,
  renderFlightAnswer,
} from "../client/flight-answer";
import type { PopularFlight } from "../database/database";
import { SEATBACK_LIVE_TV_COPY } from "../utils/aircraft-specs";
import { AIRPORT_TZ, airportTimezone } from "../utils/airport-tz";
import { article } from "../utils/grammar";
import { watchFeedEnabled } from "../utils/ics";
import { PopularFlightsLinks } from "./atoms";
import { FlightFactBlocks } from "./check-flight/fact-blocks";
import type { DatedAnswer, FlightFacts, InvalidFlightQuery } from "./check-flight/types";
import { Faq, type FaqEntry, JsonLd, breadcrumbJsonLd, scriptSafeJson } from "./faq";
import { ClientScriptTag, FlightSearchForm } from "./flight-search-form";
import { CHROME_EXTENSION_URL } from "./home/tools";
import { LINK, type Link, PageHeader, PageShell, Panel, Section, SectionTitle } from "./layout";
import { fmt, probPhrase, probTier } from "./ui/format";

export type { DatedAnswer, FlightFacts, InvalidFlightQuery } from "./check-flight/types";

interface CheckFlightPageProps {
  site: SiteConfig;
  flight?: FlightFacts;
  invalid?: InvalidFlightQuery;
  dated?: DatedAnswer;
  /** Rendered on the generic (non-permalink) page only — permalinks link
   * laterally via siblings instead. */
  popular?: PopularFlight[];
  pageLinks?: Link[];
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

const USUAL_LEAD = { likely: "Usually yes", maybe: "Sometimes", unlikely: "Usually no" } as const;

/** "Hawaiian-operated (A330/A321neo)" → "Hawaiian-operated A330/A321neo". */
const bandLabel = (label: string) => label.replace(/\s*\((.*)\)$/, " $1");

/** The undated answer: how often this flight gets Starlink. Prefers the
 * model's number (the one the API and MCP quote) over the raw check tally. */
function usualSummary(flight: FlightFacts): string {
  const fn = flight.flightNumber;
  const pred = flight.prediction;
  if (pred && pred.n_observations > 0) {
    const lead = USUAL_LEAD[probTier(pred.probability)];
    return `${lead}: ${probPhrase(pred.probability)} of recent ${fn} flights had Starlink.`;
  }
  const rule = flight.typeRule;
  if (rule) {
    const band = bandLabel(rule.label);
    if (rule.probability >= 1)
      return `Yes: ${fn} flies ${band} aircraft, and every one has Starlink.`;
    if (rule.probability <= 0)
      return `No: ${fn} flies ${band} aircraft, which don't have Starlink.`;
    return `${USUAL_LEAD[probTier(rule.probability)]}: ${probPhrase(rule.probability)} of the ${band} aircraft that fly ${fn} have Starlink.`;
  }
  const { observedStarlink: s, observedTotal: n } = flight;
  if (n > 0) {
    const lead = USUAL_LEAD[probTier(s / n)];
    return `${lead}: the aircraft had Starlink in ${fmt(s)} of ${fmt(n)} recent checks.`;
  }
  return `We haven't seen ${fn} yet.`;
}

/** A type rule of all or nothing: no date can change the answer. */
const typeSettled = (flight: FlightFacts) =>
  !flight.prediction?.n_observations &&
  !!flight.typeRule &&
  (flight.typeRule.probability >= 1 || flight.typeRule.probability <= 0);

function answerContext(site: SiteConfig, dated: DatedAnswer, flight?: FlightFacts): AnswerContext {
  const cfg = siteAirline(site);
  const origin = flight?.routes[0]?.departure_airport ?? null;
  return {
    flightNumber: dated.flightNumber,
    date: dated.date,
    daysOut: dated.daysOut,
    origin,
    originZone: origin ? (airportTimezone(origin) ?? null) : null,
    nowSec: Math.floor(Date.now() / 1000),
    airlineName: cfg.name,
    zoneFor: (code) => airportTimezone(code),
    liveTv: site.features.liveTvPage ? SEATBACK_LIVE_TV_COPY : null,
    watchEnabled: watchFeedEnabled(site),
    routePlannerEnabled: site.features.routePlannerPage,
    host: site.canonicalHost,
  };
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
          <a href="/route-planner" className={LINK}>
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

  const ctx = dated ? answerContext(site, dated, flight) : null;
  const answer: FlightAnswer | null = dated && ctx ? renderFlightAnswer(dated.body, ctx) : null;
  // A prediction near departure may firm up from the API's live schedule
  // lookup, which the server render deliberately skips.
  const refresh = !!ctx && !!answer && !answer.firm && !datePassed(ctx) && ctx.daysOut <= 2;

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
        ? `${usualSummary(flight)}${typeSettled(flight) ? "" : " Pick a date for a firm answer."}`
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
        <Section bare>
          <div
            id="flight-answer"
            aria-live="polite"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: renderFlightAnswer escapes every value
            dangerouslySetInnerHTML={{ __html: answer.html }}
          />
        </Section>
      )}

      <Section bare>
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
              <a href="/how-to-check" className={LINK}>
                How the check works
              </a>
              .{" "}
              <a href="/is-starlink-free" className={LINK}>
                Starlink Wi-Fi is free
              </a>
              .
            </p>
          )}
        </Panel>
      </Section>

      {flight && <FlightFactBlocks flight={flight} scheduledOnDate={scheduledOnDate} />}
      {!flight && popular.length > 0 && (
        <Section bare>
          <PopularFlightsLinks flights={popular} airlineName={cfg.name} />
        </Section>
      )}

      <Section title="Other ways to check">
        <ul className="space-y-2 text-sm leading-relaxed text-secondary">
          <li>
            Know your tail number? Search it on the{" "}
            <a href="/" className={LINK}>
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
                className={LINK}
              >
                Chrome extension
              </a>{" "}
              marks {shortName} flights that have Starlink.
            </li>
          )}
          {flight && site.features.fleetPage && (
            <li>
              See every {airlineName} aircraft on the{" "}
              <a href="/fleet" className={LINK}>
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
          // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by scriptSafeJson
          dangerouslySetInnerHTML={{
            __html: scriptSafeJson({
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
