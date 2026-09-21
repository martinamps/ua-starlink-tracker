import type { ReactNode } from "react";
import type { Aircraft, FleetStats, PerAirlineStat, RecentInstall } from "../../types";
import type { AirlineCode, KnownAirlineCode, SiteConfig, Tenant } from "../registry";
import { content as af } from "./af";
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
  /** The /install-rate page's measured pace (installs/month); null or absent
   * when there isn't enough organic history to state one. */
  installsPerMonth?: number | null;
  /** Newly equipped in the last 30 days; absent on the hub. */
  installs30d?: number;
  /** Installs per rolling 7-day window, oldest first (homepage sparkline). */
  weeklyInstalls?: number[];
  /** The data's own "as of" date, e.g. "September 20, 2026"; never the request clock. */
  asOf?: string;
  /** Hub only: one row per tracked airline. */
  perAirline?: PerAirlineStat[];
}

/**
 * One question and its answer. The FAQPage JSON-LD is rendered from `a`
 * itself (faqJsonLd), so the markup can never drift from the visible text.
 */
export interface FaqEntry {
  q: string;
  a: (s: ContentStats) => ReactNode;
}

export interface FaqSection {
  title: string;
  items: FaqEntry[];
}

interface SubfleetFilter {
  key: string;
  label: string;
}

interface HubHomeLink {
  href: string;
  label: string;
}

export interface HubHomeLinks {
  airlines: HubHomeLink[];
  compares: HubHomeLink[];
}

export interface HeroProps {
  site: SiteConfig;
  stats: ContentStats;
  starlinkData: Aircraft[];
  perAirlineStats?: PerAirlineStat[];
  recentInstalls?: RecentInstall[];
  /** Hub only: server-rendered inlinks to every sitemapped airline and compare page. */
  hubLinks?: HubHomeLinks;
  /** Airline sites: the dated, citable stat sentence, placed by the hero. */
  statSentence?: ReactNode;
}

export interface AirlineContent {
  /** Header dek under the H1: inline content, one or two sentences. */
  intro: (s: ContentStats) => ReactNode;
  /** Stat strip under the dek (each entry rendered with · separators). */
  headerStats: ReactNode[] | ((s: ContentStats) => ReactNode[]);
  /** Bespoke stat panel — each airline composes its own from shared atoms. */
  Hero: (p: HeroProps) => ReactNode;
  /** The head questions, answered in full near the top of the homepage. */
  answers?: FaqEntry[];
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
  AF: af,
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

/** Every question a homepage renders, answer block first, in page order. */
export function allFaqEntries(content: AirlineContent): FaqEntry[] {
  return [...(content.answers ?? []), ...content.faq.flatMap((s) => s.items)];
}
