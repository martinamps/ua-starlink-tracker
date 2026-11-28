/**
 * The page shell every HTML page shares (site bar, page header, footer) and
 * the typographic primitives pages compose: sections, panels, eyebrows,
 * inline stats, buttons, chips and table cells.
 */
import React from "react";
import { AIRLINES, SITES, type SiteConfig, liveAirlineSites } from "../airlines/registry";
import { type ClientScript, clientScriptSrc } from "../client/bundle";
import { EYEBROW_TEXT, PANEL_PAD, SURFACE, TABLE, TABLE_FRAME } from "./ui/box-classes";
import { fmt } from "./ui/format";
import { SLASHED_AIRPORT_WORDS } from "./ui/slashed-airport-words";

/** A page's browser bundle, content-hashed; nothing when it isn't built. */
export function ClientScriptTag({ name }: { name: ClientScript }) {
  const src = clientScriptSrc(name);
  return src ? <script src={src} defer /> : null;
}

export interface Link {
  href: string;
  label: string;
}

/** The hub home's flight-check panel: the menu's "Check a flight" lands on it. */
export const HUB_CHECK_ANCHOR = "check";

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
    // The hub has no flight page: its check is the home page's first panel.
    ...(!f.checkFlightPage && site.scope === "ALL"
      ? [{ href: `/#${HUB_CHECK_ANCHOR}`, label: "Check a flight" }]
      : []),
    ...(f.routePlannerPage ? [{ href: "/route-planner", label: "Route planner" }] : []),
    ...(f.airlinesPages ? [{ href: "/airlines", label: "Airlines" }] : []),
    ...(f.fleetPage ? [{ href: "/fleet", label: "Fleet" }] : []),
    ...(f.routesPage ? [{ href: "/routes", label: "Live routes" }] : []),
    ...(f.timelinePage ? [{ href: "/timeline", label: "Timeline" }] : []),
    ...(f.chromeExtension ? [{ href: "/chrome", label: "Extension" }] : []),
    // The page sets the tracker up in Claude and other AI assistants; "MCP" named the protocol.
    ...(f.mcpPage ? [{ href: "/mcp", label: "AI assistants" }] : []),
  ];
}

/** Brand text for the site bar. The hub keeps its comparison-intent name so
 * it never reads as a rival "X Starlink Tracker" to its own tenants. */
function brandName(site: SiteConfig): string {
  if (site.scope === "ALL") return "Airlines with Starlink";
  return `${AIRLINES[site.scope]?.shortName ?? site.brand.title} Starlink Tracker`;
}

/** Who runs the site, on every page: an airline's own tracker can carry
 * nearly the same name, and a visitor should never take one for the other.
 * The hub names no airline; a tenant names only its own. "Community-oriented",
 * never "community-run": one person runs the site (README). */
