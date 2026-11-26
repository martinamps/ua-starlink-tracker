import { type SiteConfig, siteAirline } from "../airlines/registry";
import { clientScriptSrc } from "../client/bundle";
import { ClientScriptTag } from "./layout";
import type { Link } from "./layout";
import { Chip, Eyebrow, PageHeader, PageShell, Panel, SectionTitle, buttonClass } from "./layout";

interface RoutePlannerPageProps {
  site: SiteConfig;
  pageLinks?: Link[];
  currentPath?: string;
  popularRoutes?: Array<{ origin: string; destination: string }>;
}

const BUSY_AIRPORTS = 40;
const AIRPORT_LIST =
  "absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded border border-neutral bg-surface-elevated text-left shadow-lg";

/**
 * A box of the planner's form. As served it takes a code, four characters at
 * most, and that is all it does with no script. The planner's script opens it
 * to city and airport names and fills the list (src/client/airport-picker.ts).
 */
function AirportField({
  id,
  name,
  label,
  placeholder,
}: { id: string; name: string; label: string; placeholder: string }) {
  return (
    <div className="flex-1 w-full min-w-0">
      <Eyebrow as="label" htmlFor={id} className="mb-2 block">
        {label}
      </Eyebrow>
      <div className="relative">
        <input
          type="text"
          id={id}
          name={name}
          placeholder={placeholder}
          maxLength={4}
          className="airport-input w-full bg-base border border-neutral rounded px-3 py-3 text-primary font-mono text-lg focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
          required
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {/* Above the list, so "choose one" is not covered by the choices. */}
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted empty:hidden" />
        <div
          id={`${id}-list`}
          data-label={`${label}: matching airports`}
          className={AIRPORT_LIST}
          hidden
        />
      </div>
    </div>
  );
}

export default function RoutePlannerPage({
  site,
  pageLinks,
  currentPath,
  popularRoutes = [],
}: RoutePlannerPageProps) {
  const cfg = siteAirline(site);
  const airlineName = cfg.name;
  const shortName = cfg.shortName;
  // The airports this airline's popular routes touch most, busiest first: a
  // city with several airports offers the one it flies from before the rest.
  const touches = new Map<string, number>();
  for (const r of popularRoutes) {
    for (const code of [r.origin, r.destination]) touches.set(code, (touches.get(code) ?? 0) + 1);
  }
  const busyAirports = [...touches]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, BUSY_AIRPORTS)
    .map(([code]) => code);

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title="Find the flights most likely to have Starlink"
        dek={<>Search {airlineName} nonstops and connections between any two airports.</>}
      />

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <Panel className="glow-accent">
          <form
            id="route-form"
            className="space-y-4"
            data-picker-src={clientScriptSrc("airport-picker") ?? undefined}
            data-busy-airports={busyAirports.join(" ") || undefined}
          >
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <AirportField id="origin" name="origin" label="From" placeholder="SFO" />

              <div className="hidden sm:flex items-center pt-11 text-muted">
                <svg
                  width="32"
                  height="12"
                  viewBox="0 0 32 12"
                  fill="none"
                  role="img"
                  aria-label="to"
                >
                  <path d="M0 6h28M24 2l6 4-6 4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>

              <AirportField id="destination" name="destination" label="To" placeholder="JAX" />
            </div>
            <div id="airport-status" role="status" className="sr-only" />
            <div>
              <Eyebrow as="label" htmlFor="travel-date" className="mb-2 block">
                Date
              </Eyebrow>
              <input
                type="date"
                id="travel-date"
                name="date"
                className="w-full bg-base border border-neutral rounded px-3 py-2 text-primary focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <button type="submit" className={`${buttonClass("primary", "lg")} w-full`}>
              Find flights
            </button>
          </form>
          <p className="text-xs text-muted mt-3 text-center">
            Nonstops first, then connections by Starlink odds.
          </p>
        </Panel>
      </div>

      <section
        id="route-flights"
        aria-live="polite"
        className="relative max-w-3xl mx-auto w-full empty:hidden"
      />
      <div id="route-results" className="relative max-w-3xl mx-auto w-full mb-10" />

      <div className="relative max-w-2xl mx-auto w-full mb-10">
        <Panel>
          <SectionTitle className="mb-3">How it works</SectionTitle>
          <div className="space-y-3 text-sm text-secondary leading-relaxed">
            <p>
              Odds come from which aircraft each {shortName} flight has used recently. A connection
              can beat the nonstop when the nonstop usually gets an aircraft without Starlink.
            </p>
            <p>
              Aircraft can change.{" "}
              <a href="/check-flight" className="text-accent hover:underline">
                Check your flight
              </a>{" "}
              1–2 days out to confirm.
            </p>
          </div>
        </Panel>
      </div>

      {popularRoutes.length > 0 && (
        <section className="relative w-full max-w-4xl mx-auto mb-8">
          <Panel>
            <SectionTitle className="mb-3">Popular Starlink routes</SectionTitle>
            <div className="flex flex-wrap gap-2">
              {popularRoutes.map((r) => (
                <Chip
                  key={`${r.origin}-${r.destination}`}
                  href={`/route-planner/${r.origin}/${r.destination}`}
                >
                  {r.origin} → {r.destination}
                </Chip>
              ))}
            </div>
          </Panel>
        </section>
      )}

      <ClientScriptTag name="route-planner" />
    </PageShell>
  );
}
