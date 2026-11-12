import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDiscoveredStarlinkPlane,
  getLastUpdated,
  getTotalCount,
  refreshFleetMeta,
  setMeta,
  syncSpreadsheetToFleet,
  updateDatabase,
  upsertFleetAircraft,
} from "../src/database/database";
import { isMembershipHeld } from "../src/database/fleet-membership-holds";
import { programmeRoster } from "../src/database/roster";
import {
  applyUaMembershipRepair,
  previewUaMembershipRepair,
} from "../src/database/ua-membership-repair";
import { createApp } from "../src/server/app";
import type { Aircraft, FleetStats } from "../src/types";
import { addPlane, bodyOf, jsonOf, makeFreshDb } from "./helpers";

const stamp = "2026-10-15T14:08:38.660Z";
const stats: FleetStats = {
  mainline: { total: 3, starlink: 1, unverified: 1, percentage: 33.33 },
  express: { total: 0, starlink: 0, unverified: 0, percentage: 0 },
};
const sheet = (tail: string, aircraft = ""): Partial<Aircraft> => ({
  TailNumber: tail,
  Aircraft: aircraft,
  WiFi: "Starlink",
  sheet_gid: "123",
  fleet: "mainline",
});
const handles: Database[] = [];
const dirs: string[] = [];
const fresh = () => {
  const db = makeFreshDb();
  handles.push(db);
  return db;
};
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function seedLegacy(db: Database, listed = false) {
  upsertFleetAircraft(db, "N34571", "A321neo", "fr24", "mainline", "United Airlines", "UA");
  upsertFleetAircraft(db, "N12004", "Boeing 787-10", "fr24", "mainline", "United Airlines", "UA");
  addPlane(db, "N34571", null, { aircraft: "A321neo" });
  db.query("UPDATE starlink_planes SET sheet_gid = '123'").run();
  // Historical unsupported membership, before the proposed hold was installed.
  db.query(`INSERT INTO united_fleet
    (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
    VALUES ('N63571', NULL, 'spreadsheet', 1, 1, 'mainline', 'unknown', 'UA')`).run();
  if (listed) {
    addPlane(db, "N63571", null, { aircraft: "" });
    db.query("UPDATE starlink_planes SET sheet_gid = '123' WHERE TailNumber = 'N63571'").run();
  }
  setMeta(db, "lastUpdated", stamp, "UA");
  refreshFleetMeta(db, "UA");
}

const count = (db: Database, table: string, column: string, airline = "UA", tail = "N63571") =>
  (
    db
      .query(`SELECT count(*) AS n FROM ${table} WHERE airline = ? AND ${column} = ?`)
      .get(airline, tail) as { n: number }
  ).n;

