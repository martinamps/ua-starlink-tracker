import type React from "react";
import { type Tone, pillColors, toneColor } from "./tone-classes";

export { TONE_TEXT, type Tone } from "./tone-classes";

const PILL = "shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium";

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={PILL} style={pillColors(toneColor(tone)) as React.CSSProperties}>
      {children}
    </span>
  );
}

/**
 * A pill whose words the stylesheet draws from an attribute. For a second
 * copy of a pill that another layout already prints: the markup then holds
 * the words once, so a reader without the stylesheet does not read them
 * twice, while a browser and a screen reader still get them here.
 */
export function DrawnPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={`${PILL} before:content-[attr(data-label)]`}
      style={pillColors(toneColor(tone)) as React.CSSProperties}
      data-label={label}
    />
  );
}
