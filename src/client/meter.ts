/**
 * The one progress bar, as classes and a string renderer for browser bundles.
 * The React <Meter> (components/ui/meter.tsx) is built from the same classes,
 * so a bar drawn by a client script matches one the server rendered.
 */
import { esc } from "./esc";

export type MeterSize = "xs" | "sm" | "md" | "lg";

export const METER_TRACK = "overflow-hidden rounded-full";
/** Track color on a surface; a bar on an elevated card sits on bg-base instead. */
export const METER_BG = "bg-surface-elevated";
export const METER_HEIGHT: Record<MeterSize, string> = {
  xs: "h-1",
  sm: "h-1.5",
  md: "h-2",
  lg: "h-3",
};
export const METER_FILL = "h-full rounded-full";
export const METER_ACCENT = "bg-[var(--color-accent)]";

/** A share of 0..1 as a clamped CSS width. */
export const meterWidth = (share: number) => `${Math.max(0, Math.min(100, share * 100))}%`;

/**
 * Single-fill bar. `dotted` draws an outline-only fill for an inferred value;
 * `bg` swaps the track color (bg-base on an elevated card); `label` is the
 * bar's spoken text, otherwise it is hidden from screen readers.
 */
export function meterHtml(
  share: number,
  {
    color,
    size = "sm",
    dotted = false,
    className = "mt-1",
    bg = METER_BG,
    label,
  }: {
    color: string;
    size?: MeterSize;
    dotted?: boolean;
    className?: string;
    bg?: string;
    label?: string;
  }
): string {
  const c = esc(color);
  const fill = dotted
    ? `width:${meterWidth(share)};border-top:2px dotted ${c};background:transparent`
    : `width:${meterWidth(share)};background:${c}`;
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true"`;
  return `<div class="${METER_TRACK} ${esc(bg)} ${METER_HEIGHT[size]} ${esc(className)}" ${a11y}><div class="${METER_FILL}" style="${fill}"></div></div>`;
}
