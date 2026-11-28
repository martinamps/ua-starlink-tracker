/**
 * The classes of the surface card and the eyebrow label, apart from the
 * components that draw them (Panel and Eyebrow in layout.tsx) so a browser
 * bundle can build the same box. No JSX here: browser bundles import it.
 */
export const EYEBROW_TEXT = "font-mono text-xs uppercase tracking-wider text-muted";
export const SURFACE = "rounded-lg border border-subtle bg-surface";
export const PANEL_PAD = { md: "p-5", sm: "p-4 sm:p-5", none: "" } as const;
/** A data table and the box around it that it measures itself against
 * (DataTable in layout.tsx; `.table-stack` in src/styles/tailwind.css). */
export const TABLE_FRAME = "table-stack-frame";
/** The frame of a table whose cells need more than 15rem side by side; it
 * stacks below a 17.5rem column (`.table-stack-early`). */
export const TABLE_FRAME_EARLY = "table-stack-frame table-stack-early";
export const TABLE = "table-stack w-full text-sm";
