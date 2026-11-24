import { MAP_HEIGHT, MAP_WIDTH } from "../../utils/map-projection";
import { Panel, SectionTitle } from "../layout";
import { fmt, pct, utcDateTime } from "../ui/format";
import type { MapArc, RouteNetwork } from "./network";

/** Below this share of departures on the map, the frame is the wrong one for
 * the airline (Hawaiian's islands, say) and the table says it better. */
const MIN_DRAWN_SHARE = 0.5;

export function showRouteMap(net: RouteNetwork): boolean {
  return net.arcs.length > 0 && net.drawnDepartures >= net.totalDepartures * MIN_DRAWN_SHARE;
}

// Strokes and dots scale with the map on purpose: on a phone the same 563
// lines in a third of the width would otherwise fill it solid.
const dotRadius = (departures: number, max: number) => 3 + 10 * Math.sqrt(departures / max);

const BANDS = 6;

/** Arcs merged into one path per brightness band: 563 separate paths cost
 * the page ~60 KB, and a tooltip per line is noise the table answers better.
 * Quietest band first, so the busiest routes paint on top. */
function arcBands(arcs: MapArc[], max: number): { level: number; d: string }[] {
  const bands = new Map<number, string[]>();
  for (const a of arcs) {
    const level = Math.max(1, Math.ceil(Math.sqrt(a.departures / max) * BANDS)) / BANDS;
    const list = bands.get(level) ?? [];
    list.push(a.d);
    bands.set(level, list);
  }
  return [...bands].sort(([x], [y]) => x - y).map(([level, ds]) => ({ level, d: ds.join("") }));
}

const LABELS_WIDE = 10;
const LABELS_NARROW = 5;
const OFF_MAP_SHOWN = 12;

/**
 * Every route with a Starlink departure in the live window, on one map.
 * Lines and dots are a server-rendered SVG over a cached coastline image, so
 * the page ships no script for it; each dot links to its airport's page.
 */
export function RoutesMap({
  net,
  basemapHref,
  windowLabel,
  updatedAt,
  airportLinks,
  airlineLabel,
}: {
  net: RouteNetwork;
  basemapHref: string;
  windowLabel: string;
  updatedAt?: string | null;
  airportLinks: boolean;
  /** "United " or "" on the hub. */
  airlineLabel: string;
}) {
  const maxArc = net.arcs.at(-1)?.departures ?? 1;
  const maxAirport = net.airports.at(-1)?.departures ?? 1;
  const busiest = [...net.airports].reverse();
  const wide = new Set(busiest.slice(0, LABELS_WIDE).map((a) => a.code));
  const narrow = new Set(busiest.slice(0, LABELS_NARROW).map((a) => a.code));
  const shownOff = net.offMap.slice(0, OFF_MAP_SHOWN);
  const offFlights = net.totalDepartures - net.drawnDepartures;
  const summary = `${fmt(net.arcs.length)} routes between ${fmt(net.airports.length)} airports with ${airlineLabel}Starlink departures in the ${windowLabel}`;

  return (
    <section className="relative mx-auto mb-8 w-full max-w-6xl">
      <SectionTitle>The Starlink network</SectionTitle>
      <p className="mt-1 text-sm text-secondary text-pretty">
        {summary}. Brighter, thicker lines carry more departures; dots grow with departures from
        that airport.
      </p>
      <Panel pad="sm" className="mt-4">
        <figure className="m-0">
          <div
            className="relative w-full overflow-hidden rounded"
            style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}
          >
            <img
              src={basemapHref}
              alt=""
              width={MAP_WIDTH}
              height={MAP_HEIGHT}
              className="absolute inset-0 h-full w-full"
              decoding="async"
            />
            <svg
              viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
              className="absolute inset-0 h-full w-full"
              role="img"
              aria-label={`Map: ${summary}.`}
            >
              <g fill="none" strokeLinecap="round" className="stroke-accent">
                {arcBands(net.arcs, maxArc).map((band) => (
                  <path
                    key={band.level}
                    d={band.d}
                    strokeOpacity={(0.14 + 0.66 * band.level).toFixed(2)}
                    strokeWidth={(0.8 + 3.6 * band.level).toFixed(2)}
                  />
                ))}
              </g>
              <g className="fill-primary stroke-surface" fillOpacity="0.92" strokeWidth="1.5">
                {net.airports.map((ap) => {
                  const title = `${ap.code}: ${fmt(ap.departures)} Starlink departure${ap.departures === 1 ? "" : "s"}`;
                  const dot = (
                    <circle
                      key={ap.code}
                      cx={ap.x}
                      cy={ap.y}
                      r={dotRadius(ap.departures, maxAirport).toFixed(1)}
                    >
                      <title>{title}</title>
                    </circle>
                  );
                  return airportLinks && ap.departures > 0 ? (
                    <a key={ap.code} href={`/routes/${ap.code}`}>
                      {dot}
                    </a>
                  ) : (
                    <g key={ap.code}>{dot}</g>
                  );
                })}
              </g>
              {busiest
                .filter((a) => wide.has(a.code))
                .map((ap) => {
                  const r = dotRadius(ap.departures, maxAirport);
                  return (
                    <text
                      key={ap.code}
                      x={Math.round(ap.x + r + 4)}
                      y={ap.y}
                      dominantBaseline="central"
                      className={`fill-primary font-mono ${narrow.has(ap.code) ? "text-[34px] sm:text-[17px]" : "hidden text-[17px] sm:inline"}`}
                      paintOrder="stroke"
                      stroke="#0a0f1a"
                      strokeWidth="4"
                      strokeLinejoin="round"
                      pointerEvents="none"
                    >
                      {ap.code}
                    </text>
                  );
                })}
            </svg>
          </div>
          <figcaption className="mt-3 text-xs text-muted text-pretty">
            {offFlights > 0
              ? `${pct(net.drawnDepartures, net.totalDepartures)} of ${fmt(net.totalDepartures)} departures are on this map. `
              : ""}
            Lines join airports along the great circle, not the track flown. Counts only aircraft
            assigned so far, so a route missing here may still have Starlink.
            {updatedAt ? ` Data updated ${utcDateTime(updatedAt)}.` : ""}
          </figcaption>
          {shownOff.length > 0 && (
            <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-secondary">
              <span className="text-muted">Beyond the map, flights to or from:</span>
              {shownOff.map((o) =>
                airportLinks && o.departs ? (
                  <a
                    key={o.code}
                    href={`/routes/${o.code}`}
                    className="font-mono whitespace-nowrap hover:text-accent"
                  >
                    {o.code} <span className="tabular-nums">{fmt(o.flights)}</span>
                  </a>
                ) : (
                  <span key={o.code} className="font-mono whitespace-nowrap">
                    {o.code} <span className="tabular-nums">{fmt(o.flights)}</span>
                  </span>
                )
              )}
              {net.offMap.length > shownOff.length && (
                <span className="text-muted">
                  and {fmt(net.offMap.length - shownOff.length)} more
                </span>
              )}
            </div>
          )}
        </figure>
      </Panel>
    </section>
  );
}
