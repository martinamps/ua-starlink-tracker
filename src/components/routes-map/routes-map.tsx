import { MAP_HEIGHT, MAP_WIDTH } from "../../utils/map-projection";
import { ClientScriptTag, Eyebrow, Panel, SectionTitle } from "../layout";
import { fmt, pct, utcDateTime } from "../ui/format";
import type { MapAirport, MapArc, RouteNetwork } from "./network";

/** Below this share of departures on the map, the frame is the wrong one for
 * the airline (Hawaiian's islands, say) and the table says it better. */
const MIN_DRAWN_SHARE = 0.5;

export function showRouteMap(net: RouteNetwork): boolean {
  return net.arcs.length > 0 && net.drawnDepartures >= net.totalDepartures * MIN_DRAWN_SHARE;
}

// Strokes and dots scale with the map on purpose: on a phone the same 563
// lines in a third of the width would otherwise fill it solid.
const dotRadius = (departures: number, max: number) => 3 + 10 * Math.sqrt(departures / max);

/** Tap targets, in map units: half of 24 px on a 360 px phone (the map is
 * about 300 px wide there), and on sm screens and up. */
const HIT_PHONE = 41;
const HIT_WIDE = 22;
/** The least a phone tap target may shrink to before the airport takes no
 * taps on the map: 16 px across on a 360 px phone. */
const HIT_PHONE_MIN = 27;

/** Phones: each airport, busiest first, gets the room its busier neighbours
 * left, up to the cap, so targets never overlap. An airport too crowded to
 * take taps still holds its room as a dead zone. */
function packPhoneTargets(busiestFirst: MapAirport[]) {
  const placed: { x: number; y: number; r: number }[] = [];
  return busiestFirst.map((a) => {
    let r = HIT_PHONE;
    for (const p of placed) r = Math.min(r, Math.hypot(a.x - p.x, a.y - p.y) - p.r);
    placed.push({ x: a.x, y: a.y, r });
    return r;
  });
}

/** Wider screens: targets paint busiest first, so a quieter airport's target
 * lies on top of a busier one's. It stops short of every busier airport's
 * dot, or of half the gap between their centres where the dots overlap, so
 * a click on any dot's middle is that airport's own. */
function wideTargets(busiestFirst: MapAirport[], max: number) {
  return busiestFirst.map((a, i) => {
    let r = HIT_WIDE;
    for (const b of busiestFirst.slice(0, i)) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      r = Math.min(r, d - Math.min(dotRadius(b.departures, max), d / 2));
    }
    return r;
  });
}

/**
 * Two hundred airports can't each get 24 px on a phone. On wider screens
 * every airport takes clicks through these targets; the dots themselves take
 * none. On phones client/routes-map.ts decides what a tap opens, from where
 * the finger landed, and the packed phone targets here are what is left when
 * that script hasn't run: only an airport with room for a usable target takes
 * taps, and the list under the map links every airport.
 */
function hitRadii(busiestFirst: MapAirport[], max: number) {
  const phone = packPhoneTargets(busiestFirst);
  const wide = wideTargets(busiestFirst, max);
  return new Map(
    busiestFirst.map((a, i) => [
      a.code,
      {
        phone: phone[i] >= HIT_PHONE_MIN ? Math.floor(phone[i]) : null,
        wide: Math.floor(wide[i] * 10) / 10,
      },
    ])
  );
}

/**
 * Closed and empty until a tap lands where several dots share a
 * fingertip: client/routes-map.ts fills it with those airports and places it
 * by the tap; on wider screens only a finger's tap opens it. Markup lives here so the stylesheet compiles its classes.
 */
