import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getMeta, refreshFleetMeta } from "./database";
import { UA_N63571_HOLD, heldTailSql, heldUaMembershipSql } from "./fleet-membership-holds";
import { programmeRoster } from "./roster";

type Row = Record<string, string | number | null>;
const { airline, tail } = UA_N63571_HOLD;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
const untyped = (value: Row[string]): boolean =>
  value === null || (typeof value === "string" && /^(?:unknown)?$/i.test(value.trim()));

function buildPlan(db: Database) {
  // Normalized lookup detects ambiguous legacy spellings; only exact canonical
  // rows may be removed. Never turn a fuzzy tail match into a rename/delete.
  const fleet = db
    .query(`SELECT * FROM united_fleet
    WHERE ${heldUaMembershipSql("tail_number")} ORDER BY id`)
    .all() as Row[];
  const listings = db
    .query(`SELECT * FROM starlink_planes
    WHERE ${heldUaMembershipSql("TailNumber")} ORDER BY id`)
    .all() as Row[];
  const verification = db
    .query(`SELECT * FROM starlink_verification_log
    WHERE ${heldUaMembershipSql("tail_number")} ORDER BY id`)
    .all() as Row[];
  const flights = db
    .query(`SELECT * FROM upcoming_flights
    WHERE ${heldUaMembershipSql("tail_number")} ORDER BY id`)
    .all() as Row[];
  const departures = db
    .query(`SELECT * FROM departure_log
    WHERE ${heldUaMembershipSql("tail_number")} ORDER BY id`)
    .all() as Row[];
  const firstFlights = db
    .query(`SELECT * FROM first_flights
    WHERE ${heldUaMembershipSql("tail_number")}`)
    .all() as Row[];
  const assignments = db
    .query(`SELECT * FROM flight_assignment_log
    WHERE ${heldUaMembershipSql("tail_number")}
    ORDER BY airline, flight_number, dep_date, departure_airport, tail_number`)
    .all() as Row[];
  // Registrant identity/address is irrelevant to membership and must not be
  // copied into the preview or archive. Missing optional ACFTREF models are
  // explicit nulls, not evidence that the registration is absent.
  const faa = db
    .query(`SELECT tail_number, mode_s_hex, serial, faa_model, faa_status,
    expiration_date, dereg_date, last_refreshed FROM faa_registry
    WHERE ${heldTailSql("tail_number")} ORDER BY tail_number`)
    .all() as Row[];
  const knownModels = new Set([
    "RX8",
    "AEROSTARRX8",
    "AEROSTARINTERNATIONALRX8",
    "AEROSTARINTERNATIONALINCRX8",
  ]);
  if (
    faa.length > 1 ||
    faa.some(
      (r) =>
        r.tail_number !== tail ||
        r.faa_status !== "V" ||
        (r.serial && String(r.serial).trim().toUpperCase() !== "RX8-3127") ||
        (r.faa_model &&
          !knownModels.has(
            String(r.faa_model)
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
          )) ||
        r.dereg_date
    )
  ) {
    throw new Error("Local FAA identity conflicts with the reviewed hold; stop for owner review");
  }
  const row = fleet[0];
  if (fleet.length !== 1 || row.airline !== airline || row.tail_number !== tail) {
    throw new Error("Repair requires exactly one canonical UA/N63571 fleet row");
  }
  if (
    row.first_seen_source !== "spreadsheet" ||
    !untyped(row.aircraft_type) ||
    row.starlink_status !== "unknown" ||
    row.verified_wifi !== null ||
    row.verified_at !== null ||
    row.ship_number !== null ||
    row.rts_until !== null
  ) {
    throw new Error(
      "Fleet row has unreviewed provenance, identity, or verification; stop for owner review"
    );
  }
  if (
    listings.length > 1 ||
    listings.some(
      (p) =>
        p.airline !== airline ||
        p.TailNumber !== tail ||
        !untyped(p.aircraft) ||
        !/^\d+$/.test(String(p.sheet_gid ?? "")) ||
        p.verified_wifi !== null ||
        p.verified_at !== null ||
        Number(p.last_check_successful) !== 0
    )
  ) {
    throw new Error(
      "Listing has unreviewed identity, source, or verification; stop for owner review"
    );
  }
  if (
    verification.some((v) => v.error === null) ||
    flights.length ||
    departures.length ||
    firstFlights.length ||
    assignments.length
  ) {
    throw new Error("Flight or successful verification evidence exists; stop for owner review");
  }
  const roster = programmeRoster(db, airline);
  if (roster.length < 2 || !roster.some((r) => r.tail_number === tail)) {
    throw new Error("Repair must leave a nonempty programme roster for metadata recomputation");
  }
  const lastUpdated = getMeta(db, "lastUpdated", airline);
  if (!lastUpdated) throw new Error("Missing source timestamp; stop for owner review");
  const meta = db.query("SELECT * FROM meta WHERE key LIKE 'UA:%' ORDER BY key").all() as Row[];
  const snapshot = {
    fleet,
    listings,
    verification,
    flights,
    departures,
    firstFlights,
    assignments,
    faa,
    meta,
    rosterHash: digest(roster),
    before: {
      total: roster.length,
      equipped: roster.filter((r) => r.equipped).length,
      lastUpdated,
    },
  };
  const plan = { version: 1, hold: UA_N63571_HOLD, snapshot };
  return { ...plan, fingerprint: digest(plan) };
}

