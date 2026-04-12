import type { ReactNode } from "react";
import type { Aircraft, FleetStats, PerAirlineStat, RecentInstall } from "../../types";
import type { Tenant } from "../registry";
import { content as ha } from "./ha";
import { content as hub } from "./hub";
import { content as ua } from "./ua";

export interface ContentStats {
  starlinkCount: number;
  totalCount: number;
  percentage: string;
  fleetStats?: FleetStats;
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
  /** Show check-flight / route-planner / fleet / mcp nav pills. */
  showNavLinks: boolean;
  /** Bespoke stat panel — each airline composes its own from shared atoms. */
  Hero: (p: HeroProps) => ReactNode;
  /** Optional per-row badge under tail number (e.g. UA mainline/express). null = no badge. */
  rowBadge: (plane: Aircraft, airline: string) => string | null;
  /** Filter buttons next to search (UA: mainline/express). Empty = ALL only. */
  subfleetFilters: SubfleetFilter[];
  faq: FaqSection[];
}

const CONTENT: Record<string, AirlineContent> = {
  UA: ua,
  HA: ha,
};

export function getContent(tenant: Tenant): AirlineContent {
  if (tenant === "ALL") return hub;
  return CONTENT[tenant.code] ?? hub;
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
