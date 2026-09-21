import { normalizeAircraftType } from "../airlines/aircraft-families";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { factsBySlug } from "../airlines/rollout-facts";
import type { Aircraft } from "../types";
import { type SeatbackLiveTv, seatbackLiveTv } from "../utils/aircraft-specs";
import type { PageLink } from "./atoms";
import { Faq } from "./faq";
import { FlightSearchForm } from "./flight-search-form";
import { PageHeader, PageShell, Section, StatInline, Td, Th, fmt } from "./layout";

export interface LiveTvTypeRow {
  label: string;
  starlink: number;
  tier: Exclude<SeatbackLiveTv, "no">;
}

interface LiveTvPageProps {
  site: SiteConfig;
  pageLinks?: PageLink[];
  currentPath?: string;
  mainlineStarlink: number;
  mainlineTotal: number;
  byType: LiveTvTypeRow[];
}

const DISH_RELEASE =
  "https://www.globenewswire.com/news-release/2026/09/17/3364268/0/en/dish-teams-up-with-united-airlines-to-provide-live-football-at-35-000-feet.html";
const UNITED_RELEASE =
  "https://www.prnewswire.com/news-releases/united-teams-up-with-dish-to-broadcast-professional-and-college-football-games-live-on-starlink-enabled-seatback-screens-302882330.html";

/** The live-TV fleet target, as cited on /airlines/united — never a figure
 * typed into this page, which drifted from the rollout facts once already. */
export const LIVE_TV_TARGET_FACT =
  factsBySlug("united")?.facts.find((f) => f.source.url === UNITED_RELEASE) ?? null;

const TIER_LABEL: Record<LiveTvTypeRow["tier"], string> = {
  likely: "Likely",
  possible: "Possible",
};
const TIER_CLASS: Record<LiveTvTypeRow["tier"], string> = {
  likely: "text-success",
  possible: "text-yellow-400",
};

const FAMILY_LABEL: Record<string, string> = {
  A319: "Airbus A319",
  A320: "Airbus A320",
  A321: "Airbus A321neo / A321XLR",
  "B737-700": "Boeing 737-700",
  "B737-800": "Boeing 737-800",
  "B737-900": "Boeing 737-900 / 900ER",
  "B737-MAX8": "Boeing 737 MAX 8",
  "B737-MAX9": "Boeing 737 MAX 9",
  "B737-MAX10": "Boeing 737 MAX 10",
  B757: "Boeing 757",
  B767: "Boeing 767",
  B777: "Boeing 777",
  B787: "Boeing 787",
};

/** Mainline Starlink tails grouped by type family — the page's "likely
 * eligible" table. Express tails are left out: they have no seatbacks. */
