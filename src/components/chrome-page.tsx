import { SITES, type SiteConfig } from "../airlines/registry";
import { Faq, type FaqEntry } from "./faq";
import { CHROME_EXTENSION_URL } from "./home/tools";
import { ButtonLink, Eyebrow, LINK, type Link, PageHeader, PageShell, Section } from "./layout";
import { Pill, type Tone } from "./ui/tone";

// Flip to true once the Chrome Web Store listing shows 2.1.1 (1.2.0 is United-only).
export const EXTENSION_MULTI_AIRLINE_LIVE = false;

/** The one URL every host's /chrome canonicalizes to: the extension is
 * multi-airline, but its link equity belongs on the United site. */
export const CHROME_PAGE_URL = `https://${SITES.united.canonicalHost}/chrome`;

const LATER_AIRLINES = "Alaska, Hawaiian and Qatar";

export function extensionCoverage(): string {
  return EXTENSION_MULTI_AIRLINE_LIVE
    ? "United, Alaska, Hawaiian and Qatar"
    : `United today; ${LATER_AIRLINES} arriving in the next update`;
}

interface Badge {
  tone: Tone;
  label: string;
  name: string;
  body: string;
  /** Introduced in 2.x; labelled as upcoming until the store ships it. */
  v2: boolean;
}

const BADGES: Badge[] = [
  {
    tone: "info",
    label: "Starlink",
    name: "Blue: verified",
    body: "The aircraft assigned to this flight was confirmed Starlink-equipped on the airline's own site.",
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
    body: "No aircraft is assigned yet (airlines usually assign one about two days out). The percentage is how often this flight recently flew a Starlink aircraft, or the Starlink share of the fleet that flies it. Shown only at 80% or higher.",
    v2: true,
  },
];

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

const SCREENSHOTS = [
  {
    src: "/static/chrome-united-predicted.webp",
    alt: "Google Flights results for Denver to Aspen ten days out, each United Express flight marked with a gray 'Starlink ~95%' style odds badge.",
    caption: "Booking ahead: gray badges show the odds before a plane is assigned.",
  },
  {
    src: "/static/chrome-alaska-installed.webp",
    alt: "Google Flights results for Seattle to Portland, two Alaska Horizon flights marked with a green 'Starlink (installed)' badge and Delta flights unmarked.",
    caption: "Alaska and Horizon: green badges for aircraft with Starlink installed.",
  },
];

function NextUpdate({ v2 }: { v2: boolean }) {
  if (!v2 || EXTENSION_MULTI_AIRLINE_LIVE) return null;
  return <Pill tone="warn">Next update</Pill>;
}

function Screenshot({
  src,
  alt,
  eager = false,
}: {
  src: string;
  alt: string;
  eager?: boolean;
}) {
  return (
    <img
      src={src}
      alt={alt}
      width="1280"
      height="800"
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className="block h-auto w-full rounded-lg border border-subtle shadow-xl"
    />
  );
}

export function chromeFaq(checkFlightHref: string): FaqEntry[] {
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
          and date in the{" "}
          <a href={checkFlightHref} className={LINK}>
            flight checker
          </a>
          .
        </>
      ),
    },
    {
      q: "Which airlines does it cover?",
      a: EXTENSION_MULTI_AIRLINE_LIVE
        ? "United and United Express, Alaska and Horizon, Hawaiian-operated flights (listed under Alaska flight numbers) and Qatar Airways."
        : `United and United Express today. ${LATER_AIRLINES} arrive in the next update, which is in Chrome Web Store review.`,
    },
    {
      q: "Why doesn't a flight have a badge?",
      a: "No badge means the flight doesn't have Starlink, the odds are too low or too uncertain to show, or the airline isn't covered. A connecting trip is judged by its weakest leg, so it's never marked Starlink when only one flight has it.",
    },
    {
      q: "Does it work on my phone?",
      a: "No. Chrome on phones doesn't run extensions. Use the flight checker on your phone instead.",
    },
  ];
}

interface ChromePageProps {
  site: SiteConfig;
  pageLinks?: Link[];
  currentPath?: string;
}

