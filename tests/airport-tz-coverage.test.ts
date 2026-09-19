/**
 * AIRPORT_TZ coverage. An unmapped departure airport silently drops to the
 * strict UTC day window, which files an evening US departure under the next
 * date. Thresholds rather than equality: a newly served airport must not block
 * pushes, but a regression in coverage must.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIRLINES } from "../src/airlines/registry";
import { resolveFlightVerdict, scheduledFlights } from "../src/api/check-flight-core";
import { createReaderFactory } from "../src/database/reader";
import { AIRPORT_TZ, flightDateWindow, matchesLocalDate } from "../src/utils/airport-tz";
import { addFlight, addPlane, makeSyntheticDb, openSnapshot, stubPredict, utc } from "./helpers";

const MAX_UNMAPPED_SHARE = 0.005;

function tableExists(db: ReturnType<typeof openSnapshot>, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;
}

describe("AIRPORT_TZ coverage (snapshot)", () => {
  test("upcoming_flights departures are almost all mapped", () => {
    const db = openSnapshot();
    const rows = db
      .query(
        "SELECT UPPER(departure_airport) AS code, COUNT(*) AS n FROM upcoming_flights GROUP BY 1"
      )
      .all() as { code: string | null; n: number }[];
    db.close();
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    const missing = rows.filter((r) => r.code && !AIRPORT_TZ[r.code]);
    const unmapped = missing.reduce((sum, r) => sum + r.n, 0);
    if (missing.length > 0) {
      console.log(`unmapped upcoming_flights origins: ${missing.map((r) => r.code).join(", ")}`);
    }
    expect(unmapped).toBeLessThanOrEqual(Math.floor(total * MAX_UNMAPPED_SHARE));
  });

  test("qatar_schedule origins are almost all mapped", () => {
    const db = openSnapshot();
    if (!tableExists(db, "qatar_schedule")) {
      db.close();
      return;
    }
    const codes = (
      db
        .query(
          "SELECT DISTINCT UPPER(departure_airport) AS code FROM qatar_schedule WHERE departure_airport IS NOT NULL"
        )
        .all() as { code: string }[]
    ).map((r) => r.code);
    db.close();
    const missing = codes.filter((c) => !AIRPORT_TZ[c]);
    if (missing.length > 0) console.log(`unmapped qatar_schedule origins: ${missing.join(", ")}`);
    expect(missing.length).toBeLessThanOrEqual(Math.floor(codes.length * MAX_UNMAPPED_SHARE));
  });
});

describe("AIRPORT_TZ integrity", () => {
  test("every zone constructs a formatter", () => {
    for (const [iata, zone] of Object.entries(AIRPORT_TZ)) {
      expect(() => new Intl.DateTimeFormat("en", { timeZone: zone }), iata).not.toThrow();
    }
  });

  test("no duplicate keys in the source literal", () => {
    // A duplicated key silently keeps the last value, so a later wrong zone
    // would override a correct one with no runtime signal.
    const src = readFileSync(join(import.meta.dir, "..", "src/utils/airport-tz.ts"), "utf8");
    const keys = [...src.matchAll(/^ {2}([A-Z]{3}): "/gm)].map((m) => m[1]);
    expect(keys.length).toBe(Object.keys(AIRPORT_TZ).length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("regional airports seen in assignment data are mapped", () => {
    for (const code of [
      "OME",
      "OTZ",
      "BET",
      "BLI",
      "PAE",
      "LGB",
      "ASE",
      "HDN",
      "ACK",
      "MDW",
      "YYJ",
    ]) {
      expect(AIRPORT_TZ[code], code).toBeDefined();
    }
  });

  test("an evening BLI departure keeps its Pacific date", () => {
    const d = "2027-06-09";
    const next = "2027-06-10";
    const evening = utc("2027-06-10T02:19:00Z");
    const morning = utc("2027-06-10T15:00:00Z");
    const wd = flightDateWindow(d)!;
    const wn = flightDateWindow(next)!;
    expect(matchesLocalDate(d, "BLI", evening, wd.start, wd.end)).toBe(true);
    expect(matchesLocalDate(next, "BLI", evening, wn.start, wn.end)).toBe(false);
    expect(matchesLocalDate(next, "BLI", morning, wn.start, wn.end)).toBe(true);
  });

  test("a scoped BLI lookup never returns the previous evening's tail", async () => {
    const db = makeSyntheticDb();
    addPlane(db, "N4001", "Starlink");
    addFlight(db, "N4001", "UA4001", "BLI", utc("2027-06-10T02:19:00Z"), { arrivalAirport: "SEA" });
    addPlane(db, "N4002", "Starlink");
    addFlight(db, "N4002", "UA4001", "BLI", utc("2027-06-10T15:00:00Z"), { arrivalAirport: "SEA" });
    const reader = createReaderFactory(db)("UA");
    const v = await resolveFlightVerdict(AIRLINES.UA, reader, "UA4001", "2027-06-10", {
      lookupTail: null,
      predict: stubPredict(0),
      leg: { origin: "BLI" },
    });
    expect(v.kind).toBe("scheduled");
    if (v.kind === "scheduled") {
      expect(scheduledFlights(v).map((r) => r.tail_number)).toEqual(["N4002"]);
      expect(v.leg?.match).toBe("exact");
    }
  });
});
