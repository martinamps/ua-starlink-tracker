import { type SiteConfig, siteAirline } from "../airlines/registry";
import { listedWording } from "../api/check-flight-core";
import {
  type AnswerContext,
  CALENDAR_OFFER_ID,
  type FlightAnswer,
  answerShown,
  calendarOffered,
  datePassed,
  renderFlightAnswer,
} from "../client/flight-answer";
import type { PopularFlight } from "../database/database";
import { SEATBACK_LIVE_TV_COPY } from "../utils/aircraft-specs";
import { toIata } from "../utils/airport-code";
import { AIRPORT_TZ, airportTimezone, flightDateWindow } from "../utils/airport-tz";
import { article } from "../utils/grammar";
import { watchFeedEnabled } from "../utils/ics";
import { PopularFlightsLinks } from "./atoms";
import { FlightFactBlocks } from "./check-flight/fact-blocks";
import { SWAP_CAVEAT, firmLead } from "./check-flight/firm-lead";
import { PlaneSwapNote } from "./check-flight/plane-swap";
import type { DatedAnswer, FlightFacts, InvalidFlightQuery } from "./check-flight/types";
import { usualSummary } from "./check-flight/usual";
import { Faq, type FaqEntry, JsonLd, breadcrumbJsonLd, scriptSafeJson } from "./faq";
import { FlightSearchForm } from "./flight-search-form";
import {
  ClientScriptTag,
  LINK,
  type Link,
  PageHeader,
  PageShell,
  Panel,
  Section,
  SectionTitle,
} from "./layout";
import { wholeDates, zonedIsoDate } from "./ui/format";

export type {
  AssignedDeparture,
  DatedAnswer,
  FlightFacts,
  InvalidFlightQuery,
} from "./check-flight/types";

