import React from "react";
import { AIRLINES, type SiteConfig } from "../airlines/registry";
import type {
  FleetAnchorRow,
  FleetFamily,
  FleetMovement,
  FleetPageData,
  FleetProgressRow,
  FleetProgressTailRow,
  FleetTail,
  WifiProvider,
} from "../types";
import { AIRCRAFT_SPECS, type AircraftSpec } from "../utils/aircraft-specs";
import { type PageLink, PageNavLinks, ShareCardLink } from "./atoms";

const PROVIDER_LABEL: Record<WifiProvider, string> = {
  starlink: "Starlink",
  viasat: "Viasat",
  panasonic: "Panasonic",
  thales: "Thales",
  none: "None",
  unknown: "?",
};

const PROVIDER_ORDER: WifiProvider[] = [
  "starlink",
  "viasat",
  "panasonic",
  "thales",
  "none",
  "unknown",
];

function timeAgo(sec: number | null): string {
  if (!sec) return "never";
  const d = Math.floor((Date.now() / 1000 - sec) / 86400);
  return d === 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;
}

const EYEBROW = "text-[10px] font-mono text-muted uppercase tracking-wider mb-3";
const PANEL = "bg-surface border border-subtle rounded-lg p-5";
const SECTION = "relative w-full max-w-6xl mx-auto mb-10";

type PipelineMap = Map<string, FleetProgressTailRow>;

// Mod-line stations as the progress sheets abbreviate them. Only entries we're
// sure of — an unlisted code renders as the bare code rather than a guess.
const STATION_NAMES: Record<string, string> = {
  MLB: "Melbourne, FL",
  MIA: "Miami, FL",
  LCQ: "Lake City, FL",
  BFM: "Mobile, AL",
  GSO: "Greensboro, NC",
  RFD: "Rockford, IL",
  MCO: "Orlando, FL",
  IAB: "Wichita, KS",
  PNS: "Pensacola, FL",
  GYR: "Goodyear, AZ",
  ROW: "Roswell, NM",
  ILN: "Wilmington, OH",
  INT: "Winston-Salem, NC",
  SAL: "San Salvador, El Salvador",
  BQN: "Aguadilla, Puerto Rico",
  XMN: "Xiamen, China",
  HKG: "Hong Kong",
  GIG: "Rio de Janeiro, Brazil",
  SFO: "San Francisco, CA",
  LAX: "Los Angeles, CA",
  IAH: "Houston, TX",
  EWR: "Newark, NJ",
  ORD: "Chicago, IL",
  GUM: "Guam",
  MDE: "Medellín, Colombia",
  PEK: "Beijing, China",
  SIN: "Singapore",
  FTW: "Fort Worth, TX",
  AMA: "Amarillo, TX",
  VCV: "Victorville, CA",
  CWF: "Lake Charles, LA",
};

// "MLB (Melbourne, FL)" — the code stays first so the vocabulary gets taught,
// not replaced; an unknown code renders bare.
function stationPhrase(code: string): string {
  const name = STATION_NAMES[code];
  return name ? `${code} (${name})` : code;
}

const PIPELINE_LABEL: Record<FleetProgressTailRow["state"], string> = {
  in_mod: "Starlink install underway",
  verification_needed: "install finished — awaiting verification",
  scheduled: "queued for a future mod line",
};

function pipelinePhrase(state: FleetProgressTailRow["state"], loc: string | null): string {
  return `${PIPELINE_LABEL[state]}${loc ? ` at ${stationPhrase(loc)}` : ""}`;
}

function pipelineNote(p: PipelineMap, tail: string): string {
  const row = p.get(tail);
  if (!row) return "";
  return ` · ${pipelinePhrase(row.state, row.mod_location)}`;
}

function cellTitle(t: FleetTail, pipeline: PipelineMap): string {
  return `${t.tail} · ${PROVIDER_LABEL[t.provider]}${pipelineNote(pipeline, t.tail)}`;
}

function monumentTitle(t: FleetTail, pipeline: PipelineMap): string {
  return `${t.type || "type unknown"} · ${PROVIDER_LABEL[t.provider]}${pipelineNote(pipeline, t.tail)} · ${t.fleet} · verified ${timeAgo(t.verified_at)} · click for live tracking`;
}

function monumentClass(t: FleetTail, pipeline: PipelineMap): string {
  if (t.provider === "starlink") return "tail-sl";
  return pipeline.has(t.tail) ? "tail-dim tail-pipe" : "tail-dim";
}

function monumentDotClass(t: FleetTail, pipeline: PipelineMap): string {
  if (t.provider === "starlink") return "";
  const state = pipeline.get(t.tail)?.state;
  if (state === "in_mod" || state === "scheduled") return " dot-mod";
  if (state === "verification_needed") return " dot-verif";
  return "";
}

function monumentDot(t: FleetTail, pipeline: PipelineMap): string {
  if (t.provider === "starlink") return "◉";
  const state = pipeline.get(t.tail)?.state;
  if (state === "in_mod") return "○";
  if (state === "verification_needed") return "◎";
  if (state === "scheduled") return "◌";
  return " ";
}

