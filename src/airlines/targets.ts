/**
 * Publicly stated Starlink rollout targets, per airline, with sources.
 * The Install Rate Index measures observed pace against these — every target
 * must cite where the airline said it AND when it said it, so the page stays
 * quotable by press and a reader can tell current guidance from an old
 * statement.
 *
 * Sourcing rules, learned the hard way (the hub once published a "half the
 * fleet by end-2026" figure attributed to an Alaska URL that 404s, for a claim
 * that page never contained):
 *
 *  - One target, one source. Two claims sharing a generic newsroom link is
 *    indistinguishable from a claim with no source at all.
 *  - Only cite a document that has been read end-to-end and verified to
 *    contain the claim. Where the airline's own newsroom blocks automated
 *    reading, prefer its SEC filings: 8-K earnings exhibits carry the same
 *    sentences, are permanently archived, and are machine-verifiable.
 *  - No verifiable source, no target. An empty array is a deliberate,
 *    documented entry, not an oversight.
 *
 * Record<KnownAirlineCode, …> so a newly registered airline is a compile
 * error here until someone decides its target story.
 */

import { error as logError } from "../utils/logger";
import type { KnownAirlineCode } from "./registry";

export interface RolloutTargetDef {
  /** What the airline committed to, in its own terms. */
  label: string;
  /** Deadline the statement names (YYYY-MM-DD, end of the stated period). */
  deadline: string;
  /** Absolute aircraft count, when the statement gives one. Only ever the
   * airline's own figure — never arithmetic of ours. */
  count?: number;
  /** Target as a share of the fleet this tracker counts (0–1), when the
   * statement is relative ("half the fleet", "all aircraft"). Resolved
   * against the live tracked total at render time. The resulting count is
   * OURS, not the airline's, and the page must label it as such. */
  fractionOfTracked?: number;
  /** Airline codes the fraction spans, when the statement covers more than the
   * tenant reading it — Alaska's "combined Alaska/Hawaiian fleet" is half of
   * AS+HA, and an AS-scoped reader alone would silently publish half of AS. */
  fractionSpans?: readonly KnownAirlineCode[];
  /** Date the airline made THIS statement (YYYY-MM-DD). Rendered next to the
   * source: a target is only as current as the statement behind it, and a
   * reader has no way to tell a fresh commitment from a stale one otherwise. */
  statedOn: string;
  source: { title: string; url: string };
}

// United's own newsroom (united.com/…/announcements/cision-*) blocks automated
// fetching outright, so its content cannot be verified from here — and one
// undated link was standing for both targets below. These are the same
// sentences, in United's 8-K earnings exhibits, permanently archived on EDGAR.
const UA_Q2_2026 = {
  title: "United Airlines Q2 2026 earnings release (SEC Form 8-K, Ex-99.1, July 15, 2026)",
  url: "https://www.sec.gov/Archives/edgar/data/100517/000010051726000135/ual_erx06302026xex991.htm",
};
const UA_Q1_2026 = {
  title: "United Airlines Q1 2026 earnings release (SEC Form 8-K, Ex-99.1, April 21, 2026)",
  url: "https://www.sec.gov/Archives/edgar/data/100517/000010051726000089/ual_erx03312026xex991.htm",
};

const AS_LAUNCH = {
  title: "Alaska Airlines newsroom — Starlink selection announcement (August 20, 2025)",
  url: "https://news.alaskaair.com/guest-experience/alaska-airlines-to-launch-new-era-of-inflight-connectivity/",
};
// The half-by-end-2026 split is NOT in the Starlink announcement above, nor in
// the Q4 2025 earnings press release — it lives in Air Group's quarterly
// supplemental decks, which restate it each quarter against a current count.
const AS_Q2_2026_SUPPLEMENTAL = {
  title: "Alaska Air Group Q2 2026 supplemental information (SEC Form 8-K, Ex-99.2, July 21, 2026)",
  url: "https://www.sec.gov/Archives/edgar/data/766421/000076642126000036/alksupplemental2q26.htm",
};

// Southwest has also stated a target (300+ aircraft by end of 2026) but is
// not a tracked airline here — no observed install data exists to measure it
// against, so it deliberately has no entry until it becomes a tenant.
const ROLLOUT_TARGETS: Record<KnownAirlineCode, RolloutTargetDef[]> = {
  UA: [
    {
      // "…450 aircraft installed and nearly 1,000 expected by year end."
      label: "Close to 1,000 aircraft equipped",
      deadline: "2026-12-31",
      count: 1000,
      statedOn: "2026-07-15",
      source: UA_Q2_2026,
    },
    {
      // "Starlink installations expected fleet-wide by the end of 2027."
      label: "Entire fleet equipped",
      deadline: "2027-12-31",
      fractionOfTracked: 1,
      statedOn: "2026-04-21",
      source: UA_Q1_2026,
    },
  ],
  // Rollout complete since September 2024 — nothing left to project.
  HA: [],
  AS: [
    {
      // "1/3 of fleet (134 aircraft) now retrofitted with Starlink Wi-Fi, 50%
      // expected by YE" — Air Group fleet, i.e. Alaska + Horizon + Hawaiian.
      label: "About half the combined Alaska/Hawaiian fleet",
      deadline: "2026-12-31",
      fractionOfTracked: 0.5,
      // Alaska stated the share, not a count, and stated it over the merged
      // Alaska + Hawaiian fleet — so the denominator has to span both tenants.
      // Resolving 0.5 against the AS reader alone published "175 aircraft"
      // under Alaska's byline, a number Alaska never said.
      fractionSpans: ["AS", "HA"],
      statedOn: "2026-07-21",
      source: AS_Q2_2026_SUPPLEMENTAL,
    },
    {
      // "Alaska will start offering Starlink in 2026 and bring the technology
      // to its entire fleet by 2027."
      label: "Entire fleet equipped",
      deadline: "2027-12-31",
      fractionOfTracked: 1,
      statedOn: "2025-08-20",
      source: AS_LAUNCH,
    },
  ],
  // Qatar Airways has stated a 787 completion target, but its only public
  // source is a qatarairways.com press release that returns 403 to every
  // automated client — it cannot be read, so it cannot be cited, so there is
  // nothing here to publish. QR's /install-rate page is off for its own
  // reasons (bulk type-settled statuses, no dated install history), so this
  // costs no surface today. Restore it with a source someone has actually
  // read, and a statedOn date.
  QR: [],
};

/**
 * Targets for an airline. Returns [] for a code with no entry rather than
 * throwing: this runs from the footer nav on every page of every tenant, so a
 * throw here would 500 the whole site instead of degrading one page. The real
 * invariant — every registered airline has a decided entry — is a compile
 * error via Record<KnownAirlineCode, …> and is asserted in the tests; a
 * runtime miss is logged so it cannot pass silently.
 */
export function rolloutTargets(code: string): RolloutTargetDef[] {
  const targets = (ROLLOUT_TARGETS as Record<string, RolloutTargetDef[]>)[code];
  if (targets === undefined) {
    logError(`no rollout-target entry for airline ${code} — add one to ROLLOUT_TARGETS`);
    return [];
  }
  return targets;
}

/** Codes with a decided entry — the set the config tests assert over. */
export function airlinesWithTargetEntry(): string[] {
  return Object.keys(ROLLOUT_TARGETS);
}
