import {
  type AircraftAnswer,
  type AircraftPageDef,
  type OfficialCount,
  PROVIDER_NAMES,
  SHARE_KINDS,
  type TypeFaqItem,
  factText,
  sheetComparison,
  targetFact,
  tenantCopy,
} from "../airlines/aircraft-pages";
import type { SiteConfig } from "../airlines/registry";
import { type RolloutFact, formatFactDate } from "../airlines/rollout-facts";
import type { AircraftTypePageData, AircraftVerdictKind, WifiProvider } from "../types";
import type { AircraftSpec } from "../utils/aircraft-specs";
import { article } from "../utils/grammar";
import type { PageLink } from "./atoms";
import { TailGrid } from "./fleet/hangar";
import {
  MovementsPanel,
  PipelineBar,
  PipelineTailChip,
  sheetTypeName,
  stationKey,
} from "./fleet/pipeline";
import { PROVIDER_LABEL, ProviderLegend } from "./fleet/providers";
import { ShareBarRow, providerCounts } from "./fleet/type-bars";
import { EYEBROW, H2, PANEL, PageHeader, PageShell, StatInline, fmt } from "./layout";

export interface AircraftTypeSibling {
  slug: string;
  short: string;
  starlink: number;
  total: number;
}

interface AircraftTypePageProps {
  site: SiteConfig;
  pageLinks?: PageLink[];
  currentPath?: string;
  def: AircraftPageDef;
  data: AircraftTypePageData;
  answer: AircraftAnswer;
  facts: RolloutFact[];
  faq: TypeFaqItem[];
  siblings: AircraftTypeSibling[];
  iata: string;
  lastUpdated: string | null;
  checkFlight: boolean;
  spec: AircraftSpec | null;
}

const VERDICT_CLASS: Record<AircraftVerdictKind, string> = {
  all: "verdict verdict-yes",
  all_checked: "verdict verdict-yes",
  most: "verdict verdict-most",
  some: "verdict verdict-some",
  verifying: "verdict verdict-wait",
  installing: "verdict verdict-no",
  none: "verdict verdict-no",
  official_none: "verdict verdict-no",
  unknown: "verdict verdict-wait",
};

const TARGET_IN_HEADER: ReadonlySet<AircraftVerdictKind> = new Set([
  "verifying",
  "installing",
  "none",
]);

const H2_CARD = `${H2} mb-3`;
const CARD = `${PANEL} mb-4`;
const LINK = "text-accent hover:underline";

function monthDay(iso: string): string {
  return formatFactDate(iso.slice(0, 10));
}

/** Every tail of the type as one square, colored by its Wi-Fi today. */
function TailMatrix({
  def,
  data,
  airline,
  official,
}: {
  def: AircraftPageDef;
  data: AircraftTypePageData;
  airline: string;
  official: OfficialCount | null;
}) {
  const copy = tenantCopy(data.airline);
  // Where the airline publishes nothing per tail, an unlit square is "no
  // data", never "not checked yet": nobody is going to check it.
  const labels: Record<WifiProvider, string> = copy.checksEveryTail
    ? PROVIDER_LABEL
    : { ...PROVIDER_LABEL, unknown: "No per-aircraft data" };
  return (
    <div
      className="mt-5 border-t border-subtle pt-4"
      data-equipped={data.starlink}
      data-total={data.total}
      data-official={official ? official.count : undefined}
    >
      <div className={EYEBROW}>
        Wi-Fi on {airline} {def.short}s
      </div>
      <TailGrid tails={data.tails} anchorBase="/fleet" size="lg" />
      <ProviderLegend counts={providerCounts(data.tails)} labels={labels} className="mt-3" />
      <p className="text-xs text-muted mt-2">
        {copy.checksEveryTail
          ? "One square per aircraft, as last checked on united.com."
          : `${airline} doesn't publish Wi-Fi per aircraft, so only tails we've confirmed are lit.`}
      </p>
    </div>
  );
}

