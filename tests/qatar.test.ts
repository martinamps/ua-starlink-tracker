/**
 * Qatar Airways tests — equipment-code mapper, schedule cache, and the
 * QR-specific /api/check-flight branch.
 *
 * Unlike the integration suite (which uses a snapshot of prod), these tests
 * build an in-memory SQLite + seed deterministic qatar_schedule rows so they
 * run hermetically. The QR data path doesn't read prod tables (no JOINs into
 * starlink_planes), so a from-scratch DB is sufficient.
 */

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  type QatarWifi,
  isQatarFreighterEquipment,
  qatarEquipmentName,
  qatarEquipmentToWifi,
} from "../src/api/qatar-status";
import {
  getQatarScheduleByFlight,
  getQatarScheduleByRoute,
  getQatarScheduleStats,
  initializeDatabase,
  upsertQatarSchedule,
} from "../src/database/database";

// In-memory DB so tests don't pollute /tmp/ua-test.sqlite
const DB_FILE = ":memory:";

describe("qatarEquipmentToWifi", () => {
  test.each<[string, QatarWifi]>([
    ["77W", "Starlink"], // 777-300ER — rollout complete Q2 2025
    ["77L", "Starlink"], // 777-200LR
    ["351", "Starlink"], // A350-900 (one of two codes QR returns)
    ["359", "Starlink"], // A350-900 (alternate)
    ["35K", "Starlink"], // A350-1000
    ["788", "Rolling"], // 787-8 — rolling
    ["789", "Rolling"], // 787-9 — rolling
    ["388", "None"], // A380 — not in plan
    ["332", "None"], // A330-200
    ["333", "None"], // A330-300
    ["320", "None"], // A320
    ["321", "None"], // A321
    ["21N", "None"], // A321neo
    ["38M", "None"], // 737 MAX
    ["77w", "Starlink"], // case-insensitive
  ])("%s → %s", (code, want) => {
    expect(qatarEquipmentToWifi(code)).toBe(want);
  });

  test("null/undefined → None", () => {
    expect(qatarEquipmentToWifi(null)).toBe("None");
    expect(qatarEquipmentToWifi(undefined)).toBe("None");
    expect(qatarEquipmentToWifi("")).toBe("None");
  });

  test("unknown code → None (conservative)", () => {
    expect(qatarEquipmentToWifi("XXX")).toBe("None");
    expect(qatarEquipmentToWifi("747")).toBe("None");
  });
});

describe("isQatarFreighterEquipment", () => {
  test("recognizes 777/747 freighter codes", () => {
    expect(isQatarFreighterEquipment("77F")).toBe(true);
    expect(isQatarFreighterEquipment("77X")).toBe(true);
    expect(isQatarFreighterEquipment("74Y")).toBe(true);
    expect(isQatarFreighterEquipment("74F")).toBe(true);
    expect(isQatarFreighterEquipment("77f")).toBe(true);
  });

  test("passenger 77W / 77L are NOT freighters", () => {
    expect(isQatarFreighterEquipment("77W")).toBe(false);
    expect(isQatarFreighterEquipment("77L")).toBe(false);
  });

  test("nullish → false (don't accidentally drop unknown rows)", () => {
    expect(isQatarFreighterEquipment(null)).toBe(false);
    expect(isQatarFreighterEquipment(undefined)).toBe(false);
    expect(isQatarFreighterEquipment("")).toBe(false);
  });
});

describe("qatarEquipmentName", () => {
  test("known codes map to readable names", () => {
    expect(qatarEquipmentName("77W")).toBe("Boeing 777-300ER");
    expect(qatarEquipmentName("77L")).toBe("Boeing 777-200LR");
    expect(qatarEquipmentName("351")).toBe("Airbus A350-900");
    expect(qatarEquipmentName("35K")).toBe("Airbus A350-1000");
    expect(qatarEquipmentName("788")).toBe("Boeing 787-8");
    expect(qatarEquipmentName("789")).toBe("Boeing 787-9");
    expect(qatarEquipmentName("388")).toBe("Airbus A380-800");
  });

  test("unknown code passes through", () => {
    expect(qatarEquipmentName("XXX")).toBe("XXX");
  });

  test("nullish → 'Unknown'", () => {
    expect(qatarEquipmentName(null)).toBe("Unknown");
    expect(qatarEquipmentName(undefined)).toBe("Unknown");
  });
});

