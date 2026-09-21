/**
 * FAQ renderers and the FAQPage JSON-LD built from them. The visible Q&A and
 * the structured data come from one list, so the markup can never describe
 * answers the page doesn't show (Google's rule, and how two copies drifted
 * before). `Faq` takes plain entries (flight and content pages); `HomeFaq` and
 * `AnswerBlock` take the homepage's stat-driven entries from content/.
 */
import type React from "react";
import ReactDOMServer from "react-dom/server";
import type { ContentStats, FaqSection, FaqEntry as HomeFaqEntry } from "../airlines/content";
import { H2 } from "./layout";

export interface FaqEntry {
  q: string;
  /** Visible answer. */
  a: React.ReactNode;
  /** Plain-text answer for JSON-LD; required when `a` isn't a string. */
  ld?: string;
}

/** Serialized JSON-LD, safe inside <script>: "<" is escaped so a string value
 * holding "</script>" can't end the block. */
export function jsonLdString(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

export function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by jsonLdString
      dangerouslySetInnerHTML={{ __html: jsonLdString(data) }}
    />
  );
}

export function faqJsonLd(items: FaqEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.ld ?? (typeof item.a === "string" ? item.a : ""),
      },
    })),
  };
}

export function breadcrumbJsonLd(host: string, crumbs: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `https://${host}${c.path}`,
    })),
  };
}

/** Open list of questions (no accordions: short answers read faster than they click). */
export function Faq({
  items,
  title = "Questions",
  structuredData = true,
}: {
  items: FaqEntry[];
  title?: string;
  /** Off on noindex pages, where FAQPage rich results are ignored anyway. */
  structuredData?: boolean;
}) {
  return (
    <section className="relative mx-auto mb-8 w-full max-w-3xl">
      <h2 className={H2}>{title}</h2>
      <dl className="mt-4 space-y-5 rounded-lg border border-subtle bg-surface p-5">
        {items.map((item) => (
          <div key={item.q}>
            <dt className="font-semibold text-primary">{item.q}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-secondary">{item.a}</dd>
          </div>
        ))}
      </dl>
      {structuredData && <JsonLd data={faqJsonLd(items)} />}
    </section>
  );
}

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

/** Homepage FAQPage JSON-LD, answers rendered from the same components the reader sees. */
export function homeFaqJsonLd(
  entries: HomeFaqEntry[],
  stats: ContentStats,
  dateModified?: string
): string {
  if (entries.length === 0) return "";
  const json = jsonLdString({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    dateModified,
    mainEntity: entries.map((e) => ({
      "@type": "Question",
      name: e.q,
      acceptedAnswer: { "@type": "Answer", text: answerText(e.a(stats)) },
    })),
  });
  return `<script type="application/ld+json">${json}</script>`;
}

/** The head questions, answered in the open: no accordion, first thing after the numbers. */
export function AnswerBlock({
  title,
  entries,
  stats,
}: {
  title: string;
  entries: HomeFaqEntry[];
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

export function HomeFaq({ sections, stats }: { sections: FaqSection[]; stats: ContentStats }) {
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
