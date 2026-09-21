import { AirlineProgressList, RecentInstallsFeed, completeScope } from "../../components/atoms";
import { ClientScriptTag, FlightSearchForm } from "../../components/flight-search-form";
import {
  Chip,
  Eyebrow,
  Panel,
  SectionTitle,
  StatInline,
  buttonClass,
  chipClass,
  fmt,
} from "../../components/layout";
import { SITES, airlineHomeUrl, publicAirlines } from "../registry";
import { AIRLINE_FACTS, type AirlineFactsEntry, type RolloutFactsStatus } from "../rollout-facts";
import type { AirlineContent, HeroProps, HubHomeLinks } from "./index";

const LINK = "text-accent hover:underline";

// The hub answers cross-airline questions; United-specific intent belongs to
// the United tracker, so every United mention here links there.
const UNITED_URL = airlineHomeUrl("UA");
const UNITED_HOST = new URL(UNITED_URL).host;

function namesWith(status: RolloutFactsStatus): string[] {
  return AIRLINE_FACTS.filter((e: AirlineFactsEntry) => e.status === status).map((e) => {
    const scope = status === "complete" ? completeScope(e.trackedCode) : undefined;
    return scope ? `${e.shortName} (${scope})` : e.shortName;
  });
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const FLYING_COUNT = AIRLINE_FACTS.filter(
  (e) => e.status === "installing" || e.status === "complete"
).length;

/** Crawlable inlinks to the hub's own URL families: most of its sitemap URLs
 * were discovered but never crawled while the homepage linked only /airlines. */
function HubLinkGrid({ links }: { links?: HubHomeLinks }) {
  if (!links || (links.airlines.length === 0 && links.compares.length === 0)) return null;
  return (
    <Panel as="nav" aria-label="Airlines">
      {links.airlines.length > 0 && (
        <>
          <Eyebrow as="h2">Airlines with Starlink</Eyebrow>
          <div className="flex flex-wrap gap-2">
            {links.airlines.map((l) => (
              <Chip key={l.href} href={l.href} size="sm">
                {l.label}
              </Chip>
            ))}
          </div>
        </>
      )}
      {links.compares.length > 0 && (
        <>
          <Eyebrow as="h2" className="mt-4 mb-3">
            Compare
          </Eyebrow>
          <div className="flex flex-wrap gap-2">
            {links.compares.map((l) => (
              <Chip key={l.href} href={l.href} size="sm">
                {l.label}
              </Chip>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// Preset chips: pick city pairs that exercise the comparison — mainland routes
// with UA-vs-AS overlap, plus one Hawai'i route where HA is the answer.
const PRESET_ROUTES: { o: string; d: string }[] = [
  { o: "SEA", d: "SFO" },
  { o: "DEN", d: "SAN" },
  { o: "SFO", d: "HNL" },
];

function RouteComparePanel() {
  return (
    <Panel>
      <Eyebrow className="mb-1">Starlink odds by airline</Eyebrow>
      <div className="text-xs font-mono text-muted leading-relaxed mb-3">
        Share of each carrier's planes on this nonstop route that have Starlink today.
      </div>
      <form id="hub-compare-route" className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          name="origin"
          placeholder="From (SFO)"
          maxLength={3}
          className="flex-1 font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent uppercase"
          required
        />
        <input
          type="text"
          name="destination"
          placeholder="To (HNL)"
          maxLength={3}
          className="flex-1 font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent uppercase"
          required
        />
        <button type="submit" className={buttonClass()}>
          Compare
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {PRESET_ROUTES.map((r) => (
          <button
            key={`${r.o}-${r.d}`}
            type="button"
            data-preset-origin={r.o}
            data-preset-dest={r.d}
            className={chipClass("sm")}
          >
            {r.o} → {r.d}
          </button>
        ))}
      </div>
      <div id="hub-compare-result" className="mt-3 hidden" />
      <div
        id="hub-compare-footer"
        className="mt-3 text-xs font-mono text-muted leading-relaxed hidden"
      >
        Carrier missing? It only shows up once one of its Starlink planes has flown here.{" "}
        {/* Static href must be a real page: /route-planner 404s on the hub, and
            crawlers see this SSR value — client JS only rewrites it to the
            per-route URL after a comparison runs. */}
        <a
          id="hub-compare-rp"
          href={`https://${SITES.united.canonicalHost}/route-planner`}
          className="text-accent hover:underline"
        >
          Route Planner →
        </a>
      </div>
    </Panel>
  );
}

const HubHero = ({ site, perAirlineStats = [], recentInstalls = [], hubLinks }: HeroProps) => {
  return (
    <div className="relative mx-auto mb-8 w-full max-w-3xl space-y-6">
      <section>
        <SectionTitle>Where each tracked rollout stands</SectionTitle>
        <Panel className="mt-4">
          <AirlineProgressList stats={perAirlineStats} />
        </Panel>
        <p className="mt-2 text-sm">
          <a href="/airlines" className={LINK}>
            All {AIRLINE_FACTS.length} airlines, including the ones that said no →
          </a>
        </p>
      </section>
      <RouteComparePanel />
      <Panel pad="sm">
        <Eyebrow className="mb-2">Already booked? Check a flight</Eyebrow>
        <FlightSearchForm
          site={site}
          id="hub-check-flight"
          mode="check-any"
          placeholder="UA1736, HA51, AS118, QR1…"
          prefillDate
          hideLabels
          withScript={false}
        />
      </Panel>
      <RecentInstallsFeed items={recentInstalls} airlines={perAirlineStats} />
      <HubLinkGrid links={hubLinks} />
      <ClientScriptTag name="hub" />
    </div>
  );
};

export const content: AirlineContent = {
  headerStats: [
    <span key="flying">
      <span className="text-accent font-semibold">{FLYING_COUNT}</span> airlines flying or
      installing Starlink
    </span>,
  ],

  intro: () => (
    <>
      {AIRLINE_FACTS.length} airlines, from finished fleets to firm no's, each with a dated source.
      We count{" "}
      {list(
        publicAirlines()
          .filter((a) => !a.communitySource && a.rollout.rosterIsProgramScope)
          .map((a) => a.shortName)
      )}{" "}
      plane by plane.
    </>
  ),

  Hero: HubHero,

  answers: [
    {
      q: "Which airlines have Starlink Wi-Fi?",
      a: () => (
        <p>
          {FLYING_COUNT} airlines fly Starlink or are installing it. Finished:{" "}
          {list(namesWith("complete"))}. Installing: {list(namesWith("installing"))}. Announced but
          not flying yet: {list(namesWith("announced"))}. The{" "}
          <a href="/airlines" className={LINK}>
            full list
          </a>{" "}
          dates and sources every status.
        </p>
      ),
    },
    {
      q: "Which airline has the most Starlink planes?",
      a: ({ perAirline = [] }) => {
        const [top, ...rest] = [...perAirline].sort((a, b) => b.starlink - a.starlink);
        if (!top) return <p>See the full list for each airline's count.</p>;
        return (
          <p>
            Of the airlines tracked here, {top.name} has the most, with{" "}
            <StatInline n={top.starlink} /> planes
            {top.code === "UA" ? (
              <>
                {" "}
                on the{" "}
                <a href={UNITED_URL} className={LINK}>
                  United Starlink Tracker
                </a>
              </>
            ) : null}
            .{" "}
            {rest.length > 0 && (
              <>Next: {list(rest.map((r) => `${r.name} (${fmt(r.starlink)})`))}.</>
            )}
          </p>
        );
      },
    },
    {
      q: "Is Starlink Wi-Fi free on every airline?",
      a: () => (
        <p>
          Not always, and the rules differ. United's is free for MileagePlus members, Alaska's for
          Atmos Rewards members, and Hawaiian's and Qatar's for every passenger. Each airline's page
          on the{" "}
          <a href="/airlines" className={LINK}>
            full list
          </a>{" "}
          gives its terms with a source.
        </p>
      ),
    },
    {
      q: "How do I check if my flight has Starlink?",
      a: () => (
        <p>
          Enter the flight number and date in the flight check above; it covers every airline we
          track. For United flights,{" "}
          <a href={UNITED_URL} className={LINK}>
            {UNITED_HOST}
          </a>{" "}
          has the full answer, including route odds.
        </p>
      ),
    },
  ],

  rowBadge: (_p, airline) => airline,

  subfleetFilters: publicAirlines().map((a) => ({ key: a.code, label: a.name })),

  faq: [
    {
      title: "Airlines",
      items: [
        {
          q: "Does Delta have Starlink?",
          a: () => (
            <p>
              No. Delta has partnered with Amazon's Project Kuiper, a Starlink competitor, for
              in-flight Wi-Fi from around 2028.{" "}
              <a href="/airlines/delta" className={LINK}>
                Delta's page
              </a>{" "}
              has the details.
            </p>
          ),
        },
        {
          q: "Does United have Starlink?",
          a: () => (
            <p>
              Yes, and it's the biggest rollout we track. The{" "}
              <a href={UNITED_URL} className={LINK}>
                United Starlink Tracker
              </a>{" "}
              has the live count, every equipped aircraft and a flight check.
            </p>
          ),
        },
      ],
    },
    {
      title: "About this tracker",
      items: [
        {
          q: "How is this data collected?",
          a: () => (
            <p>
              Fleet rosters and flight schedules come from public aviation data. Starlink status is
              confirmed per aircraft against each airline's own systems where they show it (United,
              Alaska), and by aircraft type where the airline has finished whole types (Hawaiian,
              Qatar). Airlines we don't track aircraft by aircraft get dated, sourced status pages.
            </p>
          ),
        },
        {
          q: "How accurate is this?",
          a: () => (
            <p>
              For United we check answers against united.com continuously. Type-based answers
              (Hawaiian, Qatar) are as good as the airline's own type list. Aircraft swaps close to
              departure are the main source of error on any airline.
            </p>
          ),
        },
      ],
    },
  ],
};
