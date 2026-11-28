/**
 * A regional jet's operator follows its own scheduled legs (United Express)
 * and the FAA register (Alaska), not only what a volunteer last typed.
 * Synthetic fixtures shaped like the rows that exposed each miss.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AIRLINES } from "../src/airlines/registry";
import { buildTailPage } from "../src/api/tail-page";
import {
  addDiscoveredStarlinkPlane,
  alaskaOperator,
  alaskaOperatorFromTail,
  syncSpreadsheetToFleet,
  updateDatabase,
} from "../src/database/database";
import {
  MIN_OPERATOR_LEGS,
  alaskaOperatorFromRegistrant,
  expressCarrierKey,
  expressOperatorFromLegs,
} from "../src/database/operator-evidence";
import { createReaderFactory } from "../src/database/reader";
import { addFlight, makeSyntheticDb } from "./helpers";

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

describe("expressOperatorFromLegs", () => {
  test("operating codes that agree name the carrier, in either spelling", () => {
    const flown = expressOperatorFromLegs(["RPA4512", "YX4513", "RPA4402"]);
    expect(flown?.key).toBe("republic");
    expect(expressCarrierKey(flown?.label ?? null)).toBe(flown?.key ?? "missing");
  });

  test("United's own spelling says nothing about the regional and is passed over", () => {
    expect(expressOperatorFromLegs(["UA5212", "SKW5212", "OO5213", "UAL6029"])?.key).toBe(
      "skywest"
    );
    expect(expressOperatorFromLegs(["UA5212", "UAL6029", "UA499"])).toBeNull();
  });

  test("disagreement, an unplaceable code or too few legs keep the sheet", () => {
    expect(expressOperatorFromLegs(["ASH3401", "RPA4512", "RPA4513"])).toBeNull();
    expect(expressOperatorFromLegs(["RPA4512", "XX123", "RPA4513"])).toBeNull();
    expect(expressOperatorFromLegs(["RPA4512"])).toBeNull();
    expect(expressOperatorFromLegs(Array(MIN_OPERATOR_LEGS).fill("G74174"))?.key).toBe("gojet");
  });

  test("a stored label names its regional however the sheet spells it", () => {
    for (const label of ["Skywest dba UAX", "SkyWest dba UAX", "SkyWest floater"]) {
      expect(expressCarrierKey(label)).toBe("skywest");
    }
    expect(expressCarrierKey("United Airlines")).toBeNull();
    expect(expressCarrierKey(null)).toBeNull();
  });
});

const STATS = {
  express: { total: 2, starlink: 2, unverified: 0, percentage: 100 },
  mainline: { total: 1, starlink: 1, unverified: 0, percentage: 100 },
  combined: { total: 3, starlink: 3, unverified: 0, percentage: 100 },
};
const express = (tail: string, operatedBy: string) => ({
  TailNumber: tail,
  Aircraft: "ERJ-175",
  WiFi: "Starlink",
  sheet_gid: "1",
  sheet_type: "E175",
  fleet: "express",
  OperatedBy: operatedBy,
});
const SHEET = [
  express("N85340", "Mesa dba UAX"),
  express("N86372", "Skywest dba UAX"),
  { ...express("N37502", "United Airlines"), fleet: "mainline", Aircraft: "737 MAX 9" },
];
const listed = (db: Database, tail: string) =>
  (
    db.query("SELECT OperatedBy AS o FROM starlink_planes WHERE TailNumber = ?").get(tail) as {
      o: string;
    }
  ).o;
const rostered = (db: Database, tail: string) =>
  (
    db.query("SELECT operated_by AS o FROM united_fleet WHERE tail_number = ?").get(tail) as {
      o: string;
    }
  ).o;
const operatedByFact = (db: Database, tail: string) =>
  buildTailPage(AIRLINES.UA, createReaderFactory(db)("UA"), tail)?.plane.find(
    (f) => f.label === "Operated by"
  )?.value;

describe("United Express operator from the tail's legs", () => {
  test("N85340 reads Republic once its legs all say Republic, and Mesa while they are mixed", () => {
    const db = makeSyntheticDb();
    for (const [i, fn] of ["ASH3401", "UA3402", "RPA4512", "UA4513"].entries()) {
      addFlight(db, "N85340", fn, "DEN", NOW + (i + 1) * HOUR);
    }
    for (const [i, fn] of ["OO5257", "UAL6029", "SKW5720"].entries()) {
      addFlight(db, "N86372", fn, "SFO", NOW + (i + 1) * HOUR);
    }
    expect(updateDatabase(db, 3, SHEET, STATS, "UA")).toBeNull();
    expect(listed(db, "N85340")).toBe("Mesa dba UAX");

    // The Mesa legs fly off and only Republic's remain: the next hourly read.
    db.query("DELETE FROM upcoming_flights WHERE flight_number IN ('ASH3401', 'UA3402')").run();
    addFlight(db, "N85340", "YX4514", "ORD", NOW + 30 * HOUR);
    expect(updateDatabase(db, 3, SHEET, STATS, "UA")).toBeNull();
    syncSpreadsheetToFleet(db, "UA");

    expect(expressCarrierKey(listed(db, "N85340"))).toBe("republic");
    expect(expressCarrierKey(rostered(db, "N85340"))).toBe("republic");
    expect(operatedByFact(db, "N85340")).toMatch(/^Republic\b/);
    // Legs that agree with the sheet, and a mainline row, are left as typed.
    expect(listed(db, "N86372")).toBe("Skywest dba UAX");
    expect(listed(db, "N37502")).toBe("United Airlines");

    // Legs gone (or past the window): the sheet's value is back next read.
    db.query("UPDATE upcoming_flights SET departure_time = departure_time + 72 * 3600").run();
    expect(updateDatabase(db, 3, SHEET, STATS, "UA")).toBeNull();
    expect(listed(db, "N85340")).toBe("Mesa dba UAX");
    db.close();
  });

  test("another airline's legs never move a United listing", () => {
    const db = makeSyntheticDb();
    for (const [i, fn] of ["RPA4512", "RPA4513"].entries()) {
      addFlight(db, "N85340", fn, "DEN", NOW + (i + 1) * HOUR, { airline: "AS" });
    }
    updateDatabase(db, 3, SHEET, STATS, "UA");
    expect(listed(db, "N85340")).toBe("Mesa dba UAX");
    db.close();
  });
});

describe("Alaska regional operator from the FAA register", () => {
  const register = (db: Database, tail: string, registrant: string) =>
    db
      .query(
        `INSERT INTO faa_registry (tail_number, faa_status, registrant, last_refreshed)
         VALUES (?, 'V', ?, 1)`
      )
      .run(tail, registrant);

  test("Horizon and SkyWest registrants name their carrier; a bank or Alaska names nobody", () => {
    expect(alaskaOperatorFromRegistrant("HORIZON AIR INDUSTRIES INC")).toBe("Horizon Air");
    expect(alaskaOperatorFromRegistrant("SKY WEST AIRLINES INC")).toBe("SkyWest Airlines");
    expect(alaskaOperatorFromRegistrant("SKYWEST AIRLINES INC")).toBe("SkyWest Airlines");
    expect(alaskaOperatorFromRegistrant("ALASKA AIRLINES INC")).toBeNull();
    expect(alaskaOperatorFromRegistrant("WILMINGTON TRUST CO TRUSTEE")).toBeNull();
    expect(alaskaOperatorFromRegistrant(null)).toBeNull();
  });

  test("a relisted N652MK reads Horizon Air from its registrant, outside the QX block", () => {
    const db = makeSyntheticDb();
    register(db, "N652MK", "HORIZON AIR INDUSTRIES INC");
    register(db, "N181SY", "WELLS FARGO TRUST CO NA TRUSTEE");
    expect(alaskaOperatorFromTail("N652MK")).toBeNull();
    for (const tail of ["N652MK", "N181SY", "N651MK"]) {
      addDiscoveredStarlinkPlane(
        db,
        tail,
        "Embraer E175LR",
        "Starlink",
        "Alaska Airlines",
        "horizon",
        { airline: "AS", evidence: "type_rule" }
      );
    }
    expect(listed(db, "N652MK")).toBe("Horizon Air");
    // A lessor names nobody: the suffix block still does.
    expect(listed(db, "N181SY")).toBe(alaskaOperatorFromTail("N181SY") ?? "missing");
    // No register row and no block: the passed operator, as before.
    expect(alaskaOperator(db, "N651MK")).toBeNull();
    expect(listed(db, "N651MK")).toBe("Alaska Airlines");
    db.close();
  });
});
