/**
 * Structured data and the FAQ that feeds it. The visible Q&A and the FAQPage
 * JSON-LD are built from one list, so the markup can never describe answers
 * the page doesn't show (Google's rule, and how two copies drifted before).
 */
import type React from "react";
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
