/**
 * The one FAQ renderer and the one FAQPage JSON-LD builder. The visible Q&A
 * and the structured data come from the same entries, so the markup can never
 * describe answers the page doesn't show (Google's rule, and how two copies
 * drifted before). Homepage entries are functions of the stats; homeFaqItems
 * resolves them into plain entries first.
 */
import type React from "react";
import ReactDOMServer from "react-dom/server";
import type { ContentStats, FaqSection, FaqEntry as HomeFaqEntry } from "../airlines/content";
import { Eyebrow, PANEL, SECTION, SectionTitle } from "./layout";

export interface FaqEntry {
  q: string;
  /** Visible answer. */
  a: React.ReactNode;
  /** Plain-text answer for JSON-LD; derived from `a` when omitted. */
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
function answerText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  const html = ReactDOMServer.renderToStaticMarkup(node as React.ReactElement);
  return html
    .replace(/<\/p>\s*<p[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#x27|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim();
}

export function faqJsonLd(items: FaqEntry[], dateModified?: string) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    dateModified,
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.ld ?? answerText(item.a) },
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

export const homeFaqItems = (entries: HomeFaqEntry[], stats: ContentStats): FaqEntry[] =>
  entries.map((e) => ({ q: e.q, a: e.a(stats) }));

/** Homepage FAQPage JSON-LD as a <script> block, answers rendered from the components the reader sees. */
export function homeFaqJsonLd(
  entries: HomeFaqEntry[],
  stats: ContentStats,
  dateModified?: string
): string {
  if (entries.length === 0) return "";
  const json = jsonLdString(faqJsonLd(homeFaqItems(entries, stats), dateModified));
  return `<script type="application/ld+json">${json}</script>`;
}

function Accordion({ item }: { item: FaqEntry }) {
  return (
    <details className="group py-4">
      <summary className="flex cursor-pointer list-none items-start justify-between">
        <h3 className="font-display text-base text-secondary transition-colors group-hover:text-accent">
          {item.q}
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
      <div className="mt-3 text-sm leading-relaxed text-secondary">{item.a}</div>
    </details>
  );
}

/**
 * Questions and answers under one heading. "open" lists them (short answers
 * read faster than they click), "grid" sets the head questions two-up, and
 * "accordion" folds grouped `sections` behind their questions; "card" puts
 * the heading inside the panel, for pages built from a stack of cards. JSON-LD is on
 * by default; pages whose handler emits it, or that are noindex, turn it off.
 */
export function Faq({
  items = [],
  sections,
  title = "Questions",
  variant = "open",
  id,
  structuredData = true,
}: {
  items?: FaqEntry[];
  sections?: Array<{ title: string; items: FaqEntry[] }>;
  title?: string;
  variant?: "open" | "grid" | "accordion" | "card";
  id?: string;
  structuredData?: boolean;
}) {
  const all = sections ? sections.flatMap((s) => s.items) : items;
  if (all.length === 0) return null;
  const list = (
    <dl className="space-y-5">
      {all.map((item) => (
        <div key={item.q}>
          <dt className="font-semibold text-primary">{item.q}</dt>
          <dd className="mt-1 text-sm leading-relaxed text-secondary">{item.a}</dd>
        </div>
      ))}
    </dl>
  );
  if (variant === "card") {
    return (
      <section id={id} className={`${PANEL} mb-4`}>
        <SectionTitle className="mb-3">{title}</SectionTitle>
        {list}
        {structuredData && <JsonLd data={faqJsonLd(all)} />}
      </section>
    );
  }
  return (
    <section id={id} className={`${SECTION} scroll-mt-4`}>
      <SectionTitle>{title}</SectionTitle>
      {variant === "accordion" && sections ? (
        sections.map((s) => (
          <div key={s.title} className="mt-4">
            <Eyebrow as="h3" className="mb-2">
              {s.title}
            </Eyebrow>
            <div className="divide-y divide-subtle rounded-lg border border-subtle bg-surface px-5">
              {s.items.map((item) => (
                <Accordion key={item.q} item={item} />
              ))}
            </div>
          </div>
        ))
      ) : variant === "grid" ? (
        <div className={`${PANEL} mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2`}>
          {all.map((item) => (
            <div key={item.q}>
              <h3 className="font-display text-base text-primary">{item.q}</h3>
              <div className="mt-1 text-sm leading-relaxed text-secondary">{item.a}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className={`${PANEL} mt-4`}>{list}</div>
      )}
      {structuredData && <JsonLd data={faqJsonLd(all)} />}
    </section>
  );
}

/** A homepage's grouped FAQ, resolved against its stats. */
export const homeFaqSections = (sections: FaqSection[], stats: ContentStats) =>
  sections.map((s) => ({ title: s.title, items: homeFaqItems(s.items, stats) }));
