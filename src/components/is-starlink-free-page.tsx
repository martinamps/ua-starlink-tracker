import { type SiteConfig, siteAirline } from "../airlines/registry";
import { FlightSearchForm } from "./flight-search-form";
import type { Link } from "./layout";
import { PageHeader, PageShell, Section, StatInline } from "./layout";

/** The airline-specific access story. Kept per-airline (like methodology's
 * SOURCES) because "free" has different fine print per carrier — the handler
 * 404s airlines without an entry rather than guessing. */
interface FreeAccess {
  /** One-sentence direct answer, honest fine print included. */
  answer: string;
  /** How you connect on board. */
  access: string;
}

const ACCESS: Record<string, FreeAccess> = {
  UA: {
    answer:
      "Yes. United Starlink Wi-Fi is free for MileagePlus members, and joining MileagePlus is free.",
    access:
      "On board, connect to the Wi-Fi network and sign in with your MileagePlus number, or join on the spot. You don't need to buy anything or have status.",
  },
};

export function hasFreeAnswer(code: string): boolean {
  return code in ACCESS;
}

/** The same sentence llms.txt hands agents, so the human-facing page and the
 * agent-facing contract can't disagree on the sign-in fine print. */
export function freeAccessAnswer(code: string): string | null {
  return ACCESS[code]?.answer ?? null;
}

interface IsStarlinkFreePageProps {
  site: SiteConfig;
  starlinkCount: number;
  totalCount: number;
  pageLinks?: Link[];
  currentPath?: string;
}

export default function IsStarlinkFreePage({
  site,
  starlinkCount,
  totalCount,
  pageLinks,
  currentPath,
}: IsStarlinkFreePageProps) {
  const cfg = siteAirline(site);
  const copy = ACCESS[cfg.code];
  const short = cfg.shortName;

  // No FAQPage JSON-LD here on purpose. Its questions had no visible Q&A on the
  // page (Google requires markup to match rendered content), and its lead
  // question duplicated the homepage FAQ's verbatim — two competing FAQPage
  // entities for one question. The page's own answer copy is the answer; the
  // WebPage JSON-LD renderSubPage emits already describes it.
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader title={`Is ${short} Starlink Wi-Fi free?`} dek={copy.answer} />

      <Section title="How to connect">
        <p className="text-sm leading-relaxed text-secondary">{copy.access}</p>
      </Section>

      {/* Speed claims stay qualitative: nothing here is cited to a measured
          figure, and published speed tests vary too much by flight to quote. */}
      <Section title="What you get">
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-secondary">
          <li>Fast enough for streaming and video calls on most flights.</li>
          <li>Coverage over oceans and remote areas, where ground-based systems drop out.</li>
          <li>The same service for every passenger, in every cabin.</li>
        </ul>
      </Section>

      <Section title="The catch: it's only on some planes">
        <div className="space-y-3 text-sm leading-relaxed text-secondary">
          <p>
            <StatInline n={starlinkCount} /> of <StatInline n={totalCount} /> {cfg.name} aircraft
            have Starlink today. Most of the rest have an older system, usually slower and often
            paid, and a few have no Wi-Fi.
            {site.features.fleetPage && (
              <>
                {" "}
                The{" "}
                <a href="/fleet" className="text-accent hover:underline">
                  fleet page
                </a>{" "}
                shows every aircraft.
              </>
            )}
          </p>
          <p>
            Whether your flight has it depends on the aircraft.{" "}
            <a href="/check-flight" className="text-accent hover:underline">
              Check your flight
            </a>
            :
          </p>
          {site.features.checkFlightPage && (
            <FlightSearchForm site={site} id="free-flight-search" prefillDate />
          )}
          {site.features.timelinePage && (
            <p>
              See how fast the gap is closing on the{" "}
              <a href="/timeline" className="text-accent hover:underline">
                rollout timeline
              </a>
              .
            </p>
          )}
          {site.features.liveTvPage && (
            <p>
              Live TV on the seatback screen needs more than Starlink.{" "}
              <a href="/live-tv" className="text-accent hover:underline">
                See which planes have it
              </a>
              .
            </p>
          )}
        </div>
      </Section>
    </PageShell>
  );
}
