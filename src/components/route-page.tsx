import type { SiteConfig } from "../airlines/registry";
import type { RouteFlightBoard } from "../api/route-flights";
import type { Link } from "./layout";
import { LINK, PageHeader, PageShell } from "./layout";
import { RouteFlightsSection } from "./route-flights";

interface RoutePageProps {
  site: SiteConfig;
  origin: string;
  destination: string;
  /** Every nonstop on the pair with its odds and next assigned plane. */
  board: RouteFlightBoard;
  /** The server's routeHasData answer for destination→origin; the reverse-leg
   * link renders only when that page serves. */
  reverseLinkable?: boolean;
  pageLinks?: Link[];
  currentPath?: string;
}

/** /route-planner/{origin}/{destination}: the nonstop board, then the way back. */
export default function RoutePage({
  site,
  origin,
  destination,
  board,
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
