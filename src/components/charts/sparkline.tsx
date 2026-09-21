/**
 * The one sparkline (homepage installs per week, /fleet live pulse) and the
 * SVG path builder the rollout chart shares with it. The SVG stretches to its
 * box, so strokes are non-scaling.
 */

/** "M0.0 12.0 L10.0 8.5 …" through the points, in viewBox units. */
export const pathOf = (pts: ReadonlyArray<readonly [number, number]>) =>
  pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

const W = 600;
const H = 64;

/** Values as a line with a tinted area under it, scaled to `peak` (default: the max). */
export function Sparkline({
  values,
  peak = Math.max(...values),
  label,
  className = "h-12 w-full",
}: {
  values: number[];
  peak?: number;
  label: string;
  className?: string;
}) {
  if (values.length < 2 || peak <= 0) return null;
  const step = W / (values.length - 1);
  const line = pathOf(values.map((v, i) => [i * step, H - 3 - (v / peak) * (H - 6)] as const));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`block ${className}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="var(--color-accent)" opacity="0.12" />
      <path
        d={line}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="2"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
