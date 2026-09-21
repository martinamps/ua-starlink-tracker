import React from "react";
import {
  type AircraftAnswer,
  type AircraftPageDef,
  type OfficialCount,
  PROVIDER_NAMES,
  SHARE_KINDS,
  type TypeFaqItem,
  factText,
  sharePct,
  sheetComparison,
  targetFact,
  tenantCopy,
} from "../airlines/aircraft-pages";
import type { SiteConfig } from "../airlines/registry";
import { type RolloutFact, formatFactDate } from "../airlines/rollout-facts";
import type { AircraftTypePageData, AircraftVerdictKind, WifiProvider } from "../types";
import type { AircraftSpec } from "../utils/aircraft-specs";
import { article } from "../utils/grammar";
import { PageFooter, type PageLink } from "./atoms";
import {
  EYEBROW,
  FLEET_GRID_CSS,
  MovementsPanel,
  PANEL,
  PROVIDER_ORDER,
  PipelineBar,
  PipelineTailChip,
  STATION_NAMES,
} from "./fleet-page";

export interface AircraftTypeSibling {
  slug: string;
  short: string;
  starlink: number;
  total: number;
}

interface AircraftTypePageProps {
  site: SiteConfig;
  pageLinks?: PageLink[];
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

const TAIL_CHIP_CLASS: Record<WifiProvider, string> = {
  starlink: "tchip tchip-sl",
  viasat: "tchip tchip-dim",
  panasonic: "tchip tchip-dim",
  thales: "tchip tchip-dim",
  none: "tchip tchip-dim",
  unknown: "tchip tchip-dim",
};

const PAGE_CSS = `
  .verdict { border-left-width: 3px; }
  .verdict-yes  { border-left-color: var(--color-accent); }
  .verdict-most { border-left-color: rgba(14, 165, 233, 0.6); }
  .verdict-some { border-left-color: rgba(14, 165, 233, 0.35); }
  .verdict-wait { border-left-color: #f59e0b; }
  .verdict-no   { border-left-color: rgba(90, 106, 128, 0.6); }
  .tchip { font-family: var(--font-mono, monospace); font-size: 11px; text-decoration: none; padding: 1px 5px; border-radius: 3px; }
  .tchip:hover { text-decoration: underline; }
  .tchip-sl  { color: var(--color-accent); background: rgba(14, 165, 233, 0.08); }
  .tchip-dim { color: var(--color-text-muted); }
`;

const H2 = "font-display text-lg font-semibold text-primary mb-2";
const CARD = `${PANEL} mb-4`;
const LINK = "text-accent hover:underline";

function monthDay(iso: string): string {
  return formatFactDate(iso.slice(0, 10));
}

function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center">
      <div className="font-display text-2xl font-semibold text-primary tabular-nums">{value}</div>
      <div className="font-mono text-[10px] text-muted uppercase tracking-wider">{label}</div>
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
      <p id="answer" className="text-base text-secondary leading-relaxed">
        <strong className="font-display text-primary">{answer.headline}</strong> {answer.sentence}
        {lastUpdated && <span className="text-muted text-xs"> As of {lastUpdated}.</span>}
      </p>
      <div
        className="grid grid-cols-3 gap-3 mt-4"
        data-equipped={data.starlink}
        data-total={data.total}
        data-official={official ? official.count : undefined}
      >
        <StatCell label={official ? "Confirmed by us" : "With Starlink"} value={data.starlink} />
        <StatCell label={`${airline} ${def.short}s`} value={data.total} />
        {official && (official.count > data.starlink || answer.rosterShort) ? (
          <StatCell label={`Per ${airline}`} value={official.count} />
        ) : (
          <StatCell label="Share" value={sharePct(answer.effective, data.total)} />
        )}
      </div>
      {official && (
        <p className="text-xs text-muted mt-3">
          {airline}'s figure:{" "}
          <a href={official.url} className={LINK} rel="noopener noreferrer" target="_blank">
            {official.sourceLabel}
          </a>
          , updated {formatFactDate(official.asOf)}.
        </p>
      )}
      {target?.asOf && (
        <p className="text-xs text-muted mt-3">
          {airline}'s stated target ({formatFactDate(target.asOf)}): {factText(target)}
        </p>
      )}
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
          className="flex-1 min-w-0 bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none"
        />
        <input
          type="date"
          id="type-flight-date"
          name="date"
          aria-label="Flight date"
          className="bg-base border border-subtle rounded px-3 py-2 text-primary font-mono text-sm focus:outline-none sm:w-40"
        />
        <button
          type="submit"
          className="px-5 py-2 border border-subtle text-accent font-display font-semibold rounded cursor-pointer whitespace-nowrap"
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

function ProvidersSection({
  def,
  data,
  airline,
}: {
  def: AircraftPageDef;
  data: AircraftTypePageData;
  airline: string;
}) {
  const copy = tenantCopy(data.airline);
  if (!copy.checksEveryTail) {
    if (data.starlink >= data.total) return null;
    return (
      <section className={CARD}>
        <h2 className={H2}>
          {data.starlink > 0 ? "What the rest have today" : "What they have today"}
        </h2>
        <p className="text-sm text-muted">
          No tail-level WiFi data: {airline} doesn't publish it per aircraft.
          {data.starlink > 0 &&
            ` The ${data.starlink} ${def.short}s we can confirm with Starlink are highlighted below.`}
        </p>
      </section>
    );
  }
  if (data.knownOther === 0 && data.unchecked === 0) return null;
  const shown = PROVIDER_ORDER.filter((p) => p !== "unknown" && data.providers[p] > 0);
  return (
    <section className={CARD}>
      <h2 className={H2}>
        {data.starlink > 0 ? "What the rest have today" : "What they have today"}
      </h2>
      {data.checked > 0 && (
        <div className="flex h-3 rounded overflow-hidden bg-surface-elevated mb-3">
          {shown.map((p) => (
            <span
              key={p}
              className={`wifi-${p}`}
              style={{ width: `${(data.providers[p] / data.checked) * 100}%` }}
              title={`${PROVIDER_NAMES[p]}: ${data.providers[p]}`}
            />
          ))}
        </div>
      )}
      <ul className="font-mono text-xs text-secondary space-y-1">
        {shown.map((p) => (
          <li key={p} className="flex items-center gap-2">
            <span className={`wifi-${p} inline-block w-2.5 h-2.5 rounded-[1px]`} />
            {data.providers[p]} {p === "none" ? "with no WiFi" : PROVIDER_NAMES[p]}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted mt-3">
        Last checked on united.com.
        {data.unchecked > 0 && ` ${data.unchecked} not checked yet.`}
      </p>
    </section>
  );
}

function VariantsSection({ data }: { data: AircraftTypePageData }) {
  if (!data.variants || data.variants.length < 2) return null;
  return (
    <section className={CARD}>
      <h2 className={H2}>By variant</h2>
      <table className="w-full font-mono text-xs text-secondary">
        <tbody>
          {data.variants.map((v) => (
            <tr key={v.label} className="border-t border-subtle">
              <td className="py-1">{v.label}</td>
              <td className="py-1 text-right">
                {v.starlink} of {v.total} with Starlink
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PipelineSection({ def, data }: { def: AircraftPageDef; data: AircraftTypePageData }) {
  const p = data.pipeline;
  if (!p) return null;
  const queued = p.tails.filter((t) => t.state === "scheduled").length;
  const stations = [...new Set(p.tails.map((t) => t.mod_location).filter(Boolean))]
    .filter((c): c is string => !!c && !!STATION_NAMES[c])
    .sort()
    .map((c) => `${c} ${STATION_NAMES[c]}`);
  return (
    <section className={CARD}>
      <h2 className={H2}>{def.short} install pipeline</h2>
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
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-secondary mt-3">
          {p.rows.map((r) => (
            <div key={r.type_code}>
              {r.label === r.type_code ? r.label : `${r.label} (${r.type_code})`}:{" "}
              {r.starlink_complete}/{r.total} complete
              {r.in_mod > 0 ? `, ${r.in_mod} in mod` : ""}
              {r.verification_needed > 0 ? `, ${r.verification_needed} verifying` : ""}
            </div>
          ))}
        </div>
      )}
      {p.tails.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {p.tails.map((t) => (
            <PipelineTailChip key={t.tail} row={t} anchorBase="/fleet" />
          ))}
        </div>
      )}
      {p.movements.length > 0 && <MovementsPanel movements={p.movements} anchorBase="/fleet" />}
      {stations.length > 0 && (
        <p className="font-mono text-[10px] text-muted mt-3">
          Mod stations: {stations.join(" · ")}
        </p>
      )}
    </section>
  );
}

function RecentSection({ def, data }: { def: AircraftPageDef; data: AircraftTypePageData }) {
  if (data.recentInstalls.length === 0) return null;
  return (
    <section className={CARD}>
      <h2 className={H2}>Recently first seen with Starlink</h2>
      <ul className="font-mono text-xs text-secondary grid grid-cols-2 sm:grid-cols-3 gap-1">
        {data.recentInstalls.map((r) => (
          <li key={r.tail}>
            <a href={`/fleet#t-${r.tail}`} className="text-accent hover:underline">
              {r.tail}
            </a>{" "}
            <span className="text-muted">{monthDay(r.date)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted mt-3">
        The date each {def.short} first appeared with Starlink in the tracked data, leaving out bulk
        imports{data.firstSeen ? `; the earliest such date was ${monthDay(data.firstSeen)}` : ""}.
      </p>
    </section>
  );
}

function RoutesSection({ def, data }: { def: AircraftPageDef; data: AircraftTypePageData }) {
  if (data.routes.length === 0) return null;
  return (
    <section className={CARD}>
      <h2 className={H2}>Where Starlink {def.short}s fly next (48 h)</h2>
      <p className="text-xs text-muted mb-3">
        {data.routeTotals.departures} scheduled departures on {data.routeTotals.pairs}{" "}
        {data.routeTotals.pairs === 1 ? "route" : "routes"}; the busiest:
      </p>
      <ul className="font-mono text-xs text-secondary grid sm:grid-cols-2 gap-1">
        {data.routes.map((r) => (
          <li key={`${r.origin}-${r.destination}`}>
            {r.href ? (
              <a href={r.href} className={LINK}>
                {r.origin} → {r.destination}
              </a>
            ) : (
              <span>
                {r.origin} → {r.destination}
              </span>
            )}{" "}
            <span className="text-muted">
              {r.departures} {r.departures === 1 ? "departure" : "departures"}
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
  const caption = starlinkOnly
    ? `Flights that recently had a Starlink ${def.short}`
    : SHARE_KINDS.has(answer.kind)
      ? `Flight numbers that often get ${article(def.short)} ${def.short}, seen on this type in the last 30 days of observed assignments.`
      : expect === "none"
        ? `Flights that usually get ${article(def.short)} ${def.short}, so expect no WiFi.`
        : expect
          ? `Flights that usually get ${article(def.short)} ${def.short}, so expect ${PROVIDER_NAMES[expect]} WiFi rather than Starlink.`
          : `Flights that usually get ${article(def.short)} ${def.short}.`;
  return (
    <section className={CARD}>
      <h2 className={H2}>
        {starlinkOnly ? "Recent flights" : `Flights that use the ${def.short}`}
      </h2>
      <p className="text-xs text-muted mb-3">{caption}</p>
      <ul className="flex flex-wrap gap-2 font-mono text-xs">
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
      <h2 className={H2}>What {airline} has said</h2>
      <ul className="space-y-3">
        {facts.map((f) => (
          <li
            key={f.source.url + (f.asOf ?? "")}
            className="text-sm text-secondary leading-relaxed"
          >
            {f.asOf && (
              <span className="font-mono text-[11px] text-muted">{formatFactDate(f.asOf)} · </span>
            )}
            {factText(f)}{" "}
            <a
              href={f.source.url}
              className={`${LINK} text-xs`}
              rel="noopener noreferrer"
              target="_blank"
            >
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
    ["Range", `${spec.range_mi.toLocaleString("en-US")} mi`],
    ["Cruise", `${spec.cruise_mph} mph`],
    ["First flight", String(spec.first_flight)],
    ["Engines", spec.engines],
  ];
  return (
    <section className={CARD}>
      <h2 className={H2}>The {def.name}</h2>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-xs">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-muted">{k}</dt>
            <dd className="text-secondary">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function TailsSection({
  def,
  data,
  airline,
}: {
  def: AircraftPageDef;
  data: AircraftTypePageData;
  airline: string;
}) {
  return (
    <section className={CARD}>
      <h2 className={H2}>
        Every {airline} {def.short} ({data.total})
      </h2>
      <p className="text-xs text-muted mb-3">
        Highlighted tails have Starlink. Each links to its row in the{" "}
        <a href="/fleet" className={LINK}>
          fleet registry
        </a>
        .
      </p>
      <div className="flex flex-wrap gap-1">
        {data.tails.map((t) => (
          <a key={t.tail} href={`/fleet#t-${t.tail}`} className={TAIL_CHIP_CLASS[t.provider]}>
            {t.tail}
          </a>
        ))}
      </div>
    </section>
  );
}

function FaqSection({ faq }: { faq: TypeFaqItem[] }) {
  if (faq.length === 0) return null;
  return (
    <section className={CARD}>
      <h2 className={H2}>Questions</h2>
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

export default function AircraftTypePage({
  site,
  pageLinks,
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
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />
      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static CSS, no user input
        dangerouslySetInnerHTML={{ __html: FLEET_GRID_CSS + PAGE_CSS }}
      />

      <header className="relative py-5 sm:py-6 text-center mb-3">
        <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-muted mb-2">
          <a href="/fleet" className="hover:underline">
            Fleet
          </a>{" "}
          › {def.name}
        </nav>
        <h1 className="font-display text-3xl sm:text-4xl font-semibold text-primary tracking-tight">
          Does the {airline} {def.short} have Starlink?
        </h1>
      </header>

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
            <h2 className={H2}>
              Flying on {article(def.short)} {def.short}?
            </h2>
            <p className="text-sm text-secondary leading-relaxed">{answer.shareLine}</p>
            {checkFlight && <CheckForm iata={iata} />}
          </section>
        )}

        <ProvidersSection def={def} data={data} airline={airline} />
        <VariantsSection data={data} />
        <PipelineSection def={def} data={data} />
        <RecentSection def={def} data={data} />
        <RoutesSection def={def} data={data} />
        <FlightsSection def={def} data={data} answer={answer} />
        <FactsSection facts={facts.filter((f) => f !== headerTarget)} airline={airline} />
        <SpecsSection def={def} spec={spec} />
        <TailsSection def={def} data={data} airline={airline} />
        <FaqSection faq={faq} />

        {siblings.length > 0 && (
          <section className={CARD}>
            <div className={EYEBROW}>Other {airline} aircraft types</div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
              {siblings.map((s) => (
                <li key={s.slug}>
                  <a href={`/fleet/${s.slug}`} className={LINK}>
                    {s.short}
                  </a>{" "}
                  <span className="text-muted">
                    {s.starlink}/{s.total}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-sm text-muted text-center">
          The type is only a starting point: the aircraft assigned to your flight decides it.{" "}
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

      <PageFooter site={site} pageLinks={pageLinks} />
    </div>
  );
}
