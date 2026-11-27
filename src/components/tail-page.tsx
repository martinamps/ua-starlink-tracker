import { Fragment } from "react";
import type { SiteConfig } from "../airlines/registry";
import type { TailFact, TailFlightRow, TailPageModel } from "../api/tail-page";
import type { Link } from "./layout";
import {
  Chip,
  Eyebrow,
  LINK,
  PageHeader,
  PageShell,
  Panel,
  SECTION,
  Section,
  Td,
  Th,
} from "./layout";
import { fmt } from "./ui/format";
import { TONE_TEXT } from "./ui/tone";

interface TailPageProps {
  site: SiteConfig;
  model: TailPageModel;
  /** Pages this host serves that a reader goes to next. */
  wayOn: Link[];
  pageLinks?: Link[];
  currentPath?: string;
}

const FLIGHT_LINK = "font-mono text-primary hover:text-accent transition-colors";

function Facts({ facts }: { facts: TailFact[] }) {
  return (
    <dl className="space-y-2.5 text-sm">
      {facts.map((f) => (
        <Fragment key={f.label}>
          <div className="sm:flex sm:gap-4">
            <dt className="text-muted sm:w-44 sm:shrink-0">{f.label}</dt>{" "}
            <dd className="min-w-0 text-primary text-pretty">
              {f.href ? (
                <a href={f.href} className={LINK}>
                  {f.value}
                </a>
              ) : (
                f.value
              )}
            </dd>
          </div>{" "}
        </Fragment>
      ))}
    </dl>
  );
}

function Flights({ rows }: { rows: TailFlightRow[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <Th>Leaves</Th>
          <Th>Flight</Th>
          <Th numeric>Route</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => (
          <tr key={`${f.flight_number}-${f.departure_time}`} className="align-top">
            <Td className="pr-3">
              <div className="whitespace-nowrap text-primary">{f.time}</div>{" "}
              <div className="whitespace-nowrap text-xs text-muted">{f.day}</div>
            </Td>
            <Td className="pr-3">
              {f.flightHref ? (
                <a href={f.flightHref} className={FLIGHT_LINK}>
                  {f.flight_number}
                </a>
              ) : (
                <span className="font-mono text-primary">{f.flight_number}</span>
              )}
            </Td>
            <Td numeric>
              {f.routeHref ? (
                <a
                  href={f.routeHref}
                  className="whitespace-nowrap text-secondary hover:text-accent transition-colors"
                >
                  {f.route}
                </a>
              ) : (
                <span className="whitespace-nowrap text-secondary">{f.route}</span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const shownOf = (shown: number, total: number) =>
  total > shown ? ` The first ${fmt(shown)} of ${fmt(total)}.` : "";

/** /fleet/{tail}: one aircraft. The answer, how we know it, what the plane is
 * and where it flies, each only where a stored row backs it. */
export default function TailPage({ site, model, wayOn, pageLinks, currentPath }: TailPageProps) {
  const m = model;
  const { departures } = m;
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        eyebrow={m.typeName ? `${m.airline} ${m.typeName}` : `${m.airline} aircraft`}
        title={`Does ${m.tail} have Starlink?`}
      />

      <Panel as="section" aria-label="Answer" className={SECTION}>
        <p
          id="tail-answer"
          className={`font-display text-4xl leading-none ${m.tone === "neutral" ? "text-primary" : TONE_TEXT[m.tone]}`}
        >
          {m.verdict}
        </p>{" "}
        <p className="mt-3 text-base text-primary text-pretty">{m.answer}</p>{" "}
        {m.note && <p className="mt-1.5 text-sm text-secondary text-pretty">{m.note}</p>}
      </Panel>

      {m.evidence.length > 0 && (
        <Section id="evidence" title="How we know">
          <Facts facts={m.evidence} />{" "}
          <p className="mt-4 text-xs text-muted text-pretty">
            Dates are when this tracker saw each thing, which can be later than the day it happened.
            {site.features.methodologyPage && (
              <>
                {" "}
                <a href="/methodology" className={LINK}>
                  How we verify
                </a>
              </>
            )}
          </p>
        </Section>
      )}

      {m.plane.length > 0 && (
        <Section id="plane" title="The plane">
          <Facts facts={m.plane} />{" "}
          {m.faaRead && (
            <p className="mt-4 text-xs text-muted text-pretty">
              Model, year, serial, owner and Mode S code are from the FAA aircraft registry, read{" "}
              {m.faaRead}.
            </p>
          )}
        </Section>
      )}

      {m.upcoming.length > 0 && (
        <Section
          id="upcoming"
          title={`Where ${m.tail} flies next`}
          dek={`Times local to each departure airport. Planes can be swapped before departure.${shownOf(m.upcoming.length, m.upcomingTotal)}`}
        >
          <Flights rows={m.upcoming} />
        </Section>
      )}

      {m.recent.length > 0 && (
        <Section
          id="recent"
          title={`Flown in the last ${m.recentDays} days`}
          dek={`Departures we saw ${m.tail} leave on, newest first.${shownOf(m.recent.length, m.recentTotal)}`}
        >
          <Flights rows={m.recent} />
        </Section>
      )}

      {departures.total > 0 && (
        <Section
          id="airports"
          title="Where it leaves from"
          dek={`${fmt(departures.total)} ${departures.total === 1 ? "departure" : "departures"} seen in the last ${departures.days} days, by airport.`}
        >
          <ul className="flex flex-wrap gap-2">
            {departures.airports.map((a) => (
              <Fragment key={a.airport}>
                <li>
                  {a.href ? (
                    <Chip href={a.href}>
                      {a.airport} {fmt(a.departures)}
                    </Chip>
                  ) : (
                    <span className="inline-block rounded border border-subtle bg-surface-elevated px-2.5 py-1 font-mono text-sm text-secondary">
                      {a.airport} {fmt(a.departures)}
                    </span>
                  )}
                </li>{" "}
              </Fragment>
            ))}
          </ul>
        </Section>
      )}

      <section className={SECTION}>
        <Eyebrow>Next</Eyebrow>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
          {wayOn.map((l) => (
            <Fragment key={l.href}>
              <li>
                <a href={l.href} className={LINK}>
                  {l.label}
                </a>
              </li>{" "}
            </Fragment>
          ))}
          <li>
            <a
              href={`https://flightaware.com/live/flight/${m.tail}`}
              target="_blank"
              rel="nofollow noreferrer noopener"
              className={LINK}
            >
              {m.tail} on FlightAware
            </a>
          </li>
        </ul>
      </section>
    </PageShell>
  );
}