const FAMILY_ABBR: Record<string, string> = {
  E175: "E175",
  "ERJ-145": "ERJ145",
  "CRJ-200": "CRJ200",
  "CRJ-550": "CRJ550",
  "CRJ-700": "CRJ700",
  "B737-700": "737-700",
  "B737-800": "737-800",
  "B737-900": "737-900",
  "B737-MAX8": "MAX8",
  "B737-MAX9": "MAX9",
  "B737-MAX10": "MAX10",
  B757: "757",
  B767: "767",
  B777: "777",
  B787: "787",
  A319: "A319",
  A320: "A320",
  A321: "A321",
  A350: "A350",
};

function Sparkline({ data, peak }: { data: number[]; peak: number }) {
  if (data.length < 2 || peak === 0) {
    return <div className="h-16 flex items-center text-muted text-xs">no flight data</div>;
  }
  const w = 600;
  const h = 64;
  const step = w / (data.length - 1);
  const y = (v: number) => h - (v / peak) * (h - 4) - 2;
  const path = data
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`)
    .join("");
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full h-16"
      preserveAspectRatio="none"
      role="img"
      aria-label="Airborne Starlink planes over the scheduled window"
    >
      <path d={area} fill="var(--color-accent)" opacity="0.15" />
      <path d={path} stroke="var(--color-accent)" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

function LivePulse({ pulse }: { pulse: FleetPageData["pulse"] }) {
  const haveData = pulse.sparkline.length > 0;
  return (
    <section className="relative max-w-4xl mx-auto text-center mb-10">
      <div className={`${PANEL} p-6 glow-accent`}>
        <div className={EYEBROW}>Live Pulse</div>
        <div className="flex items-baseline justify-center gap-3 mb-2">
          {pulse.now > 0 && <span className="status-dot animate-pulse-glow" />}
          <span className="font-display text-5xl sm:text-6xl font-bold text-accent tabular-nums">
            {haveData ? pulse.now : "—"}
          </span>
        </div>
        <p className="text-sm text-secondary mb-4">
          {haveData
            ? "Starlink planes in the air right now"
            : "Airborne count unavailable (data refreshing)"}
        </p>
        <Sparkline data={pulse.sparkline} peak={pulse.peak} />
        <div className="flex items-center justify-center gap-4 text-[10px] font-mono text-muted mt-2">
          <span>
            peak <span className="text-accent">{pulse.peak}</span>
          </span>
          <span>·</span>
          <span>
            trough <span className="text-secondary">{pulse.trough}</span>
          </span>
          <span>·</span>
          <span>
            <span className="text-accent">{pulse.totalHours.toFixed(0)}</span> Starlink flight-hrs
            scheduled
          </span>
        </div>
      </div>
    </section>
  );
}

// The two pipeline states worth a visual on the grid — "scheduled" stays
// title-only (a dashed 8px cell reads as rendering noise, not information).
function pipelineCellClass(p: PipelineMap, tail: string): string {
  const state = p.get(tail)?.state;
  if (state === "in_mod") return " pipe-mod";
  if (state === "verification_needed") return " pipe-verif";
  return "";
}

function TailGrid({ tails, pipeline }: { tails: FleetTail[]; pipeline: PipelineMap }) {
  return (
    <div className="grid grid-cols-[repeat(10,8px)] gap-[2px]">
      {tails.map((t) => (
        // biome-ignore lint/a11y/useAnchorContent: aria-label provides the accessible name; inline text on 1.5k cells would add ~50KB
        <a
          key={t.tail}
          href={`#t-${t.tail}`}
          title={cellTitle(t, pipeline)}
          aria-label={cellTitle(t, pipeline)}
          className={`wifi-${t.provider}${pipelineCellClass(pipeline, t.tail)} w-2 h-2 rounded-[1px] hover:scale-150 transition-transform`}
        />
      ))}
    </div>
  );
}

function SpecCard({ family, spec }: { family: string; spec: AircraftSpec }) {
  const row = (label: string, value: string | number, unit = "") => (
    <div className="flex justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className="text-secondary text-right">
        {value}
        {unit && <span className="text-muted ml-0.5">{unit}</span>}
      </span>
    </div>
  );
  return (
    <div className="spec-card absolute top-full left-0 mt-1 w-64 bg-surface-elevated border border-subtle rounded-lg p-3 text-[11px] font-mono shadow-xl z-20">
      <div className="font-display text-sm font-semibold text-primary mb-2 tracking-wide">
        {family}
      </div>
      <div className="space-y-1 mb-2">
        {row("Seats", spec.seats)}
        {row("Wingspan", spec.wingspan_ft, "ft")}
        {row("Length", spec.length_ft, "ft")}
        {row("Range", spec.range_mi.toLocaleString(), "mi")}
        {row("Cruise", spec.cruise_mph, "mph")}
        {row("First flight", spec.first_flight)}
        {row("Engines", spec.engines)}
      </div>
      <p className="text-[10px] text-accent/80 leading-snug pt-2 border-t border-subtle">
        {spec.fun_fact}
      </p>
    </div>
  );
}