export default function ChromePage({ site, pageLinks, currentPath }: ChromePageProps) {
  // Hosts without the tool pages send people to United's.
  const united = `https://${SITES.united.canonicalHost}`;
  const checkFlightHref = site.features.checkFlightPage
    ? "/check-flight"
    : `${united}/check-flight`;
  const routePlannerHref = site.features.routePlannerPage
    ? "/route-planner"
    : `${united}/route-planner`;

  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        eyebrow="Free Chrome extension"
        title="See which flights have Starlink, right in Google Flights"
        dek={
          EXTENSION_MULTI_AIRLINE_LIVE ? (
            <>
              A small badge on every United, Alaska, Hawaiian and Qatar result with Starlink Wi-Fi,
              as you search.
            </>
          ) : (
            <>
              A small badge on every United result with Starlink Wi-Fi, as you search.{" "}
              {LATER_AIRLINES} arrive in the next update.
            </>
          )
        }
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

      <div className="relative mx-auto mb-10 w-full max-w-4xl">
        <Screenshot
          eager
          src="/static/chrome-united-verified.webp"
          alt="Google Flights results for Chicago O'Hare to Madison: five United and United Express flights carry a blue 'Starlink' badge next to the departure time, while the American flights and one United flight have none."
        />
      </div>

      <Section title="What the badges mean">
        <ul className="space-y-4">
          {BADGES.map((b) => (
            <li key={b.label} className="flex flex-col gap-2 sm:flex-row sm:gap-4">
              <div className="sm:w-40 sm:shrink-0">
                <Pill tone={b.tone}>{b.label}</Pill>
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2 font-semibold text-primary">
                  {b.name} <NextUpdate v2={b.v2} />
                </div>
                <p className="mt-1 text-sm leading-relaxed text-secondary">{b.body}</p>
              </div>
            </li>
          ))}
          <li className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            <div className="text-sm text-muted italic sm:w-40 sm:shrink-0">no badge</div>
            <div>
              <div className="font-semibold text-primary">No, unknown, or not covered</div>
              <p className="mt-1 text-sm leading-relaxed text-secondary">
                The flight doesn't have Starlink, the odds are too low or too uncertain, or the
                airline isn't covered. It stays silent rather than guess. Hover a badge for the full
                explanation.
              </p>
            </div>
          </li>
        </ul>
      </Section>

      <section className="relative mx-auto mb-8 grid w-full max-w-6xl gap-6 md:grid-cols-2">
        {SCREENSHOTS.map((s) => (
          <figure key={s.src}>
            <Screenshot src={s.src} alt={s.alt} />
            <figcaption className="mt-2 flex flex-wrap items-center justify-center gap-2 text-center text-sm text-secondary">
              {s.caption} <NextUpdate v2 />
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
              {a.v2 && !EXTENSION_MULTI_AIRLINE_LIVE ? (
                <NextUpdate v2 />
              ) : (
                <Pill tone="success">Live</Pill>
              )}
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
          <li>It runs only on Google Flights.</li>
          <li>
            For each covered flight on the page, it sends only the flight number, the date, the
            departure and arrival airport codes and the extension's version number to
            unitedstarlinktracker.com or airlinestarlinktracker.com.
          </li>
          <li>
            No account, no cookies, no names, no other page contents, no browsing history and no
            identifiers.
          </li>
          <li>
            Answers are kept in memory for up to 30 minutes and are gone when you close the tab.
          </li>
        </ul>
      </Section>

      <Section title="Not on Chrome?">
        <p className="text-sm leading-relaxed text-secondary">
          The same answers work in any browser. Check one flight by number and date, or find the
          routes most likely to have Starlink before you book.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <ButtonLink href={checkFlightHref}>Check a flight</ButtonLink>
          <ButtonLink href={routePlannerHref} variant="secondary">
            Route planner
          </ButtonLink>
        </div>
      </Section>

      <Faq items={chromeFaq(checkFlightHref)} />

      <div className="relative mx-auto mb-10 w-full max-w-3xl text-center">
        <Eyebrow className="mb-3">Google Flights Starlink Indicator</Eyebrow>
        <ButtonLink href={CHROME_EXTENSION_URL} target="_blank" rel="noopener noreferrer">
          Add to Chrome — free
        </ButtonLink>
      </div>
    </PageShell>
  );
}

/** Kept beside the copy it describes so the two can't drift. */
export function chromeSoftwareJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Google Flights Starlink Indicator",
    applicationCategory: "TravelApplication",
    operatingSystem: "Chrome",
    description: `Free Chrome extension that badges Google Flights results with Starlink Wi-Fi status: ${extensionCoverage()}.`,
    url: CHROME_PAGE_URL,
    installUrl: CHROME_EXTENSION_URL,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
}
