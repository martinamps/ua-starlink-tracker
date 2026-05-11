import React from "react";
import { airlineHomeUrl } from "../airlines/registry";
import type { RecentInstall } from "../types";
import type { Aircraft, PerAirlineStat } from "../types";

export type { PerAirlineStat };

/**
 * Hub status cards — one per airline, equal-height grid. % is over the FULL
 * fleet so a viewer can read it as "odds on a random flight"; the status pill
 * + prose explain the nuance (HA at 69% but Complete: 717s won't get it).
 */
const STATUS_TONE = {
  complete: { color: "#3fb950", bg: "rgba(63,185,80,.12)" },
  phase_done: { color: "#d4a72c", bg: "rgba(212,167,44,.12)" },
  in_progress: { color: "#58a6ff", bg: "rgba(88,166,255,.12)" },
} as const;

export function AirlineStatusCards({ stats }: { stats: PerAirlineStat[] }) {
  const ranked = [...stats]
    .map((a) => {
      const fleet = a.fleetTotal ?? a.total;
      return { ...a, fleet, pct: fleet > 0 ? (a.starlink / fleet) * 100 : 0 };
    })
    .sort((a, b) => b.pct - a.pct);

  const r = 30;
  const c = 2 * Math.PI * r;

  return (
    <section>
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
        Where each rollout stands
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {ranked.map((a) => {
          const tone = STATUS_TONE[a.status ?? "in_progress"];
          return (
            <a
              key={a.code}
              href={a.href || "#"}
              className="group relative bg-surface border border-subtle rounded-xl overflow-hidden flex flex-col hover:border-accent transition-all hover:-translate-y-0.5"
              style={{
                boxShadow: "inset 0 1px 0 0 rgba(255,255,255,.03)",
              }}
            >
              {/* Accent top edge */}
              <div
                className="h-[3px] w-full"
                style={{
                  background: `linear-gradient(90deg, ${a.accentColor}, ${a.accentColor}40)`,
                  boxShadow: `0 1px 8px ${a.accentColor}60`,
                }}
              />
              {/* Subtle accent wash */}
              <div
                className="absolute inset-0 pointer-events-none opacity-[0.04]"
                style={{
                  background: `radial-gradient(circle at 0% 0%, ${a.accentColor}, transparent 60%)`,
                }}
              />

              <div className="relative p-4 flex flex-col gap-3">
                {/* Header: chip + name + status pill */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="font-mono text-xs px-1.5 py-0.5 rounded shrink-0"
                      style={{
                        color: a.accentColor,
                        background: `color-mix(in srgb, ${a.accentColor} 18%, transparent)`,
                      }}
                    >
                      {a.code}
                    </span>
                    <span className="font-display text-sm text-primary truncate group-hover:text-accent transition-colors">
                      {a.name}
                    </span>
                  </div>
                  <span
                    className="font-mono text-[10px] uppercase tracking-wide px-2 py-1 rounded-full shrink-0"
                    style={{ color: tone.color, background: tone.bg }}
                  >
                    {a.statusLabel ?? "In progress"}
                  </span>
                </div>

                {/* Hero: ring + counts */}
                <div className="flex items-center gap-4">
                  <div className="relative w-[72px] h-[72px] shrink-0">
                    <svg
                      width="72"
                      height="72"
                      viewBox="0 0 72 72"
                      className="-rotate-90"
                      role="img"
                      aria-label={`${a.name} ${Math.round(a.pct)}% Starlink`}
                    >
                      <circle cx="36" cy="36" r={r} stroke="#1d2536" strokeWidth="7" fill="none" />
                      <circle
                        cx="36"
                        cy="36"
                        r={r}
                        stroke={a.accentColor}
                        strokeWidth="7"
                        fill="none"
                        strokeLinecap="round"
                        strokeDasharray={c}
                        strokeDashoffset={c * (1 - Math.min(100, a.pct) / 100)}
                        style={{ filter: `drop-shadow(0 0 5px ${a.accentColor}90)` }}
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="font-mono text-lg font-semibold text-primary">
                        {Math.round(Math.min(100, a.pct))}
                        <span className="text-[10px] text-muted">%</span>
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="font-mono text-2xl font-semibold text-primary leading-none">
                      {a.starlink}
                      <span className="text-sm text-muted font-normal"> / {a.fleet}</span>
                    </div>
                    <div className="font-mono text-[10px] text-muted uppercase tracking-wider">
                      aircraft equipped
                    </div>
                    {(a.installs30d ?? 0) > 0 ? (
                      <div className="font-mono text-[11px] mt-1" style={{ color: tone.color }}>
                        +{a.installs30d} in the last 30 days
                      </div>
                    ) : (
                      <div className="font-mono text-[11px] text-muted mt-1">
                        {a.status === "complete" ? "rollout finished" : "—"}
                      </div>
                    )}
                  </div>
                </div>

                {/* Prose */}
                {a.phaseNote && (
                  <p className="text-[11.5px] text-secondary leading-snug border-t border-subtle pt-2.5 mt-auto">
                    {a.phaseNote}
                  </p>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

export function RecentInstallsFeed({
  items,
  airlines,
}: { items: RecentInstall[]; airlines: PerAirlineStat[] }) {
  // Group once per airline — the per-row airline name was 90%+ "United Airlines".
  const grouped = airlines
    .map((a) => ({ cfg: a, rows: items.filter((i) => i.airline === a.code) }))
    .filter((g) => g.rows.length > 0);
  return (
    <div className="bg-surface border border-subtle rounded-lg p-5">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-3">
        Recent installs
      </div>
      {grouped.length === 0 ? (
        <div className="text-xs text-muted font-mono">No recent installs</div>
      ) : (
        <>
          {grouped.map((g) => (
            <div key={g.cfg.code} className="mb-3 last:mb-0">
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted mb-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: g.cfg.accentColor || "#5a6a80" }}
                />
                {g.cfg.name}
              </div>
              <div className="space-y-1">
                {g.rows.map((r) => (
                  <a
                    key={r.TailNumber}
                    href={airlineHomeUrl(g.cfg.code, { q: r.TailNumber })}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-elevated transition-colors group"
                  >
                    <span className="font-mono text-xs text-primary group-hover:text-accent transition-colors w-16">
                      {r.TailNumber}
                    </span>
                    <span className="font-mono text-[10px] text-muted flex-1 truncate">
                      {r.Aircraft}
                    </span>
                    {r.OperatedBy && (
                      <span className="font-mono text-[10px] text-secondary truncate hidden sm:inline">
                        {r.OperatedBy}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-muted w-12 text-right">
                      {new Date(r.DateFound).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * Universal flight-number check input. Renders an inert form; client-side
 * script in hub.tsx fetches /api/check-any-flight and renders the result.
 * Compact variant — secondary action below route compare.
 */
export function FlightCheckInput() {
  return (
    <div className="bg-surface border border-subtle rounded-lg p-3">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">
        Already booked? Check a flight
      </div>
      <form id="hub-check-flight" className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          name="flight_number"
          placeholder="UA1736, HA51, AS118…"
          className="flex-1 font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent"
          required
        />
        <input
          type="date"
          name="date"
          className="font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary focus:outline-none focus:border-accent"
          required
        />
        <button
          type="submit"
          className="font-mono text-sm px-4 py-2 bg-accent/20 border border-accent rounded text-accent hover:bg-accent/30 transition-colors"
        >
          Check
        </button>
      </form>
      <div id="hub-check-result" className="mt-2 text-sm font-mono hidden" />
    </div>
  );
}

// Preset chips: pick city pairs that exercise the comparison — mainland routes
// with UA-vs-AS overlap, plus one Hawai'i route where HA is the answer.
const PRESET_ROUTES: { o: string; d: string }[] = [
  { o: "SEA", d: "SFO" },
  { o: "DEN", d: "SAN" },
  { o: "SFO", d: "HNL" },
];

export function RouteComparePanel() {
  return (
    <div className="bg-surface border border-subtle rounded-lg p-5">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-1">
        Starlink odds by airline
      </div>
      <div className="text-[10px] font-mono text-muted leading-relaxed mb-3">
        Share of each carrier's planes on this nonstop route that have Starlink today.
      </div>
      <form id="hub-compare-route" className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          name="origin"
          placeholder="From (SFO)"
          maxLength={3}
          className="flex-1 font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent uppercase"
          required
        />
        <input
          type="text"
          name="destination"
          placeholder="To (HNL)"
          maxLength={3}
          className="flex-1 font-mono text-sm px-3 py-2 bg-surface-elevated border border-subtle rounded text-primary placeholder-muted focus:outline-none focus:border-accent uppercase"
          required
        />
        <button
          type="submit"
          className="font-mono text-sm px-4 py-2 bg-accent/20 border border-accent rounded text-accent hover:bg-accent/30 transition-colors"
        >
          Compare
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {PRESET_ROUTES.map((r) => (
          <button
            key={`${r.o}-${r.d}`}
            type="button"
            data-preset-origin={r.o}
            data-preset-dest={r.d}
            className="hub-route-preset font-mono text-xs px-2.5 py-1.5 bg-surface-elevated border border-subtle rounded text-secondary hover:text-accent hover:border-accent transition-colors"
          >
            {r.o} → {r.d}
          </button>
        ))}
      </div>
      <div id="hub-compare-result" className="mt-3 hidden" />
      <div
        id="hub-compare-footer"
        className="mt-3 text-[10px] font-mono text-muted leading-relaxed hidden"
      >
        Carrier missing? It only shows up once one of its Starlink planes has flown here.{" "}
        <a id="hub-compare-rp" href="/route-planner" className="text-accent hover:underline">
          Route Planner →
        </a>
      </div>
    </div>
  );
}

export const PIE_COLORS = ["#0ea5e9", "#22c55e", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];

export function StatRing({
  label,
  pct,
  starlink,
  total,
  color = "#0ea5e9",
  variant = "default",
}: {
  label: string;
  pct: number;
  starlink: number;
  total: number;
  color?: string;
  variant?: "default" | "total";
}) {
  const isTotal = variant === "total";
  return (
    <div className="bg-surface p-4 flex flex-col justify-center text-center">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">{label}</div>
      <div className="relative w-20 h-20 mx-auto mb-2">
        <svg className="w-20 h-20 transform -rotate-90" role="img" aria-label={`${label} progress`}>
          <circle cx="40" cy="40" r="34" stroke="#243044" strokeWidth="6" fill="none" />
          <circle
            cx="40"
            cy="40"
            r="34"
            stroke={color}
            strokeWidth="6"
            fill="none"
            strokeDasharray={`${2 * Math.PI * 34}`}
            strokeDashoffset={`${2 * Math.PI * 34 * (1 - pct / 100)}`}
            className="transition-all duration-1000 ease-out"
            strokeLinecap={isTotal ? "round" : "inherit"}
            style={{ filter: `drop-shadow(0 0 6px ${color}80)` }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className={`font-mono text-xl font-semibold ${isTotal ? "text-green-400" : "text-primary"}`}
          >
            {isTotal ? Math.round(pct) : pct.toFixed(0)}%
          </span>
        </div>
      </div>
      <div className="font-mono text-xs text-secondary">
        <span className={isTotal ? "text-green-400" : "text-accent"}>{starlink}</span>
        <span className="text-muted"> / {total}</span>
      </div>
    </div>
  );
}

export interface ModelDatum {
  model: string;
  count: number;
}

export function computeModelBreakdown(starlinkData: Aircraft[]): ModelDatum[] {
  const counts: Record<string, number> = {};
  for (const p of starlinkData) {
    const base = (p.Aircraft || "Unknown").split(/[-\s]/)[0];
    counts[base] = (counts[base] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([model, count]) => ({ model, count }));
}

export function ModelPie({ data, total }: { data: ModelDatum[]; total: number }) {
  return (
    <div className="bg-surface p-4 flex flex-col justify-center text-center">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-2">By Type</div>
      <div className="relative w-20 h-20 mx-auto mb-2" id="pie-chart-container">
        <svg
          className="w-20 h-20"
          viewBox="0 0 80 80"
          role="img"
          aria-label="Aircraft types pie chart"
        >
          <circle cx="40" cy="40" r="34" stroke="#243044" strokeWidth="6" fill="none" />
          {(() => {
            const sum = data.reduce((s, d) => s + d.count, 0);
            const oR = 37;
            const iR = 31;
            let angle = -90;
            return data.map((item, idx) => {
              const slice = (item.count / sum) * 360;
              const sA = angle;
              const eA = angle + slice;
              angle = eA;
              const sR = (sA * Math.PI) / 180;
              const eR = (eA * Math.PI) / 180;
              const ox1 = 40 + oR * Math.cos(sR);
              const oy1 = 40 + oR * Math.sin(sR);
              const ox2 = 40 + oR * Math.cos(eR);
              const oy2 = 40 + oR * Math.sin(eR);
              const ix1 = 40 + iR * Math.cos(sR);
              const iy1 = 40 + iR * Math.sin(sR);
              const ix2 = 40 + iR * Math.cos(eR);
              const iy2 = 40 + iR * Math.sin(eR);
              const large = slice > 180 ? 1 : 0;
              const pct = ((item.count / sum) * 100).toFixed(0);
              const d = `M ${ox1} ${oy1} A ${oR} ${oR} 0 ${large} 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${iR} ${iR} 0 ${large} 0 ${ix1} ${iy1} Z`;
              return (
                <path
                  key={item.model}
                  d={d}
                  fill={PIE_COLORS[idx % PIE_COLORS.length]}
                  className="pie-slice transition-opacity duration-200 hover:opacity-70 cursor-pointer"
                  style={{
                    filter: `drop-shadow(0 0 3px ${PIE_COLORS[idx % PIE_COLORS.length]}40)`,
                  }}
                  data-model={item.model}
                  data-count={item.count}
                  data-pct={pct}
                />
              );
            });
          })()}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span id="pie-center-text" className="font-mono text-xl font-semibold text-primary">
            {data[0]?.count || total}
          </span>
        </div>
      </div>
      <div id="pie-status" className="h-4 flex items-center justify-center text-[10px] font-mono">
        <span id="pie-status-label">
          <span style={{ color: "#0ea5e9" }}>{data[0]?.model || "—"}</span>
          <span style={{ color: "#5a6a80" }}>
            {" "}
            · {data[0] ? Math.round((data[0].count / total) * 100) : 0}%
          </span>
        </span>
      </div>
    </div>
  );
}

export function TypeBreakdownRow({
  type,
  count,
  status,
  note,
}: {
  type: string;
  count?: number;
  status: "starlink" | "none" | "pending";
  note?: string;
}) {
  const icon =
    status === "starlink" ? (
      <span className="text-green-400 font-mono">✓</span>
    ) : status === "pending" ? (
      <span className="text-amber-400 font-mono">…</span>
    ) : (
      <span className="text-muted font-mono">—</span>
    );
  const label =
    status === "starlink"
      ? "Starlink"
      : status === "pending"
        ? note || "Planned"
        : note || "No WiFi";
  return (
    <div className="flex items-center justify-between py-3 px-4 border-b border-subtle last:border-0">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <div className="font-mono text-sm text-primary">{type}</div>
          {count !== undefined && (
            <div className="text-[10px] font-mono text-muted">{count} aircraft</div>
          )}
        </div>
      </div>
      <div
        className={`text-xs font-mono ${status === "starlink" ? "text-green-400" : "text-muted"}`}
      >
        {label}
      </div>
    </div>
  );
}

export function HeaderStatStrip({ items }: { items: React.ReactNode[] }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 text-xs sm:text-sm font-mono text-muted">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static per-airline list, never reorders
        <React.Fragment key={i}>
          {i > 0 && <span className="text-subtle">·</span>}
          {it}
        </React.Fragment>
      ))}
    </div>
  );
}
