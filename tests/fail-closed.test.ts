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
import {
  fetchByFlight as qatarFetchByFlight,
  fetchByRoute as qatarFetchByRoute,
} from "../src/api/qatar-status";
import {
  SHEET_ROSTER_WHERE,
  addDiscoveredStarlinkPlane,
  countQatarForwardSchedule,
  getHubStats,
  getMeta,
  getNextAlaskaVerifyTarget,
  getNextPlanesToVerify,
  getVerificationObservations,
  reconcileTypeDeterministicFleets,
  recordQatarFetchCoverage,
  setMeta,
  updateDatabase,
  upsertFleetAircraft,
  upsertQatarEquipmentHistory,
} from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { checkOne } from "../src/scripts/alaska-verifier";
import { ingestQatarSchedule } from "../src/scripts/qatar-schedule-ingester";
import { runSheetScrape } from "../src/scripts/sheet-scrape";
import type { FleetStats } from "../src/types";
import { isInSpreadsheetCache, updateSpreadsheetCache } from "../src/utils/utils";
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
    ["Airbus A330-202", "negative"], // covered by the canonical family table
    ["Airbus A380-861", "negative"],
    ["Boeing 737 MAX 8", "negative"], // QR's MAX fleet is real and non-Starlink
    ["Boeing 787-8 Dreamliner", "confirmed"], // sub-fleet complete Aug 2026
    ["Boeing 787-9", null], // rollout in progress — per-tail, not type
    ["Boeing 787", null], // no sub-variant → no phase row, never a guess
    ["B788", null],
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

