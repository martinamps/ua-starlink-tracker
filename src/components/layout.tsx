/**
 * The page shell every HTML page shares: the site bar, the page header, the
 * footer, and the few typographic primitives (sections, inline stats, bar rows,
 * table cells) that pages had been hand-copying with drifting sizes. A page
 * body owns its content; it should not own its chrome.
 */
import type React from "react";
import { normalizeAircraftType } from "../airlines/aircraft-families";
import { AIRLINES, type SiteConfig } from "../airlines/registry";
import { CrossSiteLinks, type PageLink, PageNavLinks } from "./atoms";

/** Thousands-separated integer or decimal, the one number format pages use. */
export function fmt(n: number, maximumFractionDigits = 0): string {
  return n.toLocaleString("en-US", { maximumFractionDigits });
}

/** Share as "35%", floored so no page claims more than the data: "100%" only
 * when every aircraft has it, ">99%" and "<1%" at the edges. */
export function pct(n: number, total: number): string {
  if (total <= 0) return "0%";
  if (n >= total) return "100%";
  const p = (n / total) * 100;
  if (p > 99) return ">99%";
  if (p > 0 && p < 1) return "<1%";
  return `${Math.floor(p)}%`;
}

const FAMILY_DISPLAY: Record<string, string> = {
  "B737-MAX8": "737 MAX 8",
  "B737-MAX9": "737 MAX 9",
  "B737-MAX10": "737 MAX 10",
  "B737-700": "737-700",
  "B737-800": "737-800",
  "B737-900": "737-900",
  B737F: "737 Freighter",
  B717: "717",
  B747: "747",
  B747F: "747 Freighter",
  B757: "757",
  B767: "767",
  B777: "777",
  B777F: "777 Freighter",
  B787: "787",
  "CRJ-200": "CRJ200",
  "CRJ-550": "CRJ550",
  "CRJ-700": "CRJ700",
  "ERJ-145": "ERJ-145",
};

/**
 * Short display name for any aircraft-type string — FR24 names, sheet headers
 * ("B737-MAX9", "E175SC") and family keys alike — via the one normalizer, so a
 * page never shows "E175" and "ERJ-175" for the same aircraft. Display only:
 * grouping and counting still key on normalizeAircraftType.
 */
export function aircraftName(raw: string | null | undefined): string {
  const family = normalizeAircraftType(raw);
  if (family === "other" || family === "unknown") return raw?.trim() || "Unknown";
  return FAMILY_DISPLAY[family] ?? family;
}

export interface NavLink {
  href: string;
  label: string;
}

/**
 * Primary nav, one list for the site bar and the footer so the two never
 * disagree on a label. Feature-gated exactly like the routes themselves.
 */
export function primaryNavLinks(site: SiteConfig): NavLink[] {
  const f = site.features;
  return [
    ...(f.checkFlightPage ? [{ href: "/check-flight", label: "Check a flight" }] : []),
    ...(f.routePlannerPage ? [{ href: "/route-planner", label: "Route planner" }] : []),
    ...(f.airlinesPages ? [{ href: "/airlines", label: "Airlines" }] : []),
    ...(f.fleetPage ? [{ href: "/fleet", label: "Fleet" }] : []),
    ...(f.routesPage ? [{ href: "/routes", label: "Live routes" }] : []),
    ...(f.timelinePage ? [{ href: "/timeline", label: "Timeline" }] : []),
    ...(f.mcpPage ? [{ href: "/mcp", label: "MCP" }] : []),
  ];
}

/** Brand text for the site bar. The hub keeps its comparison-intent name so
 * it never reads as a rival "X Starlink Tracker" to its own tenants. */
function brandName(site: SiteConfig): string {
  if (site.scope === "ALL") return "Airlines with Starlink";
  return `${AIRLINES[site.scope]?.shortName ?? site.brand.title} Starlink Tracker`;
}

