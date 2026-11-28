/**
 * The one flight-number + date form. Every page that asks "which flight?"
 * renders this, and one browser bundle (src/client/flight-search.ts) gives
 * every instance its behavior:
 *
 *  - "permalink" (airline sites): normalize with the router's own rules,
 *    serialized into data-rules, and go to /check-flight/{fn}/{date}. Without
 *    JS it GETs /check-flight?flight_number=…&date=…, which redirects.
 *  - "check-any" (hub): ask /api/check-any-flight and print the answer under
 *    the form. `answer="community"` says only a firm yes out loud. An airline
 *    answered by route (no schedule held) asks for the two airports, and one
 *    answered by aircraft type for the type on the booking: those fields
 *    under the answer stay hidden and disabled until it does.
 *  - "report" (onboard banner): no date, no navigation; the banner module
 *    owns the submit.
 */
import { Fragment, type ReactNode } from "react";
import { flightInputRules } from "../airlines/flight-number";
import {
  type SiteConfig,
  hubLookupAirlines,
  liveAirlineSites,
  siteAirline,
} from "../airlines/registry";
import { RETIRED_CODE_NOTES } from "../airlines/untracked-airline";
import { ClientScriptTag, buttonClass } from "./layout";

/** The form's input look, for `extra` fields (a select) that must match it. */
export const FIELD_CLASS =
  "w-full min-w-0 min-h-11 rounded border border-neutral bg-base px-3 py-2 text-base text-primary placeholder-muted focus:border-accent focus:outline-none sm:text-sm";
const LABEL = "mb-1 block text-xs text-muted";

/** Airline name (as /api/check-any-flight spells it) → that airline's own
 * check page, which names the aircraft and re-checks close to departure. */
function checkPagesByAirline(): Record<string, { url: string; site: string }> {
  const pages: Record<string, { url: string; site: string }> = {};
  for (const { site, airline } of liveAirlineSites()) {
    if (!site.features.checkFlightPage) continue;
    pages[airline.name] = {
      url: `https://${site.canonicalHost}/check-flight`,
      site: site.brand.title,
    };
  }
  return pages;
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
  extra?: ReactNode;
  className?: string;
  /** Off when the page ships a bundle that already includes the form behavior. */
  withScript?: boolean;
}) {
  const cfg = site.scope !== "ALL" ? siteAirline(site) : null;
  const label = hideLabels ? "sr-only" : LABEL;
  const rules = mode === "permalink" && cfg ? JSON.stringify(flightInputRules(cfg)) : undefined;
  const checkPages =
    mode === "check-any" && answer === "tracked"
      ? JSON.stringify(checkPagesByAirline())
      : undefined;
  // The API answer for an HA number is pinned byte for byte, so the page says
  // which number to use instead.
  const numberNotes =
    mode === "check-any" && answer === "tracked" ? JSON.stringify(RETIRED_CODE_NOTES) : undefined;
  // The airlines /api/check-any-flight answers, by name: its "not tracked"
  // error lists them by code, which the page writes out.
  const trackedAirlines =
    mode === "check-any" ? JSON.stringify(hubLookupAirlines().map((a) => a.shortName)) : undefined;
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
        data-check-pages={checkPages}
        data-number-notes={numberNotes}
        data-tracked-airlines={trackedAirlines}
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
            // iOS autocorrect rewrites "ua 1"; spellCheck alone leaves it on.
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            required
            className={`${FIELD_CLASS} font-mono`}
          />
        </div>{" "}
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
              className={FIELD_CLASS}
            />
          </div>
        )}{" "}
        {extra}{" "}
        <button type="submit" className={`${buttonClass()} min-h-11`}>
          {submitLabel}
        </button>
      </form>{" "}
      {mode === "check-any" && (
        <div
          id={`${id}-result`}
          aria-live="polite"
          className="mt-3 hidden text-sm leading-relaxed text-secondary"
        />
      )}{" "}
      {mode === "check-any" && answer === "tracked" && (
        <div id={`${id}-route`} className="mt-3 hidden">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            {(
              [
                ["origin", "From (airport code)", "DUB"],
                ["destination", "To (airport code)", "JFK"],
              ] as const
            ).map(([name, text, example]) => (
              <Fragment key={name}>
                <div className="sm:w-44">
                  <label htmlFor={`${id}-${name}`} className={LABEL}>
                    {text}
                  </label>
                  <input
                    type="text"
                    id={`${id}-${name}`}
                    name={name}
                    form={id}
                    disabled
                    maxLength={4}
                    placeholder={example}
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    className={`${FIELD_CLASS} font-mono uppercase`}
                  />
                </div>{" "}
              </Fragment>
            ))}
            <button type="submit" form={id} className={`${buttonClass()} min-h-11`}>
              Check this route
            </button>
          </div>
        </div>
      )}{" "}
      {mode === "check-any" && answer === "tracked" && (
        <div id={`${id}-type`} className="mt-3 hidden">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-72">
              <label htmlFor={`${id}-aircraft-type`} className={LABEL}>
                Aircraft type on your booking
              </label>
              <input
                type="text"
                id={`${id}-aircraft-type`}
                name="aircraft_type"
                form={id}
                disabled
                maxLength={40}
                placeholder="Airbus A350-1000"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="search"
                className={FIELD_CLASS}
              />
            </div>{" "}
            <button type="submit" form={id} className={`${buttonClass()} min-h-11`}>
              Check this aircraft type
            </button>
          </div>
        </div>
      )}{" "}
      {withScript && <ClientScriptTag name="flight-search" />}
    </>
  );
}
