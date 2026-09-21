/**
 * The one flight-number + date form. Every page that asks "which flight?"
 * renders this, and one browser bundle (src/client/flight-search.ts) gives
 * every instance the same normalization, fed the router's own rules through
 * data-rules. Without JS it GETs /check-flight?flight_number=…&date=…, which
 * the server redirects to the permalink.
 */
import { flightInputRules } from "../airlines/flight-number";
import { type SiteConfig, siteAirline } from "../airlines/registry";
import { type ClientScript, clientScriptSrc } from "../client/bundle";

const INPUT =
  "w-full min-w-0 rounded border border-subtle bg-base px-3 py-2 text-base text-primary placeholder-muted focus:border-accent focus:outline-none sm:text-sm";
const LABEL = "mb-1 block text-xs text-muted";
export const BUTTON =
  "cursor-pointer whitespace-nowrap rounded border border-accent bg-accent/20 px-5 py-2 font-display text-accent transition-colors hover:bg-accent/30";

export function ClientScriptTag({ name }: { name: ClientScript }) {
  const src = clientScriptSrc(name);
  return src ? <script src={src} defer /> : null;
}

export function FlightSearchForm({
  site,
  id,
  flightNumber,
  date,
  prefillDate = false,
  submitLabel = "Check",
  withScript = true,
}: {
  site: SiteConfig;
  /** Prefix for element ids; tests and analytics key on `${id}`. */
  id: string;
  flightNumber?: string;
  date?: string;
  /** Default the date to the viewer's local today (the checker needs one). */
  prefillDate?: boolean;
  submitLabel?: string;
  /** Off when the page ships a bundle that already includes the form behavior. */
  withScript?: boolean;
}) {
  const cfg = siteAirline(site);
  return (
    <>
      <form
        id={id}
        method="GET"
        action="/check-flight"
        data-flight-search=""
        data-rules={JSON.stringify(flightInputRules(cfg))}
        data-prefill-date={prefillDate ? "" : undefined}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <div className="flex-1 min-w-0">
          <label htmlFor={`${id}-number`} className={LABEL}>
            Flight number
          </label>
          <input
            type="text"
            id={`${id}-number`}
            name="flight_number"
            defaultValue={flightNumber}
            placeholder={`${cfg.iata}881`}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            className={`${INPUT} font-mono`}
          />
        </div>
        <div className="sm:w-44">
          <label htmlFor={`${id}-date`} className={LABEL}>
            Date
          </label>
          <input type="date" id={`${id}-date`} name="date" defaultValue={date} className={INPUT} />
        </div>
        <button type="submit" className={BUTTON}>
          {submitLabel}
        </button>
      </form>
      {withScript && <ClientScriptTag name="flight-search" />}
    </>
  );
}
