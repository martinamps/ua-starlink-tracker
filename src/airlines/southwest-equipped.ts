/**
 * Southwest equipped-tails source of truth.
 *
 * Southwest exposes no first-party per-tail WiFi oracle, and its tail
 * assignments settle too late (~1h before departure) to observe installs
 * through a per-flight verifier loop the way UA/AS are tracked. Until an
 * automated discovery job exists, this curated log IS the evidence base for
 * "which Southwest 737s have Starlink": one record per tail, each carrying
 * the date the install was publicly evidenced and a note saying what proved
 * it. Records here are per-tail observations ("observed" evidence tier),
 * never program-wide type rules — Southwest's whole fleet is one 737 family,
 * so type can never decide status.
 *
 * Provider-aware by design: Southwest has committed Starlink for 300+ of its
 * ~800 737s and has named no provider for the rest, so a record states its
 * provider instead of assuming Starlink. The tenant is a Southwest WiFi
 * tracker in its bones; Starlink is the first provider, not an assumption.
 * (No second vendor is named here on purpose — the LEO-aviation deals in the
 * news belong to other carriers, and attributing one to Southwest would be
 * exactly the fabrication this log exists to prevent.)
 *
 * Contract for a future automated-discovery job (and for hand edits):
 *  - `tail` must match AIRLINES.WN.tailPattern (FAA N-number) and appear at
 *    most once; validateSouthwestEquipped() enforces both and the seed script
 *    refuses to write on any violation.
 *  - `equippedOn` is the date of the earliest public evidence (first revenue
 *    flight, credible spotter report), ISO YYYY-MM-DD. It feeds DateFound, so
 *    install-pace surfaces stay honest — a discovery job must never stamp its
 *    own run date across a batch (the rollout-cliff fabrication class).
 *  - `evidence` says what proved it, specifically enough to re-check.
 *  - Appending records is the only supported mutation; the seed script
 *    (src/scripts/seed-southwest.ts) is idempotent, so re-running it after an
 *    append settles only the new tails. A discovery job that wants to write
 *    the DB directly should instead reuse applySouthwestEquipped() there.
 */

import { AIRLINES } from "./registry";

/** Wifi-provider keyspace for Southwest installs. Extend when a second vendor
 * is actually observed on a tail — never speculatively. */
export type SouthwestWifiProvider = "Starlink";

export interface SouthwestEquippedTail {
  tail: string;
  aircraftType: string;
  provider: SouthwestWifiProvider;
  /** Earliest public evidence of the install, ISO YYYY-MM-DD. */
  equippedOn: string;
  /** What proved it — precise enough for a reader to re-verify. */
  evidence: string;
  /** Where a reader can check it. Rendered next to the note on /methodology,
   * so the log is citable rather than a claim about a claim. */
  evidenceUrl?: string;
}

export const SOUTHWEST_EQUIPPED_TAILS: readonly SouthwestEquippedTail[] = [
  {
    tail: "N8543Z",
    aircraftType: "Boeing 737-800",
    provider: "Starlink",
    equippedOn: "2026-06-22",
    evidence:
      "Southwest's launch-day newsroom release: first Starlink revenue flight, Dallas Love Field to Albuquerque, June 22, 2026.",
    evidenceUrl:
      "https://www.swamedia.com/news-and-stories/news-release/heart-meets-high-speed-wifi-southwest-airlines-first-starlink-aircraft-takes-fli-MCH6NK6V4NLBFQTGKAE4SVWJRDXQ",
  },
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Human-readable problems with the curated log; empty = valid. Split from
 * the seed script so a future discovery job can pre-validate its appends. */
export function validateSouthwestEquipped(
  records: readonly SouthwestEquippedTail[] = SOUTHWEST_EQUIPPED_TAILS
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!AIRLINES.WN.tailPattern.test(r.tail)) {
      problems.push(`${r.tail}: not a valid FAA registration`);
    }
    if (seen.has(r.tail)) problems.push(`${r.tail}: duplicate record`);
    seen.add(r.tail);
    if (!ISO_DATE_RE.test(r.equippedOn) || Number.isNaN(Date.parse(r.equippedOn))) {
      problems.push(`${r.tail}: equippedOn "${r.equippedOn}" is not an ISO date`);
    }
    if (!r.evidence.trim()) problems.push(`${r.tail}: evidence note is empty`);
    if (!r.aircraftType.trim()) problems.push(`${r.tail}: aircraftType is empty`);
  }
  return problems;
}
