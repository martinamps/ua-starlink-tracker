import type React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import type { Link } from "./layout";
import { PageHeader, PageShell, Section } from "./layout";
import { longDate } from "./ui/format";

interface MethodologyPageProps {
  site: SiteConfig;
  lastUpdated: string;
  pageLinks?: Link[];
  currentPath?: string;
}

interface DataSource {
  name: string;
  cadence: string;
  detail: string;
}

// Source lists mirror what actually runs per airline (registry verifierBackend
// + server.ts jobs) at the level the public README already describes — what we
// check and how often, not scraping mechanics. hasMethodology gates the route
// on membership here, so the feature flag and content can't drift apart. A
// source the counts don't read (the FAA registry) is not listed.
const SOURCES: Record<string, DataSource[]> = {
  UA: [
    {
      name: "United.com",
      cadence: "one aircraft a minute",
      detail:
        "We check one aircraft a minute against the Wi-Fi United lists for its upcoming flight, so each aircraft is re-checked about every three days. Only this can mark an aircraft as verified.",
    },
    {
      name: "Community fleet spreadsheet",
      cadence: "hourly",
      detail:
        "United fleet enthusiasts keep a per-aircraft equipment sheet. Its Starlink entries count as reported installs until our own check confirms or contradicts them.",
    },
    {
      name: "Flightradar24 fleet and schedules",
      cadence: "fleet daily, schedules continuously",
      detail:
        "The fleet list gives us the total and each aircraft's type. Schedules tell us which aircraft flies which flight.",
    },
  ],
  AS: [
    {
      name: "Alaskaair.com",
      cadence: "every 90 seconds",
      detail:
        "We look up which aircraft is flying each upcoming flight. For Alaska this shows the aircraft type, not the Wi-Fi, so an aircraft's Wi-Fi comes from where its type stands in the rollout.",
    },
    {
      name: "Flightradar24 fleet and schedules",
      cadence: "fleet daily, schedules continuously",
      detail:
        "The fleet lists for Alaska and Horizon give us the total and each aircraft's type. Schedules tell us which aircraft flies which flight.",
    },
    {
      name: "Community install reports",
      cadence: "checked continuously",
      detail:
        "Frequent-flyer forums track which mainline 737s and 787s have been retrofitted. We record these as reports, never as verified.",
    },
  ],
};

/** True when SOURCES documents this airline — the /methodology handler 404s
 * otherwise, so a feature gate flipped on without content can't silently
 * render an empty-source page. */
export function hasMethodology(code: string): boolean {
  return code in SOURCES;
}

function Prose({ children }: { children: React.ReactNode }) {
  return <div className="space-y-3 text-sm leading-relaxed text-secondary">{children}</div>;
}

export default function MethodologyPage({
  site,
  lastUpdated,
  pageLinks,
  currentPath,
}: MethodologyPageProps) {
  const cfg = siteAirline(site);
  const sources = SOURCES[cfg.code] ?? [];
  const dateLabel = longDate(lastUpdated);

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={`How we verify ${cfg.shortName} Starlink data`}
        dek="Where the data comes from and how we confirm each aircraft."
      />

      <Section title="Where the data comes from" dek={`We cross-check ${sources.length} sources:`}>
        <ul className="space-y-4 text-sm leading-relaxed">
          {sources.map((s) => (
            <li key={s.name}>
              <div className="text-primary">
                <span className="font-semibold">{s.name}</span>
                <span className="text-muted"> · {s.cadence}</span>
              </div>
              <p className="mt-1 text-secondary">{s.detail}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="How an aircraft counts as having Starlink">
        <Prose>
          <p>Each aircraft has one of three levels of certainty:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <span className="font-semibold text-primary">Verified.</span> We saw Starlink listed
              on the airline's own site for a flight that aircraft flew.
            </li>
            <li>
              <span className="font-semibold text-primary">Reported.</span> A community source says
              it's installed. It counts toward the total and waits for our own check.
            </li>
            <li>
              <span className="font-semibold text-primary">Predicted.</span> More than about 2 days
              out, no aircraft is assigned yet, so a flight's answer is a probability from the
              aircraft it has used before. Predictions never change the fleet count.
            </li>
          </ul>
          <p>
            Once an hour we reconcile the sources. Our own checks win: an aircraft we find with
            another Wi-Fi system comes out of the total, whatever the spreadsheet says.
          </p>
        </Prose>
      </Section>

      <Section title="How fresh it is">
        <Prose>
          <p>
            Checks and schedule updates run all day, and every page reads the live database, so a
            change shows up on the next page load.
            {dateLabel && <> This airline's data was last updated {dateLabel}.</>}
          </p>
        </Prose>
      </Section>

      <Section title="What we can't tell you">
        <Prose>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              The aircraft can change up to departure, so yours may not be the one we checked.
            </li>
            <li>We track aircraft, not connection quality or outages on a given flight.</li>
            <li>
              An install date is the day we first saw Starlink on the aircraft, which can be a few
              days after the work was done.
            </li>
          </ul>
        </Prose>
      </Section>

      {/* The Dataset JSON-LD on this page declares /api/data as its
          distribution; Google requires the markup to describe content that is
          actually on the page, so the download has to be visible here too. */}
      <Section title="Get the data">
        <Prose>
          <p>
            <a href="/api/data" className="font-mono text-accent hover:underline">
              /api/data
            </a>{" "}
            is open JSON, no key needed. It lists the Starlink {cfg.shortName} aircraft we count
            (type, operator, date found, and the Wi-Fi the community sheet lists), the fleet totals
            behind the headline percentage, the last-updated time, and upcoming flights for each of
            those aircraft. Read <code className="font-mono">lastUpdated</code> with the counts.
          </p>
          <p>
            The same aircraft with the date each was found, as a spreadsheet:{" "}
            <a href="/data/starlink-tails.csv" className="font-mono text-accent hover:underline">
              /data/starlink-tails.csv
            </a>
            .
          </p>
        </Prose>
      </Section>

      <Section title="Citing this data" id="cite">
        <Prose>
          <p>
            Quote the dated sentence on the{" "}
            <a href="/" className="text-accent hover:underline">
              homepage
            </a>{" "}
            (element id <code className="font-mono">starlink-stat</code>), which gives the{" "}
            {cfg.name} count, the fleet total and the percentage. The numbers change as installs are
            verified, so include the date. Credit to {site.canonicalHost} is appreciated. The{" "}
            <a
              href="https://github.com/martinamps/ua-starlink-tracker"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              source code
            </a>{" "}
            is public.
          </p>
        </Prose>
      </Section>
    </PageShell>
  );
}
