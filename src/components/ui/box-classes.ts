/**
 * The classes of the surface card and the eyebrow label, apart from the
 * components that draw them (Panel and Eyebrow in layout.tsx) so a browser
 * bundle can build the same box. No JSX here: browser bundles import it.
 */
export const EYEBROW_TEXT = "font-mono text-xs uppercase tracking-wider text-muted";
export const SURFACE = "rounded-lg border border-subtle bg-surface";
export const PANEL_PAD = { md: "p-5", sm: "p-4 sm:p-5", none: "" } as const;
