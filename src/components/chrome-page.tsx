import type React from "react";
import { SITES, type SiteConfig } from "../airlines/registry";
import { CHROME_EXTENSION_URL } from "../utils/chrome-extension";
import { Faq, type FaqEntry } from "./faq";
import { ButtonLink, Eyebrow, LINK, type Link, PageHeader, PageShell, Section } from "./layout";
import { Pill, type Tone } from "./ui/tone";

// Flip to true once the Chrome Web Store listing shows 2.1.1. Until then the
// store serves 1.2.0: United only, one blue badge, and only once a plane is assigned.
export const EXTENSION_MULTI_AIRLINE_LIVE = false;

const UA_ORIGIN = `https://${SITES.united.canonicalHost}`;
const AS_ORIGIN = `https://${SITES.alaska.canonicalHost}`;

/** The one URL every host's /chrome canonicalizes to: the extension spans
 * airlines, but its link equity is pooled on the United site. */
export const CHROME_PAGE_URL = `${UA_ORIGIN}/chrome`;

/** A fixed date for sitemap lastmod and dateModified: the copy changes when
 * the extension does, not when the fleet data refreshes. */
export const CHROME_PAGE_UPDATED = "2026-10-05";

export const CHROME_OG_IMAGE_URL = `${UA_ORIGIN}/static/chrome-og.webp`;
export const CHROME_OG_IMAGE_ALT =
  "Google Flights results with blue Starlink badges next to United flight times.";

const LATER_AIRLINES = "Alaska, Hawaiian and Qatar";
const ASSIGNMENT_TIMING =
  "Badges appear once the airline assigns the aircraft, about 2 days before departure.";

export function extensionCoverage(live = EXTENSION_MULTI_AIRLINE_LIVE): string {
  return live
    ? "United, Alaska, Hawaiian and Qatar"
    : `United today; ${LATER_AIRLINES} arriving in the next update`;
}

/** Coverage first: search snippets clamp the tail. */
export function chromeMetaDescription(live = EXTENSION_MULTI_AIRLINE_LIVE): string {
  return live
    ? "United, Alaska, Hawaiian and Qatar flights: a free Chrome extension that marks verified, installed and likely Starlink Wi-Fi right in Google Flights."
    : "United flights today, more airlines next: a free Chrome extension that marks flights with Starlink Wi-Fi right in your Google Flights results.";
}

export function chromeHeroDek(live = EXTENSION_MULTI_AIRLINE_LIVE): string {
  return live
    ? "A small badge on United, Alaska, Hawaiian and Qatar results with Starlink Wi-Fi: confirmed once a plane is assigned, and as odds before that."
    : `A blue badge on United results whose assigned aircraft has Starlink Wi-Fi. ${ASSIGNMENT_TIMING} ${LATER_AIRLINES} arrive in the next update.`;
}

interface Badge {
  tone: Tone;
  label: string;
  name: string;
  body: string;
  /** Introduced in 2.x; tagged as upcoming until the store ships it. */
  v2: boolean;
}

function badges(live: boolean): Badge[] {
  return [
    live
      ? {
          tone: "info",
          label: "Starlink",
          name: "Blue: verified",
          body: "The aircraft assigned to this flight was confirmed Starlink-equipped on the airline's own site.",
          v2: false,
        }
      : {
          tone: "info",
          label: "Starlink",
          name: "Blue: Starlink on the assigned aircraft",
          body: `The assigned aircraft has Starlink, per the airline's site or fleet data. ${ASSIGNMENT_TIMING}`,
          v2: false,
        },
    {
      tone: "success",
      label: "Starlink (installed)",
      name: "Green: installed",
      body: "The assigned aircraft (for Qatar, the scheduled aircraft type) has Starlink according to fleet data, but hasn't been re-checked on the airline's site yet.",
      v2: true,
    },
    {
      tone: "neutral",
      label: "Starlink ~94%",
      name: "Gray: predicted odds",
      body: "No aircraft is assigned yet. The percentage is how often this flight recently flew a Starlink aircraft, or the Starlink share of the fleet that flies it. Shown only at 80% or higher.",
      v2: true,
    },
  ];
}

export function noBadgeExplanation(live = EXTENSION_MULTI_AIRLINE_LIVE): string {
  return live
    ? "The flight doesn't have Starlink, the odds are too low or too uncertain, or the airline isn't covered. A connecting trip is judged by its weakest leg, so it's never marked Starlink when only one flight has it. Hover a badge for the full explanation."
    : "Most often, no aircraft is assigned yet: airlines assign one about 2 days before departure. Otherwise the assigned aircraft doesn't have Starlink, or the flight isn't a United flight.";
}