export function independenceLine(site: SiteConfig): string {
  const airline =
    site.scope === "ALL" ? "any airline" : (AIRLINES[site.scope]?.name ?? "the airline");
  return `Independent, community-oriented and open source. Not affiliated with ${airline} or SpaceX.`;
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
      </a>{" "}
      {links.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 whitespace-nowrap sm:gap-x-5">
          {links.map((l) => (
            <React.Fragment key={l.href}>
              <li>
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
              </li>{" "}
            </React.Fragment>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** Small uppercase label above a panel's content. */
export const EYEBROW = `mb-3 ${EYEBROW_TEXT}`;
export const PANEL = `${SURFACE} p-5`;
/** Section frames for bodies that don't use <Section>: reading width and data width. */
export const SECTION = "relative mx-auto mb-8 w-full max-w-3xl";
export const SECTION_WIDE = "relative mx-auto mb-8 w-full max-w-6xl";
// wrap-break-word is the last resort for a word wider than a phone's column;
// headingWords offers the better break first, in an airport's name.
const H1 =
  "font-display text-3xl sm:text-4xl tracking-tight text-primary text-balance wrap-break-word";
export const H2 = "font-display text-xl text-primary wrap-break-word";

// Longest first, so "Wilkes-Barre/Scranton" is never matched by a shorter
// word that it ends with. A match stands alone: not inside a longer word or
// a path.
const SLASHED_AIRPORT_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}/-])(?:${[...SLASHED_AIRPORT_WORDS]
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\p{L}\\p{N}/-])`,
  "gu"
);

/** Where a browser may break a line by itself: at a space, and after a hyphen. */
const breaksBefore = (text: string, i: number) => text[i] === " " || text[i - 1] === "-";

/**
 * A heading's words, with a break inside a slashed airport name that is wider
 * than the heading's column. A browser breaks after a hyphen by itself but
 * keeps "Carbondale/Murphysboro" whole, and at the display size that one word
 * is wider than a 390px phone's column.
 *
 * The run a browser would not break, the name with whatever is tied to it
 * ("Arcata/Eureka\u00a0(ACV)", "Barre/Scranton" after "Wilkes-"), sits in a
 * box of its own. The box moves to the next line whole, as the unbroken run
 * did, so "Seattle/Tacoma" is split nowhere it fitted before, and a code
 * stays tied to its city; only a box wider than the column wraps inside, at
 * the slash. Only the table's own names get one: "N/A", "and/or" and "24/7"
 * stay as they are.
 *
 * `label` is the heading's name when a break was put in: a browser hands a
 * screen reader the two halves with a space between them ("Carbondale/
 * Murphysboro"), and the label says the name as written.
 */
function headingWords(title: React.ReactNode): { words: React.ReactNode; label?: string } {
  if (typeof title !== "string" || !title.includes("/")) return { words: title };
  // Where a break is offered: after each slash of an airport's name.
  const cuts: number[] = [];
  for (const match of title.matchAll(SLASHED_AIRPORT_WORD)) {
    for (let i = match.index; i < match.index + match[0].length; i++) {
      if (title[i] === "/") cuts.push(i + 1);
    }
  }
  if (cuts.length === 0) return { words: title };
  const words: React.ReactNode[] = [];
  let done = 0;
  for (let c = 0; c < cuts.length; ) {
    const slash = cuts[c] - 1;
    let start = slash;
    while (start > done && !breaksBefore(title, start)) start--;
    if (title[start] === " ") start++;
    let end = slash + 1;
    while (end < title.length && !breaksBefore(title, end)) end++;
    // One box for the whole run, with every cut that falls in it: two names
    // tied by an arrow or a no-break space share a run, and a box each
    // printed the second name's end twice.
    const halves: string[] = [];
    let cut = start;
    for (; c < cuts.length && cuts[c] <= end; c++) {
      halves.push(title.slice(cut, cuts[c]));
      cut = cuts[c];
    }
    halves.push(title.slice(cut, end));
    words.push(
      title.slice(done, start),
      <span key={start} className="inline-block max-w-full">
        {halves.map((half, k) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the halves of one fixed run, never reordered
          <React.Fragment key={k}>
            {k > 0 && <wbr />}
            {half}
          </React.Fragment>
        ))}
      </span>
    );
    done = end;
  }
  words.push(title.slice(done));
  return { words, label: title };
}

type Box = React.HTMLAttributes<HTMLElement> & { as?: "div" | "section" | "nav" | "aside" };

/** The surface card. Padding is a prop, not a className, so it never fights p-5. */
export function Panel({
  as: Tag = "div",
  pad = "md",
  className = "",
  children,
  ...rest
}: Box & { pad?: keyof typeof PANEL_PAD }) {
  return (
    <>
      <Tag className={`${SURFACE} ${PANEL_PAD[pad]} ${className}`} {...rest}>
        {children}
      </Tag>{" "}
    </>
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
  // A block eyebrow is followed by a space: it draws nothing beside a block,
  // and keeps the label off the next word in the page's plain text.
  return (
    <>
      <Tag className={`${EYEBROW_TEXT} ${className}`} {...(htmlFor ? { htmlFor } : {})}>
        {children}
      </Tag>
      {Tag !== "span" && Tag !== "label" && " "}
    </>
  );
}

export function SectionTitle({
  className = "",
  children,
}: { className?: string; children: React.ReactNode }) {
  const heading = headingWords(children);
  return (
    <>
      <h2 className={`${H2} ${className}`} aria-label={heading.label}>
        {heading.words}
      </h2>{" "}
    </>
  );
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
    <>
      <div
        className={`font-display ${STAT_SIZE[size]} leading-none tabular-nums ${accent ? "text-accent" : "text-primary"} ${className}`}
      >
        {children}
        {unit && <span className="text-base text-muted"> {unit}</span>}
      </div>{" "}
    </>
  );
}

/** Shown only on keyboard focus, in the corner of its `relative` parent. */
const SKIP_LINK =
  "sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:border focus:border-accent focus:bg-surface-elevated focus:px-3 focus:py-2 focus:text-sm focus:text-primary";

/**
 * A way past a long run of links for a keyboard: first Tab stop of its
 * `relative` section, landing on the `SkipTarget` after the run. The page's
 * own skip link jumps the site bar; this jumps a list that can hold hundreds
 * of stops before the footer.
 */
export function SkipLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <>
      <a href={`#${to}`} className={SKIP_LINK}>
        {children}
      </a>{" "}
    </>
  );
}

