/**
 * The /routes network map's projection: Albers equal-area conic (parallels
 * 20°N and 50°N, centred on 96°W), fitted so the frame below fills a
 * MAP_WIDTH-wide viewBox. One module for the committed basemap
 * (scripts/build-basemap.ts) and the server's airport dots, so a coastline and
 * an airport can never be projected two ways. Changing anything here means
 * regenerating src/components/routes-map/basemap.ts.
 */

const RAD = Math.PI / 180;
const PHI1 = 20 * RAD;
const PHI2 = 50 * RAD;
const LAMBDA0 = -96 * RAD;
const PHI0 = 30 * RAD;

const N = (Math.sin(PHI1) + Math.sin(PHI2)) / 2;
const C = Math.cos(PHI1) ** 2 + 2 * N * Math.sin(PHI1);
const RHO0 = Math.sqrt(C - 2 * N * Math.sin(PHI0)) / N;

function albers(lat: number, lon: number): [number, number] {
  const rho = Math.sqrt(C - 2 * N * Math.sin(lat * RAD)) / N;
  const theta = N * (lon * RAD - LAMBDA0);
  return [rho * Math.sin(theta), -(RHO0 - rho * Math.cos(theta))];
}

/** Continental US, southern Canada, Mexico, Central America, the Caribbean
 * and the top of South America: where nearly all UA and AS Starlink flying is.
 * Hawaii, Alaska and the Pacific islands are listed beside the map instead. */
const FRAME = { south: 5, north: 50, west: -125, east: -62 };

export const MAP_WIDTH = 1000;

const fit = (() => {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= 40; i++) {
    const lon = FRAME.west + ((FRAME.east - FRAME.west) * i) / 40;
    const lat = FRAME.south + ((FRAME.north - FRAME.south) * i) / 40;
    for (const [la, lo] of [
      [FRAME.south, lon],
      [FRAME.north, lon],
      [lat, FRAME.west],
      [lat, FRAME.east],
    ]) {
      const [x, y] = albers(la, lo);
      xs.push(x);
      ys.push(y);
    }
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const scale = MAP_WIDTH / (Math.max(...xs) - minX);
  return { minX, minY, scale, height: Math.round((Math.max(...ys) - minY) * scale) };
})();

export const MAP_HEIGHT = fit.height;

/** [x, y] in viewBox units; may fall outside the box for far-off places. */
export function projectToMap(lat: number, lon: number): [number, number] {
  const [x, y] = albers(lat, lon);
  return [(x - fit.minX) * fit.scale, (y - fit.minY) * fit.scale];
}

/** Inside the drawn box, with `margin` units to spare on every side. */
export function onMap([x, y]: readonly [number, number], margin = 0): boolean {
  return x >= margin && x <= MAP_WIDTH - margin && y >= margin && y <= MAP_HEIGHT - margin;
}

/** The point halfway along the great circle from a to b, as [lat, lon]. */
export function greatCircleMidpoint(
  a: readonly [number, number],
  b: readonly [number, number]
): [number, number] {
  const [p1, l1] = [a[0] * RAD, a[1] * RAD];
  const [p2, l2] = [b[0] * RAD, b[1] * RAD];
  const bx = Math.cos(p2) * Math.cos(l2 - l1);
  const by = Math.cos(p2) * Math.sin(l2 - l1);
  const lat = Math.atan2(
    Math.sin(p1) + Math.sin(p2),
    Math.sqrt((Math.cos(p1) + bx) ** 2 + by ** 2)
  );
  const lon = l1 + Math.atan2(by, Math.cos(p1) + bx);
  return [lat / RAD, lon / RAD];
}
