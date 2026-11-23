/**
 * What one banner report leaves in `passenger_reports`, column by column, and
 * the sentence the banner shows about it. The two live together so neither can
 * change alone: tests/passenger-detect.test.ts fails on a column that is not
 * classified here, on a "blank" column that gets written, and on a banner that
 * drops a disclosed phrase.
 */

type ColumnUse =
  /** Named to the visitor, in these words, in the banner's sentence. */
  | { kind: "disclosed"; says: string }
  /** Computed from disclosed columns and our own flight data; nothing new about the visitor. */
  | { kind: "derived"; from: readonly string[] }
  /** The same for every banner report: row id and the two fixed labels. */
  | { kind: "bookkeeping" }
  /** Never written for a banner report. Legacy columns stay in the table (NULL or ""). */
  | { kind: "blank" };

const FLIGHT = "the flight number";
const TIME = "the time";
const IN_RANGE = "that your IP is in Starlink's published range";
const DEDUPE_KEY = "a scrambled code for your network, never the address itself";

export const PASSENGER_REPORT_COLUMNS: Record<string, ColumnUse> = {
  id: { kind: "bookkeeping" },
  source: { kind: "bookkeeping" },
  outcome: { kind: "bookkeeping" },
  claimed_flight: { kind: "disclosed", says: FLIGHT },
  reported_at: { kind: "disclosed", says: TIME },
  in_geofeed: { kind: "disclosed", says: IN_RANGE },
  ip_prefix: { kind: "disclosed", says: DEDUPE_KEY },
  airborne_match: { kind: "derived", from: ["claimed_flight", "reported_at"] },
  // The banner sends neither; the endpoint still accepts them as claims about
  // the aircraft, so they are blank for a banner report rather than removed.
  claimed_tail: { kind: "blank" },
  claimed_date: { kind: "blank" },
  ip: { kind: "blank" },
  router_id: { kind: "blank" },
  ua_hash: { kind: "blank" },
};

/** How long a report blocks a repeat from the same network and source. */
export const DEDUPE_WINDOW_SEC = 6 * 3600;
/** The sweep that blanks expired dedupe keys when no new report does it first. */
export const DEDUPE_KEY_SWEEP_INTERVAL_SEC = 6 * 3600;
/** The promise in the sentence below; the test checks window + sweep fits inside it. */
export const DEDUPE_KEY_MAX_LIFE_SEC = 24 * 3600;

export const PASSENGER_REPORT_PRIVACY_NOTE = `Your report stores only ${FLIGHT}, ${TIME}, and ${IN_RANGE}. To block repeat reports we also keep ${DEDUPE_KEY}, and erase it within a day.`;
