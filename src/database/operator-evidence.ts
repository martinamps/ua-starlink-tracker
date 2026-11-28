import type { Database } from "bun:sqlite";

/**
 * Who flies a regional jet, read from the tail's own scheduled legs rather
 * than the community sheet's "Operated By" cell, which stays wrong until a
 * volunteer edits it (N85340 moved from Mesa to Republic on 29 Nov 2026 with
 * the sheet still saying Mesa). Each leg's stored code is the operating
 * carrier's (SKW5212, OO5212) or United's own (UA5212, UAL6029); United's
 * says nothing about which regional flies it, so it is passed over, and the
 * remaining legs must all name one carrier. Anything else keeps the sheet.
 */
const EXPRESS_CARRIERS: ReadonlyArray<{ key: string; codes: readonly string[]; label: string }> = [
  { key: "skywest", codes: ["OO", "SKW"], label: "SkyWest dba UAX" },
  { key: "republic", codes: ["YX", "RPA"], label: "Republic dba UAX" },
  { key: "mesa", codes: ["YV", "ASH"], label: "Mesa dba UAX" },
  { key: "gojet", codes: ["G7", "GJS"], label: "GoJet dba UAX" },
];
const MARKETING_CODES: ReadonlySet<string> = new Set(["UA", "UAL"]);
const CARRIER_BY_CODE = new Map(EXPRESS_CARRIERS.flatMap((c) => c.codes.map((code) => [code, c])));

/** Legs one carrier must fly, in the window, before the sheet is overruled:
 * one leg can be a same-day swap. */
export const MIN_OPERATOR_LEGS = 2;
const WINDOW_BEHIND_SEC = 6 * 3600;
const WINDOW_AHEAD_SEC = 48 * 3600;

function carrierCode(flightNumber: string): string | null {
  const fn = flightNumber.trim().toUpperCase();
  return /^([A-Z]{3})\d/.exec(fn)?.[1] ?? /^([A-Z0-9]{2})\d/.exec(fn)?.[1] ?? null;
}

/** The regional carrier a stored operator names ("Skywest dba UAX",
 * "SkyWest floater" → skywest), or null for United itself or anything else. */
export function expressCarrierKey(operatedBy: string | null): string | null {
  const first = operatedBy?.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return EXPRESS_CARRIERS.find((c) => c.key === first)?.key ?? null;
}

/** The one Express carrier every operating-coded leg names, or null when the
 * legs disagree, carry a code we can't place, or are too few. */
export function expressOperatorFromLegs(
  flightNumbers: readonly string[]
): { key: string; label: string } | null {
  let carrier: (typeof EXPRESS_CARRIERS)[number] | null = null;
  let legs = 0;
  for (const fn of flightNumbers) {
    const code = carrierCode(fn);
    if (!code) return null;
    if (MARKETING_CODES.has(code)) continue;
    const c = CARRIER_BY_CODE.get(code);
    if (!c || (carrier && c !== carrier)) return null;
    carrier = c;
    legs++;
  }
  return carrier && legs >= MIN_OPERATOR_LEGS ? { key: carrier.key, label: carrier.label } : null;
}

export interface OperatorOverride {
  tail: string;
  from: string;
  to: string;
}

/**
 * Relabels United Express listings whose scheduled legs all name another
 * regional carrier. Only a listing that already names a regional is touched,
 * so a mainline or unlabelled row is never moved. Runs inside the sheet
 * write, after the sheet's rows land, so the next hourly read recomputes it
 * from scratch: once the legs stop agreeing the sheet's value is back.
 */
export function applyExpressOperatorsFromFlights(
  db: Database,
  now: number = Math.floor(Date.now() / 1000)
): OperatorOverride[] {
  const rows = db
    .query(
      `SELECT sp.TailNumber AS tail, sp.OperatedBy AS operated_by,
              group_concat(u.flight_number, char(31)) AS legs
       FROM starlink_planes sp
       JOIN upcoming_flights u ON u.tail_number = sp.TailNumber AND u.airline = 'UA'
       WHERE sp.airline = 'UA' AND u.flight_number IS NOT NULL
         AND u.departure_time BETWEEN ?1 AND ?2
       GROUP BY sp.TailNumber, sp.OperatedBy`
    )
    .all(now - WINDOW_BEHIND_SEC, now + WINDOW_AHEAD_SEC) as {
    tail: string;
    operated_by: string | null;
    legs: string;
  }[];

  const update = db.query(
    "UPDATE starlink_planes SET OperatedBy = ? WHERE TailNumber = ? AND airline = 'UA'"
  );
  const overrides: OperatorOverride[] = [];
  for (const r of rows) {
    const stored = expressCarrierKey(r.operated_by);
    if (!stored || !r.operated_by) continue;
    const flown = expressOperatorFromLegs(r.legs.split("\u001f"));
    if (!flown || flown.key === stored) continue;
    update.run(flown.label, r.tail);
    overrides.push({ tail: r.tail, from: r.operated_by, to: flown.label });
  }
  return overrides;
}

/** Registrants that name the carrier flying an Alaska regional jet. The
 * register is refreshed daily (faa_registry); a bank or lessor names nobody. */
const ALASKA_OPERATOR_BY_REGISTRANT: ReadonlyArray<{ re: RegExp; name: string }> = [
  { re: /^HORIZON AIR\b/, name: "Horizon Air" },
  { re: /^SKY ?WEST AIRLINES\b/, name: "SkyWest Airlines" },
];

export function alaskaOperatorFromRegistrant(registrant: string | null): string | null {
  const r = registrant?.trim().toUpperCase() ?? "";
  return ALASKA_OPERATOR_BY_REGISTRANT.find((o) => o.re.test(r))?.name ?? null;
}

export function faaRegistrant(db: Database, tail: string): string | null {
  const row = db.query("SELECT registrant FROM faa_registry WHERE tail_number = ?").get(tail) as {
    registrant: string | null;
  } | null;
  return row?.registrant ?? null;
}