interface CheckFlightPageProps {
  site: SiteConfig;
  flight?: FlightFacts;
  /** A well-formed number we hold no rows for: no facts to show, but the page
   * still names it and keeps it in the form rather than dropping what was typed. */
  unknownFlight?: string;
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

/**
 * AIRPORT_ZONES for one page's re-check, plus any of the page's own airports
 * that only the register places, so the browser prints the local times the
 * server did. The very object when there is none: a page whose airports are
 * all hand-placed sends the bytes it always sent.
 */
export function zonesForPage(airports: Array<string | null | undefined>): Record<string, string> {
  let zones = AIRPORT_ZONES;
  for (const raw of new Set(airports)) {
    const code = toIata(raw);
    const zone = Object.hasOwn(AIRPORT_TZ, code) ? undefined : airportTimezone(code);
    if (!zone) continue;
    if (zones === AIRPORT_ZONES) zones = { ...AIRPORT_ZONES };
    zones[zone] = (zones[zone] ?? "") + code;
  }
  return zones;
}

/** A type rule of all or nothing: no date can change the answer. */
const typeSettled = (flight: FlightFacts) =>
  !flight.prediction?.n_observations &&
  !!flight.typeRule &&
  !flight.typeRule.aircraft &&
  flight.typeRule.probability !== null &&
  (flight.typeRule.probability >= 1 || flight.typeRule.probability <= 0);

/** The flight has a number to quote for other dates, not just "no history yet". */
const hasUsualFigure = (flight: FlightFacts) =>
  !!flight.prediction?.n_observations || !!flight.typeRule || flight.observedTotal > 0;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function answerContext(
  site: SiteConfig,
  dated: DatedAnswer,
  flight?: FlightFacts
): AnswerContext {
  const cfg = siteAirline(site);
  const origin = dated.leg?.origin ?? flight?.routes[0]?.departure_airport ?? null;
  return {
    flightNumber: dated.flightNumber,
    date: dated.date,
    daysOut: dated.daysOut,
    origin,
    originZone: origin ? (airportTimezone(origin) ?? null) : null,
    nowSec: Math.floor(Date.now() / 1000),
    airlineName: cfg.name,
    listedStatus: listedWording(cfg).status,
    zoneFor: (code) => airportTimezone(code),
    liveTv: site.features.liveTvPage ? SEATBACK_LIVE_TV_COPY : null,
    watchEnabled: watchFeedEnabled(site),
    routePlannerEnabled: site.features.routePlannerPage,
    tailPages: site.features.tailPages,
    host: site.canonicalHost,
    shareUrl: datedAnswerUrl(site, dated),
    ...(dated.dayLegs?.length ? { dayLegs: dated.dayLegs } : {}),
    ...(dated.seenAt ? { seenAt: dated.seenAt } : {}),
  };
}

/** The dated answer's own address: the canonical host and path, the leg kept. */
function datedAnswerUrl(site: SiteConfig, dated: DatedAnswer): string {
  const leg = new URLSearchParams();
  if (dated.leg?.origin) leg.set("origin", dated.leg.origin);
  if (dated.leg?.destination) leg.set("destination", dated.leg.destination);
  const path = `/check-flight/${encodeURIComponent(dated.flightNumber)}/${encodeURIComponent(dated.date)}`;
  return `https://${site.canonicalHost}${path}${leg.size ? `?${leg}` : ""}`;
}

function InvalidQueryNotice({
  invalid,
  example,
  shortName,
  showRoutePlanner,
  showFleet,
}: {
  invalid: InvalidFlightQuery;
  example: string;
  shortName: string;
  showRoutePlanner: boolean;
  showFleet: boolean;
}) {
  const quoted = invalid.query ? `“${invalid.query}”` : "That";
  const { elsewhere } = invalid;
  return (
    <div className="mb-4 rounded border border-subtle bg-surface-elevated p-4 text-sm">
      {invalid.reason === "other-carrier" ? (
        <>
          <p className="text-primary">
            {`${quoted} isn't ${article(shortName)} ${shortName} flight number. This site checks ${shortName} flights only.`}
          </p>{" "}
          {invalid.didYouMean && (
            <p className="mt-2 text-secondary">
              {`${shortName} flight numbers start with ${invalid.didYouMean.replace(/\d+$/, "")}. `}
              <a href={`/check-flight/${invalid.didYouMean}`} className={LINK}>
                {`Check ${invalid.didYouMean}`}
              </a>
              ?
            </p>
          )}{" "}
          {elsewhere && (
            // A deliberate cross-site mention, marked like the footer's.
            <p data-cross-site-links className="mt-2 text-secondary">
              {elsewhere.kind === "hub" && "Our "}
              {elsewhere.kind === "airlines" && "We don't track every airline. "}
              <a href={elsewhere.href} className={LINK}>
                {elsewhere.label}
              </a>
              {elsewhere.kind === "hub" ? " checks flights of the other airlines we track." : "."}
            </p>
          )}
        </>
      ) : invalid.reason === "tail" ? (
        <p className="text-primary">
          {`${quoted} looks like an aircraft tail number, not a flight number, and it isn't one of the ${shortName} aircraft we track. Enter a flight number like `}
          <span className="font-mono">{example}</span>
          {showFleet ? (
            <>
              , or{" "}
              <a href="/fleet" className={LINK}>
                {`see every ${shortName} aircraft`}
              </a>
              .
            </>
          ) : (
            "."
          )}
        </p>
      ) : (
        <p className="text-secondary">
          {invalid.tooManyDigits && `${shortName} flight numbers have at most four digits. `}
          Try something like <span className="font-mono">{example}</span>.
        </p>
      )}{" "}
      {invalid.airportHint && showRoutePlanner && (
        <p className="mt-2 text-secondary">
          Looking for an airport or a route? Try the{" "}
          <a
            href={
              invalid.airportCode
                ? `/route-planner?origin=${invalid.airportCode}`
                : "/route-planner"
            }
            className={LINK}
          >
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
  unknownFlight,
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
  const fn = flight?.flightNumber ?? dated?.flightNumber ?? unknownFlight;
  const flightExample = fn ?? `${cfg.iata}123`;
  const shortName = cfg.shortName;

  const ctx = dated ? answerContext(site, dated, flight) : null;
  const answer: FlightAnswer | null = dated && ctx ? renderFlightAnswer(dated.body, ctx) : null;
  // A prediction near departure may firm up from the API's live schedule
  // lookup, which the server render deliberately skips.
  // An answer read back from the log is firm and may be hours old: the
  // browser asks as often as it did when this page served odds here.
  const refresh =
    !!ctx && !!answer && (!answer.firm || !!dated?.seenAt) && !datePassed(ctx) && ctx.daysOut <= 2;

  // What the homepage's "Your flights" compares a later answer with
  // (src/client/recent-checks.ts): only for an answer worth coming back to.
  const seen =
    dated && ctx && answer && !dated.body.error && !datePassed(ctx)
      ? answerShown(answer, dated.body)
      : null;

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
        ? `Pick your travel date above. ${airlineName} assigns the aircraft about 2 days before departure, and the answer then comes from that aircraft. Before that, you get ${cfg.flightHistoryModel ? `Starlink odds from recent ${fn} flights, weighted to the latest` : `the share of the aircraft flying ${fn} that have Starlink`}.`
        : `Enter your flight number (for example ${flightExample}) and travel date above. We check the aircraft scheduled for that flight against our list of Starlink aircraft.`,
    },
    {
      q: "How accurate is this?",
      // A dated page says the swap caveat once, in the answer card.
      a: answer
        ? accuracyCopy
        : `${accuracyCopy} Aircraft can be swapped before departure, so check again the day before you fly.`,
    },
  ];

  const title = invalid
    ? invalid.reason === "other-carrier"
      ? `Not ${article(shortName)} ${shortName} flight`
      : invalid.reason === "tail"
        ? `Not ${article(shortName)} ${shortName} aircraft we track`
        : `${invalid.query ? `“${invalid.query}”` : "That"} isn't a flight number`
    : fn
      ? `Does ${fn} have Starlink Wi-Fi?`
      : `Does my ${shortName} flight have Starlink?`;
  // An assigned next departure with a settled aircraft opens the page; the
  // odds then describe the other dates instead of standing in for an answer.
  const assigned = !invalid && !answer ? (flight?.nextAssigned ?? null) : null;
  const dek =
    invalid || answer
      ? undefined
      : flight && assigned
        ? firmLead(flight, assigned)
        : flight
          ? `${wholeDates(usualSummary(flight))}${typeSettled(flight) ? "" : " A firm answer comes about 2 days before departure, once the aircraft is assigned."}`
          : fn
            ? `Pick your travel date to check ${fn}.`
            : "Enter your flight number and date to see whether your aircraft has Starlink.";
  // The assigned departure's dated page carries the calendar links; null where
  // no feed serves it (the hub, Qatar, a date already over at the airport).
  const assignedDate = assigned ? zonedIsoDate(assigned.departure, assigned.departureZone) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const calendarHref =
    fn &&
    assigned &&
    assignedDate &&
    calendarOffered({
      watchEnabled: watchFeedEnabled(site),
      date: assignedDate,
      daysOut: flightDateWindow(assignedDate, nowSec)?.daysOut ?? 0,
      nowSec,
      originZone: assigned.departureZone,
    })
      ? `/check-flight/${fn}/${assignedDate}#${CALENDAR_OFFER_ID}`
      : null;
  const otherDates =
    flight && assigned && !typeSettled(flight) && hasUsualFigure(flight)
      ? `On other dates: ${lowerFirst(usualSummary(flight))}`
      : null;

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
      <PageHeader title={title} dek={dek}>
        {assigned && (
          <p id="assignment-caveat" className="mx-auto max-w-2xl text-sm text-muted text-pretty">
            {SWAP_CAVEAT}
            {otherDates ? ` ${otherDates}` : ""}
            {calendarHref && (
              <>
                {" "}
                <a href={calendarHref} rel="nofollow" className={LINK}>
                  Add this departure to your calendar
                </a>
                : the event changes if we see a different aircraft on the flight.
              </>
            )}
          </p>
        )}
      </PageHeader>

      {answer && (
        <Section bare>
          {/* Above the card: a changed plane is what a traveller who checked before needs first. */}
          {answer.firm && dated?.swap && <PlaneSwapNote swap={dated.swap} />}
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
              showFleet={site.features.fleetPage}
            />
          )}{" "}
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
              <a href="/how-to-check" className={LINK}>
                How the check works
              </a>
              {" · "}
              <a href="/is-starlink-free" className={LINK}>
                Is Starlink Wi-Fi free?
              </a>
            </p>
          )}
        </Panel>
      </Section>

      {flight && <FlightFactBlocks site={site} flight={flight} scheduledOnDate={scheduledOnDate} />}
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
          </li>{" "}
          {site.features.chromeExtension && (
            <li>
              Shopping on Google Flights? The free{" "}
              <a href="/chrome" className={LINK}>
                Chrome extension
              </a>{" "}
              marks {shortName} flights that have Starlink.
            </li>
          )}{" "}
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
              zones: refresh
                ? zonesForPage([
                    ctx?.origin,
                    dated.leg?.destination,
                    ...(dated.body.flights ?? []).flatMap((f) => [
                      f.departure_airport,
                      f.arrival_airport,
                    ]),
                    ...(dated.body.fallback?.segments ?? []).flatMap((g) => [
                      g.origin,
                      g.destination,
                    ]),
                    ...(flight?.routes ?? []).flatMap((r) => [
                      r.departure_airport,
                      r.arrival_airport,
                    ]),
                  ])
                : {},
              ...(dated.leg ? { leg: dated.leg } : {}),
              ...(seen ? { seen } : {}),
            }),
          }}
        />
      )}
      <ClientScriptTag name="check-flight" />
    </PageShell>
  );
}
