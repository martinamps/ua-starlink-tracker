/**
 * Gate for united_fleet membership. Every fleet writer (FR24 sync, sheet
 * sync, seeds) asks here before inserting, so a scraper regression can't put
 * junk into a denominator: on 2026-11-05 an FR24 redesign turned type names
 * ("Boeing 757-224") into tails, and an untyped sheet tail (N63571) turned
 * out to be a hot-air balloon.
 */

import type { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability/metrics";
import { warn } from "../utils/logger";

export type FleetRejectReason = "invalid_registration" | "non_airliner";

// FAA make/model strings for every type an airline we track flies. The FAA
// file names makers by legal entity, so Embraer E175s read "YABORA INDUSTRIA
// AERONAUTICA S ERJ 170-200 LL" and CRJ-550s "MHI RJ AVIATION ULC CL-600-2C10";
// the model designators catch the next renamed entity.
const AIRLINER_MAKER =
  /\b(BOEING|AIRBUS|EMBRAER|YABORA|BOMBARDIER|CANADAIR|MITSUBISHI|MHI RJ|DE ?HAVILLAND|ATR|AVIONS DE TRANSPORT|MCDONNELL|ERJ|CL-600|DHC-8)/i;

export function isAirlinerModel(faaModel: string): boolean {
  return AIRLINER_MAKER.test(faaModel);
}

function faaModel(db: Database, tail: string): string | null {
  try {
    const row = db.query("SELECT faa_model FROM faa_registry WHERE tail_number = ?").get(tail) as {
      faa_model: string | null;
    } | null;
    return row?.faa_model?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Why `tail` may not join `airline`'s fleet, or null when it may. The FAA
 * check only applies to an untyped newcomer: a typed tail already carries
 * its own evidence, and a tail missing from the FAA file proves nothing.
 */
export function fleetRejectReason(
  db: Database,
  airline: string,
  tail: string,
  opts: { aircraftType: string | null; isNew: boolean }
): FleetRejectReason | null {
  const pattern = AIRLINES[airline as keyof typeof AIRLINES]?.tailPattern;
  if (!pattern || !pattern.test(tail)) return "invalid_registration";
  if (opts.isNew && !opts.aircraftType) {
    const model = faaModel(db, tail);
    if (model && !isAirlinerModel(model)) return "non_airliner";
  }
  return null;
}

const warned = new Set<string>();

/** Count a refused row; warn once per tail per process so an hourly writer
 * can't flood the log with the same refusal. */
export function recordFleetRejection(
  airline: string,
  tail: string,
  source: string,
  reason: FleetRejectReason
): void {
  metrics.increment(COUNTERS.FLEET_ROW_REJECTED, {
    airline: normalizeAirlineTag(airline),
    source,
    reason,
  });
  const key = `${airline}:${tail}:${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  warn(`fleet: refused ${airline} ${JSON.stringify(tail)} from ${source} (${reason})`);
}