describe("getVerificationObservations", () => {
  test("excludes error rows and empty wifi_provider (consensus parity)", () => {
    const db = makeSyntheticDb();
    const now = Math.floor(Date.now() / 1000);
    const ins = db.query(
      `INSERT INTO starlink_verification_log
         (tail_number, flight_number, source, has_starlink, wifi_provider, error, checked_at, airline)
       VALUES (?, ?, 'united', ?, ?, ?, ?, 'UA')`
    );
    ins.run("N111UA", "UA1", 1, "Starlink", null, now); // clean positive
    ins.run("N222UA", "UA2", 0, "", null, now); // scrape missed the wifi section — noise
    ins.run("N333UA", "UA3", 0, "Panasonic", "timeout", now); // errored check — noise
    ins.run("N444UA", "UA4", 0, "Panasonic", null, now); // clean negative

    const tails = getVerificationObservations(db, "UA").map((o) => o.tail_number);
    expect(tails).toContain("N111UA");
    expect(tails).toContain("N444UA");
    expect(tails).not.toContain("N222UA");
    expect(tails).not.toContain("N333UA");
    db.close();
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

  test("mapped airport never probes +1 — skew retry is the prior day only", async () => {
    const db = makeSyntheticDb();
    setupTarget(db, "AS", "N644AS", "Boeing 737-890"); // SEA — mapped

    const tried: string[] = [];
    const stub = (async (_fn: string, date: string) => {
      tried.push(date);
      return null;
    }) as unknown as typeof fetchAlaskaFlightStatus;

    const result = await checkOne(db, "AS", stub);

    expect(result).toBe("not_published");
    expect(tried.length).toBe(2);
    expect(tried[1] < tried[0]).toBe(true); // second probe is D-1, never D+1
    db.close();
  });

  test("unmapped eastern airport, early-local-morning departure: +1 day retry resolves", async () => {
    const db = makeSyntheticDb();
    addFleet(db, "N654QX", "unknown", {
      airline: "AS",
      aircraftType: "E175",
      verifiedAt: STALE_AT,
    });
    // 05:30Z = 21:30 the PREVIOUS day in the LA fallback zone, but 00:30 on
    // the UTC date at an unmapped eastern station — the published local date
    // is one day AFTER the computed fallback date.
    addFlight(db, "N654QX", "AS123", "ZZZ", utc("2027-01-15T05:30:00Z"), { airline: "AS" });

    const tried: string[] = [];
    const stub = (async (_fn: string, date: string): Promise<AlaskaFlightStatus | null> => {
      tried.push(date);
      if (date !== "2027-01-15") return null;
      return {
        flightNumber: "AS123",
        tailNumber: "N654QX",
        carrierCode: "AS",
        equipmentType: "E175",
        equipmentName: null,
        operatingAirlineCode: "QX",
        isHawaiian: false,
        codeshares: [],
      };
    }) as unknown as typeof fetchAlaskaFlightStatus;

    const result = await checkOne(db, "AS", stub);

    expect(tried).toEqual(["2027-01-14", "2027-01-13", "2027-01-15"]);
    expect(result).toBe("success");
    expect(fleetRow(db, "N654QX").starlink_status).toBe("confirmed");
    db.close();
  });
});

describe("qatar-status errorObject responses", () => {
  // 200-with-errorObject is the API's in-band failure channel. Anything other
  // than FS_NOT_FOUND must be null (outage → ingester's routes_failed gate),
  // never a success-shaped [] that prunes rows and stamps QR lastUpdated.
  const jsonFetch = (body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

  test("non-FS_NOT_FOUND errorObject → null; FS_NOT_FOUND → empty success", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = jsonFetch({ errorObject: [{ errorName: "SYSTEM_ERROR" }] });
      expect(await qatarFetchByRoute("DOH", "LHR", "2026-06-05")).toBeNull();
      expect(await qatarFetchByFlight(1, "2026-06-05")).toBeNull();

      globalThis.fetch = jsonFetch({ errorObject: [{ errorName: "FS_NOT_FOUND" }] });
      expect(await qatarFetchByRoute("DOH", "LHR", "2026-06-05")).toEqual([]);
      expect(await qatarFetchByFlight(1, "2026-06-05")).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("ingestQatarSchedule", () => {
  const OLD_STAMP = "2026-01-01T00:00:00.000Z";

  function seedQatar(db: Database) {
    setMeta(db, "lastUpdated", OLD_STAMP, "QR");
    // Departed 10h ago: past the route-scoped 2h prune, inside the global 48h
    // backstop. QR1 on DOH-LHR, QR8 on DOH-JFK.
    const departed = Math.floor(Date.now() / 1000) - 10 * 3600;
    addQatarRow(db, "QR1", departed, "Starlink", { flightStatus: "ARRIVED" });
    addQatarRow(db, "QR8", departed, "Starlink", {
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

describe("ingestQatarSchedule: history, coverage, breaker", () => {
  // 11:00 in Doha → DOH dates 2026-09-19 (+0), -20 (+1), -21.. (far).
  const NOW_MS = Date.parse("2026-09-19T08:00:00Z");
  const NOW_SEC = NOW_MS / 1000;
  const run = (
    db: Database,
    fetch: typeof fetchByRoute,
    nowMs = NOW_MS,
    ctx?: Parameters<typeof ingestQatarSchedule>[2]
  ) => ingestQatarSchedule(db, fetch, ctx, { now: nowMs, delayMs: 0 });

  const flight = (
    fn: string,
    eq: string,
    depSec: number,
    extra: Partial<QatarFlight> = {}
  ): QatarFlight => ({
    flightNumber: fn,
    carrier: "QR",
    mktFlightNumber: fn,
    equipmentCode: eq,
    departureAirport: "DOH",
    arrivalAirport: "LHR",
    flightStatus: "SCHEDULED",
    scheduledDeparture: depSec,
    scheduledArrival: depSec + 7 * 3600,
    ...extra,
  });

  /** Answers DOH-LHR from `lhr`, every other call with [] (or null). */
  function stub(
    lhr: (date: string) => QatarFlight[] | null,
    other: QatarFlight[] | null = []
  ): { fetch: typeof fetchByRoute; calls: Array<[string, string, string]> } {
    const calls: Array<[string, string, string]> = [];
    const fetch = (async (o: string, d: string, date: string) => {
      calls.push([o, d, date]);
      return o === "DOH" && d === "LHR" ? lhr(date) : other;
    }) as unknown as typeof fetchByRoute;
    return { fetch, calls };
  }

  const depOn = (date: string) => Date.parse(`${date}T06:40:00Z`) / 1000;
  const count = (db: Database, table: string) =>
    (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  test("dates per route are +0, +1 and a far offset that rotates only after a good run", async () => {
    const db = makeSyntheticDb();
    const first = stub(() => []);
    const s1 = await run(db, first.fetch);
    expect(s1.far_offset).toBe(2);
    expect(first.calls.filter(([o, d]) => o === "DOH" && d === "JFK").map((c) => c[2])).toEqual([
      "2026-09-19",
      "2026-09-20",
      "2026-09-21",
    ]);
    const second = stub(() => []);
    expect((await run(db, second.fetch)).far_offset).toBe(3);
    const failing = stub(() => null, null);
    expect((await run(db, failing.fetch)).outcome).toBe("error");
    const after = stub(() => []);
    expect((await run(db, after.fetch)).far_offset).toBe(4);
  });

  test("other carriers, codeshares and freighters are skipped in both tables", async () => {
    const db = makeSyntheticDb();
    const dep = depOn("2026-09-20");
    const { fetch } = stub((date) =>
      date === "2026-09-20"
        ? [
            flight("001", "77W", dep),
            flight("123", "77W", dep + 600, { carrier: "BA" }),
            flight("5001", "77W", dep + 900, { mktFlightNumber: "0003" }),
            flight("8001", "77F", dep + 1200),
          ]
        : []
    );
    const s = await run(db, fetch);
    expect(s.flights_upserted).toBe(1);
    expect(db.query("SELECT flight_number FROM qatar_schedule").all()).toEqual([
      { flight_number: "QR1" },
    ]);
    const history = db
      .query(
        "SELECT flight_number, service_date, fetch_origin, fetch_date FROM qatar_equipment_history"
      )
      .all();
    expect(history).toEqual([
      {
        flight_number: "QR1",
        service_date: "2026-09-20",
        fetch_origin: "DOH",
        fetch_date: "2026-09-20",
      },
    ]);
  });

  test("a total failure writes no prune, no stamp and no cursor advance", async () => {
    const db = makeSyntheticDb();
    setMeta(db, "lastUpdated", "2026-01-01T00:00:00.000Z", "QR");
    upsertQatarEquipmentHistory(
      db,
      {
        flight_number: "QR1",
        departure_airport: "DOH",
        service_date: "2026-06-01",
        arrival_airport: "LHR",
        departure_time: depOn("2026-06-01"),
        arrival_time: null,
        equipment_code: "77W",
        flight_status: "ARRIVED",
        fetch_origin: "DOH",
        fetch_destination: "LHR",
        fetch_date: "2026-06-01",
      },
      NOW_SEC
    );
    recordQatarFetchCoverage(db, "DOH", "LHR", "2026-06-01", NOW_SEC);
    addQatarRow(db, "QR914", NOW_SEC - 5 * 86400, "Starlink", {
      departureAirport: "ADL",
      arrivalAirport: "AKL",
    });
    const s = await run(db, stub(() => null, null).fetch);
    expect(s.outcome).toBe("error");
    expect(getMeta(db, "lastUpdated", "QR")).toBe("2026-01-01T00:00:00.000Z");
    expect(getMeta(db, "qatarFarOffsetCursor", "QR")).toBeNull();
    expect(count(db, "qatar_equipment_history")).toBe(1);
    expect(count(db, "qatar_fetch_coverage")).toBe(1);
    expect(count(db, "qatar_schedule")).toBe(1);
  });

  test("a partial run prunes: global 48h schedule backstop, 60d history, 10d coverage", async () => {
    const db = makeSyntheticDb();
    addQatarRow(db, "QR914", NOW_SEC - 5 * 86400, "Starlink", {
      departureAirport: "ADL",
      arrivalAirport: "AKL",
    });
    recordQatarFetchCoverage(db, "DOH", "LHR", "2026-09-01", NOW_SEC);
    let n = 0;
    const s = await run(db, (async () =>
      n++ % 2 === 0 ? [] : null) as unknown as typeof fetchByRoute);
    expect(s.outcome).toBe("partial");
    expect(count(db, "qatar_schedule")).toBe(0);
    expect(count(db, "qatar_fetch_coverage")).toBeGreaterThan(0);
    expect(
      db
        .query("SELECT COUNT(*) AS n FROM qatar_fetch_coverage WHERE fetch_date = '2026-09-01'")
        .get()
    ).toEqual({ n: 0 });
  });

  test("breaker: a dead upstream stops at 15 calls", async () => {
    const s = await run(makeSyntheticDb(), stub(() => null, null).fetch);
    expect(s.routes_attempted).toBe(15);
    expect(s.breaker_tripped).toBe(true);
    expect(s.outcome).toBe("error");
  });

  test("breaker: a null streak after successes does not stop at 15", async () => {
    let n = 0;
    const s = await run(makeSyntheticDb(), (async () =>
      n++ < 20 ? [] : null) as unknown as typeof fetchByRoute);
    expect(s.routes_attempted).toBe(60);
    expect(s.breaker_tripped).toBe(true);
    expect(s.outcome).toBe("partial");
  });

  test("breaker: a >50% failure ratio stops after 60 attempts", async () => {
    let n = 0;
    const s = await run(makeSyntheticDb(), (async () =>
      n++ % 5 < 3 ? null : []) as unknown as typeof fetchByRoute);
    expect(s.breaker_tripped).toBe(true);
    expect(s.routes_attempted).toBeGreaterThanOrEqual(60);
    expect(s.routes_attempted).toBeLessThanOrEqual(62);
    expect(s.outcome).toBe("partial");
  });

  test("healthy runs never trip the breaker", async () => {
    const s = await run(makeSyntheticDb(), stub(() => []).fetch);
    expect(s.breaker_tripped).toBe(false);
    expect(s.routes_attempted).toBe(384);
  });

  test("an abandoned run writes no history or coverage", async () => {
    const db = makeSyntheticDb();
    const { fetch } = stub(() => [flight("001", "77W", depOn("2026-09-20"))]);
    const ctx = { isCurrent: () => false } as unknown as Parameters<typeof ingestQatarSchedule>[2];
    const s = await run(db, fetch, NOW_MS, ctx);
    expect(s.outcome).toBe("abandoned");
    expect(count(db, "qatar_equipment_history")).toBe(0);
    expect(count(db, "qatar_fetch_coverage")).toBe(0);
  });

  test("a re-fetch that drops a future flight marks it stale; coverage only for successes", async () => {
    const db = makeSyntheticDb();
    const dep = depOn("2026-09-20");
    const both = stub((date) =>
      date === "2026-09-20" ? [flight("001", "77W", dep), flight("003", "388", dep + 3600)] : []
    );
    await run(db, both.fetch);
    // Second run: DOH-LHR drops QR3; DOH-JFK fails; everything else is empty.
    const onlyQR1 = (async (o: string, d: string, date: string) => {
      if (o === "DOH" && d === "JFK") return null;
      if (o === "DOH" && d === "LHR" && date === "2026-09-20") return [flight("001", "77W", dep)];
      return [];
    }) as unknown as typeof fetchByRoute;
    const s = await run(db, onlyQR1, NOW_MS + 3600_000);
    expect(s.history_staled).toBe(1);
    const stale = db
      .query("SELECT flight_number FROM qatar_equipment_history WHERE stale_at IS NOT NULL")
      .all();
    expect(stale).toEqual([{ flight_number: "QR3" }]);
    const coveredNow = (o: string, d: string) =>
      (
        db
          .query(
            "SELECT COUNT(*) AS n FROM qatar_fetch_coverage WHERE origin = ? AND destination = ? AND fetched_at = ?"
          )
          .get(o, d, NOW_SEC + 3600) as { n: number }
      ).n;
    expect(coveredNow("DOH", "LHR")).toBe(3);
    expect(coveredNow("DOH", "JFK")).toBe(0);
  });

  test("meta schedule counters equal the forward table", async () => {
    const db = makeSyntheticDb();
    const { fetch } = stub((date) =>
      date === "2026-09-20"
        ? [flight("001", "77W", depOn(date)), flight("003", "388", depOn(date) + 60)]
        : []
    );
    await run(db, fetch);
    const forward = countQatarForwardSchedule(db, NOW_SEC);
    expect(forward.total).toBe(2);
    expect(Number(getMeta(db, "scheduleFlights", "QR"))).toBe(forward.total);
    expect(Number(getMeta(db, "scheduleStarlink", "QR"))).toBe(forward.Starlink);
    expect(Number(getMeta(db, "scheduleNone", "QR"))).toBe(forward.None);
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

describe("type-settled is not verified", () => {
  test("first HA reconcile: status settles, no verification-grade stamps, no install spike", () => {
    const db = makeSyntheticDb();
    addFleet(db, "N380HA", "unknown", {
      airline: "HA",
      aircraftType: "Airbus A330-243",
      verifiedAt: null,
    });
    addFleet(db, "N488HA", "unknown", {
      airline: "HA",
      aircraftType: "Boeing 717-22A",
      verifiedAt: null,
    });

    expect(reconcileTypeDeterministicFleets(db)).toBe(2);

    const a330 = fleetRow(db, "N380HA");
    expect(a330.starlink_status).toBe("confirmed");
    expect(a330.verified_at).toBeNull(); // NOT stamped — verifier still owes a real check
    expect(fleetRow(db, "N488HA").starlink_status).toBe("negative");

    const sp = db
      .query(
        `SELECT sheet_gid, sheet_type, DateFound, verified_wifi, verified_at
         FROM starlink_planes WHERE TailNumber = 'N380HA'`
      )
      .get() as Record<string, string | null>;
    expect(sp.sheet_gid).toBe("type_deterministic");
    expect(sp.sheet_type).toBe("type_deterministic");
    expect(sp.DateFound).toBeNull(); // no fabricated deploy-day rollout cliff
    expect(sp.verified_wifi).toBeNull(); // type rule ≠ per-tail verification
    expect(sp.verified_at).toBeNull();

    // negative settles never enter starlink_planes
    const neg = db
      .query("SELECT COUNT(*) AS n FROM starlink_planes WHERE TailNumber = 'N488HA'")
      .get() as { n: number };
    expect(neg.n).toBe(0);

    // counts as equipped, but not as a 30-day install
    const hub = getHubStats(db, ["HA"]);
    expect(hub[0].starlink).toBe(1);
    expect(hub[0].installs30d).toBe(0);
    db.close();
  });

  test("verify queue serves type-settled (verified_at NULL) tails before stale ones", () => {
    const db = makeSyntheticDb();
    const now = Math.floor(Date.now() / 1000);
    addFleet(db, "N532AS", "confirmed", {
      airline: "AS",
      aircraftType: "Embraer ERJ-175LR",
      verifiedAt: null,
    });
    addFleet(db, "N533AS", "confirmed", {
      airline: "AS",
      aircraftType: "Embraer ERJ-175LR",
      verifiedAt: now - 30 * 86400,
    });
    addFlight(db, "N532AS", "AS2301", "SEA", now + 6 * 3600, { airline: "AS" });
    addFlight(db, "N533AS", "AS2302", "SEA", now + 6 * 3600, { airline: "AS" });

    expect(getNextAlaskaVerifyTarget(db, "AS")?.tail_number).toBe("N532AS");
    db.close();
  });
});

describe("seed evidence tiers (set E NULL-stamp convention)", () => {
  test("type_rule seed: status settles, verified stamps NULL, verifier-eligible", () => {
    const db = makeSyntheticDb();
    upsertFleetAircraft(db, "N777QX", "Embraer E175", "as_seed", "horizon", "Horizon Air", "AS", {
      starlinkStatus: "confirmed",
      verifiedWifi: null,
      evidence: "type_rule",
    });

    const row = db
      .query(
        "SELECT starlink_status, verified_wifi, verified_at, next_check_after FROM united_fleet WHERE tail_number = 'N777QX'"
      )
      .get() as {
      starlink_status: string;
      verified_wifi: string | null;
      verified_at: number | null;
      next_check_after: number;
    };
    expect(row.starlink_status).toBe("confirmed");
    expect(row.verified_wifi).toBeNull();
    expect(row.verified_at).toBeNull();
    expect(row.next_check_after).toBe(0); // not parked — verifier picks it up

    const queue = getNextPlanesToVerify(db, 50, "AS").map((p) => p.tail_number);
    expect(queue).toContain("N777QX");

    // starlink_planes side: no DateFound (would fabricate a rollout cliff)
    // and no verified_* stamps, even when a sheetGid is supplied.
    addDiscoveredStarlinkPlane(db, "N777QX", "Embraer E175", "Starlink", "Horizon Air", "horizon", {
      sheetGid: "as_seed",
      airline: "AS",
      evidence: "type_rule",
    });
    const sp = db
      .query(
        "SELECT DateFound, verified_wifi, verified_at, sheet_gid FROM starlink_planes WHERE TailNumber = 'N777QX'"
      )
      .get() as {
      DateFound: string | null;
      verified_wifi: string | null;
      verified_at: number | null;
      sheet_gid: string;
    };
    expect(sp.DateFound).toBeNull();
    expect(sp.verified_wifi).toBeNull();
    expect(sp.verified_at).toBeNull();
    expect(sp.sheet_gid).toBe("as_seed");
    db.close();
  });

  test("type_rule seed settling an existing unknown row also leaves stamps NULL", () => {
    const db = makeSyntheticDb();
    addFleet(db, "N778QX", "unknown", {
      airline: "AS",
      aircraftType: "Embraer E175",
      verifiedAt: null,
    });
    upsertFleetAircraft(db, "N778QX", "Embraer E175", "as_seed", "horizon", "Horizon Air", "AS", {
      starlinkStatus: "confirmed",
      verifiedWifi: null,
      evidence: "type_rule",
    });
    const row = fleetRow(db, "N778QX");
    expect(row.starlink_status).toBe("confirmed");
    expect(row.verified_wifi).toBeNull();
    expect(row.verified_at).toBeNull();
    db.close();
  });

  test("observed seed (FlyerTalk-style) keeps observation semantics: stamps + parking", () => {
    const db = makeSyntheticDb();
    upsertFleetAircraft(
      db,
      "A7-ALX",
      "Airbus A350-941",
      "flyertalk_qr",
      "mainline",
      "Qatar Airways",
      "QR",
      { starlinkStatus: "confirmed", verifiedWifi: "Starlink", evidence: "observed" }
    );
    const row = db
      .query(
        "SELECT starlink_status, verified_wifi, verified_at, next_check_after FROM united_fleet WHERE tail_number = 'A7-ALX'"
      )
      .get() as {
      starlink_status: string;
      verified_wifi: string | null;
      verified_at: number | null;
      next_check_after: number;
    };
    expect(row.starlink_status).toBe("confirmed");
    expect(row.verified_wifi).toBe("Starlink");
    expect(row.verified_at).not.toBeNull();
    expect(row.next_check_after).toBeGreaterThan(Math.floor(Date.now() / 1000)); // parked
    db.close();
  });

  test("addDiscoveredStarlinkPlane without evidence throws at runtime", () => {
    // Ad-hoc callers (bun -e, untyped scripts) bypass tsc; a silent
    // 'observed' default is the rollout-cliff fabrication path.
    const db = makeSyntheticDb();
    expect(() =>
      addDiscoveredStarlinkPlane(db, "N779QX", "Embraer E175", "Starlink", null, "horizon", {
        airline: "AS",
      } as Parameters<typeof addDiscoveredStarlinkPlane>[6])
    ).toThrow(/evidence/);
    expect(
      db.query("SELECT COUNT(*) AS n FROM starlink_planes WHERE TailNumber = 'N779QX'").get()
    ).toEqual({ n: 0 });
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

    updateSpreadsheetCache(["N12345"]);
    const result = await runSheetScrape(db, emptySheets);

    expect(result.outcome).toBe("refused");
    expect(fleetRow(db, "A7-ALA").starlink_status).toBe("confirmed");
    // Cache shares the DB refusal decision — a refused replace must not
    // desync /api/fleet-discovery by emptying or replacing the cache.
    expect(isInSpreadsheetCache("N12345")).toBe(true);
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
