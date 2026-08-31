/**
 * Share-card path derivation, shared by the nightly generator
 * (scripts/generate-og-images.ts) and the pages that offer the download —
 * one derivation so the writer and the reader can never drift.
 *
 * PNG, not the og cards' webp: the card is handed to users to post, and PNG
 * pastes cleanly everywhere.
 */

import type { AirlineCode } from "../airlines/registry";

export function shareCardFile(scope: AirlineCode | "ALL"): string {
  return `share-card-${scope === "ALL" ? "hub" : scope.toLowerCase()}.png`;
}

export function shareCardPath(scope: AirlineCode | "ALL"): string {
  return `/static/${shareCardFile(scope)}`;
}

/**
 * May a public surface publish the denominator next to the equipped count?
 *
 * One rule for every surface that ships this ratio off-site — /badge.svg and
 * the downloadable share card both did, and disagreed: the badge deliberately
 * dropped the denominator for an out-of-scope roster while the share card
 * published "OF 61 AIRCRAFT HAVE STARLINK" for the same fleet. Two answers to
 * one question is worse than either answer.
 *
 * No, when either is true:
 *  - the roster counts aircraft the programme excludes (HA's 717s, QR's
 *    narrowbodies), so the ratio advertises a finished rollout as two-thirds
 *    done; or
 *  - equipped exceeds total, which is impossible — a live row count against a
 *    separately scraped roster figure, mid-disagreement. The count alone is
 *    still true; the ratio is not.
 */
export function denominatorIsPublishable(
  equipped: number,
  total: number,
  rosterIsProgramScope: boolean
): boolean {
  return rosterIsProgramScope && total > 0 && equipped <= total;
}
