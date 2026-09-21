/**
 * The one definition of "this tail has Starlink", as a SQL predicate and its
 * JS twin. Headline counts, /fleet families, type pages, hub cards, the verdict
 * engine and the assignment log all read it from here; tests/equipped.test.ts
 * pins the two forms to each other.
 *
 * The evidence, strongest first:
 *  1. united_fleet settled the tail 'negative' — the verifier's own
 *     observation. Outranks any listing, whatever it says.
 *  2. starlink_planes.verified_wifi names another provider: listed, then
 *     observed on something else.
 *  3. starlink_planes.verified_wifi = 'Starlink': listed and observed.
 *  4. listed (sheet, discovery, type rule, community guide), not yet observed.
 *  5. not listed, but united_fleet says 'confirmed' (a settle the listing
 *     hasn't caught up with). Evidence, not equipped: every count starts
 *     from the listing.
 * Equipped = 3 or 4.
 */

import type { StarlinkStatus } from "../../types";

export type TailEvidence =
  | "settled_negative"
  | "verified_other"
  | "verified"
  | "listed"
  | "fleet_confirmed"
  | "unknown";

export interface TailEvidenceInput {
  /** The tail's starlink_planes row, or null when it isn't listed. */
  listed: { verified_wifi: string | null } | null;
  /** The tail's united_fleet row, or null when it isn't on the roster. */
  fleet: { starlink_status: string | null } | null;
}

export function tailEvidence({ listed, fleet }: TailEvidenceInput): TailEvidence {
  if (fleet?.starlink_status === "negative") return "settled_negative";
  if (listed) {
    if (listed.verified_wifi === null) return "listed";
    return listed.verified_wifi === "Starlink" ? "verified" : "verified_other";
  }
  return fleet?.starlink_status === "confirmed" ? "fleet_confirmed" : "unknown";
}

export function isEquipped(e: TailEvidence): boolean {
  return e === "verified" || e === "listed";
}

/**
 * The assignment log's 1/0/null: any positive evidence is 1, any negative 0,
 * null when the tail is in neither table.
 */
export function starlinkFlag(e: TailEvidence): 1 | 0 | null {
  if (e === "unknown") return null;
  return e === "settled_negative" || e === "verified_other" ? 0 : 1;
}

/** united_fleet status that a starlink_planes verified_wifi implies (null = unverified). */
export function fleetStatusFromWifi(verifiedWifi: string | null): StarlinkStatus {
  if (verifiedWifi === null) return "unknown";
  return verifiedWifi === "Starlink" ? "confirmed" : "negative";
}

// equippedSql's own alias for the settle probe, so it never collides with a
// caller's uf/united_fleet alias.
const NEG = "_neg";

/**
 * SQL: the starlink_planes row aliased `sp` is equipped (evidence 3 or 4).
 * Correlated on the tail, so it embeds anywhere `sp` is in scope.
 */
export function equippedSql(sp: string): string {
  return `(${sp}.verified_wifi IS NULL OR ${sp}.verified_wifi = 'Starlink')
    AND NOT EXISTS (
      SELECT 1 FROM united_fleet ${NEG}
      WHERE ${NEG}.tail_number = ${sp}.TailNumber AND ${NEG}.starlink_status = 'negative'
    )`;
}

/** SQL: equipped and observed on Starlink (evidence 3), the "verified" tier. */
export function verifiedEquippedSql(sp: string): string {
  return `${sp}.verified_wifi = 'Starlink' AND ${equippedSql(sp)}`;
}

/** SQL: the tail in `tailExpr` has an equipped listing (under `airlineExpr`, when given). */
export function tailEquippedSql(tailExpr: string, airlineExpr?: string): string {
  const scope = airlineExpr ? ` AND _eq.airline = ${airlineExpr}` : "";
  return `EXISTS (
    SELECT 1 FROM starlink_planes _eq
    WHERE _eq.TailNumber = ${tailExpr}${scope} AND ${equippedSql("_eq")}
  )`;
}

/**
 * LEFT JOIN of the negative settle, for readers that return evidence columns
 * (settled_negative, settled_wifi) rather than filter on them.
 */
export function settledNegativeJoin(alias: string, tailExpr: string): string {
  return `LEFT JOIN united_fleet ${alias}
    ON ${alias}.tail_number = ${tailExpr} AND ${alias}.starlink_status = 'negative'`;
}

/**
 * JS twin for rows that carry the evidence columns (settled_negative, the
 * listing's verified_wifi) from an INNER JOIN on the listing, as
 * getFlightAssignments returns them. Departure slots LEFT JOIN the listing and
 * carry `equipped` itself.
 */
export function rowEvidence(r: {
  settled_negative: number;
  verified_wifi: string | null;
}): TailEvidence {
  return tailEvidence({
    listed: { verified_wifi: r.verified_wifi },
    fleet: r.settled_negative ? { starlink_status: "negative" } : null,
  });
}

/** The provider that contradicts a non-equipped row, when anything names one. */
export function contradictingWifi(r: {
  settled_negative: number;
  settled_wifi: string | null;
  verified_wifi: string | null;
}): string | null {
  return r.settled_negative ? r.settled_wifi : r.verified_wifi;
}