/** Reads the existing schema only: no migration, archive creation, or stamp. */
export function previewUaMembershipRepair(db: Database) {
  return db.transaction(() => buildPlan(db)).deferred();
}

/** Explicit operator action only; never called from boot, migration, or jobs.
 * Review the preview from this database and supply its exact fingerprint. */
export function applyUaMembershipRepair(db: Database, expectedFingerprint: string) {
  if (!/^[0-9a-f]{64}$/.test(expectedFingerprint) || db.inTransaction) {
    throw new Error("A reviewed fingerprint and independent write transaction are required");
  }
  return db
    .transaction(() => {
      const plan = buildPlan(db);
      if (plan.fingerprint !== expectedFingerprint) {
        throw new Error("Reviewed snapshot changed; nothing applied");
      }
      db.exec(`CREATE TABLE IF NOT EXISTS fleet_membership_corrections (
      fingerprint TEXT PRIMARY KEY,
      hold_id TEXT NOT NULL,
      airline TEXT NOT NULL,
      tail_number TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    )`);
      db.query(`INSERT INTO fleet_membership_corrections
      (fingerprint, hold_id, airline, tail_number, applied_at, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
        plan.fingerprint,
        plan.hold.id,
        airline,
        tail,
        new Date().toISOString(),
        canonical(plan)
      );
      const removedListings = db
        .query("DELETE FROM starlink_planes WHERE airline = ? AND TailNumber = ?")
        .run(airline, tail);
      const removedFleet = db
        .query("DELETE FROM united_fleet WHERE airline = ? AND tail_number = ?")
        .run(airline, tail);
      if (removedFleet.changes !== 1 || removedListings.changes !== plan.snapshot.listings.length) {
        throw new Error("Unexpected affected rows; repair rolled back");
      }
      refreshFleetMeta(db, airline);
      if (getMeta(db, "lastUpdated", airline) !== plan.snapshot.before.lastUpdated) {
        throw new Error("Source timestamp changed; repair rolled back");
      }
      const remaining = programmeRoster(db, airline);
      return {
        fingerprint: plan.fingerprint,
        removedFleet: removedFleet.changes,
        removedListings: removedListings.changes,
        after: {
          total: remaining.length,
          equipped: remaining.filter((r) => r.equipped).length,
          lastUpdated: plan.snapshot.before.lastUpdated,
        },
      };
    })
    .immediate();
}
