import React from "react";
import type { Aircraft, PerAirlineStat } from "../types";

export type { PerAirlineStat };

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
          <span style={{ color: "#0ea5e9" }}>{data[0]?.model || "ERJ"}</span>
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

export function AirlineSummaryCard({ a }: { a: PerAirlineStat }) {
  const pct = a.total > 0 ? (a.starlink / a.total) * 100 : 0;
  return (
    <div className="bg-surface border border-subtle rounded-lg p-5 min-w-[200px] flex-1">
      <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-1">{a.code}</div>
      <div className="font-display text-base text-primary mb-3">{a.name}</div>
      <div className="font-mono text-2xl font-semibold text-accent mb-1">{pct.toFixed(0)}%</div>
      <div className="font-mono text-xs text-secondary mb-3">
        <span className="text-accent">{a.starlink}</span>
        <span className="text-muted"> of {a.total} aircraft</span>
      </div>
      <div className="h-1.5 bg-surface-elevated rounded overflow-hidden">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
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
