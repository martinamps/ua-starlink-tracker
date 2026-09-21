import type React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { article } from "../utils/grammar";
import type { PageLink } from "./atoms";
import { JsonLd } from "./faq";
import { FlightSearchForm } from "./flight-search-form";
import { PageHeader, PageShell, Section } from "./layout";

interface HowToCheckPageProps {
  site: SiteConfig;
  pageLinks?: PageLink[];
  currentPath?: string;
}

interface Step {
  name: string;
  body: React.ReactNode;
  /** Plain-text form for the HowTo JSON-LD (no markup). */
  text: string;
}

export default function HowToCheckPage({ site, pageLinks, currentPath }: HowToCheckPageProps) {
  const cfg = siteAirline(site);
  const short = cfg.shortName;
  const example = `${cfg.iata}123`;
  const host = site.canonicalHost;
  // Only the united backend observes the Wi-Fi listing itself; other verifiers
  // see equipment type, so the "verified" claim must not overstate there.
  const verifiedClaim =
    cfg.verifierBackend === "united"
      ? `the Wi-Fi ${cfg.name} lists for that aircraft on ${cfg.verifySite}`
      : "the aircraft assigned and where its type stands in the rollout";

  const steps: Step[] = [
    {
      name: "Find your flight number",
      body: (
        <>
          It's on your confirmation, boarding pass or the airline app: two letters and 1–4 digits,
          like <span className="font-mono text-primary">{example}</span>. The digits alone work too.
        </>
      ),
      text: `Find your flight number on your confirmation, boarding pass or the airline app: two letters and 1-4 digits, like ${example}.`,
    },
    {
      name: "Enter it with your date",
      body: (
        <>
          Type it into the{" "}
          <a href="/check-flight" className="text-accent hover:underline">
            flight checker
          </a>{" "}
          below with your travel date. No sign-up.
        </>
      ),
      text: `Enter the flight number and travel date in the flight checker at https://${host}/check-flight.`,
    },
    {
      name: "Read the answer",
      body: (
        <>
          About 2 days before departure, {cfg.name} assigns the aircraft, and the answer comes from{" "}
          {verifiedClaim}. Earlier than that, you get a probability based on the aircraft that
          recently flew that flight number.
        </>
      ),
      text: "About 2 days before departure the answer comes from the assigned aircraft. Earlier, it is a probability based on the aircraft that recently flew that flight number.",
    },
    {
      name: "Check again the day before",
      body: <>Aircraft can change up to departure. The answer updates as assignments change.</>,
      text: "Aircraft can change up to departure, so check again the day before you fly.",
    },
  ];

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title={`How to check if your ${short} flight has Starlink`}
        dek="Starlink depends on the aircraft. Here's how to check yours."
      />

      <Section title="Check by flight number">
        <ol className="space-y-4">
          {steps.map((s, i) => (
            <li key={s.name} className="flex gap-3">
              <span className="w-5 shrink-0 text-right font-semibold text-accent tabular-nums">
                {i + 1}.
              </span>
              <div>
                <div className="font-semibold text-primary">{s.name}</div>
                <p className="mt-1 text-sm leading-relaxed text-secondary">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        {site.features.checkFlightPage && (
          <div className="mt-6 border-t border-subtle pt-5">
            <FlightSearchForm site={site} id="how-to-check-form" prefillDate />
          </div>
        )}
      </Section>

      <Section title="Other ways">
        <ul className="space-y-3 text-sm leading-relaxed text-secondary">
          <li>
            <span className="font-semibold text-primary">By tail number.</span> The registration is
            on the fuselage and in most airline apps. Search it on the{" "}
            <a href="/" className="text-accent hover:underline">
              homepage
            </a>
            .
          </li>
          {site.features.chromeExtension && (
            <li>
              <span className="font-semibold text-primary">While shopping.</span> The free{" "}
              <a
                href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Chrome extension
              </a>{" "}
              marks Starlink flights on Google Flights.
            </li>
          )}
          {site.features.routePlannerPage && (
            <li>
              <span className="font-semibold text-primary">Before you book.</span> The{" "}
              <a href="/route-planner" className="text-accent hover:underline">
                route planner
              </a>{" "}
              ranks flights between two airports by their chance of Starlink.
            </li>
          )}
          <li>
            <span className="font-semibold text-primary">On {cfg.verifySite}.</span>{" "}
            {cfg.verifierBackend === "united" ? (
              <>
                Once an aircraft is assigned, the flight status page lists its Wi-Fi. We check the
                same page, one aircraft at a time, so each aircraft is re-checked about every three
                days.
              </>
            ) : (
              <>It shows the aircraft scheduled for your flight, which decides the Wi-Fi.</>
            )}
          </li>
        </ul>
      </Section>

      <Section title="What the answer means">
        <p className="text-sm leading-relaxed text-secondary">
          A <span className="font-semibold text-primary">verified yes</span> means we saw the
          assigned aircraft's Wi-Fi ourselves. A{" "}
          <span className="font-semibold text-primary">probability</span> means no aircraft is
          assigned yet, so it's based on the flight's recent history. Some {short} aircraft still
          have older Wi-Fi while the{" "}
          <a href="/fleet" className="text-accent hover:underline">
            rollout
          </a>{" "}
          continues, so having Wi-Fi isn't the same as having Starlink.
          {site.features.intentPages && (
            <>
              {" "}
              <a href="/is-starlink-free" className="text-accent hover:underline">
                Starlink Wi-Fi is free
              </a>
              .
            </>
          )}
        </p>
      </Section>

      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "HowTo",
          name: `How to check if ${article(cfg.name)} ${cfg.name} flight has Starlink WiFi`,
          description: `Check any ${cfg.name} flight for free Starlink Wi-Fi by flight number and date: verified near departure, a labeled probability before that.`,
          totalTime: "PT1M",
          step: steps.map((s, i) => ({
            "@type": "HowToStep",
            position: i + 1,
            name: s.name,
            text: s.text,
          })),
        }}
      />
    </PageShell>
  );
}