export function SiteBar({ site, currentPath }: { site: SiteConfig; currentPath?: string }) {
  const links = primaryNavLinks(site);
  const isCurrent = (href: string) =>
    currentPath === href || (href !== "/" && currentPath?.startsWith(`${href}/`));
  return (
    <nav
      aria-label="Primary"
      className="relative mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-subtle py-3 text-sm"
    >
      <a
        href="/"
        className="font-display text-lg text-primary hover:text-accent transition-colors whitespace-nowrap"
        aria-current={currentPath === "/" ? "page" : undefined}
      >
        {brandName(site)}
      </a>
      {links.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 whitespace-nowrap sm:gap-x-5">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                aria-current={isCurrent(l.href) ? "page" : undefined}
                className={
                  isCurrent(l.href)
                    ? "text-primary"
                    : "text-secondary hover:text-accent transition-colors"
                }
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** Small uppercase label above a panel's content. */
export const EYEBROW = "mb-3 font-mono text-xs uppercase tracking-wider text-muted";
export const PANEL = "rounded-lg border border-subtle bg-surface p-5";
/** Section frames for bodies that don't use <Section>: reading width and data width. */
export const SECTION = "relative mx-auto mb-8 w-full max-w-3xl";
export const SECTION_WIDE = "relative mx-auto mb-8 w-full max-w-6xl";
export const H1 = "font-display text-3xl sm:text-4xl tracking-tight text-primary text-balance";
export const H2 = "font-display text-xl text-primary";

export function PageHeader({
  eyebrow,
  title,
  dek,
  children,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  dek?: React.ReactNode;
  /** Anything that belongs to the header but isn't prose — a stat strip. */
  children?: React.ReactNode;
}) {
  return (
    <header className="relative mx-auto w-full max-w-3xl pt-8 pb-6 text-center">
      {eyebrow && (
        <div className="mb-2 font-mono text-xs uppercase tracking-wider text-muted">{eyebrow}</div>
      )}
      <h1 className={H1}>{title}</h1>
      {dek && <p className="mx-auto mt-2 max-w-2xl text-base text-secondary text-pretty">{dek}</p>}
      {children && <div className="mt-3">{children}</div>}
    </header>
  );
}

export function Section({
  title,
  dek,
  wide = false,
  bare = false,
  id,
  className = "",
  children,
}: {
  title?: React.ReactNode;
  dek?: React.ReactNode;
  /** max-w-6xl for data-dense sections; the default is the max-w-3xl reading width. */
  wide?: boolean;
  /** Skip the panel around the body, for content that brings its own cards. */
  bare?: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={`relative mx-auto mb-8 w-full ${wide ? "max-w-6xl" : "max-w-3xl"} ${className}`}
    >
      {title && <h2 className={H2}>{title}</h2>}
      {dek && <p className="mt-1 text-sm text-secondary text-pretty">{dek}</p>}
      <div className={`${title || dek ? "mt-4" : ""} ${bare ? "" : PANEL}`}>{children}</div>
    </section>
  );
}

/** A number inside a sentence: same face as the prose, heavier and aligned. */
export function StatInline({ n, children }: { n?: number; children?: React.ReactNode }) {
  return (
    <strong className="font-semibold text-primary tabular-nums">
      {n !== undefined ? fmt(n) : children}
    </strong>
  );
}

export function BarRow({
  label,
  href,
  n,
  total,
}: {
  label: React.ReactNode;
  href?: string;
  n: number;
  total: number;
}) {
  const share = total > 0 ? Math.min(100, (n / total) * 100) : 0;
  const text = typeof label === "string" ? label : "";
  return (
    <li className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 py-1.5 text-sm">
      {href ? (
        <a href={href} className="truncate text-secondary hover:text-accent transition-colors">
          {label}
        </a>
      ) : (
        <span className="truncate text-secondary">{label}</span>
      )}
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-elevated"
        role="img"
        aria-label={`${text}: ${fmt(n)} of ${fmt(total)} (${pct(n, total)})`}
      >
        <div
          className="h-full rounded-full bg-[var(--color-accent)]"
          style={{ width: `${share}%` }}
        />
      </div>
      <span className="font-mono text-xs text-muted tabular-nums whitespace-nowrap">
        {fmt(n)}/{fmt(total)} · {pct(n, total)}
      </span>
    </li>
  );
}

export const TH =
  "border-b border-subtle pb-2 text-left font-mono text-xs uppercase tracking-wider text-muted";
export const TD = "border-b border-subtle py-2 tabular-nums";

export function Th({
  numeric = false,
  optional = false,
  children,
}: {
  numeric?: boolean;
  /** Hidden below sm — for low-priority columns. */
  optional?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <th
      scope="col"
      className={`${TH} ${numeric ? "text-right" : ""} ${optional ? "hidden sm:table-cell" : ""}`}
    >
      {children}
    </th>
  );
}

export function Td({
  numeric = false,
  optional = false,
  className = "",
  children,
}: {
  numeric?: boolean;
  optional?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <td
      className={`${TD} ${numeric ? "text-right" : ""} ${optional ? "hidden sm:table-cell" : ""} ${className}`}
    >
      {children}
    </td>
  );
}

export function SiteFooter({ site, pageLinks }: { site: SiteConfig; pageLinks?: PageLink[] }) {
  return (
    <footer className="relative mt-auto border-t border-subtle py-6 text-center text-sm text-muted">
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4">
        <a
          href="https://x.com/martinamps"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center text-secondary hover:text-primary transition-colors"
        >
          Built with
          <svg
            className="w-4 h-4 mx-1 text-red-400"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-label="Heart"
            role="img"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
          by @martinamps
        </a>
        <span className="text-subtle" aria-hidden="true">
          ·
        </span>
        <a
          href="https://github.com/martinamps/ua-starlink-tracker"
          target="_blank"
          rel="noopener noreferrer"
          className="text-secondary hover:text-primary transition-colors"
        >
          GitHub
        </a>
        {site.features.intentPages && (
          <>
            <span className="text-subtle" aria-hidden="true">
              ·
            </span>
            <a
              href="/is-starlink-free"
              className="text-secondary hover:text-primary transition-colors"
            >
              Is it free?
            </a>
          </>
        )}
      </div>
      <PageNavLinks links={pageLinks} />
      <CrossSiteLinks site={site} />
    </footer>
  );
}

/**
 * Outer frame for every page: background, site bar, footer. `children` is the
 * page header plus body.
 */
export function PageShell({
  site,
  currentPath,
  pageLinks,
  before,
  children,
}: {
  site: SiteConfig;
  currentPath?: string;
  pageLinks?: PageLink[];
  /** Rendered above the site bar (the onboard passenger banner). */
  before?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />
      {before}
      <SiteBar site={site} currentPath={currentPath} />
      {children}
      <SiteFooter site={site} pageLinks={pageLinks} />
    </div>
  );
}
