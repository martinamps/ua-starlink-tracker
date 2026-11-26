/**
 * An airline's own published count of Starlink departures a day at its hubs,
 * shown beside ours on /routes and the hub airport pages. Copied by hand from
 * a source a person opened and read; never derived, never updated by a job.
 *
 * United publishes these on its tracker and recounts them daily. We do not
 * read United's site, so the figures here are the ones a news outlet
 * reprinted, dated by that article. Its table also carries percentages; only
 * the counts are kept, because a count sits beside a count and we hold no
 * total of departures to stand a percentage against.
 */

import { DAY_SEC, unixNow } from "../database/sql/windows";

export interface HubFigures {
  /** Whose count it is, as the pages name them. */
  by: string;
  /** The date of the article that printed it, YYYY-MM-DD. */
  reported: string;
  source: { name: string; url: string };
  /** Airport → equipped departures a day. */
  perDay: Readonly<Record<string, number>>;
}

/**
 * A reprinted figure is shown this long after its article. United's own
 * figure moved by up to five points between two reprints a day apart; months
 * on, with dozens more aircraft fitted, it would only mislead.
 */
export const HUB_FIGURE_MAX_AGE_DAYS = 90;

const HUB_FIGURES: Readonly<Record<string, HubFigures>> = {
  UA: {
    by: "United",
    reported: "2026-11-13",
    source: {
      name: "Travel And Tour World",
      url: "https://www.travelandtourworld.com/news/article/7r572726gd75/",
    },
    perDay: { ORD: 411, DEN: 293, IAH: 246, EWR: 190, IAD: 122, SFO: 117, LAX: 72 },
  },
};

/** The airline's hub figures while they are recent enough to show, else null. */
export function hubFigures(airline: string, nowSec = unixNow()): HubFigures | null {
  const figures = HUB_FIGURES[airline];
  if (!figures) return null;
  const reportedSec = Date.parse(`${figures.reported}T00:00:00Z`) / 1000;
  return nowSec - reportedSec <= HUB_FIGURE_MAX_AGE_DAYS * DAY_SEC ? figures : null;
}