describe("qatar_schedule cache", () => {
  let db: Database;
  const baseTime = Math.floor(Date.parse("2026-04-22T00:00:00Z") / 1000);

  beforeAll(() => {
    // initializeDatabase points at DB_PATH; we want :memory:, so build minimal
    // schema directly. The schedule table has no FKs into other tables.
    db = new Database(DB_FILE);
    db.exec(`
      CREATE TABLE qatar_schedule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flight_number TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        departure_airport TEXT,
        arrival_airport TEXT,
        departure_time INTEGER,
        arrival_time INTEGER,
        equipment_code TEXT,
        wifi_verdict TEXT,
        flight_status TEXT,
        last_updated INTEGER NOT NULL,
        UNIQUE(flight_number, scheduled_date)
      );
    `);

    // Three flights on the same DOH-LHR day (matches the live API result we
    // observed: QR1=77W, QR3=351, QR15=77W).
    upsertQatarSchedule(db, {
      flight_number: "QR1",
      scheduled_date: "2026-04-22",
      departure_airport: "DOH",
      arrival_airport: "LHR",
      departure_time: baseTime + 22 * 3600,
      arrival_time: baseTime + 28 * 3600,
      equipment_code: "77W",
      wifi_verdict: "Starlink",
      flight_status: "SCHEDULED",
      last_updated: baseTime,
    });
    upsertQatarSchedule(db, {
      flight_number: "QR3",
      scheduled_date: "2026-04-22",
      departure_airport: "DOH",
      arrival_airport: "LHR",
      departure_time: baseTime + 4 * 3600,
      arrival_time: baseTime + 10 * 3600,
      equipment_code: "351",
      wifi_verdict: "Starlink",
      flight_status: "SCHEDULED",
      last_updated: baseTime,
    });
    // A 787 on a different route to test the Rolling case.
    upsertQatarSchedule(db, {
      flight_number: "QR17",
      scheduled_date: "2026-04-22",
      departure_airport: "DOH",
      arrival_airport: "DUB",
      departure_time: baseTime + 5 * 3600,
      arrival_time: baseTime + 12 * 3600,
      equipment_code: "789",
      wifi_verdict: "Rolling",
      flight_status: "SCHEDULED",
      last_updated: baseTime,
    });
    // A narrowbody on an intra-Gulf route (None).
    upsertQatarSchedule(db, {
      flight_number: "QR1170",
      scheduled_date: "2026-04-22",
      departure_airport: "DOH",
      arrival_airport: "RUH",
      departure_time: baseTime + 6 * 3600,
      arrival_time: baseTime + 8 * 3600,
      equipment_code: "320",
      wifi_verdict: "None",
      flight_status: "SCHEDULED",
      last_updated: baseTime,
    });
  });

  test("getQatarScheduleByFlight matches by flight number + window", () => {
    const start = baseTime;
    const end = baseTime + 86400;
    const rows = getQatarScheduleByFlight(db, ["QR1"], start, end);
    expect(rows.length).toBe(1);
    expect(rows[0].flight_number).toBe("QR1");
    expect(rows[0].equipment_code).toBe("77W");
    expect(rows[0].wifi_verdict).toBe("Starlink");
  });

  test("getQatarScheduleByFlight handles padded variants", () => {
    const start = baseTime;
    const end = baseTime + 86400;
    // Caller passes both forms — match either.
    const rows = getQatarScheduleByFlight(db, ["QR1", "QR001"], start, end);
    expect(rows.length).toBe(1);
    expect(rows[0].flight_number).toBe("QR1");
  });

  test("getQatarScheduleByFlight returns empty when out of window", () => {
    // Day after the seeded flights → no rows.
    const start = baseTime + 7 * 86400;
    const end = start + 86400;
    expect(getQatarScheduleByFlight(db, ["QR1"], start, end)).toEqual([]);
  });

  test("getQatarScheduleByRoute returns all daily frequencies on a route", () => {
    const start = baseTime;
    const end = baseTime + 86400;
    const rows = getQatarScheduleByRoute(db, "DOH", "LHR", start, end);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.flight_number).sort()).toEqual(["QR1", "QR3"]);
    // ORDER BY departure_time ASC
    expect(rows[0].flight_number).toBe("QR3");
    expect(rows[1].flight_number).toBe("QR1");
  });

  test("getQatarScheduleByRoute is case-insensitive on airport codes", () => {
    const start = baseTime;
    const end = baseTime + 86400;
    expect(getQatarScheduleByRoute(db, "doh", "lhr", start, end).length).toBe(2);
  });

  test("upsert overwrites equipment on conflict (real-world tail swap)", () => {
    // QR1 originally seeded as 77W; pretend QR swapped to 351 mid-day.
    upsertQatarSchedule(db, {
      flight_number: "QR1",
      scheduled_date: "2026-04-22",
      departure_airport: "DOH",
      arrival_airport: "LHR",
      departure_time: baseTime + 22 * 3600,
      arrival_time: baseTime + 28 * 3600,
      equipment_code: "351",
      wifi_verdict: "Starlink",
      flight_status: "SCHEDULED",
      last_updated: baseTime + 60,
    });
    const rows = getQatarScheduleByFlight(db, ["QR1"], baseTime, baseTime + 86400);
    expect(rows.length).toBe(1);
    expect(rows[0].equipment_code).toBe("351");
    expect(rows[0].last_updated).toBe(baseTime + 60);
    // Restore for downstream tests.
    upsertQatarSchedule(db, {
      flight_number: "QR1",
      scheduled_date: "2026-04-22",
      departure_airport: "DOH",
      arrival_airport: "LHR",
      departure_time: baseTime + 22 * 3600,
      arrival_time: baseTime + 28 * 3600,
      equipment_code: "77W",
      wifi_verdict: "Starlink",
      flight_status: "SCHEDULED",
      last_updated: baseTime,
    });
  });

  test("getQatarScheduleStats counts by verdict", () => {
    const stats = getQatarScheduleStats(db);
    expect(stats.total).toBe(4);
    expect(stats.starlink).toBe(2);
    expect(stats.rolling).toBe(1);
    expect(stats.none).toBe(1);
    expect(stats.lastUpdated).not.toBeNull();
  });
});

describe("registry: QR enabled with expected shape", () => {
  test("AIRLINES.QR is enabled and uses qatar-fltstatus verifier", async () => {
    const { AIRLINES, enabledAirlines } = await import("../src/airlines/registry");
    expect(AIRLINES.QR.enabled).toBe(true);
    expect(AIRLINES.QR.verifierBackend).toBe("qatar-fltstatus");
    expect(AIRLINES.QR.iata).toBe("QR");
    expect(AIRLINES.QR.icao).toBe("QTR");
    expect(AIRLINES.QR.fr24Slug).toBe("qr-qtr");
    expect(enabledAirlines().some((a) => a.code === "QR")).toBe(true);
  });

  test("QR carrierPrefixes detects QR flight numbers", async () => {
    const { detectAirline } = await import("../src/airlines/flight-number");
    const cfg = detectAirline("QR1");
    expect(cfg?.code).toBe("QR");
    expect(detectAirline("QR001")?.code).toBe("QR");
    expect(detectAirline("QTR001")?.code).toBe("QR");
  });
});