function Header({
  def,
  data,
  answer,
  airline,
  lastUpdated,
  target,
}: {
  def: AircraftPageDef;
  data: AircraftTypePageData;
  answer: AircraftAnswer;
  airline: string;
  lastUpdated: string | null;
  target: RolloutFact | null;
}) {
  const official: OfficialCount | null = answer.official;
  return (
    <section className={`${CARD} ${VERDICT_CLASS[answer.kind]}`}>
      <p id="answer" className="text-base text-secondary leading-relaxed text-pretty">
        <strong className="font-display text-lg text-primary">{answer.headline}</strong>{" "}
        {answer.sentence}
        {lastUpdated && <span className="text-muted text-sm"> As of {lastUpdated}.</span>}
      </p>
      {official && (
        <p className="text-sm text-muted mt-3">
          {airline}'s own count: <StatInline n={official.count} />, from{" "}
          <a href={official.url} className={LINK} rel="noopener noreferrer" target="_blank">
            {official.sourceLabel}
          </a>
          , updated {formatFactDate(official.asOf)}.
        </p>
      )}
      {target?.asOf && (
        <p className="text-sm text-muted mt-3">
          {airline}'s stated target ({formatFactDate(target.asOf)}): {factText(target)}
        </p>
      )}
      <TailMatrix def={def} data={data} airline={airline} official={official} />
    </section>
  );
}

function CheckForm({ iata }: { iata: string }) {
  return (
    <>
      <form
        id="type-flight-search"
        method="GET"
        action="/check-flight"
        className="flex flex-col sm:flex-row gap-2 mt-3"
      >
        <input
          type="text"
          id="type-flight-number"
          name="flight_number"
          aria-label="Flight number"
          placeholder={`${iata}123`}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="flex-1 min-w-0 bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent"
        />
        <input
          type="date"
          id="type-flight-date"
          name="date"
          aria-label="Flight date"
          className="bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none focus:border-accent sm:w-40"
        />
        <button
          type="submit"
          className="px-5 py-2 border border-subtle text-accent font-display rounded cursor-pointer whitespace-nowrap hover:border-accent"
        >
          Check my flight
        </button>
      </form>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{
          __html: `document.addEventListener('DOMContentLoaded',function(){var f=document.getElementById('type-flight-search');if(!f)return;f.addEventListener('submit',function(e){e.preventDefault();var n=document.getElementById('type-flight-number').value.trim().toUpperCase().replace(/\\s+/g,'');if(!n)return;if(/^\\d+$/.test(n))n=${JSON.stringify(iata)}+n;var d=document.getElementById('type-flight-date').value;window.location.href='/check-flight/'+encodeURIComponent(n)+(d?'/'+encodeURIComponent(d):'');});});`,
        }}
      />
    </>
  );
}

function VariantsSection({ data }: { data: AircraftTypePageData }) {
  if (!data.variants || data.variants.length < 2) return null;
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>By variant</h2>
      <ul>
        {data.variants.map((v) => (
          <ShareBarRow key={v.label} label={v.label} n={v.starlink} total={v.total} />
        ))}
      </ul>
    </section>
  );
}

function PipelineSection({ def, data }: { def: AircraftPageDef; data: AircraftTypePageData }) {
  const p = data.pipeline;
  if (!p) return null;
  const queued = p.tails.filter((t) => t.state === "scheduled").length;
  const stations = stationKey(p.tails.map((t) => t.mod_location));
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>{def.short} install pipeline</h2>
      {sheetComparison(p, data.starlink).map((line) => (
        <p key={line} className="text-sm text-secondary leading-relaxed">
          {line}
        </p>
      ))}
      <PipelineBar
        complete={p.starlink_complete}
        verifying={p.verification_needed}
        inMod={p.in_mod}
        queued={queued}
        total={p.total}
      />
      {p.rows.length > 1 && (
        <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm text-secondary mt-3">
          {p.rows.map((r) => {
            const name = sheetTypeName(r.type_code);
            // Two sheet columns can share a name (789, 789L): the code tells them apart.
            const shared = p.rows.filter((o) => sheetTypeName(o.type_code) === name).length > 1;
            return (
              <li key={r.type_code}>
                {shared ? `${name} (${r.type_code})` : name}: {fmt(r.starlink_complete)} of{" "}
                {fmt(r.total)} complete
                {r.in_mod > 0 ? `, ${fmt(r.in_mod)} in mod` : ""}
                {r.verification_needed > 0 ? `, ${fmt(r.verification_needed)} verifying` : ""}
              </li>
            );
          })}
        </ul>
      )}
      {p.tails.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {p.tails.map((t) => (
            <PipelineTailChip key={t.tail} row={t} anchorBase="/fleet" />
          ))}
        </div>
      )}
      {p.movements.length > 0 && <MovementsPanel movements={p.movements} anchorBase="/fleet" />}
      {stations && <p className="text-xs text-muted mt-3">Mod stations: {stations}</p>}
    </section>
  );
}

