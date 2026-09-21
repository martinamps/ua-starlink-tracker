import { type SiteConfig, siteAirline } from "../airlines/registry";
import { fmt } from "./layout";

/** The homepage headline's own numbers and stamp, so a quote taken from any
 * page matches the sentence /methodology#cite calls canonical. */
export interface CiteStat {
  starlink: number;
  total: number;
  lastUpdated?: string;
}

/** One visible "Cite this" line for pages the press quotes numbers from.
 * Airline sites with a methodology page only: that is where the link lands,
 * and the hub has no single-fleet number to cite. */
export function CiteThis({ site, cite }: { site: SiteConfig; cite?: CiteStat | null }) {
  if (!cite || site.scope === "ALL" || !site.features.methodologyPage || cite.total === 0) {
    return null;
  }
  const stamped = new Date(cite.lastUpdated ?? "");
  if (Number.isNaN(stamped.getTime())) return null;
  const cfg = siteAirline(site);
  const date = stamped.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return (
    <p
      id="cite-this"
      className="relative text-xs text-muted text-center font-mono max-w-3xl mx-auto mb-6"
    >
      <a href="/methodology#cite" className="text-accent hover:underline">
        Cite this
      </a>
      : {fmt(cite.starlink)} of {fmt(cite.total)} {cfg.name} aircraft (as of {date}),{" "}
      {site.canonicalHost}
    </p>
  );
}
