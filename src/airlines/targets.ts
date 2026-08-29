/**
 * Publicly stated Starlink rollout targets, per airline, with sources.
 * The Install Rate Index measures observed pace against these — every target
 * must cite where the airline said it, so the page stays quotable by press.
 *
 * Record<KnownAirlineCode, …> so a newly registered airline is a compile
 * error here until someone decides its target story (empty array = no stated
 * forward target, e.g. a completed rollout).
 */

import type { KnownAirlineCode } from "./registry";

export interface RolloutTargetDef {
  /** What the airline committed to, in its own terms. */
  label: string;
  /** Deadline the statement names (YYYY-MM-DD, end of the stated period). */
  deadline: string;
  /** Absolute aircraft count, when the statement gives one. */
  count?: number;
  /** Target as a share of the fleet this tracker counts (0–1), when the
   * statement is relative ("half the fleet", "all aircraft"). Resolved
   * against the live tracked total at render time. */
  fractionOfTracked?: number;
  source: { title: string; url: string };
}

const UA_SOURCE = {
  title: "United Airlines newsroom — Starlink rollout announcement",
  url: "https://www.united.com/en/us/newsroom/announcements/cision-125370",
};

const AS_SOURCE = {
  title: "Alaska Airlines newsroom — free Starlink WiFi announcement",
  url: "https://news.alaskaair.com/company/alaska-airlines-and-hawaiian-airlines-to-offer-free-starlink-wi-fi/",
};

const QR_SOURCE = {
  title: "Qatar Airways press release — 787 Starlink launch",
  url: "https://www.qatarairways.com/press-releases/en-WW/259315-qatar-airways-launches-world-s-first-starlink-equipped-boeing-787-and-completes-airbus-a350-starlink-rollout-connecting-over-11-millio/",
};

// Southwest has also stated a target (300+ aircraft by end of 2026) but is
// not a tracked airline here — no observed install data exists to measure it
// against, so it deliberately has no entry until it becomes a tenant.
const ROLLOUT_TARGETS: Record<KnownAirlineCode, RolloutTargetDef[]> = {
  UA: [
    {
      label: "Close to 1,000 aircraft equipped",
      deadline: "2026-12-31",
      count: 1000,
      source: UA_SOURCE,
    },
    {
      label: "Entire fleet equipped",
      deadline: "2027-12-31",
      fractionOfTracked: 1,
      source: UA_SOURCE,
    },
  ],
  // Rollout complete since September 2024 — nothing left to project.
  HA: [],
  AS: [
    {
      label: "About half the combined Alaska/Hawaiian fleet",
      deadline: "2026-12-31",
      fractionOfTracked: 0.5,
      source: AS_SOURCE,
    },
    {
      label: "Entire fleet equipped",
      deadline: "2027-12-31",
      fractionOfTracked: 1,
      source: AS_SOURCE,
    },
  ],
  QR: [
    {
      label: "All in-scope aircraft (777/A350 done; 787 fleet completes the program)",
      deadline: "2026-12-31",
      fractionOfTracked: 1,
      source: QR_SOURCE,
    },
  ],
};

/** Fail-closed lookup: an airline missing here is a programming error, never
 * an empty answer (the tenant-default bug class). [] means "no forward
 * target" and is a deliberate entry, not an absence. */
export function rolloutTargets(code: string): RolloutTargetDef[] {
  const targets = (ROLLOUT_TARGETS as Record<string, RolloutTargetDef[]>)[code];
  if (targets === undefined) {
    throw new Error(`no rollout-target entry for airline ${code} — add one to ROLLOUT_TARGETS`);
  }
  return targets;
}