function TapChooser({ airports }: { airports: number }) {
  return (
    <dialog
      className="js-map-chooser absolute inset-x-2 z-30 m-0 w-auto rounded-lg border border-subtle bg-surface-elevated p-3 text-primary shadow-xl shadow-black/40 sm:w-80"
      aria-label="Airports near your tap"
    >
      <Eyebrow className="pr-8">Airports near your tap</Eyebrow>
      <div className="js-map-chooser-list mt-2 grid grid-cols-4 gap-2" />
      <p className="js-map-chooser-more mt-2 text-xs text-muted" hidden />
      <button
        type="button"
        className="js-map-chooser-all mt-1 py-2 text-xs text-accent hover:underline"
      >
        {`Not here? See all ${fmt(airports)} airports`}
      </button>
      {/* Last in the markup, still drawn in the top corner: focus opens on
          the first airport, and Tab from there must reach Close before it
          leaves the chooser. */}
      <button
        type="button"
        className="js-map-chooser-close absolute right-0 top-0 p-3 text-sm text-secondary hover:text-accent"
        aria-label="Close"
      >
        ✕
      </button>
    </dialog>
  );
}

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
 * Lines and dots are a server-rendered SVG over a cached coastline image;
 * each dot links to its airport's page. The one script it ships settles
 * which airport a tap means on phones, where dots sit closer than a finger.
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
  const linked = airportLinks ? busiest.filter((a) => a.departures > 0) : [];
  const hits = hitRadii(linked, maxAirport);
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
        <figure className="relative m-0">
          <div
            className="js-map relative w-full overflow-hidden rounded"
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
            {/* No role="img": it would hide the airport links from screen
                readers; the title names the map. Airports go busiest first,
                so focus follows the labels. */}
            <svg
              viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
              className="absolute inset-0 h-full w-full [-webkit-tap-highlight-color:transparent]"
            >
              <title>{`Map: ${summary}.${airportLinks ? " Each airport links to its page." : ""}`}</title>
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
              {/* Each link's last circle is its dot, which takes no clicks;
                  the invisible circles before it are the targets. Airports
                  with no page paint first, under every target. Focus lights
                  the dot up. */}
              <g
                className="fill-primary stroke-surface [&_a]:outline-none [&_a:focus-visible>circle:last-child]:fill-accent [&_a:focus-visible>circle:last-child]:stroke-primary [&_a:focus-visible>circle:last-child]:stroke-[5] [&_a[data-near]>circle:last-child]:fill-accent [&_a>circle:not(:last-child)]:fill-transparent [&_a>circle:not(:last-child)]:stroke-none"
                fillOpacity="0.92"
                strokeWidth="1.5"
              >
                {[...busiest.filter((a) => !hits.has(a.code)), ...linked].map((ap) => {
                  const title = `${ap.code}: ${fmt(ap.departures)} Starlink departure${ap.departures === 1 ? "" : "s"}`;
                  const r = dotRadius(ap.departures, maxAirport).toFixed(1);
                  const hit = hits.get(ap.code);
                  if (!hit)
                    return (
                      <circle key={ap.code} cx={ap.x} cy={ap.y} r={r}>
                        <title>{title}</title>
                      </circle>
                    );
                  // No taps at all, not just a small target: Chrome snaps a tap
                  // to the smallest link near the finger, so a crowded dot
                  // would steal taps meant for the hub beside it. Keyboards
                  // and screen readers still reach it.
                  return (
                    <a
                      key={ap.code}
                      href={`/routes/${ap.code}`}
                      aria-label={title}
                      className={
                        hit.phone ? undefined : "pointer-events-none sm:pointer-events-auto"
                      }
                    >
                      <title>{title}</title>
                      {hit.phone && (
                        <circle cx={ap.x} cy={ap.y} r={hit.phone} className="sm:hidden" />
                      )}
                      <circle cx={ap.x} cy={ap.y} r={hit.wide} className="hidden sm:inline" />
                      <circle cx={ap.x} cy={ap.y} r={r} pointerEvents="none" />
                    </a>
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
            {linked.length > 0 && (
              <div
                className="js-map-ring pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent"
                hidden
              />
            )}
          </div>
          {linked.length > 0 && <TapChooser airports={linked.length} />}
          <figcaption className="mt-3 text-xs text-muted text-pretty">
            {offFlights > 0
              ? `${pct(net.drawnDepartures, net.totalDepartures)} of ${fmt(net.totalDepartures)} departures are on this map. `
              : ""}
            Lines join airports along the great circle, not the track flown. Counts only aircraft
            assigned so far, so a route missing here may still have Starlink.
            {updatedAt ? ` Data updated ${utcDateTime(updatedAt)}.` : ""}
          </figcaption>
          {linked.length > 0 && (
            <details className="js-map-list mt-3 text-xs sm:pointer-fine:hidden">
              <summary className="cursor-pointer py-1 text-secondary">
                {`All ${fmt(linked.length)} airports on the map`}
              </summary>
              <div className="mt-1 flex flex-wrap gap-x-4 *:py-1.5 *:font-mono *:whitespace-nowrap *:text-secondary *:hover:text-accent">
                {linked.map((ap) => (
                  <a key={ap.code} href={`/routes/${ap.code}`}>
                    {ap.code} <span className="tabular-nums">{fmt(ap.departures)}</span>
                  </a>
                ))}
              </div>
            </details>
          )}
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
      {linked.length > 0 && <ClientScriptTag name="routes-map" />}
    </section>
  );
}
