/**
 * Shared FlyerTalk-tail applier. Both ingest paths (direct script and
 * residential-sync) write through here so every confirm batch ends with
 * refreshFleetMeta — public totals move the same day, not at the next daily
 * fleet sync. (lastUpdated ownership still holds: refreshFleetMeta stamps via
 * stampLastUpdated, which no-ops for non-fleet-meta owners like QR.)
 */

import type { Database } from "bun:sqlite";
import {
  addDiscoveredStarlinkPlane,
  refreshFleetMeta,
  upsertFleetAircraft,
} from "../database/database";
import type { FleetSource } from "../types";
import { info } from "../utils/logger";

export function applyFlyertalkTails(
  db: Database,
  tails: string[],
  opts: {
    airline: "AS" | "QR";
    gid: Extract<FleetSource, "flyertalk_as" | "flyertalk_qr">;
    operator: string;
    /** Aircraft type to write when the tail qualifies; null skips the tail. */
    gate: (tail: string) => { aircraftType: string | null } | null;
    gateLabel: string;
  }
): number {
  if (tails.length === 0) return 0;

  let written = 0;
  const tx = db.transaction((rows: string[]) => {
    for (const tail of rows) {
      const hit = opts.gate(tail);
      if (!hit) continue;
      // FlyerTalk tails are individually spotted/flown (community observation,
      // not a type rule) — observation semantics: verified stamps + parking.
      upsertFleetAircraft(
        db,
        tail,
        hit.aircraftType,
        opts.gid,
        "mainline",
        opts.operator,
        opts.airline,
        { starlinkStatus: "confirmed", verifiedWifi: "Starlink", evidence: "observed" }
      );
      addDiscoveredStarlinkPlane(
        db,
        tail,
        hit.aircraftType,
        "Starlink",
        opts.operator,
        "mainline",
        {
          sheetGid: opts.gid,
          airline: opts.airline,
          evidence: "observed",
        }
      );
      written++;
    }
  });
  tx(tails);

  if (written > 0) refreshFleetMeta(db, opts.airline);

  info(
    `FlyerTalk ${opts.airline} sync: ${written}/${tails.length} tails written (${opts.gateLabel})`
  );
  return written;
}
