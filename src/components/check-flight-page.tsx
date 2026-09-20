import React from "react";
import { aircraftFamilyPatterns } from "../airlines/aircraft-families";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { PopularFlight } from "../database/database";
import { SEATBACK_LIVE_TV_COPY, SEATBACK_LIVE_TV_LIKELY_FAMILIES } from "../utils/aircraft-specs";
import { AIRPORT_TZ } from "../utils/airport-tz";
import { article } from "../utils/grammar";
import { watchFeedEnabled } from "../utils/ics";
import { type PageLink, PageNavLinks, PopularFlightsLinks } from "./atoms";

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
  tail_number: string;
  aircraft_type: string | null;
  starlink: boolean;
  wifiLabel: string;
}

/** Server-assembled facts for a /check-flight/{fn} permalink — the page's
 * unique crawlable substance; the client lookup flow layers on top. */
export interface FlightFacts {
  flightNumber: string;
  airlineName: string;
  observedTotal: number;
  observedStarlink: number;
  aircraftTypes: string[];
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

interface CheckFlightPageProps {
  site: SiteConfig;
  flight?: FlightFacts;
  invalid?: InvalidFlightQuery;
  /** Rendered on the generic (non-permalink) page only — permalinks link
   * laterally via siblings instead. */
  popular?: PopularFlight[];
  pageLinks?: PageLink[];
}

// Module-level formatters: constructing a locale formatter per call
// (toLocale*String with options) dominated SSR time on list-heavy pages.
const DAY_UTC = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const MONTH_DAY_UTC = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const HHMM_UTC = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** Zone → concatenated IATA codes; a third the bytes of the flat map, and
 * the client needs every airport because the form checks any flight. */
const AIRPORT_ZONES_INLINE: string = (() => {
  const byZone: Record<string, string> = {};
  for (const [iata, zone] of Object.entries(AIRPORT_TZ)) byZone[zone] = (byZone[zone] ?? "") + iata;
  return JSON.stringify(byZone);
})();

const fmtDay = (sec: number) => DAY_UTC.format(new Date(sec * 1000));

const fmtDeparture = (sec: number) => {
  const d = new Date(sec * 1000);
  return `${MONTH_DAY_UTC.format(d)} · ${HHMM_UTC.format(d)} UTC`;
};

// Round total minutes BEFORE splitting into h/m — rounding the remainder
// alone renders 2h59m30s as "2h 60m".
const fmtDuration = (sec: number) => {
  const mins = Math.round(sec / 60);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
};

function flightSummary(flight: FlightFacts): string {
  const { flightNumber, observedStarlink: s, observedTotal: n } = flight;
  if (n > 0 && s > 0) {
    return `${flightNumber} had Starlink on ${s} of ${n} recently verified departures (${Math.round((s / n) * 100)}%). Pick a date below for a live answer.`;
  }
  if (n > 0) {
    return `Not yet — recently verified ${flightNumber} departures were flown by aircraft still awaiting Starlink installation. Pick a date below for a live answer.`;
  }
  return `Pick a date below for a live answer based on the aircraft assigned to ${flightNumber}.`;
}

/** The list is ordered by how recently each leg was seen, so the date is the
 * evidence behind the order — and the honest hedge on the heading's present
 * tense, since a leg's silence is what makes it a route the number *flew*.
 * A future timestamp is a corrupt row, not a date to show. */
function lastSeenLabel(sec: number | null): string | null {
  if (!sec || sec * 1000 > Date.now()) return null;
  return `last seen ${fmtDay(sec)}`;
}

function FlightFactBlocks({ flight }: { flight: FlightFacts }) {
  const fn = flight.flightNumber;
  const hasHistory =
    flight.observedTotal > 0 || flight.aircraftTypes.length > 0 || flight.lastStarlink !== null;
  return (
    <>
      {flight.routes.length > 0 && (
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            Routes {fn} flies
          </h2>
          {flight.notObservedSince ? (
            <p className="text-sm text-muted mb-3">
              Not observed since {fmtDay(flight.notObservedSince)}; may be seasonal or discontinued.
            </p>
          ) : null}
          <div className="space-y-2">
            {flight.routes.map((r) => {
              const lastSeen = lastSeenLabel(r.last_seen_at);
              return (
                <div
                  key={`${r.departure_airport}-${r.arrival_airport}`}
                  className="flex items-center justify-between gap-3 text-sm font-mono"
                >
                  <span className="text-secondary">
                    {r.departure_airport} → {r.arrival_airport}
                    {r.dur_sec ? (
                      <span className="text-muted"> · {fmtDuration(r.dur_sec)}</span>
                    ) : null}
                    <span className="text-muted">
                      {" "}
                      · seen {r.times} time{r.times === 1 ? "" : "s"}
                    </span>
                    {lastSeen ? <span className="text-muted"> · {lastSeen}</span> : null}
                  </span>
                  {r.linkable ? (
                    <a
                      href={`/route-planner/${r.departure_airport}/${r.arrival_airport}`}
                      className="text-accent hover:underline text-xs whitespace-nowrap"
                    >
                      Plan this route →
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {flight.siblings.length > 0 && flight.routes[0] && (
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            Other flights on {flight.routes[0].departure_airport}–{flight.routes[0].arrival_airport}
          </h2>
          <div className="flex flex-wrap gap-2">
            {flight.siblings.map((s) => (
              <a
                key={s}
                href={`/check-flight/${s}`}
                className="font-mono text-sm px-2.5 py-1 rounded border border-subtle bg-surface-elevated text-secondary hover:border-accent hover:text-accent transition-colors"
              >
                {s}
              </a>
            ))}
          </div>
          <p className="text-xs text-muted mt-3">
            Same route, different schedules — each flight number has its own aircraft history and
            Starlink record.
          </p>
        </div>
      )}

      {hasHistory && (
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            {fn} Starlink history
          </h2>
          <div className="text-sm text-muted leading-relaxed space-y-2">
            {flight.observedTotal > 0 && (
              <p>
                Starlink-equipped aircraft on{" "}
                <span className="text-secondary font-mono">
                  {flight.observedStarlink} of {flight.observedTotal}
                </span>{" "}
                recently verified {fn} departures.
              </p>
            )}
            {flight.lastStarlink && (
              <p>
                Most recent Starlink-equipped departure:{" "}
                <span className="text-secondary font-mono">
                  {fmtDay(flight.lastStarlink.checked_at)}
                </span>{" "}
                on <span className="text-secondary font-mono">{flight.lastStarlink.tail}</span>.
              </p>
            )}
            {flight.aircraftTypes.length > 0 && (
              <p>
                Aircraft recently seen on {fn}:{" "}
                <span className="text-secondary">
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
                </span>
                .
              </p>
            )}
          </div>
        </div>
      )}

      {flight.upcoming.length > 0 && (
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            Upcoming {fn} departures
          </h2>
          <div className="space-y-2">
            {flight.upcoming.map((u) => (
              <div
                key={`${u.tail_number}-${u.departure_time}`}
                className="flex items-center justify-between gap-3 text-sm font-mono"
              >
                <span className="text-secondary">
                  {u.departure_airport} → {u.arrival_airport}
                  <span className="text-muted"> · {fmtDeparture(u.departure_time)}</span>
                  <span className="text-muted hidden sm:inline">
                    {" "}
                    · {u.tail_number}
                    {u.aircraft_type ? ` (${u.aircraft_type})` : ""}
                  </span>
                </span>
                <span
                  className={`text-xs whitespace-nowrap ${u.starlink ? "text-green-400" : "text-muted"}`}
                >
                  {u.starlink ? "✓ Starlink" : u.wifiLabel}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted mt-3">
            Aircraft assignments can swap up to departure — check your exact date above.
          </p>
        </div>
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
    <div className="bg-surface-elevated border border-subtle rounded p-4 mb-4">
      <p className="text-sm text-secondary">
        {invalid.reason === "other-carrier"
          ? `${quoted} isn't ${article(shortName)} ${shortName} flight number — this tracker only covers ${shortName} flights.`
          : `${quoted} isn't a flight number.`}
      </p>
      <p className="text-sm text-muted mt-1">
        Flight numbers look like <span className="font-mono text-secondary">{example}</span> — a
        two-letter airline code followed by 1–4 digits. Try again below.
      </p>
      {invalid.airportHint && showRoutePlanner && (
        <p className="text-sm text-muted mt-2">
          Looking for an airport or a route instead? Try the{" "}
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
  popular = [],
  pageLinks,
}: CheckFlightPageProps) {
  const cfg = siteAirline(site);
  const airlineName = flight?.airlineName ?? cfg.name;
  const homeTitle = site.brand.title;
  const host = site.canonicalHost;
  const flightExample = flight?.flightNumber ?? `${cfg.iata}123`;
  const shortName = cfg.shortName;
  const showChromeExtension = site.features.chromeExtension;
  const liveTvRules = site.features.liveTvPage
    ? {
        patterns: aircraftFamilyPatterns(),
        likely: SEATBACK_LIVE_TV_LIKELY_FAMILIES,
        copy: SEATBACK_LIVE_TV_COPY,
      }
    : null;
  const accuracyCopy =
    cfg.verifierBackend === "united"
      ? "We verify Starlink status against united.com and cross-reference with flight schedules from aviation data providers."
      : cfg.verifierBackend === "alaska-json"
        ? `We cross-reference ${shortName}'s own status data, public fleet data, and observed aircraft assignments.`
        : "We cross-reference public fleet data, rollout updates, and observed aircraft assignments.";
  const faqSubject = flight ? flight.flightNumber : `my ${shortName} flight`;
  const faqAnswer = flight
    ? `Pick your travel date in the form above. Within ~2 days of departure the answer comes from the actual aircraft assigned to ${flight.flightNumber}; further out it's a probability from this flight number's recent aircraft history.`
    : `Enter your flight number (for example ${flightExample}) and travel date in the form above. The tool checks our database of Starlink-equipped aircraft against the scheduled aircraft for that flight.`;
  const extensionAnswer = showChromeExtension
    ? "Use this page to check by flight number, search by tail number on the main tracker, or install the free Chrome extension to see Starlink badges directly on Google Flights."
    : "Use this page to check by flight number, or search by tail number on the main tracker.";

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            {invalid
              ? "That Doesn't Look Like a Flight Number"
              : flight
                ? `Does ${flight.flightNumber} Have Starlink WiFi?`
                : `Check If Your ${airlineName} Flight Has Starlink WiFi`}
          </h1>
        </a>
        <p className="text-base text-secondary font-display">
          {invalid
            ? `Enter ${article(shortName)} ${shortName} flight number below to check for Starlink`
            : flight
              ? flightSummary(flight)
              : "Enter your flight number and date to see if your aircraft has free Starlink internet"}
        </p>
      </header>

      <div className="relative max-w-xl mx-auto w-full mb-10">
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-4">
            Check by flight number
          </h2>
          {invalid && (
            <InvalidQueryNotice
              invalid={invalid}
              example={flightExample}
              shortName={shortName}
              showRoutePlanner={site.features.routePlannerPage}
            />
          )}
          <form id="check-flight-form" className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label
                  htmlFor="flight-number"
                  className="block text-xs font-mono text-muted mb-1 uppercase tracking-wider"
                >
                  Flight Number
                </label>
                <input
                  type="text"
                  id="flight-number"
                  name="flight_number"
                  placeholder={flightExample}
                  className="w-full bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
                  required
                />
              </div>
              <div className="flex-1">
                <label
                  htmlFor="flight-date"
                  className="block text-xs font-mono text-muted mb-1 uppercase tracking-wider"
                >
                  Date
                </label>
                <input
                  type="date"
                  id="flight-date"
                  name="date"
                  className="w-full bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
                  required
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full bg-accent/20 border border-accent text-accent font-display font-semibold py-2 px-4 rounded hover:bg-accent/30 transition-colors cursor-pointer"
            >
              Check Flight
            </button>
          </form>

          <div id="flight-result" className="mt-4 hidden" />

          {site.features.intentPages && (
            <p className="text-xs text-muted mt-4">
              New here?{" "}
              <a href="/how-to-check" className="text-accent hover:underline">
                How the check works
              </a>{" "}
              — and yes,{" "}
              <a href="/is-starlink-free" className="text-accent hover:underline">
                Starlink WiFi is free
              </a>
              .
            </p>
          )}
        </div>
      </div>

      <div className="relative max-w-xl mx-auto w-full mb-10 space-y-6">
        {flight && <FlightFactBlocks flight={flight} />}
        {!flight && popular.length > 0 && (
          <PopularFlightsLinks flights={popular} airlineName={cfg.name} />
        )}
        {flight && site.features.fleetPage && (
          <p className="text-sm text-muted text-center">
            See where the {airlineName} rollout stands across every aircraft on the{" "}
            <a href="/fleet" className="text-accent hover:underline">
              fleet page
            </a>
            .
          </p>
        )}
        <div className="bg-surface rounded-lg border border-subtle p-6">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            Check by tail number
          </h2>
          <p className="text-sm text-muted leading-relaxed">
            If you know your aircraft's tail number (found on your boarding pass or the aircraft
            fuselage), search for it on the{" "}
            <a href="/" className="text-accent hover:underline">
              homepage tracker
            </a>
            . The search bar filters all Starlink-equipped aircraft instantly.
          </p>
        </div>

        {showChromeExtension && (
          <div className="bg-surface rounded-lg border border-subtle p-6">
            <h2 className="font-display text-lg font-semibold text-primary mb-3">
              Use the Chrome extension
            </h2>
            <p className="text-sm text-muted leading-relaxed mb-3">
              Install the free Chrome extension to see Starlink badges directly on Google Flights
              while you search for {shortName} flights. No extra steps needed.
            </p>
            <a
              href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-accent hover:underline"
            >
              <svg
                className="w-4 h-4"
                viewBox="0 0 48 48"
                fill="none"
                role="img"
                aria-label="Chrome"
              >
                <circle cx="24" cy="24" r="22" fill="#4285F4" />
                <circle cx="24" cy="24" r="9" fill="white" />
                <circle cx="24" cy="24" r="4" fill="#4285F4" />
              </svg>
              Add to Chrome — Free
            </a>
          </div>
        )}
      </div>

      <div className="relative max-w-xl mx-auto w-full mb-12">
        <div className="bg-surface rounded-lg border border-subtle p-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3 px-2">FAQ</h2>
          <div className="space-y-0 divide-y divide-subtle">
            <details className="group py-4 px-2">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                  How do I check if {faqSubject} has Starlink?
                </h3>
                <svg
                  className="w-4 h-4 text-muted group-open:rotate-45 transition-transform ml-4 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  role="img"
                  aria-label="Expand"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p>{faqAnswer}</p>
              </div>
            </details>
            <details className="group py-4 px-2">
              <summary className="cursor-pointer list-none flex items-start justify-between">
                <h3 className="font-display text-base font-medium text-secondary group-hover:text-accent transition-colors">
                  Is this information accurate?
                </h3>
                <svg
                  className="w-4 h-4 text-muted group-open:rotate-45 transition-transform ml-4 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  role="img"
                  aria-label="Expand"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
              </summary>
              <div className="mt-3 text-sm text-muted leading-relaxed">
                <p>
                  {accuracyCopy} Aircraft assignments can change, so check closer to your departure
                  date for the most accurate results.
                </p>
              </div>
            </details>
          </div>
        </div>
      </div>

      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {homeTitle}
        </a>
      </div>

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm">
        <a
          href="https://x.com/martinamps"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-secondary hover:text-primary transition-colors"
        >
          Built with
          <svg
            className="w-4 h-4 mx-1 text-red-400"
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="0"
            aria-label="Heart"
            role="img"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
          by @martinamps
        </a>
        <PageNavLinks links={pageLinks} />
      </footer>

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD from server data; flight number is regex-validated
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: homeTitle,
                item: `https://${host}/`,
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Check Flight",
                item: `https://${host}/check-flight`,
              },
              ...(flight
                ? [
                    {
                      "@type": "ListItem",
                      position: 3,
                      name: flight.flightNumber,
                      item: `https://${host}/check-flight/${flight.flightNumber}`,
                    },
                  ]
                : []),
            ],
          }),
        }}
      />

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD from server data; flight number is regex-validated
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: `How do I check if ${faqSubject} has Starlink?`,
                acceptedAnswer: {
                  "@type": "Answer",
                  text: faqAnswer,
                },
              },
              {
                "@type": "Question",
                name: `How do I know if my ${shortName} flight has Starlink WiFi?`,
                acceptedAnswer: {
                  "@type": "Answer",
                  text: extensionAnswer,
                },
              },
            ],
          }),
        }}
      />

      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{
          __html: `
        document.addEventListener('DOMContentLoaded', function() {
          var form = document.getElementById('check-flight-form');
          var resultDiv = document.getElementById('flight-result');
          var dateInput = document.getElementById('flight-date');
          var carrierPrefix = ${JSON.stringify(cfg.iata)};
          var liveTv = ${JSON.stringify(liveTvRules).replace(/</g, "\\u003c")};
          // Mirrors seatbackLiveTv() in aircraft-specs.ts, fed the server's own
          // family patterns so the two classifiers cannot drift apart.
          var liveTvLine = function(flight, esc) {
            if (!liveTv) return '';
            var tier = 'no';
            if (flight.fleet_type === 'mainline') {
              var family = 'other';
              for (var i = 0; i < liveTv.patterns.length; i++) {
                if (new RegExp(liveTv.patterns[i][0], liveTv.patterns[i][1]).test(flight.aircraft_type || '')) { family = liveTv.patterns[i][2]; break; }
              }
              tier = liveTv.likely.indexOf(family) >= 0 ? 'likely' : 'possible';
            }
            return '<div class="pt-2">' + esc(liveTv.copy[tier]) + ' <a href="/live-tv" class="text-accent hover:underline">Which planes have live TV →</a></div>';
          };
          var WATCH_ENABLED = ${JSON.stringify(watchFeedEnabled(site))};
          var ROUTE_PLANNER_ENABLED = ${JSON.stringify(site.features.routePlannerPage)};
          var WATCH_MAX_DAYS_OUT = 330;

          var escHtml = function(s) { var d = document.createElement('div'); d.textContent = String(s || ''); return d.innerHTML; };
          // verified_wifi 'None' means no WiFi installed; it is never a provider name.
          var wifiLabel = function(v) {
            return (!v || !String(v).trim() || /^none$/i.test(String(v).trim())) ? 'no WiFi' : escHtml(v) + ' WiFi (not Starlink)';
          };
          // Departure times read in the departure airport's zone, like a
          // boarding pass; the viewer's zone only when the airport is unmapped.
          var airportZones = ${AIRPORT_ZONES_INLINE};
          var airportTz = {};
          Object.keys(airportZones).forEach(function(zone) {
            var codes = airportZones[zone];
            for (var i = 0; i < codes.length; i += 3) airportTz[codes.slice(i, i + 3)] = zone;
          });
          var zoneFor = function(airport) {
            var code = String(airport || '').toUpperCase();
            if (code.length === 4 && (code[0] === 'K' || code[0] === 'C')) code = code.slice(1);
            return airportTz[code];
          };
          var localTime = function(unix, airport) {
            var opts = { hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' };
            var zone = zoneFor(airport);
            if (zone) opts.timeZone = zone;
            return new Date(unix * 1000).toLocaleTimeString('en-US', opts);
          };
          var localDay = function(unix, airport) {
            var opts = { month: 'short', day: 'numeric' };
            var zone = zoneFor(airport);
            if (zone) opts.timeZone = zone;
            return new Date(unix * 1000).toLocaleDateString('en-US', opts);
          };
          var alternativesHtml = function(list, date, origin) {
            if (!list || !list.length) return '';
            return '<div class="mt-3"><div class="text-xs font-mono text-muted mb-1 uppercase tracking-wider">Starlink flights on this route that day</div>' +
              '<ul class="text-sm text-muted font-mono space-y-1">' +
              list.map(function(a) {
                return '<li><a href="/check-flight/' + encodeURIComponent(a.flight_number) + '/' + encodeURIComponent(date) + '" class="text-accent hover:underline">' + escHtml(a.flight_number) + '</a> ' +
                  escHtml(localTime(a.departure_time, origin)) + ' <span class="text-secondary">' + escHtml(a.tail_number) + (a.aircraft_type ? ' (' + escHtml(a.aircraft_type) + ')' : '') + '</span></li>';
              }).join('') +
              '</ul></div>';
          };
          var routePlannerCta = function(origin, destination) {
            var o = String(origin || '').toUpperCase();
            var d = String(destination || '').toUpperCase();
            if (!ROUTE_PLANNER_ENABLED || !/^[A-Z]{3}$/.test(o) || !/^[A-Z]{3}$/.test(d)) return '';
            return '<p class="text-sm mt-3"><a href="/route-planner/' + o + '/' + d + '" rel="nofollow" class="text-accent hover:underline">Find Starlink flights ' + o + ' → ' + d + ' →</a></p>';
          };
          var watchRow = function(fn, date) {
            if (!WATCH_ENABLED) return '';
            var daysOut = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86400000);
            if (!(daysOut >= -1 && daysOut <= WATCH_MAX_DAYS_OUT)) return '';
            var path = '/cal/' + encodeURIComponent(fn) + '/' + encodeURIComponent(date) + '.ics';
            var webcal = 'webcal://' + window.location.host + path;
            var google = 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal);
            return '<div class="mt-4 pt-4 border-t border-subtle">' +
              '<div class="flex items-center gap-2 mb-2"><span class="font-display font-semibold text-secondary">Watch this flight</span></div>' +
              '<div class="flex flex-wrap gap-3 text-sm">' +
              '<a href="' + webcal + '" data-watch="webcal" class="text-accent hover:underline">Apple / Outlook</a>' +
              '<a href="' + google + '" data-watch="google" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">Google Calendar</a>' +
              '<a href="' + path + '" data-watch="ics" download class="text-accent hover:underline">Download .ics</a>' +
              '</div>' +
              '<p class="text-xs text-muted mt-2">A calendar event that updates itself as the aircraft is assigned or swapped. Apple refreshes about hourly, Google every 8–24 hours.</p>' +
              '</div>';
          };

          var pathParts = window.location.pathname.split('/').filter(Boolean);
          var urlFlight = pathParts.length >= 2 ? decodeURIComponent(pathParts[1]) : null;
          var urlDate = pathParts.length >= 3 ? decodeURIComponent(pathParts[2]) : null;

          if (dateInput) {
            // en-CA formats the user's LOCAL date as YYYY-MM-DD; toISOString()
            // is the UTC day, which pre-fills tomorrow for evening US users.
            dateInput.value = urlDate || new Date().toLocaleDateString('en-CA');
          }
          if (urlFlight && document.getElementById('flight-number')) {
            document.getElementById('flight-number').value = urlFlight.toUpperCase();
          }

          if (form) {
            var runCheck = function() {
              var flightNumber = document.getElementById('flight-number').value.trim();
              var date = document.getElementById('flight-date').value;

              if (!flightNumber || !date) return;

              // Same separators canonicalFlightInput strips ("UA 544", "ua-544")
              // so the permalink is the canonical spelling too.
              flightNumber = flightNumber.toUpperCase().replace(/[\\s\\-.]/g, '');
              if (/^\\d+$/.test(flightNumber)) {
                flightNumber = carrierPrefix + flightNumber;
              }

              var newUrl = '/check-flight/' + encodeURIComponent(flightNumber) + '/' + encodeURIComponent(date);
              history.replaceState(null, '', newUrl);

              resultDiv.className = 'mt-4';
              resultDiv.innerHTML = '<div class="text-sm text-muted font-mono">Checking...</div>';

              fetch('/api/check-flight?flight_number=' + encodeURIComponent(flightNumber) + '&date=' + encodeURIComponent(date))
                .then(function(res) { return res.json(); })
                .then(function(data) {
                  var esc = escHtml;
                  if (data.hasStarlink) {
                    var flight = data.flights[0] || {};
                    var depTime = flight.departure_time ? new Date(flight.departure_time * 1000) : null;
                    var timeStr = depTime ? localTime(flight.departure_time, flight.departure_airport) : 'TBD';
                    var dateStr = depTime ? localDay(flight.departure_time, flight.departure_airport) : date;
                    var displayFlight = flight.ua_flight_number || flight.flight_number || flightNumber;
                    var aircraftInfo = flight.aircraft_type ? ' (' + flight.aircraft_type + ')' : '';
                    var dep = (flight.departure_airport || '').replace(/^K/, '');
                    var arr = (flight.arrival_airport || '').replace(/^K/, '');
                    var utcDate = depTime ? depTime.toISOString().slice(0, 10).replace(/-/g, '') : date.replace(/-/g, '');
                    var depIcao = dep.length === 3 ? 'K' + dep : dep;
                    var arrIcao = arr.length === 3 ? 'K' + arr : arr;
                    var faUrl = flight.flight_number
                      ? 'https://www.flightaware.com/live/flight/' + flight.flight_number + '/history/' + utcDate + '/' + depIcao + '/' + arrIcao
                      : 'https://www.flightaware.com';
                    resultDiv.innerHTML = '<div class="bg-green-900/30 border border-green-700/50 rounded p-4">' +
                      '<div class="flex items-center gap-2 mb-2">' +
                      '<span class="text-green-400 text-lg">&#10003;</span>' +
                      '<span class="font-display font-semibold text-green-400">This flight has Starlink WiFi!</span>' +
                      '</div>' +
                      '<div class="text-sm text-muted font-mono space-y-1">' +
                      '<div>Flight: <span class="text-secondary">' + displayFlight + '</span>' + (dep && arr ? ' <span class="text-muted">(' + dep + ' → ' + arr + ')</span>' : '') + '</div>' +
                      '<div>Departs: <span class="text-secondary">' + dateStr + ' at ' + timeStr + '</span></div>' +
                      '<div>Aircraft: <span class="text-secondary">' + (flight.tail_number || '') + aircraftInfo + '</span></div>' +
                      (flight.operated_by ? '<div>Operated by: <span class="text-secondary">' + flight.operated_by + '</span></div>' : '') +
                      liveTvLine(flight, esc) +
                      '<div class="pt-2"><a href="' + faUrl + '" target="_blank" rel="nofollow noopener noreferrer" class="text-accent hover:underline text-xs">View on FlightAware →</a></div>' +
                      '</div></div>';
                  } else if (data.fallback && data.fallback.segments && data.fallback.segments.length > 0) {
                    var segs = data.fallback.segments;
                    // Only a segment the API marked hasStarlink === false earns the
                    // firm verdict; unknown tails are not a "no".
                    var firmNo = segs.every(function(s) { return s.hasStarlink === false; });
                    var segHtml = segs.map(function(seg) {
                      var age = seg.verified_at ? Math.floor((Date.now()/1000 - seg.verified_at) / 86400) : null;
                      var ageStr = age !== null ? ' ' + age + ' day' + (age === 1 ? '' : 's') + ' ago' : '';
                      var model = seg.aircraft_model ? ' (' + esc(seg.aircraft_model) + ')' : '';
                      var leg = seg.origin && seg.destination ? ' <span class="text-muted">(' + esc(seg.origin) + ' → ' + esc(seg.destination) + ')</span>' : '';
                      var status = seg.hasStarlink === false
                        ? 'Verified <span class="text-secondary">' + wifiLabel(seg.verified_wifi) + '</span>' + ageStr + '.'
                        : 'WiFi on this aircraft is not verified yet.';
                      var note = (age !== null && age > 7)
                        ? ' Retrofits happen mid-cycle — if you see Starlink onboard, we have flagged this plane for re-check.'
                        : '';
                      return '<div class="text-sm text-muted font-mono space-y-1">' +
                        '<div>Aircraft: <span class="text-secondary">' + esc(seg.tail_number) + model + '</span>' + leg + '</div>' +
                        '<p class="text-sm text-muted">' + status + note + '</p>' +
                        '</div>';
                    }).join('');
                    var first = segs[0];
                    resultDiv.innerHTML = '<div class="bg-surface-elevated border border-subtle rounded p-4">' +
                      (firmNo
                        ? '<div class="flex items-center gap-2 mb-2">' +
                          '<span class="text-muted text-lg">&#10007;</span>' +
                          '<span class="font-display font-semibold text-secondary">No Starlink on this flight</span>' +
                          '</div>'
                        : '<div class="font-display font-semibold text-secondary mb-2">Assigned aircraft</div>') +
                      '<div class="space-y-2">' + segHtml + '</div>' +
                      '<p class="text-sm text-muted mt-2">Aircraft swaps can happen; re-check closer to departure.</p>' +
                      alternativesHtml(data.sameDayAlternatives, date, first.origin) +
                      routePlannerCta(first.origin, first.destination) +
                      '</div>';
                  } else if (data.confidence === 'verified' && data.hasStarlink === false) {
                    // scheduled_no: a firm verified-no with no fallback segments.
                    // Estimating a probability against it would contradict the
                    // verified answer the API just returned.
                    resultDiv.innerHTML = '<div class="bg-surface-elevated border border-subtle rounded p-4">' +
                      '<div class="flex items-center gap-2 mb-2">' +
                      '<span class="text-muted text-lg">&#10007;</span>' +
                      '<span class="font-display font-semibold text-secondary">No Starlink on this flight</span>' +
                      '</div>' +
                      '<p class="text-sm text-muted">' + esc(data.message || data.reason || 'The assigned aircraft is verified as non-Starlink WiFi.') + '</p>' +
                      alternativesHtml(data.sameDayAlternatives, date, ((data.flights || [])[0] || {}).departure_airport) +
                      '</div>';
                  } else {
                    var pred = data.prediction;
                    if (!pred || typeof pred.probability !== 'number') {
                      // Answers without a prediction carry their explanation as
                      // message (no_model), reason (qatar) or error (400s).
                      resultDiv.innerHTML = '<div class="bg-surface-elevated border border-subtle rounded p-4">' +
                        '<p class="text-sm text-muted">' + esc(data.message || data.reason || data.error || 'No per-flight prediction available — Starlink status depends on the scheduled aircraft type.') + '</p>' +
                        '</div>';
                    } else {
                      var daysOut = (new Date(date + 'T00:00:00Z').getTime() - Date.now()) / 86400000;
                      var timingNote = daysOut > 2
                        ? 'Aircraft assignments firm up ~2 days before departure — check back then for a confirmed answer.'
                        : daysOut >= -1
                        ? 'No live tail assignment found — the flight may have an equipment swap in progress, or this flight number may be a codeshare.'
                        : 'This date is in the past — we do not retain historical assignments.';
                      var pct = Math.round(pred.probability * 100);
                      var isLikely = pct >= 70;
                      var isPossible = pct >= 40 && pct < 70;
                      var label = isLikely ? 'Likely' : isPossible ? 'Possible' : 'Unlikely';
                      var barColor = isLikely ? 'bg-green-500' : isPossible ? 'bg-yellow-500' : 'bg-surface-elevated';
                      var borderColor = isLikely ? 'border-green-700/50 bg-green-900/20' : isPossible ? 'border-yellow-700/50 bg-yellow-900/20' : 'border-subtle bg-surface-elevated';
                      var iconColor = isLikely ? 'text-green-400' : isPossible ? 'text-yellow-400' : 'text-muted';
                      var detail = pred.n_observations > 0
                        ? 'Based on <span class="text-secondary">' + pred.n_observations + '</span> historical observation' + (pred.n_observations === 1 ? '' : 's') + ' of aircraft on this flight number (' + pred.confidence + ' confidence).'
                        : 'No history for this flight number — this is our estimate for flights we have not yet seen on a Starlink aircraft.';
                      resultDiv.innerHTML = '<div class="rounded p-4 border ' + borderColor + '">' +
                        '<div class="flex items-center gap-2 mb-3">' +
                        '<span class="text-lg ' + iconColor + '">~</span>' +
                        '<span class="font-display font-semibold ' + iconColor + '">' + label + ' — estimated ' + pct + '% chance of Starlink</span>' +
                        '</div>' +
                        '<div class="mb-3"><div class="w-full bg-base rounded-full h-2 overflow-hidden"><div class="' + barColor + ' h-2 rounded-full" style="width: ' + pct + '%"></div></div></div>' +
                        '<p class="text-xs text-muted leading-relaxed">' + detail + ' ' + timingNote + '</p>' +
                        '</div>';
                    }
                  }
                  if (!data.error) resultDiv.insertAdjacentHTML('beforeend', watchRow(flightNumber, date));
                })
                .catch(function() {
                  resultDiv.innerHTML = '<div class="text-sm text-red-400">Error checking flight. Please try again.</div>';
                });
            };

            resultDiv.addEventListener('click', function(e) {
              var link = e.target && e.target.closest ? e.target.closest('[data-watch]') : null;
              if (link && window.plausible) {
                window.plausible('Watch', { props: { client: link.getAttribute('data-watch') } });
              }
            });

            form.addEventListener('submit', function(e) {
              e.preventDefault();
              runCheck();
            });

            if (urlFlight && urlDate) {
              runCheck();
            }
          }
        });
      `,
        }}
      />
    </div>
  );
}