export function privacyLines(live = EXTENSION_MULTI_AIRLINE_LIVE): string[] {
  return live
    ? [
        "It runs only on Google Flights.",
        "For each covered flight on the page, it sends only the flight number, the date, the departure and arrival airport codes and the extension's version number to unitedstarlinktracker.com or airlinestarlinktracker.com.",
        "No account, no cookies, no names, no other page contents, no browsing history and no identifiers.",
        "Answers are kept in memory for up to 30 minutes and are gone when you close the tab.",
      ]
    : [
        "It runs only on Google Flights.",
        "For each United flight on the page, it sends only the flight number and the date to unitedstarlinktracker.com.",
        "No account, no cookies, no names, no other page contents, no browsing history and no identifiers.",
        "Answers are kept in memory for up to 30 minutes.",
      ];
}

interface Airline {
  name: string;
  note?: string;
  v2: boolean;
}

const AIRLINES_COVERED: Airline[] = [
  { name: "United and United Express", v2: false },
  { name: "Alaska Airlines and Horizon", v2: true },
  {
    name: "Hawaiian Airlines-operated flights",
    note: "Google Flights lists these under Alaska (AS) flight numbers.",
    v2: true,
  },
  { name: "Qatar Airways", v2: true },
];

// /static/ is edge-cached for a day under its name, so a recropped image
// ships under a new filename rather than over the old one.
const SCREENSHOT_W = "505";

const SCREENSHOTS = [
  {
    src: "/static/chrome-odds-united.webp",
    height: "300",
    alt: "Four Denver to Aspen United Express flights ten days out, marked with gray odds badges: Starlink ~95%, ~94%, ~98% and ~96%.",
    caption: "Booking ahead: gray badges show the odds before a plane is assigned.",
  },
  {
    src: "/static/chrome-installed-alaska.webp",
    height: "598",
    alt: "Seattle to Portland results: a Horizon-operated and a SkyWest-operated Alaska flight carry a green 'Starlink (installed)' badge; other Alaska and Delta flights have none.",
    caption: "Alaska and Horizon: green badges for aircraft with Starlink installed.",
  },
];

/** Where a visitor without Chrome checks a flight. The hub has no checker of
 * its own, so it splits by airline: AS numbers (Hawaiian-operated included)
 * go to the Alaska site. */
export function checkerLinks(site: SiteConfig, kind: "check-flight" | "route-planner"): Link[] {
  const local =
    kind === "check-flight" ? site.features.checkFlightPage : site.features.routePlannerPage;
  const noun = kind === "check-flight" ? "Check" : "Plan";
  if (local) {
    return [
      { href: `/${kind}`, label: kind === "check-flight" ? "Check a flight" : "Route planner" },
    ];
  }
  return [
    { href: `${UA_ORIGIN}/${kind}`, label: `${noun} a United flight` },
    { href: `${AS_ORIGIN}/${kind}`, label: `${noun} an Alaska or Hawaiian flight` },
  ];
}

function joinLinks(links: Link[]): React.ReactNode {
  return links.map((l, i) => (
    <span key={l.href}>
      {i > 0 && " or "}
      <a href={l.href} className={LINK}>
        {l.label.charAt(0).toLowerCase() + l.label.slice(1)}
      </a>
    </span>
  ));
}

export function chromeFaq(site: SiteConfig, live = EXTENSION_MULTI_AIRLINE_LIVE): FaqEntry[] {
  return [
    {
      q: "Is it free?",
      a: "Yes. The extension is free, with no account, no sign-in and no settings.",
    },
    {
      q: "Does it work on united.com?",
      a: (
        <>
          No. It only runs on Google Flights. To check any flight booked anywhere, enter its number
          and date: {joinLinks(checkerLinks(site, "check-flight"))}.
        </>
      ),
    },
    {
      q: "Which airlines does it cover?",
      a: live
        ? "United and United Express, Alaska and Horizon, Hawaiian-operated flights (listed under Alaska flight numbers) and Qatar Airways."
        : `United and United Express today. ${LATER_AIRLINES} arrive in the next update, which is in Chrome Web Store review.`,
    },
    {
      q: "Why doesn't a flight have a badge?",
      a: noBadgeExplanation(live),
    },
    {
      q: "Does it work on my phone?",
      a: "No. Chrome on phones doesn't run extensions. Use the flight checker on your phone instead.",
    },
  ];
}

function NextUpdate({ v2, live }: { v2: boolean; live: boolean }) {
  if (!v2 || live) return null;
  return <Pill tone="warn">Next update</Pill>;
}

function Screenshot({
  src,
  alt,
  height,
  eager = false,
}: {
  src: string;
  alt: string;
  height: string;
  eager?: boolean;
}) {
  return (
    <img
      src={src}
      alt={alt}
      width={SCREENSHOT_W}
      height={height}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className="mx-auto block h-auto w-full max-w-[505px] rounded-lg border border-subtle shadow-xl"
    />
  );
}

interface ChromePageProps {
  site: SiteConfig;
  pageLinks?: Link[];
  currentPath?: string;
  /** Defaults to the flag; tests render both states. */
  live?: boolean;
}

