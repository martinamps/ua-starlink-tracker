/**
 * The FAQ renderer and its FAQPage JSON-LD twin. The structured data is
 * rendered from the same answer components the reader sees, so Google's
 * "markup must match visible content" rule holds by construction instead of
 * by hand-synced strings.
 */
import type React from "react";
import ReactDOMServer from "react-dom/server";
import type { ContentStats, FaqEntry, FaqSection } from "../airlines/content";
import { H2 } from "./layout";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Plain text of a rendered answer: tags dropped, entities decoded, whitespace folded. */
export function answerText(node: React.ReactNode): string {
  const html = ReactDOMServer.renderToStaticMarkup(node as React.ReactElement);
  return html
    .replace(/<\/p>\s*<p[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim();
}

/** FAQPage JSON-LD for the given questions; "<" escaped so no value can close the script. */
export function faqJsonLd(entries: FaqEntry[], stats: ContentStats, dateModified?: string): string {
  if (entries.length === 0) return "";
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    dateModified,
    mainEntity: entries.map((e) => ({
      "@type": "Question",
      name: e.q,
      acceptedAnswer: { "@type": "Answer", text: answerText(e.a(stats)) },
    })),
  }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

/** The head questions, answered in the open: no accordion, first thing after the numbers. */
export function AnswerBlock({
  title,
  entries,
  stats,
}: {
  title: string;
  entries: FaqEntry[];
  stats: ContentStats;
}) {
  if (entries.length === 0) return null;
  return (
    <section id="answers" className="relative mx-auto mb-8 w-full max-w-3xl scroll-mt-4">
      <h2 className={H2}>{title}</h2>
      <div className="mt-4 grid gap-x-8 gap-y-5 rounded-lg border border-subtle bg-surface p-5 sm:grid-cols-2">
        {entries.map((e) => (
          <div key={e.q}>
            <h3 className="font-display text-base text-primary">{e.q}</h3>
            <div className="mt-1 text-sm leading-relaxed text-secondary">{e.a(stats)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FaqItem({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group py-4">
      <summary className="flex cursor-pointer list-none items-start justify-between">
        <h3 className="font-display text-base text-secondary transition-colors group-hover:text-accent">
          {q}
        </h3>
        <svg
          className="ml-4 h-4 w-4 flex-shrink-0 text-muted transition-transform group-open:rotate-45"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
          />
        </svg>
      </summary>
      <div className="mt-3 text-sm leading-relaxed text-secondary">{children}</div>
    </details>
  );
}

export function Faq({ sections, stats }: { sections: FaqSection[]; stats: ContentStats }) {
  if (sections.length === 0) return null;
  return (
    <section id="faq" className="relative mx-auto mb-8 w-full max-w-3xl scroll-mt-4">
      <h2 className={H2}>More questions</h2>
      {sections.map((section) => (
        <div key={section.title} className="mt-4">
          <h3 className="mb-2 font-mono text-xs uppercase tracking-wider text-muted">
            {section.title}
          </h3>
          <div className="divide-y divide-subtle rounded-lg border border-subtle bg-surface px-5">
            {section.items.map((item) => (
              <FaqItem key={item.q} q={item.q}>
                {item.a(stats)}
              </FaqItem>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
