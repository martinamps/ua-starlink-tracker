/**
 * The one status palette. Every "yes / partly / no" mark on the site takes a
 * Tone, and each tone is a CSS variable in index.html's :root, so a pill, a
 * text label and a client-rendered answer can never pick three different
 * greens for the same "yes". No JSX here: browser bundles import it.
 */

export type Tone = "success" | "warn" | "danger" | "info" | "trial" | "neutral";

/** Text color per tone, spelled out whole so the Tailwind scanner finds each. */
export const TONE_TEXT: Record<Tone, string> = {
  success: "text-success",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
  trial: "text-trial",
  neutral: "text-muted",
};

/** The tone's color. Neutral text is the muted text grey, as in TONE_TEXT. */
export const toneColor = (tone: Tone) =>
  tone === "neutral" ? "var(--color-text-muted)" : `var(--color-${tone})`;

/** Inline colors for a tinted pill: a color, and that color at 12% for its fill. */
export function pillColors(color: string): { color: string; background: string } {
  return { color, background: `color-mix(in srgb, ${color} 12%, transparent)` };
}

/** pillColors as a style attribute, for string-rendered pills. */
export function pillStyle(color: string): string {
  const c = pillColors(color);
  return `color:${c.color};background:${c.background}`;
}
