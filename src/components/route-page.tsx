import type { SiteConfig } from "../airlines/registry";
import type { RouteFlightBoard } from "../api/route-flights";
import type { Link } from "./layout";
import { Chip, LINK, PageHeader, PageShell, Section } from "./layout";
import { RouteFlightsSection } from "./route-flights";

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
  pageLinks?: Link[];
  currentPath?: string;
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
  pageLinks,
  currentPath,
}: RoutePageProps) {
  const plannerHref = `/route-planner?origin=${origin}&destination=${destination}`;
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader title={`Which ${origin} to ${destination} flights have Starlink?`} />

      <RouteFlightsSection
        board={board}
        path={`/route-planner/${origin}/${destination}`}
        plannerHref={plannerHref}
      />

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
        </p>
      </section>
    </PageShell>
  );
}
