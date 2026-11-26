import type { SiteConfig } from "../airlines/registry";
import type { RouteFlightBoard } from "../api/route-flights";
import { airportWithCode, routePairLabel } from "../utils/airport-names";
import type { Link } from "./layout";
import { Chip, LINK, PageHeader, PageShell, Section } from "./layout";
import {
  type RouteOutlookView,
  countSentence,
  directionSentence,
  followSentence,
} from "./outlook-copy";
import { RouteFlightsSection } from "./route-flights";
import { fmt, monthYear, pct } from "./ui/format";
import { Meter } from "./ui/meter";

interface RoutePageProps {
  site: SiteConfig;
  origin: string;
  destination: string;
  /** Every nonstop on the pair with its odds and next assigned plane. */
  board: RouteFlightBoard;
  /** Every marketing number seen on the pair, beyond the board's week. */
  flightNumbers?: string[];
  /** The server's routeHasData answer for destination→origin; the reverse-leg
   * link renders only when that page serves. */
  reverseLinkable?: boolean;
  /** The pair's airports whose /routes/{airport} page serves. */
  airportLinks?: string[];
  /** The route's Starlink share by month and its types' install pace; absent
   * where we saw too few departures to state a month. */
  outlook?: RouteOutlookView | null;
  pageLinks?: Link[];
  currentPath?: string;
}

/** Is Starlink getting more common here: each full month's share of the
 * departures we saw, then the pace of the types that fly the route. */
function RouteOutlookSection({ outlook }: { outlook: RouteOutlookView }) {
  const direction = directionSentence(outlook);
  return (
    <Section
      id="trend"
      title="Starlink on this route, month by month"
      dek={`The share of departures we saw on a Starlink aircraft.${direction ? ` ${direction}` : ""}`}
    >
      <ul className="space-y-2 text-sm">
        {outlook.months.map((m) => (
          <li key={m.month} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-secondary">
              {monthYear(m.month)}
              {!m.complete && <span className="block text-xs text-muted">so far</span>}
            </span>
            <Meter
              share={m.share}
              className="flex-1"
              label={`${monthYear(m.month)}: ${pct(m.starlink, m.departures)}`}
            />
            <span className="w-24 shrink-0 text-right text-muted tabular-nums">
              <span className="text-primary">{pct(m.starlink, m.departures)}</span> of{" "}
              {fmt(m.departures)}
            </span>
          </li>
        ))}
      </ul>
      {outlook.types.map((t) => (
        <p key={t.short} className="mt-4 text-sm leading-relaxed text-secondary">
          {t.href ? (
            <a href={t.href} className={LINK}>
              {t.short}
            </a>
          ) : (
            <span className="text-primary">{t.short}</span>
          )}
          {`, ${pct(t.share, 1)} of these departures: `}
          {countSentence(t.outlook, "")} {followSentence(t.outlook, t.airline, t.now)}
        </p>
      ))}
    </Section>
  );
}

/** /route-planner/{origin}/{destination}: the nonstop board, every number
 * flown on the pair, then the way back. */
export default function RoutePage({
  site,
  origin,
  destination,
  board,
  flightNumbers = [],
  reverseLinkable = false,
  airportLinks = [],
  outlook = null,
  pageLinks,
  currentPath,
}: RoutePageProps) {
  // A code stays on its city's line: "Denver (DEN)" never breaks before the bracket.
  const pair = routePairLabel(origin, destination).replaceAll(" (", "\u00a0(");
  const plannerHref = `/route-planner?origin=${origin}&destination=${destination}`;
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader title={`Which ${pair} flights have Starlink?`} />

      <RouteFlightsSection
        board={board}
        path={`/route-planner/${origin}/${destination}`}
        plannerHref={plannerHref}
      />

      {outlook && <RouteOutlookSection outlook={outlook} />}

      {flightNumbers.length > 0 && (
        <Section id="flight-numbers" title="All flight numbers on this route">
          <div className="flex flex-wrap gap-1.5">
            {flightNumbers.map((fn) => (
              <Chip key={fn} size="sm" href={`/check-flight/${fn}`}>
                {fn}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      <section className="relative mx-auto mb-8 w-full max-w-3xl text-center">
        <p className="text-sm text-secondary">
          {reverseLinkable && (
            <>
              <a href={`/route-planner/${destination}/${origin}`} className={LINK}>
                {destination} to {origin}
              </a>
              {" · "}
            </>
          )}
          <a href={plannerHref} className={LINK}>
            Connections
          </a>
          {airportLinks.map((airport) => (
            <span key={airport}>
              {" · "}
              <a href={`/routes/${airport}`} className={LINK}>
                Starlink flights from {airportWithCode(airport)}
              </a>
            </span>
          ))}
        </p>
      </section>
    </PageShell>
  );
}
