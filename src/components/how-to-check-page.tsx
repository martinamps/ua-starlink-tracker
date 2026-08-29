import type React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { PageFooter } from "./atoms";

interface HowToCheckPageProps {
  site: SiteConfig;
}

interface Step {
  name: string;
  body: React.ReactNode;
  /** Plain-text form for the HowTo JSON-LD (no markup). */
  text: string;
}

export default function HowToCheckPage({ site }: HowToCheckPageProps) {
  const cfg = siteAirline(site);
  const short = cfg.shortName;
  const example = `${cfg.iata}123`;
  const host = site.canonicalHost;
  // Only the united backend observes the WiFi banner itself; other verifiers
  // see equipment type, so the "verified" claim must not overstate there.
  const verifiedClaim =
    cfg.verifierBackend === "united"
      ? `the WiFi provider ${cfg.name} itself lists for that aircraft on ${cfg.verifySite}`
      : "the aircraft assigned to the flight and the fleet program state for its type";

  const steps: Step[] = [
    {
      name: "Find your flight number",
      body: (
        <>
          It's on your booking confirmation, boarding pass, or airline app — two letters plus 1–4
          digits, like <span className="font-mono text-secondary">{example}</span>. The digits alone
          work too; the checker assumes {short}.
        </>
      ),
      text: `Find your flight number on your booking confirmation, boarding pass, or airline app — two letters plus 1-4 digits, like ${example}.`,
    },
    {
      name: "Enter it in the flight checker with your date",
      body: (
        <>
          Open the{" "}
          <a href="/check-flight" className="text-accent hover:underline">
            flight checker
          </a>
          , type the flight number, pick your travel date, and hit Check. The answer comes straight
          from the live database — no signup.
        </>
      ),
      text: `Open the flight checker at https://${host}/check-flight, enter the flight number and travel date, and hit Check.`,
    },
    {
      name: "Read the answer by its confidence",
      body: (
        <>
          Within about 2 days of departure, {cfg.name} has assigned an actual aircraft, so the
          answer reflects {verifiedClaim}. Further out, no aircraft is assigned yet — you get a
          probability built from which aircraft recently flew that flight number, clearly labeled as
          an estimate.
        </>
      ),
      text: "Within ~2 days of departure the answer reflects the actual assigned aircraft; further out it is a labeled probability based on which aircraft recently flew that flight number.",
    },
    {
      name: "Re-check close to departure",
      body: (
        <>
          Aircraft swaps happen up to the gate. Check again the day before you fly — the page
          updates continuously as assignments firm up.
        </>
      ),
      text: "Aircraft swaps happen up to the gate, so re-check the day before you fly — the answer updates continuously as assignments firm up.",
    },
  ];

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            How to Check If Your {short} Flight Has Starlink
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Whether a flight has Starlink depends on the aircraft, not the route — here's how to get a
          real answer in under a minute.
        </p>
      </header>

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-4">
            Check by flight number
          </h2>
          <ol className="space-y-4">
            {steps.map((s, i) => (
              <li key={s.name} className="flex gap-3">
                <span className="font-mono text-sm text-accent shrink-0 w-6 text-right">
                  {i + 1}.
                </span>
                <div>
                  <div className="text-secondary font-medium font-display">{s.name}</div>
                  <p className="text-sm text-muted leading-relaxed mt-1">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-5 text-center">
            <a
              href="/check-flight"
              className="inline-block bg-accent/20 border border-accent text-accent font-display font-semibold py-2 px-6 rounded hover:bg-accent/30 transition-colors"
            >
              Check your flight →
            </a>
          </div>
        </section>

        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">Other ways</h2>
          <ul className="space-y-3 text-sm text-muted leading-relaxed">
            <li className="pl-4 border-l-2 border-subtle">
              <span className="text-secondary font-medium">By tail number.</span> The aircraft's
              registration (on the fuselage near the tail, or in most airline apps) can be searched
              on the{" "}
              <a href="/" className="text-accent hover:underline">
                homepage tracker
              </a>{" "}
              to see its exact WiFi status.
            </li>
            {site.features.chromeExtension && (
              <li className="pl-4 border-l-2 border-subtle">
                <span className="text-secondary font-medium">While shopping for flights.</span> The
                free{" "}
                <a
                  href="https://chromewebstore.google.com/detail/google-flights-starlink-i/jjfljoifenkfdbldliakmmjhdkbhehoi"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Chrome extension
                </a>{" "}
                puts Starlink badges directly on Google Flights results.
              </li>
            )}
            {site.features.routePlannerPage && (
              <li className="pl-4 border-l-2 border-subtle">
                <span className="text-secondary font-medium">Before you book.</span> The{" "}
                <a href="/route-planner" className="text-accent hover:underline">
                  route planner
                </a>{" "}
                ranks flights between two cities by Starlink probability, so you can pick the
                routing with coverage the whole way.
              </li>
            )}
            <li className="pl-4 border-l-2 border-subtle">
              <span className="text-secondary font-medium">On the airline's own site.</span>{" "}
              {cfg.verifierBackend === "united" ? (
                <>
                  Once an aircraft is assigned, {cfg.verifySite}'s flight status page lists the WiFi
                  provider for your flight — that's the same source this tracker verifies against
                  every minute.
                </>
              ) : (
                <>
                  {cfg.verifySite} shows the scheduled aircraft for your flight, which determines
                  the WiFi system on board.
                </>
              )}
            </li>
          </ul>
        </section>

        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">
            What the answer means
          </h2>
          <p className="text-sm text-muted leading-relaxed">
            A <span className="text-secondary">verified yes</span> means we observed the assigned
            aircraft's status directly; a <span className="text-secondary">probability</span> means
            no aircraft is assigned yet and the number reflects that flight's recent history — not a
            guarantee. Some {short} aircraft still carry older WiFi systems while the{" "}
            <a href="/fleet" className="text-accent hover:underline">
              rollout
            </a>{" "}
            continues, so "has WiFi" and "has Starlink" are not the same question.
            {site.features.intentPages && (
              <>
                {" "}
                Wondering about the price?{" "}
                <a href="/is-starlink-free" className="text-accent hover:underline">
                  Starlink WiFi is free
                </a>
                .
              </>
            )}
          </p>
        </section>
      </div>

      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </div>

      <PageFooter site={site} />

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD built from static registry-driven copy
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "HowTo",
            name: `How to check if a ${cfg.name} flight has Starlink WiFi`,
            description: `Check any ${cfg.name} flight for free Starlink WiFi by flight number and date, with verified answers near departure and labeled probabilities further out.`,
            totalTime: "PT1M",
            step: steps.map((s, i) => ({
              "@type": "HowToStep",
              position: i + 1,
              name: s.name,
              text: s.text,
            })),
          }).replace(/</g, "\\u003c"),
        }}
      />
    </div>
  );
}
