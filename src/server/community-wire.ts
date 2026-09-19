/**
 * Wire fields for community-source carriers (AF) on /api/check-any-flight and
 * the hub /api/check-flight — one builder so the two routes can't drift.
 *
 * All additive and top-level. Deliberately no `probability` and no
 * `prediction`: a per-type share is not a per-flight probability, and the
 * extension badges any numeric `probability`.
 */

import type { TypeProgress } from "../database/database";
import type { CarrierPrediction } from "../scripts/starlink-predictor";

/** Bounded free text: a booking's type string ("Boeing 777-300ER"). Anything
 * else is ignored rather than rejected, so a bad value can't break a lookup. */
const AIRCRAFT_TYPE_PARAM = /^[A-Za-z0-9 ()-]{1,40}$/;

export function aircraftTypeParam(url: URL): string | null {
  const raw = url.searchParams.get("aircraft_type")?.trim();
  return raw && AIRCRAFT_TYPE_PARAM.test(raw) ? raw : null;
}

export type TypeStatus = "in_progress" | "not_started" | "complete" | "retiring";

export function typeStatus(t: TypeProgress): TypeStatus {
  if (t.excluded) return "retiring";
  if (t.equipped === 0) return "not_started";
  return t.equipped === t.total ? "complete" : "in_progress";
}

function byType(types: readonly TypeProgress[]) {
  return types.map((t) => ({
    type: t.key,
    label: t.label,
    equipped: t.equipped,
    total: t.total,
    not_in_guide: t.notInGuide,
    status: typeStatus(t),
  }));
}

const GUIDE_STATUS = {
  starlink: "starlink_listed",
  legacy: "legacy_wifi",
  none: "no_wifi_listed",
} as const;

export function communityWireFields(answer: CarrierPrediction): Record<string, unknown> {
  switch (answer.kind) {
    case "type_progress":
      return { by_type: byType(answer.types) };
    case "type_rate":
      return {
        type_rate: {
          type: answer.type.key,
          label: answer.type.label,
          equipped: answer.type.equipped,
          total: answer.type.total,
          share: answer.share,
        },
        by_type: byType(answer.types),
      };
    case "assigned_unconfirmed":
      return {
        assignment: {
          tail_number: answer.tail,
          aircraft_type: answer.aircraftType,
          guide_status: answer.mark ? GUIDE_STATUS[answer.mark] : "not_in_guide",
        },
      };
    case "partner_operated":
      return { assignment: { tail_number: answer.tail, operated_by_other: true } };
    default:
      return {};
  }
}
