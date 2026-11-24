import type { RouteScheduleRow } from "../../types";
import { AIRPORT_COORDS } from "../../utils/airport-geo";
import { greatCircleMidpoint, onMap, projectToMap } from "../../utils/map-projection";

export interface MapArc {
  key: string;
  /** SVG path: one quadratic curve through the projected great-circle
   * midpoint, in whole units (a unit is about a pixel on the widest map). */
  d: string;
  /** Both directions combined. */
  departures: number;
}

export interface MapAirport {
  code: string;
  x: number;
  y: number;
  /** Starlink departures from this airport in the window, to anywhere. */
  departures: number;
}

export interface OffMapAirport {
  code: string;
  /** Starlink departures to or from it in the window. */
  flights: number;
  /** Whether any leave from it: only those airports have a page. */
  departs: boolean;
}

export interface RouteNetwork {
  arcs: MapArc[];
  airports: MapAirport[];
  offMap: OffMapAirport[];
  /** Departures with both ends on the map. */
  drawnDepartures: number;
  totalDepartures: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The /routes map from the same route rows the table counts: one arc per
 * airport pair, one dot per departure airport. A pair with an end beyond the
 * frame, or an airport with no coordinates, is never drawn at the edge or
 * guessed at: it is listed in `offMap` (or left out of both when no
 * coordinates exist), and `drawnDepartures` says how much of the total shows.
 */
export function buildRouteNetwork(rows: RouteScheduleRow[]): RouteNetwork {
  const point = new Map<string, [number, number] | null>();
  const at = (code: string) => {
    if (!point.has(code)) {
      const c = AIRPORT_COORDS[code];
      const p = c ? projectToMap(c[0], c[1]) : null;
      point.set(code, p && onMap(p, 2) ? p : null);
    }
    return point.get(code) ?? null;
  };

  const pairs = new Map<string, { a: string; b: string; departures: number }>();
  const outbound = new Map<string, number>();
  const offMap = new Map<string, { flights: number; departs: boolean }>();
  let drawn = 0;
  let total = 0;
  for (const r of rows) {
    total += r.departures;
    const pa = at(r.origin);
    const pb = at(r.destination);
    if (pa) outbound.set(r.origin, (outbound.get(r.origin) ?? 0) + r.departures);
    if (pb && !outbound.has(r.destination)) outbound.set(r.destination, 0);
    if (!pa || !pb) {
      for (const code of [r.origin, r.destination]) {
        if (at(code) || !AIRPORT_COORDS[code]) continue;
        const o = offMap.get(code) ?? { flights: 0, departs: false };
        o.flights += r.departures;
        o.departs ||= code === r.origin;
        offMap.set(code, o);
      }
      continue;
    }
    drawn += r.departures;
    const [a, b] = [r.origin, r.destination].sort();
    const key = `${a}-${b}`;
    const pair = pairs.get(key) ?? { a, b, departures: 0 };
    pair.departures += r.departures;
    pairs.set(key, pair);
  }

  const arcs: MapArc[] = [...pairs]
    .map(([key, { a, b, departures }]) => {
      const [x0, y0] = at(a) as [number, number];
      const [x2, y2] = at(b) as [number, number];
      const [mLat, mLon] = greatCircleMidpoint(AIRPORT_COORDS[a], AIRPORT_COORDS[b]);
      const [mx, my] = projectToMap(mLat, mLon);
      // The control point that puts the curve through the midpoint at t = 0.5.
      const cx = 2 * mx - (x0 + x2) / 2;
      const cy = 2 * my - (y0 + y2) / 2;
      return {
        key,
        d: `M${Math.round(x0)} ${Math.round(y0)}Q${Math.round(cx)} ${Math.round(cy)} ${Math.round(x2)} ${Math.round(y2)}`,
        departures,
      };
    })
    // Quietest first, so the busiest routes paint on top.
    .sort((p, q) => p.departures - q.departures || p.key.localeCompare(q.key));

  const airports: MapAirport[] = [...outbound]
    .map(([code, departures]) => {
      const [x, y] = at(code) as [number, number];
      return { code, x: r1(x), y: r1(y), departures };
    })
    .sort((p, q) => p.departures - q.departures || p.code.localeCompare(q.code));

  return {
    arcs,
    airports,
    offMap: [...offMap]
      .map(([code, o]) => ({ code, ...o }))
      .sort((p, q) => q.flights - p.flights || p.code.localeCompare(q.code)),
    drawnDepartures: drawn,
    totalDepartures: total,
  };
}
