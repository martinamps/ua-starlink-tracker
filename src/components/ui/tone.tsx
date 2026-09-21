/**
 * The one status palette. Every "yes / partly / no" mark on the site takes a
 * Tone, and each tone is a CSS variable in index.html's :root, so a pill, a
 * text label and a client-rendered answer can never pick three different
 * greens for the same "yes".
 */
import type React from "react";

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

/** Inline colors for a tinted pill: the tone, and the tone at 12% for its fill. */
export function toneStyle(tone: Tone): React.CSSProperties {
  const color = `var(--color-${tone})`;
  return { color, background: `color-mix(in srgb, ${color} 12%, transparent)` };
}

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
      style={toneStyle(tone)}
    >
      {children}
    </span>
  );
}
