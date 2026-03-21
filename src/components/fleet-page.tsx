import React from "react";
import type { FleetFamily, FleetPageData, FleetTail, WifiProvider } from "../types";
import { AIRCRAFT_SPECS, type AircraftSpec } from "../utils/aircraft-specs";

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

function cellTitle(t: FleetTail): string {
  return `${t.tail} · ${PROVIDER_LABEL[t.provider]}`;
}

function monumentTitle(t: FleetTail): string {
  return `${t.type || "type unknown"} · ${PROVIDER_LABEL[t.provider]} · ${t.fleet} · verified ${timeAgo(t.verified_at)} · click for live tracking`;
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
  const live = pulse.now > 0;
  return (
    <section className="relative max-w-4xl mx-auto text-center mb-10">
      <div className={`${PANEL} p-6 glow-accent`}>
        <div className={EYEBROW}>Live Pulse</div>
        <div className="flex items-baseline justify-center gap-3 mb-2">
          {live && <span className="status-dot animate-pulse-glow" />}
          <span className="font-display text-5xl sm:text-6xl font-bold text-accent tabular-nums">
            {live ? pulse.now : "—"}
          </span>
        </div>
        <p className="text-sm text-secondary mb-4">
          {live
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

function TailGrid({ tails }: { tails: FleetTail[] }) {
  return (
    <div className="grid grid-cols-[repeat(10,8px)] gap-[2px]">
      {tails.map((t) => (
        // biome-ignore lint/a11y/useAnchorContent: aria-label provides the accessible name; inline text on 1.5k cells would add ~50KB
        <a
          key={t.tail}
          href={`#t-${t.tail}`}
          title={cellTitle(t)}
          aria-label={cellTitle(t)}
          className={`wifi-${t.provider} w-2 h-2 rounded-[1px] hover:scale-150 transition-transform`}
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

function FamilyBlock({ fam }: { fam: FleetFamily }) {
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
        <TailGrid tails={fam.tails} />
      </div>
    </details>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-muted">
      {PROVIDER_ORDER.map((p) => (
        <span key={p} className="inline-flex items-center gap-1.5">
          <span className={`wifi-${p} w-2.5 h-2.5 rounded-[1px]`} />
          {PROVIDER_LABEL[p]}
        </span>
      ))}
    </div>
  );
}

function HangarFloor({
  families,
  totalFleet,
  totalStarlink,
}: {
  families: FleetFamily[];
  totalFleet: number;
  totalStarlink: number;
}) {
  return (
    <section className={SECTION}>
      <div className="mb-4">
        <h2 className="font-display text-xl font-semibold text-primary mb-1">The Hangar Floor</h2>
        <p className="text-xs text-muted mb-3">
          Every United tail number is one cell. {totalStarlink} of {totalFleet} have Starlink. The
          cyan stops where Express ends and Mainline begins.
        </p>
        <Legend />
      </div>

      <div className="fam-container gap-3">
        {families.map((fam) => (
          <FamilyBlock key={fam.family} fam={fam} />
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

function CarrierLeaderboard({ carriers }: { carriers: FleetPageData["carriers"] }) {
  if (carriers.length === 0) return null;
  const max = Math.max(...carriers.map((c) => c.total));
  return (
    <div className={PANEL}>
      <div className={EYEBROW}>Express Carrier Race</div>
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
      <div className={EYEBROW}>The Long-Haul Irony</div>
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
        Your 16-hour flight to Singapore still has Panasonic. Your 53-minute hop from Duluth has
        Starlink.
      </p>
    </div>
  );
}

function TailMonument({ allTails, totalFleet }: { allTails: FleetTail[]; totalFleet: number }) {
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
            rel="noreferrer noopener"
            title={monumentTitle(t)}
            className={t.provider === "starlink" ? "tail-sl" : "tail-dim"}
          >
            <span className="tail-dot">{t.provider === "starlink" ? "◉" : "\u00A0"}</span>
            <span className="tail-num">{t.tail}</span>
            <span className="tail-abbr">{FAMILY_ABBR[t.family] || "—"}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

export default function FleetPage({ data }: { data: FleetPageData }) {
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
            United Fleet · Starlink Rollout
          </h1>
        </a>
        <p className="text-base text-secondary font-display">
          {data.totalStarlink} of {data.totalFleet} aircraft equipped — and what's replacing what
        </p>
      </header>

      <LivePulse pulse={data.pulse} />
      <HangarFloor
        families={data.families}
        totalFleet={data.totalFleet}
        totalStarlink={data.totalStarlink}
      />

      <section className={`${SECTION} grid md:grid-cols-2 gap-4`}>
        <CarrierLeaderboard carriers={data.carriers} />
        <IronyStack bodyClass={data.bodyClass} />
      </section>

      <TailMonument allTails={data.allTails} totalFleet={data.totalFleet} />

      <footer className="relative py-6 text-center border-t border-subtle text-muted text-sm">
        <a href="/" className="text-accent hover:underline font-display">
          ← back to tracker
        </a>
      </footer>
    </div>
  );
}
