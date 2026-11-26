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

export interface MapDot {
  code: string;
  x: number;
  y: number;
}

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