function FamilyBlock({ fam, pipeline }: { fam: FleetFamily; pipeline: PipelineMap }) {
  const pct = Math.round((fam.starlink / fam.total) * 100);
  const spec = AIRCRAFT_SPECS[fam.family];
  return (
    <details className="fam-block bg-surface border border-subtle rounded" open>
      <summary className="fam-summary list-none flex items-start justify-between gap-2 p-2">
        <div className="min-w-0">
          <span
            className={`spec-trigger relative block font-display text-xs font-semibold uppercase tracking-wide ${
              spec ? "text-secondary hover:text-accent cursor-help" : "text-secondary"
            }`}
            tabIndex={spec ? 0 : -1}
          >
            <span className="block truncate">{fam.family}</span>
            {spec && <SpecCard family={fam.family} spec={spec} />}
          </span>
          <span className="font-mono text-[10px] text-muted">
            {fam.starlink}/{fam.total}
            {pct > 0 && <span className="text-accent ml-1.5">{pct}%</span>}
          </span>
        </div>
        <svg
          className="fam-caret w-3 h-3 text-muted shrink-0"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 11L3 6h10z" />
        </svg>
      </summary>
      <div className="px-2 pb-2">
        <TailGrid tails={fam.tails} pipeline={pipeline} />
      </div>
    </details>
  );
}

function Legend({ pipeline }: { pipeline: PipelineMap }) {
  const count = (state: string) => [...pipeline.values()].filter((r) => r.state === state).length;
  const inMod = count("in_mod");
  const verif = count("verification_needed");
  return (
    <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-muted">
      {PROVIDER_ORDER.map((p) => (
        <span key={p} className="inline-flex items-center gap-1.5">
          <span className={`wifi-${p} w-2.5 h-2.5 rounded-[1px]`} />
          {PROVIDER_LABEL[p]}
        </span>
      ))}
      {inMod > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span className="pipe-mod w-2.5 h-2.5 rounded-[1px]" />
          in mod line
        </span>
      )}
      {verif > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span className="pipe-verif w-2.5 h-2.5 rounded-[1px]" />
          install verifying
        </span>
      )}
    </div>
  );
}

function HangarFloor({
  families,
  totalFleet,
  totalStarlink,
  scopeLabel,
  pipeline,
}: {
  families: FleetFamily[];
  totalFleet: number;
  totalStarlink: number;
  scopeLabel: string;
  pipeline: PipelineMap;
}) {
  return (
    <section className={SECTION}>
      <div className="mb-4">
        <h2 className="font-display text-xl font-semibold text-primary mb-1">The Hangar Floor</h2>
        <p className="text-xs text-muted mb-3">
          Every {scopeLabel} tail number is one cell. {totalStarlink} of {totalFleet} currently show
          Starlink. The color tells you which WiFi system is installed today.
        </p>
        <Legend pipeline={pipeline} />
      </div>

      <div className="fam-container gap-3">
        {families.map((fam) => (
          <FamilyBlock key={fam.family} fam={fam} pipeline={pipeline} />
        ))}
      </div>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline script, no user input
        dangerouslySetInnerHTML={{
          __html: `if(matchMedia('(max-width:767px)').matches)document.querySelectorAll('.fam-block').forEach(d=>d.removeAttribute('open'))`,
        }}
      />
    </section>
  );
}