export default function ChromePage({
  site,
  pageLinks,
  currentPath,
  live = EXTENSION_MULTI_AIRLINE_LIVE,
}: ChromePageProps) {
  const tools = [...checkerLinks(site, "check-flight"), ...checkerLinks(site, "route-planner")];

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        eyebrow="Free Chrome extension"
        title="See which flights have Starlink, right in Google Flights"
        dek={chromeHeroDek(live)}
      >
        <div className="mt-2 flex flex-col items-center gap-2">
          <ButtonLink
            href={CHROME_EXTENSION_URL}
            target="_blank"
            rel="noopener noreferrer"
            size="lg"
          >
            Add to Chrome — free
          </ButtonLink>
          <span className="text-xs text-muted">No account, no sign-in, no settings.</span>
        </div>
      </PageHeader>

      <figure className="relative mx-auto mb-10 w-full max-w-3xl">
        <Screenshot
          eager
          src="/static/chrome-badges-united.webp"
          height="598"
          alt="Chicago O'Hare to Madison results: five United and United Express flights carry a blue 'Starlink' badge next to the departure time; the American flights and one United flight have none."
        />
        <figcaption className="mt-2 text-center text-sm text-secondary">
          Blue badges on United flights, Chicago to Madison.
        </figcaption>
      </figure>

      <Section title="What the badges mean">
        <ul className="space-y-4">
          {badges(live).map((b) => (
            <li key={b.label} className="flex flex-col gap-2 sm:flex-row sm:gap-4">
              <div className="sm:w-40 sm:shrink-0">
                <Pill tone={b.tone}>{b.label}</Pill>
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2 font-semibold text-primary">
                  {b.name} <NextUpdate v2={b.v2} live={live} />
                </div>
                <p className="mt-1 text-sm leading-relaxed text-secondary">{b.body}</p>
              </div>
            </li>
          ))}
          <li className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            <div className="text-sm text-muted italic sm:w-40 sm:shrink-0">no badge</div>
            <div>
              <div className="font-semibold text-primary">
                {live ? "No, unknown, or not covered" : "Not assigned yet, no, or not covered"}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-secondary">
                {noBadgeExplanation(live)}
              </p>
            </div>
          </li>
        </ul>
      </Section>

      <section className="relative mx-auto mb-8 grid w-full max-w-5xl items-start gap-6 md:grid-cols-2">
        {SCREENSHOTS.map((s) => (
          <figure key={s.src}>
            <Screenshot src={s.src} alt={s.alt} height={s.height} />
            <figcaption className="mt-2 flex flex-wrap items-center justify-center gap-2 text-center text-sm text-secondary">
              {s.caption} <NextUpdate v2 live={live} />
            </figcaption>
          </figure>
        ))}
      </section>

      <Section title="Airlines covered">
        <ul className="divide-y divide-subtle">
          {AIRLINES_COVERED.map((a) => (
            <li
              key={a.name}
              className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
            >
              <div>
                <div className="text-primary">{a.name}</div>
                {a.note && <div className="text-xs text-muted">{a.note}</div>}
              </div>
              {a.v2 && !live ? <NextUpdate v2 live={live} /> : <Pill tone="success">Live</Pill>}
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-subtle pt-4 text-sm leading-relaxed text-secondary">
          <span className="font-semibold text-primary">Planes get swapped.</span> United and the
          other airlines can change the aircraft on a flight up to departure, so a badge is the best
          information at the time you search, not a guarantee.
        </p>
      </Section>

      <Section title="Privacy, in plain words">
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-secondary">
          {privacyLines(live).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>

      <Section title="Not on Chrome?">
        <p className="text-sm leading-relaxed text-secondary">
          The same answers work in any browser. Check one flight by number and date, or find the
          routes most likely to have Starlink before you book.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {tools.map((l, i) => (
            <ButtonLink key={l.href} href={l.href} variant={i === 0 ? "primary" : "secondary"}>
              {l.label}
            </ButtonLink>
          ))}
        </div>
      </Section>

      <Faq items={chromeFaq(site, live)} />

      <div className="relative mx-auto mb-10 w-full max-w-3xl text-center">
        <Eyebrow className="mb-3">Google Flights Starlink Indicator</Eyebrow>
        <ButtonLink href={CHROME_EXTENSION_URL} target="_blank" rel="noopener noreferrer">
          Add to Chrome — free
        </ButtonLink>
      </div>
    </PageShell>
  );
}

export function chromeSoftwareJsonLd(live = EXTENSION_MULTI_AIRLINE_LIVE): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Google Flights Starlink Indicator",
    applicationCategory: "TravelApplication",
    operatingSystem: "Chrome",
    description: `Free Chrome extension that badges Google Flights results with Starlink Wi-Fi status: ${extensionCoverage(live)}.`,
    url: CHROME_PAGE_URL,
    installUrl: CHROME_EXTENSION_URL,
    image: CHROME_OG_IMAGE_URL,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
}
