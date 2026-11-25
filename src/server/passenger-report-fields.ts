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

/** The portal the automatic check tries, as a visitor would recognise it. */
export const ONBOARD_PORTAL_HOST = "onboard.united.com";
/** The three answers the automatic check can send, in the page's words; the
 * keys are the outcomes PROBE_SNIPPET posts. */
export const ONBOARD_CHECK_OUTCOMES = {
  onboard_reachable: "reached",
  onboard_unreachable: "not reached",
  timeout: "no answer within four seconds",
} as const;

/**
 * What the automatic check (PROBE_SNIPPET) does, for the methodology page. It
 * asks the visitor nothing, so unlike the banner it has no place of its own to
 * say so. tests/passenger-detect.test.ts holds these sentences to the snippet
 * and to the row a check leaves.
 */
export const ONBOARD_CHECK_NOTICE = {
  when: "If your connection's address is in Starlink's published address list, each page of this site runs one automatic check when it loads. That list covers Starlink on aircraft and Starlink at home alike. Visitors on any other connection never get the check.",
  what: `Your browser tries to reach United's onboard Wi-Fi portal (${ONBOARD_PORTAL_HOST}), to see whether you are on a United aircraft. It sends no cookies and no sign-in, and reads nothing back. It then tells our server one of three things: ${Object.values(ONBOARD_CHECK_OUTCOMES).join(", ")}.`,
  kept: `We keep ${TIME}, that result, and ${IN_RANGE}. To block repeat results we also keep ${DEDUPE_KEY}, and erase it within a day. The check sends no flight number, and the stored result holds no address and no browser details.`,
  use: "Results are counted and stored. They do not change any aircraft's status on this site.",
  banner:
    "On the home page the same visitors see a box that asks for their flight number. It sends nothing unless you fill it in, and it says what a report stores.",
} as const;
