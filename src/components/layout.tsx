/**
 * The page shell every HTML page shares (site bar, page header, footer) and
 * the typographic primitives pages compose: sections, panels, eyebrows,
 * inline stats, buttons, chips and table cells.
 */
import React from "react";
import { AIRLINES, SITES, type SiteConfig, liveAirlineSites } from "../airlines/registry";
import { type ClientScript, clientScriptSrc } from "../client/bundle";
import { fmt } from "./ui/format";

/** A page's browser bundle, content-hashed; nothing when it isn't built. */
export function ClientScriptTag({ name }: { name: ClientScript }) {
  const src = clientScriptSrc(name);
  return src ? <script src={src} defer /> : null;
}

export interface Link {
  href: string;
  label: string;
}

/** Inline prose link. */
export const LINK = "text-accent hover:underline";

/**
 * Primary nav, one list for the site bar and the footer so the two never
 * disagree on a label. Feature-gated exactly like the routes themselves.
 */
export function primaryNavLinks(site: SiteConfig): Link[] {
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

function SiteBar({ site, currentPath }: { site: SiteConfig; currentPath?: string }) {
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
const EYEBROW_TEXT = "font-mono text-xs uppercase tracking-wider text-muted";
export const EYEBROW = `mb-3 ${EYEBROW_TEXT}`;
const SURFACE = "rounded-lg border border-subtle bg-surface";
export const PANEL = `${SURFACE} p-5`;
/** Section frames for bodies that don't use <Section>: reading width and data width. */
export const SECTION = "relative mx-auto mb-8 w-full max-w-3xl";
export const SECTION_WIDE = "relative mx-auto mb-8 w-full max-w-6xl";
const H1 = "font-display text-3xl sm:text-4xl tracking-tight text-primary text-balance";
export const H2 = "font-display text-xl text-primary";

type Box = React.HTMLAttributes<HTMLElement> & { as?: "div" | "section" | "nav" | "aside" };

const PANEL_PAD = { md: "p-5", sm: "p-4 sm:p-5", none: "" } as const;

/** The surface card. Padding is a prop, not a className, so it never fights p-5. */
export function Panel({
  as: Tag = "div",
  pad = "md",
  className = "",
  children,
  ...rest
}: Box & { pad?: keyof typeof PANEL_PAD }) {
  return (
    <Tag className={`${SURFACE} ${PANEL_PAD[pad]} ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

/** Pass a margin class to replace the default mb-3. */
export function Eyebrow({
  as: Tag = "div",
  className = "mb-3",
  htmlFor,
  children,
}: {
  as?: "div" | "h2" | "h3" | "span" | "label";
  className?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <Tag className={`${EYEBROW_TEXT} ${className}`} {...(htmlFor ? { htmlFor } : {})}>
      {children}
    </Tag>
  );
}

export function SectionTitle({
  className = "",
  children,
}: { className?: string; children: React.ReactNode }) {
  return <h2 className={`${H2} ${className}`}>{children}</h2>;
}

const STAT_SIZE = { md: "text-3xl", lg: "text-4xl", xl: "text-5xl sm:text-6xl" } as const;

/** A headline number: display face, aligned figures, an optional muted unit. */
export function StatValue({
  size = "md",
  accent = false,
  unit,
  className = "",
  children,
}: {
  size?: keyof typeof STAT_SIZE;
  accent?: boolean;
  unit?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`font-display ${STAT_SIZE[size]} leading-none tabular-nums ${accent ? "text-accent" : "text-primary"} ${className}`}
    >
      {children}
      {unit && <span className="text-base text-muted"> {unit}</span>}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON: Record<`${ButtonVariant}-${ButtonSize}`, string> = {
  "primary-sm":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-accent bg-accent/20 px-3 py-1.5 font-display text-sm text-accent transition-colors hover:bg-accent/30",
  "primary-md":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-accent bg-accent/20 px-5 py-2 font-display text-accent transition-colors hover:bg-accent/30",
  "primary-lg":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-accent bg-accent/20 px-5 py-3 font-display text-accent transition-colors hover:bg-accent/30",
  "secondary-sm":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-subtle bg-surface-elevated px-3 py-1.5 font-display text-sm text-secondary transition-colors hover:border-accent hover:text-accent",
  "secondary-md":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-subtle bg-surface-elevated px-5 py-2 font-display text-secondary transition-colors hover:border-accent hover:text-accent",
  "secondary-lg":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-subtle bg-surface-elevated px-5 py-3 font-display text-secondary transition-colors hover:border-accent hover:text-accent",
};

/** Classes for a <button> or a link styled as one. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md"): string {
  return BUTTON[`${variant}-${size}`];
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <a className={`${buttonClass(variant, size)} ${className}`} {...rest}>
      {children}
    </a>
  );
}

const CHIP = {
  sm: "inline-block rounded border border-subtle bg-surface-elevated px-2.5 py-1 font-mono text-xs text-secondary transition-colors hover:border-accent hover:text-accent",
  md: "inline-block rounded border border-subtle bg-surface-elevated px-2.5 py-1 font-mono text-sm text-secondary transition-colors hover:border-accent hover:text-accent",
} as const;

export const chipClass = (size: keyof typeof CHIP = "md") => CHIP[size];

/** A small link tag: flight numbers, routes, airline pairs. */
export function Chip({
  href,
  size = "md",
  children,
}: {
  href: string;
  size?: keyof typeof CHIP;
  children: React.ReactNode;
}) {
  return (
    <a href={href} className={CHIP[size]}>
      {children}
    </a>
  );
}

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
      {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
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
    <section id={id} className={`${wide ? SECTION_WIDE : SECTION} ${className}`}>
      {title && <SectionTitle>{title}</SectionTitle>}
      {dek && <p className="mt-1 text-sm text-secondary text-pretty">{dek}</p>}
      {bare ? (
        <div className={title || dek ? "mt-4" : ""}>{children}</div>
      ) : (
        <Panel className={title || dek ? "mt-4" : ""}>{children}</Panel>
      )}
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

const TH = `border-b border-subtle pb-2 pr-3 last:pr-0 text-left ${EYEBROW_TEXT}`;
const TD = "border-b border-subtle py-2 tabular-nums";

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

/**
 * One-line cross-domain footer links, rendered on every site. Registry-derived
 * (live sites only) and plain followed links — the sister domains are the same
 * publisher, so no nofollow. The hub, whose site bar already carries
 * /airlines, links only its sisters.
 */
function CrossSiteLinks({ site }: { site: SiteConfig }) {
  const links: Link[] = liveAirlineSites()
    .filter(({ site: s }) => s.key !== site.key)
    .map(({ site: s, airline }) => ({
      href: `https://${s.canonicalHost}/`,
      label: `${airline.shortName} Starlink tracker`,
    }));
  if (site.scope !== "ALL") {
    links.push({
      href: `https://${SITES.airline.canonicalHost}/airlines`,
      label: "All airlines with Starlink",
    });
  }
  // data-cross-site-links marks the block as a deliberate cross-tenant
  // mention — the tenant-matrix canary sweep strips it before scanning.
  return (
    <div data-cross-site-links className="mt-3 text-xs text-muted">
      Also tracking:{" "}
      {links.map((l, i) => (
        <React.Fragment key={l.href}>
          {i > 0 && <span className="mx-1.5 text-subtle">·</span>}
          <a href={l.href} className="text-secondary hover:text-primary transition-colors">
            {l.label}
          </a>
        </React.Fragment>
      ))}
    </div>
  );
}

/**
 * Internal nav for the secondary URL families (/newly-equipped, /install-rate,
 * /embed). They are sitemapped and indexable, so without an inbound href from
 * a real page they are orphans — no PageRank path in and no way for a human to
 * find them. The server builds this list from the same sitePages() filter the
 * sitemap uses (feature flag AND data gate), so a link here can never point at
 * a 404, and the current page is dropped so nothing self-links.
 */
function PageNavLinks({ links }: { links?: Link[] }) {
  if (!links?.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
      {links.map((l, i) => (
        <React.Fragment key={l.href}>
          {i > 0 && <span className="text-subtle">·</span>}
          <a href={l.href} className="text-secondary hover:text-primary transition-colors">
            {l.label}
          </a>
        </React.Fragment>
      ))}
    </div>
  );
}

function SiteFooter({ site, pageLinks }: { site: SiteConfig; pageLinks?: Link[] }) {
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
            className="w-4 h-4 mx-1 text-danger"
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
  pageLinks?: Link[];
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
