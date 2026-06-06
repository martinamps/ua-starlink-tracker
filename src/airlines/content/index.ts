import type { ReactNode } from "react";
import type { Aircraft, FleetStats, PerAirlineStat, RecentInstall } from "../../types";
import type { AirlineCode, KnownAirlineCode, Tenant } from "../registry";
import { content as as } from "./as";
import { content as ha } from "./ha";
import { content as hub } from "./hub";
import { content as qr } from "./qr";
import { content as ua } from "./ua";

export interface ContentStats {
  starlinkCount: number;
  totalCount: number;
  percentage: string;
  fleetStats?: FleetStats | null;
}

export interface FaqEntry {
  q: string;
  a: (s: ContentStats) => ReactNode;
  ld: string;
}

export interface FaqSection {
  title: string;
  items: FaqEntry[];
}

export interface SubfleetFilter {
  key: string;
  label: string;
}

export interface HeroProps {
  stats: ContentStats;
  starlinkData: Aircraft[];
  perAirlineStats?: PerAirlineStat[];
  recentInstalls?: RecentInstall[];
}

export interface AirlineContent {
  intro: (s: ContentStats) => ReactNode;
  /** Stat strip under the tagline (each entry rendered with · separators). */
  headerStats: ReactNode[];
  /** Bespoke stat panel — each airline composes its own from shared atoms. */
  Hero: (p: HeroProps) => ReactNode;
  /** Optional per-row badge under tail number (e.g. UA mainline/express). null = no badge. */
  rowBadge: (plane: Aircraft, airline: string) => string | null;
  /** Filter buttons next to search (UA: mainline/express). Empty = ALL only. */
  subfleetFilters: SubfleetFilter[];
  faq: FaqSection[];
}

// Exhaustive over the registry: adding an airline without homepage content is
// a compile error, never a silent fallback to another tenant's copy.
const CONTENT: Record<KnownAirlineCode, AirlineContent> = {
  UA: ua,
  HA: ha,
  AS: as,
  QR: qr,
};

// Widened view for runtime lookup by arbitrary code — typed possibly-undefined
// so the guard below stays honest (no cast pretending the key is known).
const contentByCode: Partial<Record<AirlineCode, AirlineContent>> = CONTENT;

export function getContent(tenant: Tenant): AirlineContent {
  if (tenant === "ALL") return hub;
  const content = contentByCode[tenant.code];
  if (!content) {
    throw new Error(`no homepage content registered for airline ${tenant.code}`);
  }
  return content;
}

export function buildFaqJsonLd(content: AirlineContent, currentDate: string): string {
  const entities = content.faq.flatMap((section) =>
    section.items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.ld },
    }))
  );
  const json = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    dateModified: currentDate,
    mainEntity: entities,
  });
  return `<script type="application/ld+json">${json}</script>`;
}
