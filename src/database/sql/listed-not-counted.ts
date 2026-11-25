/**
 * The one rule for "the community sheet lists this tail with Starlink and we
 * don't count it", and why. The complement of equipped.ts over independent
 * listings: every such listing is either equipped, here with a reason, or a
 * regional flap (below), so no sheet-listed tail can sit on neither public
 * list. /api/mismatches, the newly-equipped panel and feed, the /fleet mark
 * and the tail pages all read it through getListedNotCounted.
 *
 * Nothing here feeds a count: a row exists only when no listing of the tail
 * satisfies equippedSql.
 */

import { equippedSql, tailEquippedSql } from "./equipped";
import { sheetSaysStarlink } from "./fragments";

export type UncountedReason =
  /** No verdict of ours stands on the listing: never read since it appeared, or too few reads. */
  | "awaiting_check"
  /** Our check reads a named other provider. */
  | "other_provider"
  /** Our check reads no Wi-Fi, and has never read Starlink on the tail. */
  | "no_wifi";

/** A Starlink listing we didn't derive ourselves: not discovery, not a type rule. */
export function independentListingSql(sp = ""): string {
  const col = (name: string) => (sp ? `${sp}.${name}` : name);
  return `COALESCE(${col("sheet_gid")}, '') NOT IN ('discovery', 'type_deterministic')
  AND ${sheetSaysStarlink(col("wifi"))}`;
}

/**
 * SQL over starlink_verification_log (unqualified columns): a clean Starlink
 * read of the tail on united.com. The consensus's own flap line: united.com
 * flips regional jets between Starlink and "not offered", and in the Aug-2026
 * log every one of 34 runs of 3+ "None" after a Starlink read went back to
 * Starlink, while tails with no Starlink read kept "None" for good (N786SK,
 * 20 of 20). So "no Wi-Fi" is lasting exactly when this matches no row.
 */
export const UNITED_STARLINK_READ_WHERE = `tail_confirmed = 1 AND has_starlink = 1
  AND source = 'united' AND error IS NULL`;

/** SQL: the starlink_planes row aliased `sp` is an independent listing of a tail no listing equips. */
export function listedNotCountedSql(sp: string): string {
  return `${independentListingSql(sp)}
    AND NOT (${equippedSql(sp)})
    AND NOT ${tailEquippedSql(`${sp}.TailNumber`, `${sp}.airline`)}`;
}

const isNoWifi = (wifi: string) => /^none$/i.test(wifi.trim());

export interface UncountedInput {
  /** The listing's own verdict (starlink_planes.verified_wifi). */
  listingWifi: string | null;
  /** The roster's reading when it settled the tail 'negative', else null. */
  settledWifi: string | null;
  /** A row matches UNITED_STARLINK_READ_WHERE. */
  everReadStarlink: boolean;
}

/**
 * Why a listed, uncounted tail is uncounted; null for the regional flap, which
 * stays off every list. The reading that stands is the listing's own verdict;
 * a listing that reads Starlink under a negative settle defers to the settle,
 * as tailEvidence does. A listing with no verdict is awaiting our check even
 * when the roster holds an older "not Starlink": that reading predates the
 * listing or has aged out, and says nothing about the install the sheet reports.
 */
export function uncountedReason(i: UncountedInput): {
  reason: UncountedReason;
  observedWifi: string | null;
} | null {
  const flap = (wifi: string | null) => !!wifi && isNoWifi(wifi) && i.everReadStarlink;
  if (i.listingWifi === null) {
    return flap(i.settledWifi) ? null : { reason: "awaiting_check", observedWifi: null };
  }
  const standing = i.listingWifi === "Starlink" ? i.settledWifi : i.listingWifi;
  if (!standing || standing === "Starlink") return { reason: "awaiting_check", observedWifi: null };
  if (isNoWifi(standing)) {
    return flap(standing) ? null : { reason: "no_wifi", observedWifi: standing };
  }
  return { reason: "other_provider", observedWifi: standing };
}
