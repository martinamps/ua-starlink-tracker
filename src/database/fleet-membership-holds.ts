import type { Database } from "bun:sqlite";

/** Proposed membership hold, subject to upstream owner review. An N-number
 * can be reassigned; release requires new identity/admission evidence, not a
 * timer, a type guess, or a spelling substitution. */
export const UA_N63571_HOLD = Object.freeze({
  id: "UA-N63571-2026-10-17",
  airline: "UA",
  tail: "N63571",
  evidenceDate: "2026-10-17",
  evidenceUrl: "https://registry.faa.gov/aircraftinquiry/Search/NNumberResult?NNumberTxt=63571",
  issueUrl: "https://github.com/martinamps/ua-starlink-tracker/issues/168",
  reason: "FAA identifies Aerostar RX 8 balloon, serial RX8-3127; UA membership needs correction",
});

export function isMembershipHeld(airline: string, tail: string): boolean {
  return (
    airline.trim().toUpperCase() === UA_N63571_HOLD.airline &&
    tail.trim().toUpperCase() === UA_N63571_HOLD.tail
  );
}

// SQLite trim() defaults to ASCII space, unlike JS trim(). The same alias
// must be held in incoming data and stored rows, before a destructive scrape.
const whitespace =
  "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
export function heldUaMembershipSql(tailColumn: "tail_number" | "TailNumber"): string {
  return `upper(trim(airline, ${whitespace})) = 'UA' AND ${heldTailSql(tailColumn)}`;
}
export function heldTailSql(tailColumn: "tail_number" | "TailNumber"): string {
  return `upper(trim(${tailColumn}, ${whitespace})) = 'N63571'`;
}

/** A scrape must not erase the evidence before the explicit archived repair. */
export function hasHeldUaMembership(db: Database, airline: string): boolean {
  if (airline.trim().toUpperCase() !== "UA") return false;
  return Boolean(
    db
      .query(`SELECT 1 FROM united_fleet WHERE ${heldUaMembershipSql("tail_number")}
      UNION ALL SELECT 1 FROM starlink_planes WHERE ${heldUaMembershipSql("TailNumber")} LIMIT 1`)
      .get()
  );
}