describe("reviewed exact UA membership hold", () => {
  test("matches only the scoped identity, including case and space variants", () => {
    expect(isMembershipHeld("UA", "N63571")).toBe(true);
    expect(isMembershipHeld(" ua ", " n63571 ")).toBe(true);
    expect(isMembershipHeld("AS", "N63571")).toBe(false);
    expect(isMembershipHeld("UA", "N34571")).toBe(false);
    expect(isMembershipHeld("UA", "N635710")).toBe(false);
  });

  test("sheet ingestion rejects the held tail but retains a legitimate unknown type", () => {
    const db = fresh();
    expect(
      updateDatabase(
        db,
        3,
        [sheet("N63571"), sheet("N77777"), sheet("N34571", "A321neo")],
        stats,
        "UA"
      )
    ).toBeNull();
    expect(syncSpreadsheetToFleet(db, "UA")).toBe(2);
    expect(count(db, "starlink_planes", "TailNumber")).toBe(0);
    expect(count(db, "united_fleet", "tail_number")).toBe(0);
    const unknown = db
      .query(
        "SELECT aircraft_type, starlink_status, verified_wifi FROM united_fleet WHERE tail_number = 'N77777'"
      )
      .get();
    expect(unknown).toEqual({
      aircraft_type: null,
      starlink_status: "unknown",
      verified_wifi: null,
    });
    expect(count(db, "united_fleet", "tail_number", "UA", "N34571")).toBe(1);
  });

  test.each(["\t", "\n", "\r", "\u00a0", "\u2003", "\ufeff"])(
    "stored whitespace aliases are preserved for review, never erased: %j",
    (space) => {
      const db = fresh();
      seedLegacy(db, true);
      const alias = `${space}N63571${space}`;
      db.query(
        "UPDATE starlink_planes SET TailNumber = ?, airline = ? WHERE TailNumber = 'N63571'"
      ).run(alias, `${space}UA${space}`);
      db.query(
        "UPDATE united_fleet SET tail_number = ?, airline = ? WHERE tail_number = 'N63571'"
      ).run(alias, `${space}UA${space}`);
      expect(isMembershipHeld(`${space}UA${space}`, alias)).toBe(true);
      const before = db.serialize();
      expect(updateDatabase(db, 2, [sheet("N34571")], stats, "UA")).toContain(
        "explicit archived repair"
      );
      expect(() => previewUaMembershipRepair(db)).toThrow("canonical");
      expect(db.serialize()).toEqual(before);
    }
  );

  test("a held-only payload cannot empty listings or advance freshness", () => {
    const db = fresh();
    addPlane(db, "N34571");
    db.query("UPDATE starlink_planes SET sheet_gid = '123'").run();
    setMeta(db, "lastUpdated", stamp, "UA");
    const before = db.serialize();
    expect(updateDatabase(db, 1, [sheet("N63571")], stats, "UA")).toBe("parsed 0 rows");
    expect(db.serialize()).toEqual(before);
  });

  test("rejected inputs cannot satisfy the existing relative shrink gate", () => {
    const db = fresh();
    for (let i = 0; i < 24; i++) addPlane(db, `N${80000 + i}`);
    db.query("UPDATE starlink_planes SET sheet_gid = '123'").run();
    const before = db.serialize();
    const input = [
      sheet("N63571"),
      sheet("N63571"),
      ...Array.from({ length: 11 }, (_, i) => sheet(`N${80000 + i}`)),
    ];
    expect(updateDatabase(db, 24, input, stats, "UA")).toContain("< 50%");
    expect(db.serialize()).toEqual(before);
  });

  test.each([false, true])(
    "existing held membership cannot be erased by a scrape (listed=%s)",
    (listed) => {
      const db = fresh();
      seedLegacy(db, listed);
      const before = db.serialize();
      expect(updateDatabase(db, 2, [sheet("N34571")], stats, "UA")).toContain(
        "explicit archived repair"
      );
      expect(db.serialize()).toEqual(before);
    }
  );

  test("sync, fleet upsert and discovery cannot reimport the held membership", () => {
    const db = fresh();
    addPlane(db, "N63571", null, { aircraft: "" });
    expect(syncSpreadsheetToFleet(db, "UA")).toBe(0);
    expect(count(db, "united_fleet", "tail_number")).toBe(0);
    expect(count(db, "starlink_planes", "TailNumber")).toBe(1); // Preserved for review, not silently deleted.
    db.query("DELETE FROM starlink_planes").run();
    upsertFleetAircraft(db, "N63571", "A321neo", "fr24", "mainline", "United", "UA");
    addDiscoveredStarlinkPlane(db, "N63571", "A321neo", "Starlink", "United", "mainline", {
      airline: "UA",
      evidence: "observed",
    });
    expect(count(db, "united_fleet", "tail_number")).toBe(0);
    expect(count(db, "starlink_planes", "TailNumber")).toBe(0);
    expect(() =>
      addDiscoveredStarlinkPlane(db, "N63571", null, "Starlink", null, "mainline", {
        airline: "UA",
        evidence: "invalid" as "observed",
      })
    ).toThrow("opts.evidence");
  });

  test("the hold does not change another airline or revoke membership on listing disappearance", () => {
    const db = fresh();
    upsertFleetAircraft(db, "N63571", null, "fr24", "mainline", null, "AS");
    addDiscoveredStarlinkPlane(db, "N63571", null, "Starlink", null, "mainline", {
      airline: "AS",
      evidence: "community",
    });
    expect(count(db, "united_fleet", "tail_number", "AS")).toBe(1);
    expect(count(db, "starlink_planes", "TailNumber", "AS")).toBe(1);
    expect(
      updateDatabase(db, 2, [sheet("N34571", "A321neo"), sheet("N77777")], stats, "UA")
    ).toBeNull();
    expect(syncSpreadsheetToFleet(db, "UA")).toBe(2);
    expect(updateDatabase(db, 2, [sheet("N77777")], stats, "UA")).toBeNull();
    expect(count(db, "starlink_planes", "TailNumber", "UA", "N34571")).toBe(0);
    expect(count(db, "united_fleet", "tail_number", "UA", "N34571")).toBe(1);
  });
});

