import React from "react";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { PageFooter } from "./atoms";

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
      "Yes — United Starlink WiFi is free for MileagePlus members, and MileagePlus itself is free to join. No purchase, no elite status, no data caps.",
    access:
      "On board, connect to the WiFi network and sign in with your MileagePlus number (or join free on the spot). It works gate to gate — no waiting for 10,000 feet.",
  },
};

export function hasFreeAnswer(code: string): boolean {
  return code in ACCESS;
}

interface IsStarlinkFreePageProps {
  site: SiteConfig;
  starlinkCount: number;
  totalCount: number;
}

export default function IsStarlinkFreePage({
  site,
  starlinkCount,
  totalCount,
}: IsStarlinkFreePageProps) {
  const cfg = siteAirline(site);
  const copy = ACCESS[cfg.code];
  const short = cfg.shortName;

  const faq = [
    {
      q: `Is ${short} Starlink WiFi free?`,
      a: copy.answer,
    },
    {
      q: "How fast is it?",
      a: "Real-world speeds run in the 100-250 Mbps range with low latency — enough for streaming, video calls, gaming, and VPNs, on every device you bring.",
    },
    {
      q: `Does every ${short} flight have it?`,
      a: `Not yet — ${starlinkCount} of ${totalCount} ${cfg.name} aircraft have Starlink today, and whether your flight has it depends on the aircraft assigned, not the route. Aircraft without Starlink still carry the older WiFi systems, which are typically paid.`,
    },
  ];

  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            Is {short} Starlink WiFi Free?
          </h1>
        </a>
        <p className="text-base text-secondary font-display max-w-xl mx-auto">
          Short answer: yes. Here's the fine print, what you actually get, and how to know whether
          your flight has it.
        </p>
      </header>

      <div className="relative max-w-2xl mx-auto w-full mb-8">
        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">The answer</h2>
          <p className="text-sm text-secondary leading-relaxed font-medium">{copy.answer}</p>
          <p className="text-sm text-muted leading-relaxed mt-3">{copy.access}</p>
        </section>

        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">What you get</h2>
          <ul className="space-y-2 text-sm text-muted leading-relaxed list-disc pl-5">
            <li>
              <span className="text-secondary">100–250 Mbps</span> real-world speeds with low
              latency — streaming, video calls, gaming, and VPNs all work.
            </li>
            <li>
              <span className="text-secondary">Gate-to-gate</span> coverage, including over oceans
              and remote terrain where older air-to-ground systems drop out.
            </li>
            <li>
              <span className="text-secondary">No data caps or speed tiers</span> — the same service
              for every passenger, on multiple devices.
            </li>
          </ul>
        </section>

        <section className="bg-surface rounded-lg border border-subtle p-5 sm:p-6 mb-4">
          <h2 className="font-display text-lg font-semibold text-primary mb-3">The one catch</h2>
          <p className="text-sm text-muted leading-relaxed">
            Free Starlink is only on Starlink-equipped aircraft —{" "}
            <span className="text-secondary font-mono">
              {starlinkCount.toLocaleString("en-US")} of {totalCount.toLocaleString("en-US")}
            </span>{" "}
            {cfg.name} aircraft today, with more added weekly. Aircraft still awaiting installation
            carry the older Viasat, Panasonic, or Thales systems, which are slower and usually paid.
            Whether <em>your</em> flight has Starlink depends on the aircraft assigned, so{" "}
            <a href="/check-flight" className="text-accent hover:underline">
              check your flight number and date
            </a>{" "}
            — the answer is verified near departure and updates continuously.
          </p>
          {site.features.timelinePage && (
            <p className="text-sm text-muted leading-relaxed mt-3">
              Curious how fast the gap is closing? See the{" "}
              <a href="/timeline" className="text-accent hover:underline">
                rollout timeline
              </a>
              .
            </p>
          )}
        </section>

        <div className="text-center mb-2">
          <a
            href="/check-flight"
            className="inline-block bg-accent/20 border border-accent text-accent font-display font-semibold py-2 px-6 rounded hover:bg-accent/30 transition-colors"
          >
            Does my flight have Starlink? →
          </a>
        </div>
      </div>

      <div className="relative text-center mb-6">
        <a href="/" className="text-sm text-accent hover:underline font-display">
          ← Back to {site.brand.title}
        </a>
      </div>

      <PageFooter site={site} />

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD built from static per-airline copy + live counts
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faq.map((f) => ({
              "@type": "Question",
              name: f.q,
              acceptedAnswer: { "@type": "Answer", text: f.a },
            })),
          }).replace(/</g, "\\u003c"),
        }}
      />
    </div>
  );
}