/** A space in the page's plain text where a margin draws the gap on screen
 * ("103/104 95%", "76 ft"): a crawler that doesn't render, or a reader that
 * ignores layout, gets a word break, and the page draws nothing more. */
export function TextGap() {
  return <span className="sr-only"> </span>;
}

/** Where a SkipLink lands: focusable by script only, so the next Tab moves on from here. */
export function SkipTarget({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <>
      <p id={id} tabIndex={-1} className="sr-only">
        {children}
      </p>{" "}
    </>
  );
}

type ButtonVariant = "primary" | "secondary";
type ButtonSize = "sm" | "md" | "lg";

// A bordered button's edge is border-neutral, like a field's: 3.2:1 on a panel
// where border-subtle is 1.3:1 (WCAG 1.4.11 asks 3:1 of a control's boundary).
// On hover a primary button's text goes to white: the accent on its own
// deepened tint fell to 3.8:1.
const BUTTON: Record<`${ButtonVariant}-${ButtonSize}`, string> = {
  "primary-sm":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-accent bg-accent/20 px-3 py-1.5 font-display text-sm text-accent transition-colors hover:bg-accent/30 hover:text-primary",
  "primary-md":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-accent bg-accent/20 px-5 py-2 font-display text-accent transition-colors hover:bg-accent/30 hover:text-primary",
  "primary-lg":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-accent bg-accent/20 px-5 py-3 font-display text-accent transition-colors hover:bg-accent/30 hover:text-primary",
  "secondary-sm":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-neutral bg-surface-elevated px-3 py-1.5 font-display text-sm text-secondary transition-colors hover:border-accent hover:text-accent",
  "secondary-md":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-neutral bg-surface-elevated px-5 py-2 font-display text-secondary transition-colors hover:border-accent hover:text-accent",
  "secondary-lg":
    "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded border border-neutral bg-surface-elevated px-5 py-3 font-display text-secondary transition-colors hover:border-accent hover:text-accent",
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
  // Chips sit in a wrapping flex row, where the space after one draws nothing
  // and keeps its label off the next one's in the page's plain text.
  return (
    <>
      <a href={href} className={CHIP[size]}>
        {children}
      </a>{" "}
    </>
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
  const heading = headingWords(title);
  return (
    <>
      <header className="relative mx-auto w-full max-w-3xl pt-8 pb-6 text-center">
        {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
        {eyebrow && " "}
        <h1 className={H1} aria-label={heading.label}>
          {heading.words}
        </h1>{" "}
        {dek && (
          <p className="mx-auto mt-2 max-w-2xl text-base text-secondary text-pretty">{dek}</p>
        )}{" "}
        {children && <div className="mt-3">{children}</div>}
      </header>{" "}
    </>
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
  // The space after the section draws nothing between blocks, but keeps its
  // last word off the next section's first in the page's plain text.
  return (
    <>
      <section id={id} className={`${wide ? SECTION_WIDE : SECTION} ${className}`}>
        {title && <SectionTitle>{title}</SectionTitle>}{" "}
        {dek && <p className="mt-1 text-sm text-secondary text-pretty">{dek}</p>}{" "}
        {bare ? (
          <div className={title || dek ? "mt-4" : ""}>{children}</div>
        ) : (
          <Panel className={title || dek ? "mt-4" : ""}>{children}</Panel>
        )}
      </section>{" "}
    </>
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

/** A data table. In a column narrower than 15rem, which a phone gives at a
 * larger browser font, each row becomes a line of its cells that wraps, so
 * the table never pushes the page sideways; wider, it is a plain table. */
export function DataTable({
  className = "",
  children,
  ...rest
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className={TABLE_FRAME}>
      <table className={className ? `${TABLE} ${className}` : TABLE} {...rest}>
        {children}
      </table>
    </div>
  );
}

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
  // The space after a cell draws nothing in a table row, and keeps the
  // cell's last word off the next cell's first in the page's plain text.
  return (
    <>
      <th
        scope="col"
        className={`${TH} ${numeric ? "text-right" : ""} ${optional ? "hidden sm:table-cell" : ""}`}
      >
        {children}
      </th>{" "}
    </>
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
    <>
      <td
        className={`${TD} ${numeric ? "text-right" : ""} ${optional ? "hidden sm:table-cell" : ""} ${className}`}
      >
        {children}
      </td>{" "}
    </>
  );
}

/** Footer links wrap onto several rows on a phone; the padding keeps each a
 * 24px-tall target (WCAG 2.5.8) where rows of 16px text would sit 4px apart.
 * From lg up each group is one row, spaced by its own margin. */
const FOOTER_LINK = "inline-block py-1 lg:py-0 text-secondary hover:text-primary transition-colors";

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
      label: `${airline.shortName} Starlink Tracker`,
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
          <a href={l.href} className={FOOTER_LINK}>
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
          <a href={l.href} className={FOOTER_LINK}>
            {l.label}
          </a>
        </React.Fragment>
      ))}
    </div>
  );
}

