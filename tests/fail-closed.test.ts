/**
 * Fail-closed invariant: an upstream error or unrecognized input produces NO
 * observation, NO success stamp, and NO destructive write. Each ingest/verify
 * path gets a table over {failure, garbage, unknown-type} inputs asserting
 * zero state change. Synthetic in-memory DBs — no network, injected fetchers
 * throughout.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AIRLINES, qatarTypeToStarlink } from "../src/airlines/registry";
import { hawaiianTypeToStarlink } from "../src/api/alaska-status";
import type { AlaskaFlightStatus, fetchAlaskaFlightStatus } from "../src/api/alaska-status";
import { resolveFlightVerdict, verdictTelemetry } from "../src/api/check-flight-core";
import { Fr24UnavailableError } from "../src/api/flightradar24-api";
import type { QatarFlight, fetchByRoute } from "../src/api/qatar-status";
import { SHEET_ROSTER_WHERE, getMeta, setMeta, updateDatabase } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { checkOne } from "../src/scripts/alaska-verifier";
import { ingestQatarSchedule } from "../src/scripts/qatar-schedule-ingester";
import { runSheetScrape } from "../src/scripts/sheet-scrape";
import type { FleetStats } from "../src/types";
import type { fetchAllSheets } from "../src/utils/utils";
import { addFleet, addFlight, addQatarRow, makeSyntheticDb, stubPredict, utc } from "./helpers";

function fleetRow(db: Database, tail: string) {
  return db
    .query(
      "SELECT starlink_status, verified_wifi, verified_at FROM united_fleet WHERE tail_number = ?"
    )
    .get(tail) as {
    starlink_status: string | null;
    verified_wifi: string | null;
    verified_at: number | null;
  };
}

const STATS: FleetStats = {
  express: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
  mainline: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
};

describe("qatarTypeToStarlink", () => {
  test.each<[string, "confirmed" | "negative" | null]>([
    ["Boeing 777-3DZ(ER)", "confirmed"],
    ["Boeing 777-2DZ(LR)", "confirmed"],
    ["Boeing 777-367(ER)", "confirmed"],
    ["Airbus A350-941", "confirmed"],
    ["Airbus A350-1041", "confirmed"],
    ["Boeing 777-FDZ", "negative"],
    ["Boeing 777-F", "negative"],
    ["Airbus A320-232", "negative"],
    ["Airbus A321-231", "negative"],
    ["Airbus A380-861", "negative"],
    ["Boeing 737 MAX 8", "negative"], // QR's MAX fleet is real and non-Starlink
    ["Boeing 787-8 Dreamliner", null], // rollout in progress — per-tail, not type
    ["Boeing 787-9", null],
    ["B77W", null], // IATA-style drift must not mass-flip the fleet
    ["garbage", null],
    ["", null],
  ])("%s → %p", (type, want) => {
    expect(qatarTypeToStarlink(type)).toBe(want);
  });
});

describe("hawaiianTypeToStarlink", () => {
  test.each<[string | null | undefined, "Starlink" | "None" | "pending" | null]>([
    ["Airbus A330-243", "Starlink"],
    ["A332", "Starlink"],
    ["Airbus A321-271N", "Starlink"],
    ["A21N", "Starlink"],
    ["Boeing 787-9", "pending"],
    ["Boeing 717-22A", "None"], // recognized non-Starlink type — real negative
    ["B712", "None"],
    ["Boeing 737 MAX 9", null], // unrecognized — not negative evidence
    ["garbage", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%p → %p", (type, want) => {
    expect(hawaiianTypeToStarlink(type)).toBe(want);
  });
});

describe("alaska-verifier checkOne", () => {
  const STALE_AT = Math.floor(Date.now() / 1000) - 30 * 86400;

  const failingStatus = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetchAlaskaFlightStatus;
  const notPublishedStatus = (async () => null) as unknown as typeof fetchAlaskaFlightStatus;
  const stubStatus = (tail: string, type: string) =>
    (async (): Promise<AlaskaFlightStatus> => ({
      flightNumber: "HA123",
      tailNumber: tail,
      carrierCode: "HA",
      equipmentType: type,
      equipmentName: null,
      operatingAirlineCode: "HA",
      isHawaiian: true,
      codeshares: [],
    })) as unknown as typeof fetchAlaskaFlightStatus;

  function setupTarget(db: Database, airline: "AS" | "HA", tail: string, type: string) {
    addFleet(db, tail, "unknown", { airline, aircraftType: type, verifiedAt: STALE_AT });
    addFlight(db, tail, `${airline}123`, "SEA", Math.floor(Date.now() / 1000) + 6 * 3600, {
      arrivalAirport: "PDX",
      airline,
    });
  }

  test("transport failure: no verified_at touch, no status change, log row carries the error", async () => {
    const db = makeSyntheticDb();
    setupTarget(db, "AS", "N644AS", "Boeing 737-890");

    const result = await checkOne(db, "AS", failingStatus);

    expect(result).toBe("error");
    const row = fleetRow(db, "N644AS");
    expect(row.verified_at).toBe(STALE_AT); // untouched — next tick retries
    expect(row.starlink_status).toBe("unknown");
    const log = db
      .query("SELECT has_starlink, error FROM starlink_verification_log WHERE tail_number = ?")
      .get("N644AS") as { has_starlink: number | null; error: string | null };
    expect(log.has_starlink).toBeNull();
    expect(log.error).toBe("fetch_failed");
    db.close();
  });

  test("published-but-empty IS an observation: defers ~7 days, no starvation loop", async () => {
    const db = makeSyntheticDb();
    setupTarget(db, "AS", "N644AS", "Boeing 737-890");

    const result = await checkOne(db, "AS", notPublishedStatus);

    expect(result).toBe("not_published");
    const row = fleetRow(db, "N644AS");
    expect(row.verified_at).toBeGreaterThan(STALE_AT); // touched — back of the queue
    expect(row.starlink_status).toBe("unknown");
    const log = db
      .query("SELECT error FROM starlink_verification_log WHERE tail_number = ?")
      .get("N644AS") as { error: string | null };
    expect(log.error).toBe("not_published");
    db.close();
  });

  test("unrecognized HA type: no negative settle, no verified_wifi", async () => {
    const db = makeSyntheticDb();
    setupTarget(db, "HA", "N999HA", "Airbus A330-243");

    await checkOne(db, "HA", stubStatus("N999HA", "Boeing 737 MAX 10"));

    const row = fleetRow(db, "N999HA");
    expect(row.starlink_status).toBe("unknown"); // never 'negative' from an unknown type
    expect(row.verified_wifi).toBeNull();
    db.close();
  });

  test("recognized non-Starlink HA type still settles negative", async () => {
    const db = makeSyntheticDb();
    setupTarget(db, "HA", "N488HA", "Boeing 717-22A");

    await checkOne(db, "HA", stubStatus("N488HA", "Boeing 717-22A"));

    const row = fleetRow(db, "N488HA");
    expect(row.starlink_status).toBe("negative");
    expect(row.verified_wifi).toBe("None");
    db.close();
  });
});

describe("ingestQatarSchedule", () => {
  const OLD_STAMP = "2026-01-01T00:00:00.000Z";

  function seedQatar(db: Database) {
    setMeta(db, "lastUpdated", OLD_STAMP, "QR");
    // Departed >2h ago — prune bait. QR1 on DOH-LHR, QR8 on DOH-JFK.
    addQatarRow(db, "QR1", utc("2026-01-01T08:00:00Z"), "Starlink", { flightStatus: "ARRIVED" });
    addQatarRow(db, "QR8", utc("2026-01-01T08:00:00Z"), "Starlink", {
      arrivalAirport: "JFK",
      flightStatus: "ARRIVED",
    });
  }

  test("all fetches fail: meta untouched, table untouched", async () => {
    const db = makeSyntheticDb();
    seedQatar(db);
    const allFail = (async () => null) as unknown as typeof fetchByRoute;

    const stats = await ingestQatarSchedule(db, allFail);

    expect(stats.outcome).toBe("error");
    expect(stats.routes_failed).toBe(stats.routes_attempted);
    expect(getMeta(db, "lastUpdated", "QR")).toBe(OLD_STAMP);
    expect(db.query("SELECT COUNT(*) AS n FROM qatar_schedule").get()).toEqual({ n: 2 });
    db.close();
  });

  test("partial success: meta stamped; only the fetched route is pruned", async () => {
    const db = makeSyntheticDb();
    seedQatar(db);
    // ROUTES[0] is DOH→JFK: succeed only its first call, fail everything else.
    let calls = 0;
    const oneSuccess = (async (): Promise<QatarFlight[] | null> => {
      calls++;
      if (calls > 1) return null;
      return [
        {
          flightNumber: "0007",
          equipmentCode: "77W",
          departureAirport: "DOH",
          arrivalAirport: "JFK",
          flightStatus: "SCHEDULED",
          scheduledDeparture: Math.floor(Date.now() / 1000) + 6 * 3600,
          scheduledArrival: Math.floor(Date.now() / 1000) + 20 * 3600,
        },
      ];
    }) as unknown as typeof fetchByRoute;

    const stats = await ingestQatarSchedule(db, oneSuccess);

    expect(stats.outcome).toBe("partial");
    expect(stats.flights_upserted).toBe(1);
    expect(getMeta(db, "lastUpdated", "QR")).not.toBe(OLD_STAMP);
    expect(stats.pruned).toBe(1); // QR8 on the fetched DOH-JFK route
    // QR1's route (DOH-LHR) failed this run — its stale row must survive.
    const survivor = db
      .query("SELECT COUNT(*) AS n FROM qatar_schedule WHERE flight_number = 'QR1'")
      .get() as { n: number };
    expect(survivor.n).toBe(1);
    db.close();
  });
});

describe("updateDatabase roster floor", () => {
  function seedSheetRows(db: Database, n: number) {
    const stmt = db.prepare(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, airline)
       VALUES ('Boeing 737-900', 'Starlink', '100', 'B737', '2026-01-01', ?, 'United Airlines', 'mainline', 'UA')`
    );
    for (let i = 0; i < n; i++) stmt.run(`N${10000 + i}`);
  }

  function parsedRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      TailNumber: `N${20000 + i}`,
      Aircraft: "Boeing 737-900",
      WiFi: "Starlink",
      sheet_gid: "100",
      sheet_type: "B737",
      fleet: "mainline" as const,
      OperatedBy: "United Airlines",
    }));
  }

  function sheetCount(db: Database): number {
    return (
      db
        .query(`SELECT COUNT(*) AS n FROM starlink_planes WHERE ${SHEET_ROSTER_WHERE}`)
        .get("UA") as { n: number }
    ).n;
  }

  // (existing sheet rows, parsed rows, expect the replace to proceed)
  test.each<[number, number, boolean]>([
    [30, 0, false], // 200-with-HTML body parses to 0 rows
    [100, 49, false], // just under the 50% shrink rule
    [100, 50, true], // exactly 50% passes
    [15, 5, true], // small roster (≤20): relative rule off
    [0, 10, true], // bootstrap on an empty roster
    [0, 0, false], // non-empty floor still applies
  ])("existing=%i parsed=%i → replaced=%p", (existing, parsed, replaced) => {
    const db = makeSyntheticDb();
    seedSheetRows(db, existing);
    setMeta(db, "lastUpdated", "OLD", "UA");

    const refusal = updateDatabase(db, 900, parsedRows(parsed), STATS, "UA");

    expect(refusal === null).toBe(replaced);
    expect(sheetCount(db)).toBe(replaced ? parsed : existing);
    expect(getMeta(db, "lastUpdated", "UA") === "OLD").toBe(!replaced);
    db.close();
  });
});

describe("runSheetScrape refusal still runs maintenance", () => {
  test("refused roster replace: outcome=refused, type-deterministic reconcile still ran", async () => {
    const db = makeSyntheticDb();
    // QR A350 with unsettled status — reconcile should confirm it even when
    // the UA sheet parse is refused.
    addFleet(db, "A7-ALA", "unknown", { airline: "QR", aircraftType: "Airbus A350-941" });
    const emptySheets = (async () => ({
      totalAircraftCount: 900,
      starlinkAircraft: [],
      fleetStats: STATS,
    })) as unknown as typeof fetchAllSheets;

    const result = await runSheetScrape(db, emptySheets);

    expect(result.outcome).toBe("refused");
    expect(fleetRow(db, "A7-ALA").starlink_status).toBe("confirmed");
    db.close();
  });

  test("sheet fetch throwing: outcome=error", async () => {
    const db = makeSyntheticDb();
    const throwingSheets = (async () => {
      throw new Error("sheets down");
    }) as unknown as typeof fetchAllSheets;

    const result = await runSheetScrape(db, throwingSheets);

    expect(result.outcome).toBe("error");
    db.close();
  });
});

describe("resolveFlightVerdict under FR24 failure", () => {
  const failingLookup = () => Promise.reject(new Fr24UnavailableError("FR24 down"));

  test("lookup failure degrades to prediction with outcome=error", async () => {
    const db = makeSyntheticDb();
    const reader = createReaderFactory(db)("UA");
    const now = utc("2027-06-09T12:00:00Z");

    const verdict = await resolveFlightVerdict(AIRLINES.UA, reader, "9999", "2027-06-09", {
      now,
      lookupTail: failingLookup,
      predict: stubPredict(0),
    });

    if (verdict.kind !== "prediction") throw new Error(`expected prediction, got ${verdict.kind}`);
    expect(verdict.fr24Error).toBe(true);
    expect(verdictTelemetry(verdict)).toEqual({ outcome: "error", confidence: "none" });
    db.close();
  });

  test("FR24 reachable but empty stays no_data, not error", async () => {
    const db = makeSyntheticDb();
    const reader = createReaderFactory(db)("UA");
    const now = utc("2027-06-09T12:00:00Z");

    const verdict = await resolveFlightVerdict(AIRLINES.UA, reader, "9999", "2027-06-09", {
      now,
      lookupTail: () => Promise.resolve([]),
      predict: stubPredict(0),
    });

    if (verdict.kind !== "prediction") throw new Error(`expected prediction, got ${verdict.kind}`);
    expect(verdict.fr24Error).toBe(false);
    expect(verdictTelemetry(verdict)).toEqual({ outcome: "no_data", confidence: "none" });
    db.close();
  });

  test("informative prediction during an outage keeps its confidence, outcome=error", async () => {
    const db = makeSyntheticDb();
    const reader = createReaderFactory(db)("UA");
    const now = utc("2027-06-09T12:00:00Z");

    const verdict = await resolveFlightVerdict(AIRLINES.UA, reader, "9999", "2027-06-09", {
      now,
      lookupTail: failingLookup,
      predict: stubPredict(12),
    });

    if (verdict.kind !== "prediction") throw new Error(`expected prediction, got ${verdict.kind}`);
    expect(verdictTelemetry(verdict)).toEqual({ outcome: "error", confidence: "low" });
    db.close();
  });

  test("non-FR24 errors propagate — a DB error must not masquerade as an outage", async () => {
    const db = makeSyntheticDb();
    const reader = createReaderFactory(db)("UA");
    const now = utc("2027-06-09T12:00:00Z");

    await expect(
      resolveFlightVerdict(AIRLINES.UA, reader, "9999", "2027-06-09", {
        now,
        lookupTail: () => Promise.reject(new Error("db broke")),
        predict: stubPredict(0),
      })
    ).rejects.toThrow("db broke");
    db.close();
  });
});
