/**
 * Regenerates src/components/routes-map/basemap.ts: the /routes map's land,
 * country borders and US state lines, pre-projected through
 * src/utils/map-projection.ts so a request only ever concatenates strings.
 *
 * Source: Natural Earth 1:50m land and countries (public domain) via the npm
 * package world-atlas@2.0.2, and US states (Census, public domain) via
 * us-atlas@3.0.1. Neither is a dependency: fetch them once with
 *   npm pack world-atlas@2.0.2 us-atlas@3.0.1   (then untar both)
 * and run
 *   bun scripts/build-basemap.ts <world-atlas/package> <us-atlas/package>
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAP_HEIGHT, MAP_WIDTH, projectToMap } from "../src/utils/map-projection";

type Arc = [number, number][];
interface Topology {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: Arc[];
  objects: Record<string, { geometries?: Geometry[] } & Geometry>;
}
interface Geometry {
  type: string;
  arcs?: unknown;
  geometries?: Geometry[];
}

function decodeArcs(t: Topology): [number, number][][] {
  const [sx, sy] = t.transform.scale;
  const [tx, ty] = t.transform.translate;
  return t.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty] as [number, number];
    });
  });
}

const arcPoints = (arcs: [number, number][][], i: number) =>
  i >= 0 ? arcs[i] : [...arcs[~i]].reverse();

function ring(arcs: [number, number][][], ids: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const id of ids) {
    const pts = arcPoints(arcs, id);
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  return out;
}

/** Polygon rings of every geometry in an object. */
function rings(t: Topology, arcs: [number, number][][], object: string): [number, number][][] {
  const out: [number, number][][] = [];
  const walk = (g: Geometry) => {
    if (g.type === "GeometryCollection") g.geometries?.forEach(walk);
    else if (g.type === "Polygon") for (const r of g.arcs as number[][]) out.push(ring(arcs, r));
    else if (g.type === "MultiPolygon")
      for (const p of g.arcs as number[][][]) for (const r of p) out.push(ring(arcs, r));
  };
  walk(t.objects[object]);
  return out;
}

/** Arcs two polygons share: internal borders, each drawn once. */
function sharedArcs(t: Topology, arcs: [number, number][][], object: string): [number, number][][] {
  const owners = new Map<number, Set<number>>();
  let n = 0;
  const visit = (ids: unknown, owner: number) => {
    if (typeof ids === "number") {
      const k = ids >= 0 ? ids : ~ids;
      const set = owners.get(k) ?? new Set();
      set.add(owner);
      owners.set(k, set);
    } else if (Array.isArray(ids)) for (const x of ids) visit(x, owner);
  };
  for (const g of t.objects[object].geometries ?? []) visit(g.arcs, n++);
  return [...owners].filter(([, s]) => s.size > 1).map(([k]) => arcs[k]);
}

/** Douglas-Peucker, in viewBox units: detail finer than the tolerance is
 * under a pixel even on a wide desktop map. */
function simplify(pts: [number, number][], tolerance: number): [number, number][] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const TOLERANCE = 0.7;
/** Islands smaller than this (square units) vanish at any size we render. */
const MIN_AREA = 6;

function area(pts: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

const PAD = 4;
const clampX = (x: number) => Math.max(-PAD, Math.min(MAP_WIDTH + PAD, x));
const clampY = (y: number) => Math.max(-PAD, Math.min(MAP_HEIGHT + PAD, y));

/** Projected, clamped just past the box (clamping only moves points the box
 * hides), rounded to whole units and deduplicated. Null when nothing shows. */
function toPath(points: [number, number][], closed: boolean): string | null {
  const projected = points.map(([lon, lat]) => projectToMap(lat, lon));
  const visible = projected.some(([x, y]) => x >= 0 && x <= MAP_WIDTH && y >= 0 && y <= MAP_HEIGHT);
  if (!visible) return null;
  if (closed && area(projected) < MIN_AREA) return null;
  const pts: [number, number][] = [];
  const clamped = projected.map(([x, y]) => [clampX(x), clampY(y)] as [number, number]);
  // A closed ring starts and ends on one point, which gives Douglas-Peucker a
  // zero-length baseline: split it at the point farthest from the start.
  let far = 0;
  if (closed)
    for (let i = 1; i < clamped.length; i++)
      if (
        Math.hypot(clamped[i][0] - clamped[0][0], clamped[i][1] - clamped[0][1]) >
        Math.hypot(clamped[far][0] - clamped[0][0], clamped[far][1] - clamped[0][1])
      )
        far = i;
  const simplified =
    closed && far > 0
      ? [
          ...simplify(clamped.slice(0, far + 1), TOLERANCE),
          ...simplify(clamped.slice(far), TOLERANCE).slice(1),
        ]
      : simplify(clamped, TOLERANCE);
  for (const [x, y] of simplified) {
    const p: [number, number] = [Math.round(x), Math.round(y)];
    const last = pts.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  if (pts.length < (closed ? 3 : 2)) return null;
  return `M${pts.map(([x, y]) => `${x} ${y}`).join("L")}${closed ? "Z" : ""}`;
}

const [worldDir, usDir] = process.argv.slice(2);
if (!worldDir || !usDir) {
  console.error("usage: bun scripts/build-basemap.ts <world-atlas/package> <us-atlas/package>");
  process.exit(1);
}
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Topology;

const land = read(path.join(worldDir, "land-50m.json"));
const landArcs = decodeArcs(land);
const countries = read(path.join(worldDir, "countries-50m.json"));
const countryArcs = decodeArcs(countries);
const states = read(path.join(usDir, "states-10m.json"));
const stateArcs = decodeArcs(states);

const join = (parts: (string | null)[]) => parts.filter(Boolean).join("");
const landPath = join(rings(land, landArcs, "land").map((r) => toPath(r, true)));
const borderPath = join(
  sharedArcs(countries, countryArcs, "countries").map((a) => toPath(a, false))
);
const statePath = join(sharedArcs(states, stateArcs, "states").map((a) => toPath(a, false)));

const out = `// Generated by scripts/build-basemap.ts from Natural Earth 1:50m (public
// domain) and US Census states, projected by src/utils/map-projection.ts at
// ${MAP_WIDTH}x${MAP_HEIGHT}. Do not edit by hand; rerun the script.

export const LAND_PATH =
  ${JSON.stringify(landPath)};

export const BORDER_PATH =
  ${JSON.stringify(borderPath)};

export const STATE_PATH =
  ${JSON.stringify(statePath)};
`;
const target = path.join(import.meta.dir, "..", "src", "components", "routes-map", "basemap.ts");
writeFileSync(target, out);
console.log(
  `wrote ${target}: land ${landPath.length} B, borders ${borderPath.length} B, states ${statePath.length} B`
);