describe("explicit archived repair", () => {
  test.each([false, true])(
    "archives exact rows and corrects totals without changing source time (listed=%s)",
    (listed) => {
      const db = fresh();
      seedLegacy(db, listed);
      addPlane(db, "N63571", null, { airline: "AS", aircraft: "" });
      db.query(`INSERT INTO starlink_verification_log (tail_number, source, checked_at, error, airline)
      VALUES ('N63571', 'united', 1, 'no result', 'UA')`).run();
      const before = db.serialize();
      const plan = previewUaMembershipRepair(db);
      expect(db.serialize()).toEqual(before);
      const result = applyUaMembershipRepair(db, plan.fingerprint);
      expect(result.after).toEqual({ total: 2, equipped: 1, lastUpdated: stamp });
      expect(getTotalCount(db, "UA")).toBe(2);
      expect(getLastUpdated(db, "UA")).toBe(stamp);
      const archive = db.query("SELECT snapshot_json FROM fleet_membership_corrections").get() as {
        snapshot_json: string;
      };
      expect(JSON.parse(archive.snapshot_json)).toEqual(plan);
      expect(count(db, "united_fleet", "tail_number")).toBe(0);
      expect(count(db, "starlink_planes", "TailNumber")).toBe(0);
      expect(count(db, "starlink_planes", "TailNumber", "AS")).toBe(1);
      expect(count(db, "starlink_verification_log", "tail_number")).toBe(1);
      expect(programmeRoster(db, "UA").map((r) => r.tail_number)).toEqual(["N12004", "N34571"]);
      const applied = db.serialize();
      expect(() => applyUaMembershipRepair(db, plan.fingerprint)).toThrow("exactly one");
      expect(db.serialize()).toEqual(applied);
    }
  );

  test("replaying all normal writers after repair cannot resurrect the member", () => {
    const db = fresh();
    seedLegacy(db);
    applyUaMembershipRepair(db, previewUaMembershipRepair(db).fingerprint);
    expect(
      updateDatabase(db, 3, [sheet("N63571"), sheet("N34571", "A321neo")], stats, "UA")
    ).toBeNull();
    syncSpreadsheetToFleet(db, "UA");
    upsertFleetAircraft(db, "N63571", null, "fr24", "mainline", null, "UA");
    addDiscoveredStarlinkPlane(db, "N63571", null, "Starlink", null, "mainline", {
      airline: "UA",
      evidence: "community",
    });
    expect(count(db, "united_fleet", "tail_number")).toBe(0);
    expect(count(db, "starlink_planes", "TailNumber")).toBe(0);
    expect(getTotalCount(db, "UA")).toBe(2);
  });

  test.each([
    "UPDATE united_fleet SET last_seen_at = 2 WHERE tail_number = 'N63571'",
    "UPDATE united_fleet SET fleet = 'express' WHERE tail_number = 'N12004'",
    "UPDATE meta SET value = 'changed' WHERE key = 'UA:lastUpdated'",
    "INSERT INTO starlink_verification_log (tail_number, source, checked_at, error, airline) VALUES ('N63571','united',2,'new error','UA')",
  ])("changed reviewed state fails without a write: %s", (sql) => {
    const db = fresh();
    seedLegacy(db);
    const plan = previewUaMembershipRepair(db);
    db.exec(sql);
    const before = db.serialize();
    expect(() => applyUaMembershipRepair(db, plan.fingerprint)).toThrow("snapshot changed");
    expect(db.serialize()).toEqual(before);
  });

  test.each([
    "UPDATE united_fleet SET aircraft_type = 'A321neo' WHERE tail_number = 'N63571'",
    "UPDATE united_fleet SET first_seen_source = 'fr24' WHERE tail_number = 'N63571'",
    "UPDATE united_fleet SET verified_wifi = 'Starlink', verified_at = 2 WHERE tail_number = 'N63571'",
    "UPDATE united_fleet SET tail_number = 'n63571' WHERE tail_number = 'N63571'",
    "UPDATE starlink_planes SET sheet_gid = 'discovery' WHERE TailNumber = 'N63571'",
    "UPDATE starlink_planes SET last_check_successful = 1 WHERE TailNumber = 'N63571'",
    "INSERT INTO starlink_verification_log (tail_number, source, checked_at, error, airline) VALUES ('N63571','united',2,NULL,'UA')",
    "INSERT INTO upcoming_flights (tail_number, airline) VALUES ('N63571','UA')",
    "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES ('N63571','EWR',2,'UA')",
    "DELETE FROM united_fleet WHERE tail_number <> 'N63571'",
  ])("unreviewed provenance or corroboration refuses correction: %s", (sql) => {
    const db = fresh();
    seedLegacy(db, true);
    db.exec(sql);
    const before = db.serialize();
    expect(() => previewUaMembershipRepair(db)).toThrow();
    expect(() => applyUaMembershipRepair(db, "0".repeat(64))).toThrow();
    expect(db.serialize()).toEqual(before);
  });

  test("an archive or deletion failure rolls back the entire repair", () => {
    const db = fresh();
    seedLegacy(db, true);
    const plan = previewUaMembershipRepair(db);
    db.exec(`CREATE TRIGGER refuse_repair BEFORE DELETE ON united_fleet
      BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END`);
    const before = db.serialize();
    expect(() => applyUaMembershipRepair(db, plan.fingerprint)).toThrow("simulated delete failure");
    expect(db.serialize()).toEqual(before);
    expect(
      db.query("SELECT 1 FROM sqlite_master WHERE name = 'fleet_membership_corrections'").get()
    ).toBeNull();
    db.exec(
      "DROP TRIGGER refuse_repair; CREATE TABLE fleet_membership_corrections (wrong_schema TEXT)"
    );
    const archiveFailure = db.serialize();
    expect(() => applyUaMembershipRepair(db, plan.fingerprint)).toThrow();
    expect(db.serialize()).toEqual(archiveFailure);
  });

  test.each([false, true])(
    "flight assignment evidence blocks repair (arrived after preview=%s)",
    (afterPreview) => {
      const db = fresh();
      seedLegacy(db);
      const plan = afterPreview ? previewUaMembershipRepair(db) : null;
      db.query(`INSERT INTO flight_assignment_log
      (airline, flight_number, dep_date, departure_airport, tail_number, starlink, first_seen, last_seen)
      VALUES ('UA', 'UA123', '2026-10-17', 'EWR', 'N63571', 1, 1, 1)`).run();
      const before = db.serialize();
      expect(() => previewUaMembershipRepair(db)).toThrow("Flight or successful verification");
      expect(() => applyUaMembershipRepair(db, plan?.fingerprint ?? "0".repeat(64))).toThrow(
        "Flight or successful verification"
      );
      expect(db.serialize()).toEqual(before);
    }
  );

  test("local FAA identity is reviewed without copying registrant information", () => {
    const db = fresh();
    seedLegacy(db);
    const absent = previewUaMembershipRepair(db);
    expect(absent.snapshot.faa).toEqual([]);
    db.query(`INSERT INTO faa_registry (tail_number, serial, faa_model, faa_status, registrant, last_refreshed)
      VALUES ('N63571', 'RX8-3127', 'AEROSTAR INTERNATIONAL INC RX 8', 'V', 'PRIVATE REGISTRANT', 1)`).run();
    const before = db.serialize();
    expect(() => applyUaMembershipRepair(db, absent.fingerprint)).toThrow("snapshot changed");
    expect(db.serialize()).toEqual(before);
    const plan = previewUaMembershipRepair(db);
    expect(plan.snapshot.faa).toHaveLength(1);
    expect(JSON.stringify(plan)).not.toContain("registrant");
    expect(JSON.stringify(plan)).not.toContain("PRIVATE REGISTRANT");
    applyUaMembershipRepair(db, plan.fingerprint);
    const archive = db.query("SELECT snapshot_json FROM fleet_membership_corrections").get() as {
      snapshot_json: string;
    };
    expect(archive.snapshot_json).not.toContain("PRIVATE REGISTRANT");
  });

  test.each([
    "serial = 'NEW-AIRFRAME'",
    "faa_model = 'AIRBUS A321-271NX'",
    "faa_status = 'NOT_IN_MASTER'",
    "last_refreshed = 2",
  ])("changed FAA identity or observation invalidates approval: %s", (change) => {
    const db = fresh();
    seedLegacy(db);
    db.query(`INSERT INTO faa_registry (tail_number, serial, faa_model, faa_status, last_refreshed)
        VALUES ('N63571', 'RX8-3127', NULL, 'V', 1)`).run();
    const plan = previewUaMembershipRepair(db);
    db.exec(`UPDATE faa_registry SET ${change}`);
    const before = db.serialize();
    expect(() => applyUaMembershipRepair(db, plan.fingerprint)).toThrow();
    expect(db.serialize()).toEqual(before);
  });

  test("public API, summary, fleet and badge derive the repaired fixture consistently", async () => {
    const db = fresh();
    seedLegacy(db);
    applyUaMembershipRepair(db, previewUaMembershipRepair(db).fingerprint);
    const app = createApp(db);
    const data = await jsonOf(app, "/api/data", "unitedstarlinktracker.com");
    const summary = await jsonOf(app, "/api/fleet-summary", "unitedstarlinktracker.com");
    const fleet = await bodyOf(app, "/fleet", "unitedstarlinktracker.com");
    const badge = await bodyOf(app, "/badge.svg", "unitedstarlinktracker.com");
    expect(data.totalCount).toBe(2);
    expect(data.lastUpdated).toBe(stamp);
    expect(data.starlinkPlanes).toHaveLength(1);
    const ua = summary.airlines.find((entry: { code: string }) => entry.code === "UA");
    expect(ua.total).toBe(2);
    expect(ua.installed).toBe(1);
    expect(
      ua.families.reduce((sum: number, family: { total: number }) => sum + family.total, 0)
    ).toBe(2);
    expect(fleet.status).toBe(200);
    expect(fleet.text).not.toContain('id="t-N63571"');
    expect(fleet.text).toContain('id="t-N34571"');
    expect(badge.status).toBe(200);
    expect(badge.text).toContain("1 of 2 aircraft");
  });

  test("CLI defaults to read-only review and needs an explicit matching hash to apply", () => {
    const db = fresh();
    seedLegacy(db);
    const dir = mkdtempSync(join(tmpdir(), "ua-membership-test-"));
    dirs.push(dir);
    const file = join(dir, "fixture.sqlite");
    writeFileSync(file, db.serialize(), { mode: 0o600 });
    const original = readFileSync(file);
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, "src/scripts/review-ua-membership.ts", ...args], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, DD_TRACE_ENABLED: "false", DISABLE_JOBS: "1" },
      });
    const preview = run(file);
    expect(preview.exitCode).toBe(0);
    expect(readFileSync(file)).toEqual(original);
    const plan = JSON.parse(preview.stdout.toString());
    expect(run(file, "--apply", "0".repeat(64)).exitCode).toBe(1);
    expect(readFileSync(file)).toEqual(original);
    expect(run(file, "--apply", plan.fingerprint).exitCode).toBe(0);
    const repaired = new Database(file, { readonly: true });
    handles.push(repaired);
    expect(getTotalCount(repaired, "UA")).toBe(2);
    expect(run(join(dir, "absent.sqlite")).exitCode).toBe(1);
    expect(existsSync(join(dir, "absent.sqlite"))).toBe(false);
  });
});