function InstallPaceSection({ pace }: { pace: FleetPageData["installPace"] }) {
  if (!pace) return null;
  const totalRecent = pace.weeks.reduce((s, w) => s + w.installs, 0);
  if (totalRecent === 0 && pace.express.starlink === 0 && pace.mainline.starlink === 0) return null;
  const peak = Math.max(1, ...pace.weeks.map((w) => w.installs));
  const currentWeekStart = pace.weeks[pace.weeks.length - 1]?.weekStart;
  const monthDay = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  // Labels mirror the homepage rings (getFleetStats buckets), which fold every
  // regional subfleet into "express" — keep them generic, not type-specific.
  // A missing fleet-total meta key must degrade to a count, not hide equipped
  // aircraft the homepage rings and the tail list on this page both show.
  const groups = [
    { label: "Express & regional", g: pace.express },
    { label: "Mainline", g: pace.mainline },
  ].filter((x) => x.g.total > 0 || x.g.starlink > 0);

  return (
    <section className={SECTION}>
      <div className="mb-4">
        <h2 className="font-display text-xl font-semibold text-primary mb-1">Install Pace</h2>
        <p className="text-xs text-muted">
          Newly Starlink-equipped aircraft per week, by first appearance in the tracked fleet data —
          installs typically surface within a few days. {totalRecent} added in the last 10 weeks.
        </p>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className={PANEL}>
          <div className={EYEBROW}>Installs per week</div>
          <div className="flex items-end gap-1.5 h-28">
            {pace.weeks.map((w) => (
              <div key={w.weekStart} className="flex-1 flex flex-col items-center gap-1">
                <span className="font-mono text-[10px] text-secondary">
                  {w.installs > 0 ? w.installs : ""}
                </span>
                <div
                  className={`w-full bg-[var(--color-accent)] rounded-t ${
                    w.weekStart === currentWeekStart ? "opacity-40" : "opacity-80"
                  }`}
                  style={{ height: `${(w.installs / peak) * 80}px` }}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between font-mono text-[9px] text-muted mt-1">
            <span>{monthDay(pace.weeks[0].weekStart)}</span>
            <span>
              {monthDay(pace.weeks[pace.weeks.length - 1].weekStart)} (this week, partial)
            </span>
          </div>
        </div>
        <div className={PANEL}>
          <div className={EYEBROW}>Rollout progress</div>
          <div className="space-y-4">
            {groups.map(({ label, g }) => {
              const pct = g.total > 0 ? Math.round((g.starlink / g.total) * 100) : null;
              return (
                <div key={label}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="font-display text-sm font-semibold text-secondary">
                      {label}
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                      {pct !== null ? (
                        <>
                          {g.starlink}/{g.total} <span className="text-accent">{pct}%</span>
                        </>
                      ) : (
                        <>{g.starlink} equipped</>
                      )}
                    </span>
                  </div>
                  {pct !== null && (
                    <div className="h-2 bg-surface-elevated rounded overflow-hidden">
                      <div
                        className="h-full bg-[var(--color-accent)]"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {pace.projectedFinishMonth && (
            <p className="text-[11px] text-muted mt-4 leading-snug">
              At the recent mainline pace of ~{pace.mainlinePaceWk}/week, the remaining{" "}
              {pace.remainingMainline} mainline aircraft would wrap up around{" "}
              <span className="text-accent">{pace.projectedFinishMonth}</span>. Straight-line
              estimate from the last six weeks of tracked installs — rates change as hangar lines
              open and close.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function CarrierLeaderboard({ carriers }: { carriers: FleetPageData["carriers"] }) {
  if (carriers.length === 0) return null;
  const max = Math.max(...carriers.map((c) => c.total));
  return (
    <div className={PANEL}>
      <div className={EYEBROW}>Operating Carriers</div>
      <div className="space-y-3">
        {carriers.map((c, i) => {
          const widthPct = (c.total / max) * 100;
          const fillPct = c.pct;
          return (
            <div key={c.name}>
              <div className="flex items-baseline justify-between mb-1">
                <span className="font-display text-sm font-semibold text-secondary">
                  {c.name}
                  {i === 0 && fillPct >= 95 && (
                    <span className="ml-1.5 text-accent text-xs">◉ leading</span>
                  )}
                </span>
                <span className="font-mono text-[10px] text-muted">
                  {c.confirmed}/{c.total} <span className="text-accent">{c.pct.toFixed(0)}%</span>
                </span>
              </div>
              <div
                className="h-2 bg-surface-elevated rounded overflow-hidden"
                style={{ width: `${widthPct}%` }}
              >
                <div className="h-full bg-[var(--color-accent)]" style={{ width: `${fillPct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IronyStack({ bodyClass }: { bodyClass: FleetPageData["bodyClass"] }) {
  const rows = [
    { key: "regional" as const, label: "Regional", sub: "E175 · CRJ · ERJ" },
    { key: "narrowbody" as const, label: "Narrowbody", sub: "737 · A319/320/321 · 757" },
    { key: "widebody" as const, label: "Widebody", sub: "777 · 787 · 767" },
  ];
  return (
    <div className={PANEL}>
      <div className={EYEBROW}>WiFi by Aircraft Size</div>
      <div className="space-y-4">
        {rows.map((r) => {
          const data = bodyClass[r.key];
          const total = Object.values(data).reduce((a, b) => a + b, 0);
          return (
            <div key={r.key}>
              <div className="flex items-baseline justify-between mb-1">
                <div>
                  <span className="font-display text-sm font-semibold text-secondary">
                    {r.label}
                  </span>
                  <span className="font-mono text-[9px] text-muted ml-2">{r.sub}</span>
                </div>
                <span className="font-mono text-[10px]">
                  <span className={data.starlink > 0 ? "text-accent" : "text-muted"}>
                    {data.starlink}
                  </span>
                  <span className="text-muted"> / {total} Starlink</span>
                </span>
              </div>
              <div className="flex h-3 rounded overflow-hidden bg-surface-elevated">
                {PROVIDER_ORDER.map((p) =>
                  data[p] > 0 ? (
                    <span
                      key={p}
                      className={`wifi-${p}`}
                      style={{ width: `${(data[p] / total) * 100}%` }}
                      title={`${PROVIDER_LABEL[p]}: ${data[p]}`}
                    />
                  ) : null
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted mt-4 italic leading-snug">
        Retrofit timing is uneven: smaller fleets often finish first, while long-haul cabins take
        longer to convert.
      </p>
    </div>
  );
}

function TailMonument({
  allTails,
  totalFleet,
  pipeline,
}: {
  allTails: FleetTail[];
  totalFleet: number;
  pipeline: PipelineMap;
}) {
  const byProvider: Record<WifiProvider, number> = {
    starlink: 0,
    viasat: 0,
    panasonic: 0,
    thales: 0,
    none: 0,
    unknown: 0,
  };
  for (const t of allTails) byProvider[t.provider]++;

  return (
    <section className={SECTION}>
      <div className="mb-4">
        <h2 className="font-display text-xl font-semibold text-primary mb-1">Tail Registry</h2>
        <p className="text-xs text-muted mb-2">
          All {totalFleet} tails —{" "}
          <kbd className="px-1 bg-surface border border-subtle rounded text-[10px]">⌘F</kbd> to find
          yours, click to track on FlightAware. Cyan = Starlink, dim = everything else.
        </p>
        <div className="flex flex-wrap gap-3 font-mono text-[10px] text-muted">
          {PROVIDER_ORDER.map((p) =>
            byProvider[p] > 0 ? (
              <span key={p} className="inline-flex items-center gap-1">
                <span className={`wifi-${p} w-2 h-2 rounded-[1px]`} />
                {byProvider[p]} {PROVIDER_LABEL[p]}
              </span>
            ) : null
          )}
        </div>
      </div>
      <div className="bg-surface border border-subtle rounded-lg p-4 font-mono text-[10px] leading-[1.7] columns-[18ch] gap-x-3">
        {allTails.map((t) => (
          <a
            key={t.tail}
            id={`t-${t.tail}`}
            href={`https://flightaware.com/live/flight/${t.tail}`}
            target="_blank"
            rel="nofollow noreferrer noopener"
            title={monumentTitle(t, pipeline)}
            className={monumentClass(t, pipeline)}
          >
            <span className={`tail-dot${monumentDotClass(t, pipeline)}`}>
              {monumentDot(t, pipeline)}
            </span>
            <span className="tail-num">{t.tail}</span>
            <span className="tail-abbr">{FAMILY_ABBR[t.family] || "—"}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

const PROGRESS_SEGMENT_LABELS: Record<string, string> = {
  mainline_nb: "Mainline narrowbody",
  mainline_wb: "Mainline widebody",
  express: "Express & regional",
};

function PipelineTailChip({ row }: { row: FleetProgressTailRow }) {
  const cls =
    row.state === "in_mod"
      ? "pipe-chip pipe-chip-mod"
      : row.state === "verification_needed"
        ? "pipe-chip pipe-chip-verif"
        : "pipe-chip pipe-chip-sched";
  return (
    <a
      href={`#t-${row.tail}`}
      title={`${row.type_code} · ${pipelinePhrase(row.state, row.mod_location)}`}
      className={cls}
    >
      {row.tail}
      {row.mod_location && <span className="opacity-60 ml-1">{row.mod_location}</span>}
    </a>
  );
}

// One bar per segment card: complete → verifying → in mod → queued, ordered by
// proximity to completion so the cyan mass anchors left; the bare track is
// "not started". Every nonzero state keeps a 3px floor — 4 verifying of 900 is
// the point of the bar, not a rounding error.
function PipelineBar({
  complete,
  verifying,
  inMod,
  queued,
  total,
}: {
  complete: number;
  verifying: number;
  inMod: number;
  queued: number;
  total: number | null;
}) {
  if (!total || total <= 0) return null;
  const segs = [
    { n: complete, cls: "bar-complete", label: "complete" },
    { n: verifying, cls: "bar-verif", label: "verifying" },
    { n: inMod, cls: "bar-inmod", label: "in mod" },
    { n: queued, cls: "bar-queued", label: "queued" },
  ].filter((s) => s.n > 0);
  return (
    <div
      className="flex gap-px h-3 rounded overflow-hidden bg-surface-elevated mt-2"
      role="img"
      aria-label={segs.map((s) => `${s.label}: ${s.n}`).join(", ") || "no installs yet"}
    >
      {segs.map((s) => (
        <span
          key={s.label}
          title={`${s.label}: ${s.n}`}
          className={s.cls}
          style={{ width: `${(s.n / total) * 100}%`, minWidth: 3 }}
        />
      ))}
    </div>
  );
}

// The progress sheets' column shorthand, spelled out for the feed.
const TYPE_DISPLAY: Record<string, string> = {
  "73G": "737-700",
  "738": "737-800",
  "739": "737-900",
  "38M": "737 MAX 8",
  "39M": "737 MAX 9",
  "319": "A319",
  "320": "A320",
  "321": "A321",
  "321XLR": "A321XLR",
  "752": "757-200",
  "753": "757-300",
  "763": "767-300",
  "764": "767-400",
  GE: "777-200",
  PW: "777-200",
  "77W": "777-300ER",
  "788": "787-8",
  "789": "787-9",
  "78X": "787-10",
};

const MOVEMENT_GLYPH: Record<FleetMovement["kind"], { ch: string; cls: string }> = {
  entered_mod: { ch: "○", cls: "dot-mod" },
  to_verification: { ch: "◎", cls: "dot-verif" },
  queued: { ch: "◌", cls: "text-muted" },
  confirmed: { ch: "◉", cls: "text-accent" },
};

function movementText(m: FleetMovement): string {
  switch (m.kind) {
    case "entered_mod":
      return m.mod_location ? `entered ${m.mod_location} mod line` : "entered a mod line";
    case "to_verification":
      return "install finished — verifying";
    case "queued":
      return m.mod_location
        ? `queued for ${m.mod_location} mod line`
        : "queued for future mod line";
    case "confirmed":
      return "now showing Starlink";
  }
}

function movementDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function MovementsPanel({ movements }: { movements: FleetMovement[] }) {
  return (
    <div className={`${PANEL} mt-4`}>
      <div className={EYEBROW}>Movements</div>
      {movements.length === 0 ? (
        <div className="text-xs text-muted font-mono">
          No pipeline movements in the last 14 days
        </div>
      ) : (
        <div className="space-y-1 max-w-lg">
          {movements.map((m) => {
            const glyph = MOVEMENT_GLYPH[m.kind];
            return (
              <a
                key={`${m.tail}-${m.kind}-${m.date}`}
                href={`#t-${m.tail}`}
                className="flex items-baseline gap-2 px-2 py-1 rounded hover:bg-surface-elevated transition-colors group font-mono"
              >
                <span className={`w-4 text-center flex-shrink-0 ${glyph.cls}`}>{glyph.ch}</span>
                <span className="text-xs text-primary group-hover:text-accent transition-colors w-16 flex-shrink-0">
                  {m.tail}
                </span>
                <span className="text-[10px] text-muted w-20 truncate hidden sm:inline flex-shrink-0">
                  {TYPE_DISPLAY[m.type_code] ??
                    m.type_code.replace(/^(Boeing|Airbus|Embraer)\s+/i, "")}
                </span>
                <span className="text-[11px] text-secondary flex-1 truncate">
                  {movementText(m)}
                </span>
                <span className="text-[10px] text-muted flex-shrink-0">{movementDate(m.date)}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Forward-looking install pipeline (in mod / awaiting verification) — the
// historical counterpart is InstallPaceSection.
function InstallPipelineSection({
  progress,
  tails,
  movements,
}: {
  progress: FleetProgressRow[];
  tails: FleetProgressTailRow[];
  movements: FleetMovement[];
}) {
  const totals = progress.filter((r) => r.type_code === "Totals");
  if (totals.length === 0) return null;
  const updated = totals.find((r) => r.sheet_updated)?.sheet_updated;
  const inModTypes = progress.filter(
    (r) => r.type_code !== "Totals" && ((r.in_mod ?? 0) > 0 || (r.verification_needed ?? 0) > 0)
  );
  const bySegment = new Map<string, FleetProgressTailRow[]>();
  for (const t of tails) {
    if (!bySegment.has(t.segment)) bySegment.set(t.segment, []);
    bySegment.get(t.segment)?.push(t);
  }
  const scheduled = tails.filter((t) => t.state === "scheduled");
  // The visible station decode — mobile has no hover, so every code painted on
  // a chip gets spelled out once, in one line, from live data only.
  const stationEntries = [...new Set(tails.map((t) => t.mod_location).filter(Boolean))]
    .filter((code): code is string => !!code && !!STATION_NAMES[code])
    .sort()
    .map((code) => `${code} ${STATION_NAMES[code]}`);

  const swatch = (cls: string) => (
    <span className={`inline-block w-2 h-2 rounded-[1px] mr-1.5 ${cls}`} />
  );

  return (
    <section className={SECTION}>
      <div className="mb-4">
        <h2 className="font-display text-xl font-semibold text-primary mb-1">Install Pipeline</h2>
        <p className="text-xs text-muted">
          Per the community fleet-site progress sheets{updated ? ` (updated ${updated} ET)` : ""} —
          aircraft currently in a mod line show up here before they appear as equipped.
          {tails.length > 0 && " Tail-level states are decoded from the sheets' cell colors."}
        </p>
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        {totals.map((seg) => {
          const pct =
            seg.total && seg.starlink_complete !== null
              ? Math.round((seg.starlink_complete / seg.total) * 100)
              : null;
          const segTails = (bySegment.get(seg.segment) ?? []).filter(
            (t) => t.state !== "scheduled"
          );
          const segQueued = (bySegment.get(seg.segment) ?? []).filter(
            (t) => t.state === "scheduled"
          ).length;
          return (
            <div key={seg.segment} className={PANEL}>
              <div className={EYEBROW}>{PROGRESS_SEGMENT_LABELS[seg.segment] ?? seg.segment}</div>
              <div className="font-display text-2xl font-bold text-primary">
                {seg.starlink_complete ?? 0}
                <span className="text-sm font-normal text-muted">
                  {" "}
                  of {seg.total ?? "?"} complete
                </span>
              </div>
              <PipelineBar
                complete={seg.starlink_complete ?? 0}
                verifying={seg.verification_needed ?? 0}
                inMod={seg.in_mod ?? 0}
                queued={segQueued}
                total={seg.total}
              />
              <div className="font-mono text-[11px] text-secondary mt-2 space-y-1">
                <div>
                  {swatch("bar-inmod")}
                  {seg.in_mod ?? 0} in mod line now
                </div>
                <div>
                  {swatch("bar-verif")}
                  {seg.verification_needed ?? 0} awaiting verification
                </div>
                {segQueued > 0 && (
                  <div>
                    {swatch("bar-queued")}
                    {segQueued} queued
                  </div>
                )}
                {pct !== null && <div className="text-muted">{pct}% of segment</div>}
              </div>
              {segTails.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {segTails.map((t) => (
                    <PipelineTailChip key={t.tail} row={t} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {(inModTypes.length > 0 || scheduled.length > 0) && (
        <div className="grid md:grid-cols-2 gap-4 mt-4">
          {inModTypes.length > 0 && (
            <div className={PANEL}>
              <div className={EYEBROW}>Active mod lines by type</div>
              <div className="grid grid-cols-2 gap-2 font-mono text-[11px] text-secondary">
                {inModTypes.map((r) => (
                  <div key={`${r.segment}-${r.type_code}`}>
                    {r.type_code}: {r.in_mod ?? 0} in mod
                    {(r.verification_needed ?? 0) > 0 ? `, ${r.verification_needed} verifying` : ""}
                  </div>
                ))}
              </div>
            </div>
          )}
          {scheduled.length > 0 && (
            <div className={PANEL}>
              <div className={EYEBROW}>Queued for future mod lines</div>
              <div className="flex flex-wrap gap-1.5">
                {scheduled.map((t) => (
                  <PipelineTailChip key={t.tail} row={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {tails.length > 0 && <MovementsPanel movements={movements} />}
      {stationEntries.length > 0 && (
        <p className="font-mono text-[10px] text-muted mt-3">
          Mod stations: {stationEntries.join(" · ")}
        </p>
      )}
    </section>
  );
}

// The handful of figures the airline itself has put in SEC filings — the
// citable cross-check next to our scraped counts.
function OfficialAnchorsSection({ anchors }: { anchors: FleetAnchorRow[] }) {
  // Latest figure per metric (rows arrive ordered by as_of_date DESC), so a
  // freshly seeded quarter replaces the old one without touching this list.
  const latestByMetric = new Map<string, FleetAnchorRow>();
  for (const a of anchors) {
    if (!latestByMetric.has(a.metric)) latestByMetric.set(a.metric, a);
  }
  const shown = [...latestByMetric.values()].slice(0, 6);
  if (shown.length === 0) return null;

  return (
    <section className={SECTION}>
      <div className={PANEL}>
        <div className={EYEBROW}>Officially reported (SEC filings)</div>
        <div className="font-mono text-[11px] text-secondary space-y-1">
          {shown.map((a) => (
            <div key={a.metric}>
              {a.scope}:{" "}
              <a
                href={a.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                {a.value}
              </a>{" "}
              <span className="text-muted">
                ({a.source_form}, as of {a.as_of_date})
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

interface FleetPageProps {
  data: FleetPageData;
  site: SiteConfig;
  /** Pre-rendered share card path; null until the nightly batch produced one. */
  shareCard?: string | null;
  pageLinks?: PageLink[];
}

export default function FleetPage({ data, site, shareCard, pageLinks }: FleetPageProps) {
  const pipeline: PipelineMap = new Map(data.progressTails.map((r) => [r.tail, r]));
  const scopeCode = site.scope !== "ALL" ? site.scope : null;
  const scopeLabel = scopeCode ? AIRLINES[scopeCode].name : "tracked";
  const headerTitle = scopeCode
    ? `${AIRLINES[scopeCode].name} Fleet · Starlink Rollout`
    : "Tracked Fleets · Starlink Rollout";
  const backLabel = site.brand.title;
  return (
    <div className="w-full mx-auto px-4 sm:px-6 md:px-8 bg-base min-h-screen flex flex-col relative">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static CSS, no user input
        dangerouslySetInnerHTML={{
          __html: `
          .wifi-starlink  { background: var(--color-accent); }
          .wifi-viasat    { background: rgba(245, 158, 11, 0.5); }
          .wifi-panasonic { background: rgba(168, 85, 247, 0.5); }
          .wifi-thales    { background: rgba(236, 72, 153, 0.5); }
          .wifi-none      { background: transparent; box-shadow: inset 0 0 0 1px rgba(90, 106, 128, 0.5); }
          .wifi-unknown   { background: transparent; box-shadow: inset 0 0 0 1px rgba(90, 106, 128, 0.25); }
          /* Pipeline overlays (after wifi-* so they win the cascade) */
          .pipe-mod   { background: rgba(245, 158, 11, 0.15); box-shadow: inset 0 0 0 1.5px #f59e0b; }
          .pipe-verif { background: rgba(14, 165, 233, 0.15); box-shadow: inset 0 0 0 1.5px var(--color-accent); }
          .pipe-chip {
            display: inline-flex; align-items: baseline;
            font-family: var(--font-mono, monospace); font-size: 10px;
            padding: 1px 6px; border-radius: 3px; text-decoration: none;
            border: 1px solid; color: var(--color-text-secondary);
          }
          .pipe-chip:hover { text-decoration: underline; }
          .pipe-chip-mod   { border-color: rgba(245, 158, 11, 0.6); background: rgba(245, 158, 11, 0.08); }
          .pipe-chip-verif { border-color: rgba(14, 165, 233, 0.6); background: rgba(14, 165, 233, 0.08); }
          .pipe-chip-sched { border-color: rgba(90, 106, 128, 0.5); border-style: dashed; }
          .bar-complete { background: var(--color-accent); }
          .bar-verif    { background: rgba(14, 165, 233, 0.45); }
          .bar-inmod    { background: rgba(245, 158, 11, 0.8); }
          .bar-queued   { background: repeating-linear-gradient(45deg, rgba(90, 106, 128, 0.55) 0 2px, transparent 2px 4px); }
          .tail-pipe { opacity: 0.75; }
          .dot-mod   { color: #f59e0b; }
          .dot-verif { color: var(--color-accent); }
          .tail-sl, .tail-dim { display: flex; align-items: baseline; gap: 0.5em; text-decoration: none; }
          .tail-sl  { color: var(--color-accent); }
          .tail-dim { color: var(--color-text-muted); opacity: 0.3; transition: opacity .15s; }
          .tail-sl:hover .tail-num, .tail-dim:hover .tail-num { text-decoration: underline; }
          .tail-dim:hover { opacity: 1; }
          .tail-sl:target, .tail-dim:target { background: rgba(14, 165, 233, 0.2); opacity: 1; scroll-margin-top: 5rem; }
          .tail-dot { width: 0.8em; text-align: center; flex-shrink: 0; }
          .tail-num { flex: 0 0 auto; }
          .tail-abbr { opacity: 0.4; font-size: 0.75em; flex-shrink: 0; }
          /* Hangar floor: always-open blocks on desktop, collapsible details on mobile */
          .fam-summary::-webkit-details-marker { display: none; }
          .fam-caret { transition: transform .2s; }
          .fam-container { display: grid; }
          @media (min-width: 768px) {
            .fam-container { grid-template-columns: repeat(auto-fill, 118px); align-items: start; }
            .fam-summary { pointer-events: none; min-height: 34px; }
            .fam-caret { display: none; }
          }
          @media (max-width: 767px) {
            .fam-container { grid-template-columns: 1fr; }
            .fam-summary { cursor: pointer; padding: 0.75rem; }
            .fam-block[open] .fam-caret { transform: rotate(180deg); }
          }
          /* Aircraft spec popover — hover on desktop, focus (tap) on mobile */
          .spec-trigger { pointer-events: auto; outline: none; }
          .spec-card {
            opacity: 0; pointer-events: none;
            transform: translateY(-4px);
            transition: opacity .15s, transform .15s;
            text-transform: none; letter-spacing: normal; font-weight: 400;
          }
          .spec-trigger:hover .spec-card,
          .spec-trigger:focus .spec-card,
          .spec-trigger:focus-within .spec-card {
            opacity: 1; pointer-events: auto; transform: translateY(0);
          }
          @media (max-width: 767px) {
            .spec-card { left: 0; right: 0; width: auto; position: fixed; top: auto; bottom: 1rem; margin: 0 1rem; }
          }
          `,
        }}
      />

      <header className="relative py-5 sm:py-6 text-center mb-6">
        <a href="/" className="block">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-primary mb-2 tracking-tight hover:text-accent transition-colors">
            {headerTitle}
          </h1>
        </a>
        <p className="text-base text-secondary font-display">
          {data.totalStarlink} of {data.totalFleet} aircraft equipped — and what's replacing what
        </p>
      </header>

      <LivePulse pulse={data.pulse} />
      <InstallPaceSection pace={data.installPace} />
      <InstallPipelineSection
        progress={data.progress}
        tails={data.progressTails}
        movements={data.movements}
      />
      <OfficialAnchorsSection anchors={data.anchors} />
      <HangarFloor
        families={data.families}
        totalFleet={data.totalFleet}
        totalStarlink={data.totalStarlink}
        scopeLabel={scopeLabel}
        pipeline={pipeline}
      />

      <section className={`${SECTION} grid md:grid-cols-2 gap-4`}>
        <CarrierLeaderboard carriers={data.carriers} />
        <IronyStack bodyClass={data.bodyClass} />
      </section>

      <TailMonument allTails={data.allTails} totalFleet={data.totalFleet} pipeline={pipeline} />

      <ShareCardLink path={shareCard} />

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm">
        <a href="/" className="text-accent hover:underline font-display">
          ← Back to {backLabel}
        </a>
        <PageNavLinks links={pageLinks} />
      </footer>
    </div>
  );
}