function RecentSection({ def, data }: { def: AircraftPageDef; data: AircraftTypePageData }) {
  if (data.recentInstalls.length === 0) return null;
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>Recently added</h2>
      <ul className="text-sm text-secondary grid grid-cols-2 sm:grid-cols-3 gap-1">
        {data.recentInstalls.map((r) => (
          <li key={r.tail}>
            <a href={`/fleet#t-${r.tail}`} className={`${LINK} font-mono text-xs`}>
              {r.tail}
            </a>{" "}
            <span className="text-muted">{monthDay(r.date)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted mt-3">
        The date we first saw Starlink on each {def.short}, leaving out bulk imports
        {data.firstSeen ? `. The first was ${monthDay(data.firstSeen)}` : ""}.
      </p>
    </section>
  );
}

function RoutesSection({ def, data }: { def: AircraftPageDef; data: AircraftTypePageData }) {
  if (data.routes.length === 0) return null;
  const { departures, pairs } = data.routeTotals;
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>Where Starlink {def.short}s fly in the next 48 hours</h2>
      <p className="text-sm text-muted mb-3">
        {fmt(departures)} scheduled {departures === 1 ? "departure" : "departures"} on {fmt(pairs)}{" "}
        {pairs === 1 ? "route" : "routes"}. The busiest:
      </p>
      <ul className="text-sm text-secondary grid sm:grid-cols-2 gap-x-4 gap-y-1">
        {data.routes.map((r) => (
          <li key={`${r.origin}-${r.destination}`}>
            {r.href ? (
              <a href={r.href} className={`${LINK} font-mono text-xs`}>
                {r.origin} → {r.destination}
              </a>
            ) : (
              <span className="font-mono text-xs">
                {r.origin} → {r.destination}
              </span>
            )}{" "}
            <span className="text-muted tabular-nums">
              {fmt(r.departures)} {r.departures === 1 ? "departure" : "departures"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function dominantOther(data: AircraftTypePageData): WifiProvider | null {
  const others = (["viasat", "panasonic", "thales", "none"] as const).filter(
    (p) => data.providers[p] > 0
  );
  return others.sort((a, b) => data.providers[b] - data.providers[a])[0] ?? null;
}

function FlightsSection({
  def,
  data,
  answer,
}: {
  def: AircraftPageDef;
  data: AircraftTypePageData;
  answer: AircraftAnswer;
}) {
  const starlinkOnly = data.flightNumbersScope === "starlink_only";
  if (data.flightNumbers.length < (starlinkOnly ? 3 : 1)) return null;
  const expect = dominantOther(data);
  const a = article(def.short);
  const caption = starlinkOnly
    ? `Flights that recently had a Starlink ${def.short}.`
    : SHARE_KINDS.has(answer.kind)
      ? `Flights that often got ${a} ${def.short} in the last 30 days.`
      : expect === "none"
        ? `Flights that usually get ${a} ${def.short}, so expect no Wi-Fi.`
        : expect
          ? `Flights that usually get ${a} ${def.short}, so expect ${PROVIDER_NAMES[expect]} Wi-Fi rather than Starlink.`
          : `Flights that usually get ${a} ${def.short}.`;
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>
        {starlinkOnly ? "Recent flights" : `Flights that use the ${def.short}`}
      </h2>
      <p className="text-sm text-muted mb-3">{caption}</p>
      <ul className="flex flex-wrap gap-x-3 gap-y-2 font-mono text-xs">
        {data.flightNumbers.map((f) => (
          <li key={f.flightNumber}>
            <a href={f.href} className={LINK}>
              {f.flightNumber}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FactsSection({ facts, airline }: { facts: RolloutFact[]; airline: string }) {
  if (facts.length === 0) return null;
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>What {airline} has said</h2>
      <ul className="space-y-3">
        {facts.map((f) => (
          <li
            key={f.source.url + (f.asOf ?? "")}
            className="text-sm text-secondary leading-relaxed"
          >
            {f.asOf && <span className="text-muted">{formatFactDate(f.asOf)} · </span>}
            {factText(f)}{" "}
            <a href={f.source.url} className={LINK} rel="noopener noreferrer" target="_blank">
              {f.source.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SpecsSection({ def, spec }: { def: AircraftPageDef; spec: AircraftSpec | null }) {
  if (!spec) return null;
  const rows: Array<[string, string]> = [
    ["Seats", String(spec.seats)],
    ["Range", `${fmt(spec.range_mi)} mi`],
    ["Cruise", `${fmt(spec.cruise_mph)} mph`],
    ["First flight", String(spec.first_flight)],
    ["Engines", spec.engines],
  ];
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>The {def.name}</h2>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="text-secondary tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function FaqSection({ faq }: { faq: TypeFaqItem[] }) {
  if (faq.length === 0) return null;
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>Questions</h2>
      <dl className="space-y-4">
        {faq.map((item) => (
          <div key={item.q}>
            <dt className="font-display text-sm font-semibold text-secondary">{item.q}</dt>
            <dd className="text-sm text-muted leading-relaxed mt-1">
              {item.aHtml ? (
                <>
                  {item.aHtml.before}
                  <a href={item.aHtml.href} className={LINK}>
                    {item.aHtml.linkText}
                  </a>
                  {item.aHtml.after}
                </>
              ) : (
                item.a
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SiblingsSection({
  siblings,
  airline,
}: {
  siblings: AircraftTypeSibling[];
  airline: string;
}) {
  if (siblings.length === 0) return null;
  const sorted = [...siblings].sort(
    (a, b) => b.starlink / b.total - a.starlink / a.total || b.total - a.total
  );
  return (
    <section className={CARD}>
      <h2 className={H2_CARD}>Other {airline} aircraft</h2>
      <ul className="grid sm:grid-cols-2 gap-x-8">
        {sorted.map((s) => (
          <ShareBarRow
            key={s.slug}
            label={s.short}
            href={`/fleet/${s.slug}`}
            n={s.starlink}
            total={s.total}
          />
        ))}
      </ul>
    </section>
  );
}

export default function AircraftTypePage({
  site,
  pageLinks,
  currentPath,
  def,
  data,
  answer,
  facts,
  faq,
  siblings,
  iata,
  lastUpdated,
  checkFlight,
  spec,
}: AircraftTypePageProps) {
  const airline = tenantCopy(data.airline).airline;
  const target = targetFact(facts, def.slug);
  // Above the fold only where the answer is "not yet"; it then leaves the
  // facts list so the page states it once besides the FAQ.
  const headerTarget = target?.asOf && TARGET_IN_HEADER.has(answer.kind) ? target : null;
  return (
    <PageShell site={site} currentPath={currentPath} pageLinks={pageLinks}>
      <PageHeader
        eyebrow={
          <nav aria-label="Breadcrumb">
            <a href="/fleet" className="hover:text-accent transition-colors">
              Fleet
            </a>{" "}
            › {def.name}
          </nav>
        }
        title={
          <>
            Does the {airline} {def.short} have Starlink?
          </>
        }
      />

      <div className="relative max-w-3xl mx-auto w-full mb-8">
        <Header
          def={def}
          data={data}
          answer={answer}
          airline={airline}
          lastUpdated={lastUpdated}
          target={headerTarget}
        />

        {answer.shareLine && (
          <section className={CARD}>
            <h2 className={H2_CARD}>
              Flying on {article(def.short)} {def.short}?
            </h2>
            <p className="text-sm text-secondary leading-relaxed">{answer.shareLine}</p>
            {checkFlight && <CheckForm iata={iata} />}
          </section>
        )}

        <VariantsSection data={data} />
        <PipelineSection def={def} data={data} />
        <RecentSection def={def} data={data} />
        <RoutesSection def={def} data={data} />
        <FlightsSection def={def} data={data} answer={answer} />
        <FactsSection facts={facts.filter((f) => f !== headerTarget)} airline={airline} />
        <SpecsSection def={def} spec={spec} />
        <FaqSection faq={faq} />
        <SiblingsSection siblings={siblings} airline={airline} />

        <p className="text-sm text-muted text-center">
          The aircraft on your flight is what counts.{" "}
          {checkFlight ? (
            <a href="/check-flight" className={LINK}>
              Check your flight →
            </a>
          ) : (
            <a href="/fleet" className={LINK}>
              See the whole fleet →
            </a>
          )}
        </p>
      </div>
    </PageShell>
  );
}
