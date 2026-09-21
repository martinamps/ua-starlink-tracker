// Only ever rendered when the server already saw a Starlink-geofeed IP on the
// UA tenant — the gate lives in passenger-detect.ts, not here. Behavior is
// src/client/passenger-banner.ts, shipped in the homepage bundle.
import type { SiteConfig } from "../airlines/registry";
import { FlightSearchForm } from "./flight-search-form";

export function PassengerBanner({ site }: { site: SiteConfig }) {
  return (
    <div id="psgr-banner" className="relative mx-auto mt-4 mb-4 hidden w-full max-w-3xl">
      <div className="rounded-lg border border-accent/40 bg-surface-elevated p-4 shadow-lg shadow-accent/10 sm:p-5">
        <button
          id="psgr-dismiss"
          type="button"
          aria-label="Dismiss"
          className="absolute top-2 right-3 text-lg leading-none text-muted hover:text-secondary"
        >
          ×
        </button>
        <h2 className="mb-1 pr-6 font-display text-lg text-primary">
          Are you on a Starlink flight?
        </h2>
        <p className="mb-3 pr-6 text-sm text-secondary">
          Your connection looks like Starlink. Tell us your flight number and we'll confirm this
          aircraft's Wi-Fi for other travelers.
        </p>
        <FlightSearchForm
          site={site}
          id="psgr-form"
          mode="report"
          placeholder="UA2019"
          submitLabel="Confirm flight"
          hideLabels
          withScript={false}
        />
        <output id="psgr-thanks" className="mt-2 hidden text-sm text-success">
          Thanks, recorded.
        </output>
        <p className="mt-2 text-xs text-muted">
          We store only the flight number and that your IP is in Starlink's published range.
        </p>
      </div>
    </div>
  );
}
