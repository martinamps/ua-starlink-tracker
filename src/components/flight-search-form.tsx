/**
 * The one flight-number + date form. Every page that asks "which flight?"
 * renders this, and one browser bundle (src/client/flight-search.ts) gives
 * every instance its behavior:
 *
 *  - "permalink" (airline sites): normalize with the router's own rules,
 *    serialized into data-rules, and go to /check-flight/{fn}/{date}. Without
 *    JS it GETs /check-flight?flight_number=…&date=…, which redirects.
 *  - "check-any" (hub): ask /api/check-any-flight and print the answer under
 *    the form. `answer="community"` says only a firm yes out loud.
 *  - "report" (onboard banner): no date, no navigation; the banner module
 *    owns the submit.
 */
import type React from "react";
import { flightInputRules } from "../airlines/flight-number";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { type ClientScript, clientScriptSrc } from "../client/bundle";
import { buttonClass } from "./layout";

const INPUT =
  "w-full min-w-0 rounded border border-subtle bg-base px-3 py-2 text-base text-primary placeholder-muted focus:border-accent focus:outline-none sm:text-sm";
const LABEL = "mb-1 block text-xs text-muted";

export function ClientScriptTag({ name }: { name: ClientScript }) {
  const src = clientScriptSrc(name);
  return src ? <script src={src} defer /> : null;
}

export function FlightSearchForm({
  site,
  id,
  mode = "permalink",
  answer = "tracked",
  flightNumber,
  date,
  prefillDate = false,
  placeholder,
  submitLabel = "Check",
  hideLabels = false,
  extra,
  className = "",
  withScript = true,
}: {
  site: SiteConfig;
  /** Prefix for element ids; tests and analytics key on `${id}`. */
  id: string;
  mode?: "permalink" | "check-any" | "report";
  /** check-any only: how much of the verdict to state. */
  answer?: "tracked" | "community";
  flightNumber?: string;
  date?: string;
  /** Default the date to the viewer's local today (the checker needs one). */
  prefillDate?: boolean;
  placeholder?: string;
  submitLabel?: string;
  /** Screen-reader-only labels, for compact placements with their own heading. */
  hideLabels?: boolean;
  /** More fields between the date and the button. */
  extra?: React.ReactNode;
  className?: string;
  /** Off when the page ships a bundle that already includes the form behavior. */
  withScript?: boolean;
}) {
  const cfg = site.scope !== "ALL" ? siteAirline(site) : null;
  const label = hideLabels ? "sr-only" : LABEL;
  const rules = mode === "permalink" && cfg ? JSON.stringify(flightInputRules(cfg)) : undefined;
  return (
    <>
      <form
        id={id}
        method="GET"
        action={mode === "permalink" ? "/check-flight" : undefined}
        noValidate={mode === "report"}
        data-flight-search={mode}
        data-rules={rules}
        data-answer={mode === "check-any" ? answer : undefined}
        data-prefill-date={prefillDate ? "" : undefined}
        className={`flex flex-col gap-3 sm:flex-row sm:items-end ${className}`}
      >
        <div className="flex-1 min-w-0">
          <label htmlFor={`${id}-number`} className={label}>
            Flight number
          </label>
          <input
            type="text"
            id={`${id}-number`}
            name="flight_number"
            defaultValue={flightNumber}
            placeholder={placeholder ?? (cfg ? `${cfg.iata}881` : undefined)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            className={`${INPUT} font-mono`}
          />
        </div>
        {mode !== "report" && (
          <div className="sm:w-44">
            <label htmlFor={`${id}-date`} className={label}>
              Date
            </label>
            <input
              type="date"
              id={`${id}-date`}
              name="date"
              defaultValue={date}
              required={mode === "check-any"}
              className={INPUT}
            />
          </div>
        )}
        {extra}
        <button type="submit" className={buttonClass()}>
          {submitLabel}
        </button>
      </form>
      {mode === "check-any" && (
        <div
          id={`${id}-result`}
          aria-live="polite"
          className="mt-3 hidden text-sm leading-relaxed text-secondary"
        />
      )}
      {withScript && <ClientScriptTag name="flight-search" />}
    </>
  );
}

/** A select styled like the form's inputs, for `extra` fields. */
export const FIELD_SELECT = INPUT;
