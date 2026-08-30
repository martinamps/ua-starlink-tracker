import type React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import {
  SOUTHWEST_EQUIPPED_TAILS,
  type SouthwestEquippedTail,
} from "../airlines/southwest-equipped";
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
  // WN has no automated verifier: the curated evidence log is the methodology.
  // Being explicit about that (and about the ~1h assignment window) is what
  // lets the fleet-odds product cite itself honestly.
  WN: [
    {
      name: "Curated per-tail evidence log",
      cadence: "updated as evidence appears",
      detail:
        "Southwest publishes no per-aircraft WiFi roster, so every equipped tail here carries the date of its first public evidence — launch announcements, first revenue flights, credible passenger and spotter reports — and a note saying what proved it. No tail is counted without a dated record.",
    },
    {
      name: "Flightradar24 fleet and schedule data",
      cadence: "full fleet pull daily; flight schedules continuously",
      detail:
        "The full 737 roster gives us the honest denominator for fleet odds; live schedules show where the equipped tails have been flying. We deliberately do NOT use advance tail assignments to answer per-flight questions — Southwest finalizes the operating aircraft only about an hour before departure, so an advance assignment is speculation.",
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

// The page promises that every counted tail carries "a note saying what proved
// it". That log was invisible: `evidence`/`evidenceUrl` were read by the seed
// script and the tests and rendered nowhere, so the basis the whole tenant
// cites was unverifiable to a reader. Render it here, where the claim is made.
const EVIDENCE_LOG: Record<string, readonly SouthwestEquippedTail[]> = {
  WN: SOUTHWEST_EQUIPPED_TAILS,
};

function EvidenceLog({ records }: { records: readonly SouthwestEquippedTail[] }) {
  return (
    <ul className="space-y-3">
      {records.map((r) => (
        <li key={r.tail} className="pl-4 border-l-2 border-subtle">
          <span className="text-secondary font-mono">{r.tail}</span>{" "}
          <span className="font-mono text-xs text-muted">{r.aircraftType}</span>{" "}
          <span className="font-mono text-xs text-accent">
            {r.provider} · evidenced {r.equippedOn}
          </span>
          <div className="mt-1">
            {r.evidence}
            {r.evidenceUrl && (
              <>
                {" "}
                <a
                  href={r.evidenceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Source
                </a>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function MethodologyPage({ site, lastUpdated }: MethodologyPageProps) {
  const cfg = siteAirline(site);
  const sources = SOURCES[cfg.code] ?? [];
  // No verifier backend means no first-party oracle and no verification queue,
  // so United's three-tier ladder (verified / reported / predicted) and its
  // hourly consensus pass describe machinery this tenant does not run.
  const verified = Boolean(cfg.verifierBackend);
  const evidenceLog = EVIDENCE_LOG[cfg.code] ?? [];
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
            {verified
              ? `How We Verify ${cfg.shortName} Starlink Data`
              : `Where Our ${cfg.shortName} Starlink Data Comes From`}
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
            {verified
              ? "Each aircraft carries one of three levels of certainty, and the site treats them differently:"
              : `${cfg.shortName} publishes no per-aircraft WiFi roster and we run no verifier against its systems, so there is no "reported, pending verification" middle tier here — a tail either has a dated public record or it doesn't:`}
          </p>
          <ul className="list-disc pl-5 space-y-2">
            {verified ? (
              <>
                <li>
                  <span className="text-secondary font-medium">Verified</span> — we observed the
                  status on the airline's own systems for a flight that aircraft operated.
                </li>
                <li>
                  <span className="text-secondary font-medium">Reported</span> — a community source
                  claims the install; the tail counts toward the headline number but stays queued
                  for direct verification.
                </li>
              </>
            ) : (
              <>
                <li>
                  <span className="text-secondary font-medium">Evidenced</span> — a dated public
                  record ties Starlink to that exact tail. It counts toward the headline number, and
                  the log below names the record and links it.
                </li>
                <li>
                  <span className="text-secondary font-medium">Unknown</span> — no dated record for
                  that tail yet. It stays in the denominator and out of the equipped count. An
                  aircraft can be equipped and sit here until evidence surfaces, so the headline
                  number is a floor, not a census.
                </li>
              </>
            )}
            <li>
              <span className="text-secondary font-medium">Predicted</span> —{" "}
              {cfg.lateAssignmentNote
                ? `${cfg.shortName} finalizes the operating aircraft only about an hour before departure, so every per-flight answer here is fleet odds — equipped tails over the whole roster, never an assignment claim.`
                : "for flights more than ~2 days out no aircraft is assigned yet, so per-flight answers are probabilities built from historical assignments."}{" "}
              Predictions never feed the fleet count.
            </li>
          </ul>
          <p>
            {verified
              ? "An hourly consensus pass reconciles the sources. Direct observation outranks community claims: a tail we verify as running a non-Starlink WiFi system is settled negative and removed from the headline count even if a spreadsheet says otherwise."
              : "There is no automated reconciliation to run: with no first-party roster to check against and no verifier loop, a tail's status changes only when a dated record is added to — or corrected in — the log below."}
          </p>
        </Section>

        {evidenceLog.length > 0 && (
          <Section title="The evidence log">
            <p>
              Every tail counted as equipped, with the date of its earliest public evidence and the
              record that proved it. Install dates come from these records, never from the day we
              happened to add them.
            </p>
            <EvidenceLog records={evidenceLog} />
          </Section>
        )}

        <Section title="How fresh is it">
          <p>
            {cfg.lateAssignmentNote
              ? "Schedule jobs run continuously, fleet-level syncs run daily, the curated equipped-tail log updates as evidence appears, and every page renders straight from the live database — there is no publishing delay between a status change and the site."
              : "Verification and schedule jobs run continuously (60–90 second cycles), fleet-level syncs run hourly to daily, and every page renders straight from the live database — there is no publishing delay between a status change and the site."}
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
              {cfg.lateAssignmentNote
                ? `${cfg.shortName} finalizes the operating aircraft only about an hour before departure, so nothing here names the tail you will actually fly on.`
                : "Aircraft assignments can change up to departure — a swap can put you on a different tail than the one we verified."}
            </li>
            <li>
              We track aircraft, not seats: no guarantees about connectivity quality or outages on a
              given flight.
            </li>
            <li>
              {verified
                ? "Install dates record when we first found a tail equipped, which can lag the physical installation by days."
                : "Install dates are the date of the earliest public evidence, which can lag the physical installation by weeks — and a tail with no public evidence yet reads here as unequipped."}
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
