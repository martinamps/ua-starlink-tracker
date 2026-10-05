import type { AirlineConfig } from "../../airlines/registry";
import { denominatorIsPublishable } from "../../utils/share-cards";
import { fmt, pct } from "../ui/format";

export interface HomeHeadline {
  /** "United Starlink Tracker" — also the site's brand title and WebSite.name. */
  name: string;
  /** "617 of 1,674" */
  count: string;
  /** "37%" */
  share: string;
}

/**
 * The airline homepage's one headline. The <title>, the H1 and WebPage.name
 * all read from it: Google replaced a counted <title> with the number-free H1
 * while the two disagreed. Null when the ratio isn't publishable.
 */
export function homeHeadline(cfg: AirlineConfig, n: number, total: number): HomeHeadline | null {
  if (!denominatorIsPublishable(n, total, cfg.rollout.rosterIsProgramScope)) return null;
  return {
    name: `${cfg.shortName} Starlink Tracker`,
    count: `${fmt(n)} of ${fmt(total)}`,
    // pct(), not Math.round: the hero and /fleet floor shares, and the title
    // must never state a higher share than the page under it.
    share: pct(n, total),
  };
}
