import React from "react";
import { normalizeAircraftType } from "../airlines/aircraft-families";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { Aircraft } from "../types";
import { type SeatbackLiveTv, seatbackLiveTv } from "../utils/aircraft-specs";
import { PageFooter, type PageLink } from "./atoms";

export interface LiveTvTypeRow {
  label: string;
  starlink: number;
  tier: Exclude<SeatbackLiveTv, "no">;
}

interface LiveTvPageProps {
  site: SiteConfig;
  pageLinks?: PageLink[];
  mainlineStarlink: number;
  mainlineTotal: number;
  byType: LiveTvTypeRow[];
}

const DISH_RELEASE =
  "https://www.globenewswire.com/news-release/2026/09/17/3364268/0/en/dish-teams-up-with-united-airlines-to-provide-live-football-at-35-000-feet.html";
const UNITED_RELEASE =
  "https://www.prnewswire.com/news-releases/united-teams-up-with-dish-to-broadcast-professional-and-college-football-games-live-on-starlink-enabled-seatback-screens-302882330.html";

const TIER_LABEL: Record<LiveTvTypeRow["tier"], string> = {
  likely: "Likely",
  possible: "Possible",
};
const TIER_CLASS: Record<LiveTvTypeRow["tier"], string> = {
  likely: "text-green-400",
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
      a: "No. United Express regional jets (E175, CRJ-550) have Starlink WiFi but no seatback screens, so there is no screen to show live TV on. You can still stream on your own phone, tablet or laptop over the Starlink WiFi.",
    },
    {
      q: "How do I know if my flight has live TV?",
      a: "Check your flight number and date. If the assigned aircraft has Starlink and is a mainline jet, live TV on the seatback is likely. Aircraft are assigned about two days before departure, and some older 737-800 and 737-900 cabins have no seatback screen, so those count as possible rather than certain.",
    },
    {
      q: "Is the Starlink WiFi free?",
      a: "Yes. United says Starlink is free for MileagePlus members in every class of service, and MileagePlus is free to join.",
    },
  ];
}

export default function LiveTvPage({
  site,
  pageLinks,
  mainlineStarlink,
  mainlineTotal,
  byType,
}: LiveTvPageProps) {
  const cfg = siteAirline(site);
  const faq = liveTvFaq();
  const pct = mainlineTotal > 0 ? Math.round((mainlineStarlink / mainlineTotal) * 100) : null;

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight">
          Live TV &amp; football on United flights: which planes have it
        </h1>
      </header>

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">The answer</h2>
          <p className="text-sm text-secondary leading-relaxed font-medium">
            Needs a United mainline jet with Starlink and a seatback screen (DISH OnStream, through
            Super Bowl LXI, Feb 2027). United Express E175/CRJ-550 have Starlink WiFi but no
            seatbacks — stream on your own device.
          </p>
          <p className="text-xs text-muted leading-relaxed mt-3">
            Sources:{" "}
            <a
              href={DISH_RELEASE}
              className="text-accent hover:underline"
              rel="noopener noreferrer"
              target="_blank"
            >
              DISH/United release, GlobeNewswire, Sep 17, 2026
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
        </section>

        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            Likely eligible aircraft today
          </h2>
          <p className="text-sm text-muted leading-relaxed mb-4">
            <span className="text-secondary font-mono">
              {mainlineStarlink.toLocaleString("en-US")}
            </span>{" "}
            {cfg.shortName} mainline aircraft have Starlink
            {pct !== null && (
              <>
                {" "}
                (<span className="font-mono">{pct}%</span> of{" "}
                {mainlineTotal.toLocaleString("en-US")})
              </>
            )}
            . That makes them likely eligible, not guaranteed: we track Starlink per tail, not
            seatback screens.
          </p>
          {byType.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-mono text-muted uppercase tracking-wider">
                  <th className="py-1 pr-2 font-normal">Aircraft type</th>
                  <th className="py-1 pr-2 font-normal text-right">With Starlink</th>
                  <th className="py-1 font-normal text-right">Seatback live TV</th>
                </tr>
              </thead>
              <tbody>
                {byType.map((row) => (
                  <tr key={row.label} className="border-t border-subtle">
                    <td className="py-2 pr-2 text-secondary">{row.label}</td>
                    <td className="py-2 pr-2 text-right font-mono text-secondary">
                      {row.starlink.toLocaleString("en-US")}
                    </td>
                    <td className={`py-2 text-right font-mono ${TIER_CLASS[row.tier]}`}>
                      {TIER_LABEL[row.tier]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-muted leading-relaxed mt-4">
            United expects Starlink on nearly 700 aircraft by February 2027.
            {site.features.fleetPage && (
              <>
                {" "}
                Every tail is on the{" "}
                <a href="/fleet" className="text-accent hover:underline">
                  fleet page
                </a>
                .
              </>
            )}
          </p>
        </section>

        {site.features.checkFlightPage && (
          <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
            <h2 className="font-display text-lg font-semibold text-primary mb-3">
              Check your flight
            </h2>
            <form
              id="live-tv-flight-search"
              method="GET"
              action="/check-flight"
              className="flex flex-col sm:flex-row gap-2"
            >
              <input
                type="text"
                id="live-tv-flight-number"
                name="flight_number"
                aria-label="Flight number"
                placeholder={`${cfg.iata}881`}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="flex-1 min-w-0 bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
              />
              <input
                type="date"
                id="live-tv-flight-date"
                name="date"
                aria-label="Flight date"
                className="bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent sm:w-40"
              />
              <button
                type="submit"
                className="px-5 py-2 bg-accent/20 border border-accent text-accent font-display font-semibold rounded hover:bg-accent/30 transition-colors cursor-pointer whitespace-nowrap"
              >
                Check
              </button>
            </form>
            <script
              // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
              dangerouslySetInnerHTML={{
                __html: `
            document.addEventListener('DOMContentLoaded', function() {
              var form = document.getElementById('live-tv-flight-search');
              if (!form) return;
              var carrierPrefix = ${JSON.stringify(cfg.iata)};
              form.addEventListener('submit', function(e) {
                e.preventDefault();
                var fn = document.getElementById('live-tv-flight-number').value.trim().toUpperCase();
                if (!fn) return;
                if (/^\\d+$/.test(fn)) fn = carrierPrefix + fn;
                var date = document.getElementById('live-tv-flight-date').value;
                window.location.href = '/check-flight/' + encodeURIComponent(fn) + (date ? '/' + encodeURIComponent(date) : '');
              });
            });
          `,
              }}
            />
          </section>
        )}

        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">Questions</h2>
          <dl className="space-y-4">
            {faq.map((item) => (
              <div key={item.q}>
                <dt className="font-display text-sm font-semibold text-secondary">{item.q}</dt>
                <dd className="text-sm text-muted leading-relaxed mt-1">{item.a}</dd>
              </div>
            ))}
          </dl>
          {site.features.intentPages && (
            <p className="text-sm text-muted leading-relaxed mt-4">
              More on the WiFi itself:{" "}
              <a href="/is-starlink-free" className="text-accent hover:underline">
                is {cfg.shortName} Starlink free?
              </a>
            </p>
          )}
        </section>
      </div>

      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </div>

      <PageFooter site={site} pageLinks={pageLinks} />

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD built from static copy
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faq.map((item) => ({
              "@type": "Question",
              name: item.q,
              acceptedAnswer: { "@type": "Answer", text: item.a },
            })),
          }).replace(/</g, "\\u003c"),
        }}
      />
    </div>
  );
}