export function liveTvTypeRows(planes: Aircraft[]): LiveTvTypeRow[] {
  const rows = new Map<string, LiveTvTypeRow>();
  for (const p of planes) {
    if (p.fleet !== "mainline") continue;
    const tier = seatbackLiveTv(p.fleet, p.Aircraft);
    if (tier === "no") continue;
    const family = normalizeAircraftType(p.Aircraft);
    const label = FAMILY_LABEL[family] ?? "Other mainline";
    const row = rows.get(label) ?? { label, starlink: 0, tier };
    row.starlink++;
    rows.set(label, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.starlink - a.starlink || a.label.localeCompare(b.label)
  );
}

/** Visible Q&A and the FAQPage JSON-LD are built from this one list, so the
 * markup can never describe answers the page does not show. */
export function liveTvFaq(): Array<{ q: string; a: string }> {
  return [
    {
      q: "Can I watch live football on my United flight?",
      a: "Yes, if the aircraft is a Starlink-equipped United mainline jet with a seatback screen. DISH streams nine live channels (ABC, CBS, FOX, NBC, ESPN, ESPN2, FS1, NFL Network and TNF on Prime Video) to Starlink-enabled seatback screens, starting on more than 200 mainline aircraft, on domestic flights through Super Bowl LXI in February 2027.",
    },
    {
      q: "Does United Express have live TV?",
      a: "No. United Express regional jets (E175, CRJ-550) have Starlink Wi-Fi but no seatback screens, so there is no screen to show live TV on. You can still stream on your own phone, tablet or laptop over the Starlink Wi-Fi.",
    },
    {
      q: "How do I know if my flight has live TV?",
      a: "Check your flight number and date. If the assigned aircraft has Starlink and is a mainline jet, live TV on the seatback is likely. Aircraft are assigned about two days before departure, and some older 737-800 and 737-900 cabins have no seatback screen, so those count as possible rather than certain.",
    },
    {
      q: "Is the Starlink Wi-Fi free?",
      a: "Yes. United says Starlink is free for MileagePlus members in every class of service, and MileagePlus is free to join.",
    },
  ];
}

export default function LiveTvPage({
  site,
  pageLinks,
  currentPath,
  mainlineStarlink,
  mainlineTotal,
  byType,
}: LiveTvPageProps) {
  const cfg = siteAirline(site);
  const faq = liveTvFaq();
  const pct = mainlineTotal > 0 ? Math.round((mainlineStarlink / mainlineTotal) * 100) : null;
  const likely = byType.filter((r) => r.tier === "likely").reduce((n, r) => n + r.starlink, 0);
  const possible = byType.filter((r) => r.tier === "possible").reduce((n, r) => n + r.starlink, 0);

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={`Which ${cfg.shortName} planes have live TV?`}
        dek={`You need a ${cfg.shortName} mainline jet with Starlink and a seatback screen. United Express jets have Starlink but no seatback screens, so stream on your own device.`}
      />

      <Section title="The answer">
        <div className="space-y-3 text-sm leading-relaxed text-secondary">
          <p>
            DISH streams live TV, including football, to Starlink-equipped seatback screens on
            domestic flights through Super Bowl LXI in February 2027.
          </p>
          <p className="text-muted">
            Sources:{" "}
            <a
              href={DISH_RELEASE}
              className="text-accent hover:underline"
              rel="noopener noreferrer"
              target="_blank"
            >
              DISH and United release, GlobeNewswire, Sep 17, 2026
            </a>{" "}
            ·{" "}
            <a
              href={UNITED_RELEASE}
              className="text-accent hover:underline"
              rel="noopener noreferrer"
              target="_blank"
            >
              United release, PR Newswire
            </a>
          </p>
        </div>
      </Section>

      <Section
        title="Starlink mainline aircraft by type"
        dek="We track Starlink per aircraft, not seatback screens, so these are likely or possible, never certain."
      >
        <p className="text-sm leading-relaxed text-secondary">
          <StatInline n={mainlineStarlink} /> {cfg.shortName} mainline aircraft have Starlink
          {pct !== null && (
            <>
              {" "}
              (<StatInline>{pct}%</StatInline> of {fmt(mainlineTotal)})
            </>
          )}
          . <StatInline n={likely} /> are types with seatback screens, so live TV is likely.{" "}
          <StatInline n={possible} /> are types where some cabins have no screen, so it's possible.
        </p>
        {byType.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr>
                <Th>Aircraft type</Th>
                <Th numeric>With Starlink</Th>
                <Th numeric>Live TV</Th>
              </tr>
            </thead>
            <tbody>
              {byType.map((row) => (
                <tr key={row.label}>
                  <Td className="text-secondary">{row.label}</Td>
                  <Td numeric className="text-secondary">
                    {fmt(row.starlink)}
                  </Td>
                  <Td numeric className={TIER_CLASS[row.tier]}>
                    {TIER_LABEL[row.tier]}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(LIVE_TV_TARGET_FACT || site.features.fleetPage) && (
          <p className="mt-4 text-sm leading-relaxed text-muted">
            {LIVE_TV_TARGET_FACT && (
              <>
                United's own figure, which counts live TV, not Starlink: {LIVE_TV_TARGET_FACT.fact}{" "}
                <a
                  href={LIVE_TV_TARGET_FACT.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Source
                </a>
                .
              </>
            )}
            {site.features.fleetPage && (
              <>
                {" "}
                Every aircraft is on the{" "}
                <a href="/fleet" className="text-accent hover:underline">
                  fleet page
                </a>
                .
              </>
            )}
          </p>
        )}
      </Section>

      {site.features.checkFlightPage && (
        <Section title="Check your flight">
          <FlightSearchForm site={site} id="live-tv-flight-search" prefillDate />
        </Section>
      )}

      <Faq items={faq} />
      {site.features.intentPages && (
        <p className="relative mx-auto -mt-4 mb-8 w-full max-w-3xl text-sm text-secondary">
          More on the Wi-Fi itself:{" "}
          <a href="/is-starlink-free" className="text-accent hover:underline">
            is {cfg.shortName} Starlink free?
          </a>
        </p>
      )}
    </PageShell>
  );
}