/** /chrome is canonical on United's site, so other hosts link there directly
 * rather than through a cross-domain canonical. That link is a deliberate
 * cross-tenant mention, marked like CrossSiteLinks. */
function ChromeExtensionLink({ site }: { site: SiteConfig }) {
  const className = FOOTER_LINK;
  if (site.key === SITES.united.key) {
    return (
      <a href="/chrome" className={className}>
        Chrome extension
      </a>
    );
  }
  return (
    <div data-cross-site-links className="inline">
      <a href={`https://${SITES.united.canonicalHost}/chrome`} className={className}>
        Chrome extension
      </a>
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
          className="inline-flex items-center py-1 lg:py-0 text-secondary hover:text-primary transition-colors"
        >
          Built with{" "}
          <svg
            className="w-4 h-4 mx-1 text-danger"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-label="Heart"
            role="img"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>{" "}
          by @martinamps
        </a>
        <span className="text-subtle" aria-hidden="true">
          ·
        </span>
        <a
          href="https://github.com/martinamps/ua-starlink-tracker"
          target="_blank"
          rel="noopener noreferrer"
          className={FOOTER_LINK}
        >
          GitHub
        </a>
        <span className="text-subtle" aria-hidden="true">
          ·
        </span>
        <ChromeExtensionLink site={site} />
        {site.features.intentPages && (
          <>
            <span className="text-subtle" aria-hidden="true">
              ·
            </span>
            <a href="/is-starlink-free" className={FOOTER_LINK}>
              Is it free?
            </a>
          </>
        )}
      </div>{" "}
      <PageNavLinks links={pageLinks} /> <CrossSiteLinks site={site} />
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
      {/* First in the tab order, shown only on focus: the site bar's links
          repeat on every page, and /fleet puts hundreds more before its end. */}
      <SkipLink to="main">Skip to content</SkipLink> {before}
      <SiteBar site={site} currentPath={currentPath} />{" "}
      <p
        data-independence
        className="relative mx-auto w-full max-w-6xl pt-2 text-xs text-muted text-balance"
      >
        {independenceLine(site)}
      </p>{" "}
      {/* A column like its parent, so each page's header and sections lay out
          exactly as they did as the shell's own children. */}
      <main id="main" tabIndex={-1} className="flex w-full flex-1 flex-col outline-none">
        {children}
      </main>{" "}
      <SiteFooter site={site} pageLinks={pageLinks} />
    </div>
  );
}
