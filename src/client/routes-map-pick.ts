/**
 * Which airports a tap on the /routes map means. Two hundred dots share a
 * phone map some 300 px wide, so a fingertip often covers several: the tap
 * opens an airport only when it is the one dot under the finger, and
 * otherwise the page asks. Pure geometry, so the suite can run it.
 */

/** Half of a 24 px fingertip, the smallest target a tap is expected to hit. */
export const FINGER_RADIUS_PX = 12;

/** Three rows of four in the chooser; the list under the map has the rest. */
export const CHOOSER_MAX = 12;

// Touch points arrive in whole pixels while dots sit on fractions of one.
const ROUNDING_PX = 0.5;

/**
 * Whether the script, not the browser, decides what a click on the map opens.
 * On narrow screens it always does. On wider ones only for a finger or a pen:
 * a phone turned sideways is wider than `sm`, and its dots still sit closer
 * than a fingertip. A mouse there is precise, and the server's links stand.
 */
export function tapIsOurs(wide: boolean, pointer: string | null): boolean {
  return !wide || pointer === "touch" || pointer === "pen";
}

export interface MapDot {
  code: string;
  x: number;
  y: number;
}

/** A dot as drawn: its departures, and its painted radius in viewport px. */
export interface DrawnDot extends MapDot {
  departures: number;
  radius: number;
}

/** "Far busier": this many times the departures of every other airport under
 * the finger put together, so at least ten in eleven flights there are its. */
export const HUB_SHARE = 10;

/** How much nearer the finger the hub's centre must be than any other dot's. */
export const HUB_CLEAR_PX = 8;

/** Every dot under a fingertip at (x, y), nearest first. */
export function airportsUnderTap<T extends MapDot>(
  dots: readonly T[],
  x: number,
  y: number,
  radius = FINGER_RADIUS_PX
): T[] {
  return dots
    .map((dot) => ({ dot, d: Math.hypot(dot.x - x, dot.y - y) }))
    .filter((c) => c.d <= radius + ROUNDING_PX)
    .sort((p, q) => p.d - q.d)
    .map((c) => c.dot);
}

/**
 * The hub a finger plainly meant among several dots, or null to ask. Only
 * when the finger lands on the nearest dot's painted circle, every other dot
 * under it is at least HUB_CLEAR_PX further off, and that dot is far busier
 * than all the rest together. `near` is airportsUnderTap's answer.
 */
export function clearHub<T extends DrawnDot>(near: readonly T[], x: number, y: number): T | null {
  const [top, ...rest] = near;
  if (!top || rest.length === 0) return null;
  const d = (dot: T) => Math.hypot(dot.x - x, dot.y - y);
  const own = d(top);
  if (own > top.radius + ROUNDING_PX) return null;
  if (rest.some((dot) => d(dot) - own < HUB_CLEAR_PX)) return null;
  const others = rest.reduce((sum, dot) => sum + dot.departures, 0);
  return top.departures >= HUB_SHARE * others ? top : null;
}
