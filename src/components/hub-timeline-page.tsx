/**
 * The hub's /timeline: every hub airline's dated Starlink facts, newest first,
 * grouped by airline. Built only from rollout-facts entries — the same dated,
 * sourced claims the /airlines pages print — plus the ones those pages drop:
 * a superseded fact leaves the airline page so two answers never sit side by
 * side, and this page is where its dated record stays, marked, below the fact
 * that replaced it.
 *
 * Undated facts (an evergreen page, `accessed` only) have no date to sit at,
 * so they stay on the airline pages alone.
 */

import type { SiteConfig } from "../airlines/registry";
import type { AirlineFactsEntry, RolloutFact } from "../airlines/rollout-facts";
import { Chip, LINK, PageHeader, PageShell, Section } from "./layout";
import type { Link } from "./layout";
import { fmt, monthYear, shortDate } from "./ui/format";
import { Pill } from "./ui/tone";

type DatedRolloutFact = RolloutFact & { asOf: string };

export interface HubTimelineAirline {
  entry: AirlineFactsEntry;
  /** Newest first; same-day facts keep the file's order. */
  facts: DatedRolloutFact[];
}

const isDated = (f: RolloutFact): f is DatedRolloutFact => Boolean(f.asOf);

/** "Sep 21, 2026", or "Sep 2026" where the source gives only the month: never
 * a day the source doesn't give. */
export const factDate = (asOf: string) =>
  /^\d{4}-\d{2}$/.test(asOf) ? monthYear(asOf) : shortDate(asOf);

/** The airlines with at least one dated fact, the one most recently dated
 * first. "YYYY-MM" sorts before every day of its month, which is the honest
 * place for a month-precision claim: no later than the month began. */
export function hubTimelineAirlines(entries: readonly AirlineFactsEntry[]): HubTimelineAirline[] {
  return entries
    .map((entry) => ({
      entry,
      facts: entry.facts
        .filter(isDated)
        .map((f, i) => ({ f, i }))
        .sort((a, b) => b.f.asOf.localeCompare(a.f.asOf) || a.i - b.i)
        .map(({ f }) => f),
    }))
    .filter((a) => a.facts.length > 0)
    .sort(
      (a, b) =>
        b.facts[0].asOf.localeCompare(a.facts[0].asOf) || a.entry.name.localeCompare(b.entry.name)
    );
}

/** The newest date on the page, for its lastmod. */
export const hubTimelineLatest = (airlines: readonly HubTimelineAirline[]): string | undefined =>
  airlines[0]?.facts[0]?.asOf;

const ENTRY = "grid gap-x-6 gap-y-1 py-4 first:pt-0 last:pb-0 sm:grid-cols-[8rem_1fr]";
const OUTBOUND = "underline decoration-dotted underline-offset-2 hover:text-accent";

function FactSource({ fact }: { fact: RolloutFact }) {
  return (
    <p className="mt-1 text-xs text-muted">
      Source:{" "}
      <a href={fact.source.url} target="_blank" rel="noopener noreferrer" className={OUTBOUND}>
        {fact.source.label}
      </a>
      {fact.source.mirror && (
        <>
          {" · "}
          <a
            href={fact.source.mirror}
            target="_blank"
            rel="noopener noreferrer"
            className={OUTBOUND}
          >
            archived copy
          </a>
        </>
      )}
    </p>
  );
}

function FactEntry({ fact }: { fact: DatedRolloutFact }) {
  return (
    <li className={ENTRY} data-superseded={fact.superseded ? "true" : undefined}>
      <time dateTime={fact.asOf} className="text-sm text-muted tabular-nums">
        {factDate(fact.asOf)}
      </time>
      <div>
        {fact.superseded && (
          <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Pill tone="neutral">Replaced</Pill>
            <span>A later fact, listed above, replaced its figures.</span>
          </p>
        )}
        <p className={`text-sm ${fact.superseded ? "text-muted" : "text-secondary"}`}>
          {fact.fact}
        </p>
        <FactSource fact={fact} />
      </div>
    </li>
  );
}

interface HubTimelinePageProps {
  site: SiteConfig;
  airlines: HubTimelineAirline[];
  pageLinks?: Link[];
  currentPath?: string;
}

export default function HubTimelinePage({
  site,
  airlines,
  pageLinks,
  currentPath,
}: HubTimelinePageProps) {
  const total = airlines.reduce((n, a) => n + a.facts.length, 0);
  const replaced = airlines.reduce((n, a) => n + a.facts.filter((f) => f.superseded).length, 0);
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        title="Starlink timeline by airline"
        dek={
          <>
            {fmt(total)} dated facts from {fmt(airlines.length)} airlines, newest first, each with
            the date its source gives and a link to that source.
            {replaced > 0 && (
              <>
                {" "}
                {fmt(replaced)} {replaced === 1 ? "was" : "were"} later replaced; they stay here,
                marked, under the fact that replaced them.
              </>
            )}
          </>
        }
      />

      <Section title="Airlines" dek="Ordered by each airline's most recent dated fact.">
        <ul className="flex flex-wrap gap-2">
          {airlines.map(({ entry, facts }) => (
            <li key={entry.slug}>
              <Chip href={`#${entry.slug}`} size="sm">
                {entry.name}
                <span className="ml-1.5 text-muted tabular-nums">{factDate(facts[0].asOf)}</span>
              </Chip>
            </li>
          ))}
        </ul>
      </Section>

      {airlines.map(({ entry, facts }) => (
        <Section
          key={entry.slug}
          id={entry.slug}
          className="scroll-mt-20"
          title={entry.name}
          dek={
            <a href={`/airlines/${entry.slug}`} className={LINK}>
              {entry.shortName} Starlink status today →
            </a>
          }
        >
          <ol className="divide-y divide-[var(--color-border)]">
            {facts.map((f) => (
              <FactEntry key={`${f.asOf}:${f.fact}`} fact={f} />
            ))}
          </ol>
        </Section>
      ))}
    </PageShell>
  );
}
