import type React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { PageFooter } from "./atoms";

interface MethodologyPageProps {
  site: SiteConfig;
  lastUpdated: string;
}

interface DataSource {
  name: string;
  cadence: string;
  detail: string;
}

// Source lists mirror what actually runs per airline (registry verifierBackend
// + server.ts jobs) at the level the public README already describes — what we
// check and how often, not scraping mechanics. hasMethodology gates the route
// on membership here, so the feature flag and content can't drift apart.
const SOURCES: Record<string, DataSource[]> = {
  UA: [
    {
      name: "United's own systems",
      cadence: "every 60 seconds",
      detail:
        "We check the WiFi provider United lists for upcoming flights on united.com, a few aircraft per pass, so every tracked tail is re-verified on a rolling basis. This is the only evidence that can mark a tail as verified.",
    },
    {
      name: "Community fleet spreadsheet",
      cadence: "hourly",
      detail:
        "The United fleet community maintains a per-tail equipment sheet. We sync it hourly; its Starlink claims count as reported installs until our own verification confirms or contradicts them.",
    },
    {
      name: "Flightradar24 fleet and schedule data",
      cadence: "full fleet pull daily; flight schedules continuously",
      detail:
        "Fleet rosters give us the denominator and aircraft types; live schedules tie tail numbers to upcoming flights so per-flight answers reflect the actual assigned aircraft.",
    },
    {
      name: "FAA aircraft registry",
      cadence: "daily",
      detail:
        "Registration cross-reference so retired or re-registered airframes drop out of the counts instead of lingering as phantom installs.",
    },
  ],
  AS: [
    {
      name: "Alaska's own systems",
      cadence: "every 90 seconds",
      detail:
        "We check upcoming flights on alaskaair.com to confirm which aircraft is actually operating each flight. For Alaska this observes the equipment type, not a WiFi banner, so per-tail WiFi status is derived from the fleet program state for that type.",
    },
    {
      name: "Flightradar24 fleet and schedule data",
      cadence: "full fleet pull daily; flight schedules continuously",
      detail:
        "Fleet rosters for Alaska mainline and the Horizon Air regional fleet give us the denominator and aircraft types; live schedules tie tail numbers to upcoming flights.",
    },
    {
      name: "Community install reports",
      cadence: "checked continuously",
      detail:
        "Frequent-flyer communities track which mainline 737s and 787s have been through the retrofit. We ingest those per-tail reports as claims, never as verified status.",
    },
    {
      name: "FAA aircraft registry",
      cadence: "daily",
      detail:
        "Registration cross-reference so retired or re-registered airframes drop out of the counts instead of lingering as phantom installs.",
    },
  ],
};

/** True when SOURCES documents this airline — the /methodology handler 404s
 * otherwise, so a feature gate flipped on without content can't silently
 * render an empty-source page. */
export function hasMethodology(code: string): boolean {
  return code in SOURCES;
}

export default function MethodologyPage({ site, lastUpdated }: MethodologyPageProps) {
  const cfg = siteAirline(site);
  const sources = SOURCES[cfg.code] ?? [];
  const stampedDate = new Date(lastUpdated);
  const dateLabel = Number.isNaN(stampedDate.getTime())
    ? null
    : stampedDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
      <h2 className="font-display text-lg font-semibold text-primary mb-3">{title}</h2>
      <div className="text-sm text-muted leading-relaxed space-y-3">{children}</div>
    </section>
  );

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            How We Verify {cfg.shortName} Starlink Data
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Where this tracker's numbers come from, how a tail earns "has Starlink," and what we can't
          know.
        </p>
      </header>

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <Section title="Where the data comes from">
          <p>
            No single source is trusted on its own. We combine independent feeds and reconcile them
            against each other:
          </p>
          <ul className="space-y-3">
            {sources.map((s) => (
              <li key={s.name} className="pl-4 border-l-2 border-subtle">
                <span className="text-secondary font-medium">{s.name}</span>{" "}
                <span className="font-mono text-xs text-accent">({s.cadence})</span>
                <div className="mt-1">{s.detail}</div>
              </li>
            ))}
          </ul>
        </Section>

        <Section title='How "has Starlink" is decided'>
          <p>
            Each aircraft carries one of three levels of certainty, and the site treats them
            differently:
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li>
              <span className="text-secondary font-medium">Verified</span> — we observed the status
              on the airline's own systems for a flight that aircraft operated.
            </li>
            <li>
              <span className="text-secondary font-medium">Reported</span> — a community source
              claims the install; the tail counts toward the headline number but stays queued for
              direct verification.
            </li>
            <li>
              <span className="text-secondary font-medium">Predicted</span> — for flights more than
              ~2 days out no aircraft is assigned yet, so per-flight answers are probabilities built
              from historical assignments. Predictions never feed the fleet count.
            </li>
          </ul>
          <p>
            An hourly consensus pass reconciles the sources. Direct observation outranks community
            claims: a tail we verify as running a non-Starlink WiFi system is settled negative and
            removed from the headline count even if a spreadsheet says otherwise.
          </p>
        </Section>

        <Section title="How fresh is it">
          <p>
            Verification and schedule jobs run continuously (60–90 second cycles), fleet-level syncs
            run hourly to daily, and every page renders straight from the live database — there is
            no publishing delay between a status change and the site.
            {dateLabel && (
              <>
                {" "}
                This airline's data was last updated{" "}
                <span className="text-secondary">{dateLabel}</span>.
              </>
            )}
          </p>
        </Section>

        <Section title="What this site does not know">
          <ul className="list-disc pl-5 space-y-2">
            <li>
              Aircraft assignments can change up to departure — a swap can put you on a different
              tail than the one we verified.
            </li>
            <li>
              We track aircraft, not seats: no guarantees about connectivity quality or outages on a
              given flight.
            </li>
            <li>
              Install dates record when we first found a tail equipped, which can lag the physical
              installation by days.
            </li>
          </ul>
        </Section>

        <Section title="Citing this data">
          <p>
            The canonical, quotable form of our headline stat is the dated sentence on the{" "}
            <a href="/" className="text-accent hover:underline">
              homepage
            </a>{" "}
            (HTML id <code className="font-mono text-xs">starlink-stat</code>): "As of {"{date}"},{" "}
            {"{n}"} of {"{total}"} {cfg.name} aircraft ({"{percent}"}%) have Starlink WiFi
            installed." The numbers update continuously as installs are verified, so cite the date
            alongside the counts. Attribution to {site.canonicalHost} is appreciated; the{" "}
            <a
              href="https://github.com/martinamps/ua-starlink-tracker"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              tracker's source code
            </a>{" "}
            is public.
          </p>
        </Section>
      </div>

      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </div>

      <PageFooter site={site} />
    </div>
  );
}
