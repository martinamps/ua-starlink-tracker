import type React from "react";
import { type Tone, pillColors, toneColor } from "./tone-classes";

export { TONE_TEXT, type Tone } from "./tone-classes";

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
      style={pillColors(toneColor(tone)) as React.CSSProperties}
    >
      {children}
    </span>
  );
}
