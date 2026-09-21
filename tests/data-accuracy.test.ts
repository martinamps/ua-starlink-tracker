/**
 * Data-layer accuracy fixes, each on a synthetic fixture shaped like the
 * production row that exposed it. Shapes and invariants, not live values.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { OBSERVED_WIFI_SOURCES } from "../src/airlines/registry";
import { logFlightAssignments } from "../src/database/assignment-log";
import {
  addDiscoveredStarlinkPlane,
  backfillAlaskaSkyWestOperator,
  computeWifiConsensus,
  demoteRetrofittedNegatives,
  getFirstFlights,
  getFleetPageData,
  getRouteFlightNumbers,
  isScheduledLeg,
  migrate,
  reconcileConsensus,
  recordFirstFlights,
  syncSpreadsheetToFleet,
} from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeSyntheticDb, openSnapshot, req } from "./helpers";

const NOW = Math.floor(Date.now() / 1000);

function check(db: Database, tail: string, at: number, provider: string) {
  db.query(
    `INSERT INTO starlink_verification_log
       (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, error, airline)
     VALUES (?, 'united', ?, ?, ?, 1, NULL, 'UA')`
  ).run(tail, at, provider === "Starlink" ? 1 : 0, provider);
}

const statusOf = (db: Database, tail: string) =>
  (
    db.query("SELECT starlink_status AS s FROM united_fleet WHERE tail_number = ?").get(tail) as {
      s: string;
    }
  ).s;

describe("a negative settle yields to a retrofit", () => {
  test("two newest clean checks on Starlink demote negative to unknown", () => {
    const db = makeSyntheticDb();
    addFleet(db, "N37532", "negative", { aircraftType: "Boeing 737-824" });
    for (const [d, p] of [
      [40, "Viasat"],
      [20, "Viasat"],
      [3, "Starlink"],
      [1, "Starlink"],
    ] as const) {
      check(db, "N37532", NOW - d * 86400, p);
    }
    // Retrofit not yet proven: newest check Starlink, the one before Viasat.
    addFleet(db, "N37440", "negative", { aircraftType: "Boeing 737-824" });
    check(db, "N37440", NOW - 5 * 86400, "Viasat");
    check(db, "N37440", NOW - 86400, "Starlink");

    expect(demoteRetrofittedNegatives(db, NOW)).toBe(1);
    expect(statusOf(db, "N37532")).toBe("unknown");
    expect(statusOf(db, "N37440")).toBe("negative");
    expect(demoteRetrofittedNegatives(db, NOW)).toBe(0);
    db.close();
  });

  test("checks outside the trailing window or on another airline don't demote", () => {
    const db = makeSyntheticDb();
    addFleet(db, "N1OLD", "negative");
    check(db, "N1OLD", NOW - 45 * 86400, "Starlink");
    check(db, "N1OLD", NOW - 40 * 86400, "Starlink");
    addFleet(db, "N2MIX", "negative");
    check(db, "N2MIX", NOW - 3 * 86400, "Starlink");
    db.query(
      `INSERT INTO starlink_verification_log
         (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, error, airline)
       VALUES ('N2MIX', 'united', ?, 1, 'Starlink', 1, NULL, 'AS')`
    ).run(NOW - 86400);
    expect(demoteRetrofittedNegatives(db, NOW)).toBe(0);
    db.close();
  });

  test("an errored newest check is skipped; unconfirmed tails and non-observing sources never count", () => {
    const db = makeSyntheticDb();
    const log = (
      tail: string,
      at: number,
      opts: { starlink?: boolean; error?: string; confirmed?: 0 | 1; source?: string } = {}
    ) =>
      db
        .query(
          `INSERT INTO starlink_verification_log
             (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, error, airline)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
        )
        .run(
          tail,
          opts.source ?? "united",
          at,
          opts.error ? null : opts.starlink === false ? 0 : 1,
          opts.error ? null : opts.starlink === false ? "Viasat" : "Starlink",
          opts.confirmed ?? 1,
          opts.error ?? null
        );
    addFleet(db, "N1ERR", "negative");
    log("N1ERR", NOW - 3 * 86400);
    log("N1ERR", NOW - 2 * 86400);
    log("N1ERR", NOW - 86400, { error: "timeout" });
    addFleet(db, "N2UNC", "negative");
    log("N2UNC", NOW - 3 * 86400);
    log("N2UNC", NOW - 86400, { confirmed: 0 });
    addFleet(db, "N3SRC", "negative");
    log("N3SRC", NOW - 3 * 86400);
    log("N3SRC", NOW - 86400, { source: "spreadsheet" });
    expect(OBSERVED_WIFI_SOURCES).not.toContain("spreadsheet");

    expect(demoteRetrofittedNegatives(db, NOW)).toBe(1);
    expect(statusOf(db, "N1ERR")).toBe("unknown");
    expect(statusOf(db, "N2UNC")).toBe("negative");
    expect(statusOf(db, "N3SRC")).toBe("negative");
    db.close();
  });

  test("a demotion queues a prompt re-check and clears the contradicting listing", () => {
    const db = makeSyntheticDb();
    addPlane(db, "N37532", "Viasat", { aircraft: "Boeing 737-824" });
    addFleet(db, "N37532", "negative", { aircraftType: "Boeing 737-824", verifiedWifi: "Viasat" });
    db.query(
      "UPDATE united_fleet SET next_check_after = ?, discovery_priority = 0.1 WHERE tail_number = 'N37532'"
    ).run(NOW + 30 * 86400);
    for (const d of [3, 1]) check(db, "N37532", NOW - d * 86400, "Starlink");
    expect(demoteRetrofittedNegatives(db, NOW)).toBe(1);
    expect(
      db
        .query(
          `SELECT f.starlink_status, f.verified_wifi AS fleet_wifi, f.next_check_after,
                  f.discovery_priority, sp.verified_wifi AS listing_wifi
           FROM united_fleet f JOIN starlink_planes sp ON sp.TailNumber = f.tail_number
           WHERE f.tail_number = 'N37532'`
        )
        .get()
    ).toEqual({
      starlink_status: "unknown",
      fleet_wifi: null,
      next_check_after: NOW,
      discovery_priority: 0.9,
      listing_wifi: null,
    });
    db.close();
  });

  test("the hourly sync → reconcile cycle reaches a fixed point", () => {
    const db = makeSyntheticDb();
    // The listing still says Viasat and the 30-day window leans Viasat, so
    // consensus alone would keep re-settling it; the newest two say Starlink.
    addPlane(db, "N37532", "Viasat", { aircraft: "Boeing 737-824" });
    addFleet(db, "N37532", "negative", { aircraftType: "Boeing 737-824", verifiedWifi: "Viasat" });
    for (const d of [25, 22, 18, 12, 8]) check(db, "N37532", NOW - d * 86400, "Viasat");
    for (const d of [3, 1]) check(db, "N37532", NOW - d * 86400, "Starlink");

    const state = () =>
      db
        .query(
          `SELECT f.starlink_status, f.next_check_after, sp.verified_wifi FROM united_fleet f
           JOIN starlink_planes sp ON sp.TailNumber = f.tail_number AND sp.airline = f.airline
           WHERE f.tail_number = 'N37532'`
        )
        .get();
    const cycle = (at: number) => {
      syncSpreadsheetToFleet(db, "UA");
      return reconcileConsensus(db, at);
    };

    expect(cycle(NOW)).toBeGreaterThan(0);
    const settled = state();
    expect(settled).toMatchObject({ starlink_status: "unknown", verified_wifi: null });
    for (const hour of [1, 2, 3]) {
      expect(cycle(NOW + hour * 3600)).toBe(0);
      expect(state()).toEqual(settled);
    }
    db.close();
  });
});

describe("the batched consensus sweep agrees with the per-tail settle", () => {
  test("streak, flap, ambiguous, settled, legacy-only and cross-airline fixtures", () => {
    const db = makeSyntheticDb();
    const log = (
      tail: string,
      daysAgo: number,
      provider: string,
      opts: { confirmed?: 1 | null; airline?: string } = {}
    ) =>
      db
        .query(
          `INSERT INTO starlink_verification_log
             (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, error, airline)
           VALUES (?, 'united', ?, ?, ?, ?, NULL, ?)`
        )
        .run(
          tail,
          NOW - daysAgo * 86400,
          provider === "Starlink" ? 1 : 0,
          provider,
          opts.confirmed === undefined ? 1 : opts.confirmed,
          opts.airline ?? "UA"
        );
    const fixtures: Record<string, Array<[number, string]>> = {
      N1STRK: [
        [20, "Viasat"],
        [15, "Viasat"],
        [10, "Viasat"],
        [5, "Starlink"],
        [3, "Starlink"],
        [1, "Starlink"],
      ],
      N2FLAP: [
        [60, "Starlink"],
        [9, "Starlink"],
        [6, "None"],
        [4, "Starlink"],
        [2, "None"],
      ],
      N3AMBG: [
        [8, "Starlink"],
        [6, "Viasat"],
        [4, "Starlink"],
        [2, "Viasat"],
      ],
      N4NEG: [
        [9, "Viasat"],
        [6, "Viasat"],
        [3, "Viasat"],
      ],
    };
    for (const [tail, obs] of Object.entries(fixtures)) {
      addPlane(db, tail, "Initial");
      for (const [d, p] of obs) log(tail, d, p);
    }
    addPlane(db, "N5LEGC", "Initial");
    for (const d of [6, 4, 2]) log("N5LEGC", d, "Viasat", { confirmed: null });
    addPlane(db, "N6XAIR", "Initial");
    for (const d of [6, 4]) log("N6XAIR", d, "Starlink");
    for (const d of [3, 2, 1]) log("N6XAIR", d, "Viasat", { airline: "AS" });

    const tails = [...Object.keys(fixtures), "N5LEGC", "N6XAIR"];
    const expected = new Map(
      tails.map((t) => [
        t,
        computeWifiConsensus(db, t, { sources: OBSERVED_WIFI_SOURCES, airline: "UA" }).verdict,
      ])
    );
    expect([...expected.values()].some((v) => v === null)).toBe(true);
    expect([...expected.values()].some((v) => v === "Starlink")).toBe(true);
    reconcileConsensus(db, NOW);
    for (const t of tails) {
      const row = db
        .query("SELECT verified_wifi AS v FROM starlink_planes WHERE TailNumber = ?")
        .get(t) as { v: string | null };
      expect(row.v, t).toBe(expected.get(t) ?? "Initial");
    }
    db.close();
  });
});

describe("/fleet operating carriers", () => {
  test("express tails naming no regional count under one row; totals add up", () => {
    const db = makeSyntheticDb();
    const express = (tail: string, op: string | null, status: string) => {
      addFleet(db, tail, status, { aircraftType: "Bombardier CRJ-200" });
      db.query(
        "UPDATE united_fleet SET fleet = 'express', operated_by = ? WHERE tail_number = ?"
      ).run(op, tail);
    };
    express("N1SK", "SkyWest dba UAX", "confirmed");
    express("N2SK", "Skywest dba UAX", "unknown");
    express("N3UA", "United Airlines", "unknown");
    express("N4UA", null, "unknown");
    const { carriers } = getFleetPageData(db, "UA");
    expect(carriers.map((c) => c.name)).toEqual(["SkyWest", "Unattributed"]);
    expect(carriers.at(-1)).toMatchObject({ total: 2, unattributed: true });
    expect(carriers.reduce((s, c) => s + c.total, 0)).toBe(4);
    db.close();
  });
});

describe("first observed Starlink flight", () => {
  const recentDay = new Date((NOW - 3 * 86400) * 1000).toISOString().slice(0, 10);
  const installed = Math.floor(Date.parse(`${recentDay}T00:00:00Z`) / 1000);

  function seed(db: Database, tail: string, gid: string, leg: [string, string, string]) {
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
       VALUES ('B737','Starlink',?,'UA-mainline',?,?,'United','mainline','Starlink','UA')`
    ).run(gid, recentDay, tail);
    addFlight(db, tail, leg[0], leg[1], installed + 10000, { arrivalAirport: leg[2] });
  }
  const modStation = (db: Database, station: string) =>
    db
      .query(
        `INSERT INTO fleet_progress_tails (airline, segment, type_code, tail, state, mod_location, fetched_at)
         VALUES ('UA', 'mainline', '737', ?, 'in_mod', ?, 1)`
      )
      .run(`N${station}`, station);
  const routeSeen = (db: Database, fn: string, o: string, d: string, spanDays: number) =>
    db
      .query(
        `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, 3600, ?, ?, 3)`
      )
      .run(fn, o, d, NOW - 40 * 86400, NOW - 40 * 86400 + spanDays * 86400);

  test("a ferry off the mod station and a charter are not first flights; forum dates never are", () => {
    const db = makeSyntheticDb();
    db.query(
      "INSERT INTO bts_monthly_routes (month, origin, dest, performed) VALUES ('2026-08', 'ORD', 'GRB', 90)"
    ).run();
    modStation(db, "MLB");
    routeSeen(db, "UA6088", "BOI", "GNV", 0.4);
    seed(db, "N64572", "948315825", ["UAL3878", "MLB", "ORD"]);
    seed(db, "N640SY", "1106195214", ["OO6088", "BOI", "GNV"]);
    seed(db, "N587GJ", "6", ["GJS4574", "ORD", "GRB"]);
    // International legs sit outside the domestic census and still count.
    seed(db, "N17326", "6", ["UAL873", "GUM", "NRT"]);
    seed(db, "N846AK", "flyertalk_as", ["UAL1703", "ORD", "GRB"]);

    const recorded = recordFirstFlights(db, NOW).map((f) => f.tail_number);
    expect(recorded.sort()).toEqual(["N17326", "N587GJ"]);
    db.close();
  });

  test("rows recorded before the rules are held to them on read", () => {
    const db = makeSyntheticDb();
    db.query(
      "INSERT INTO bts_monthly_routes (month, origin, dest, performed) VALUES ('2026-08', 'ORD', 'GRB', 90)"
    ).run();
    modStation(db, "MLB");
    addPlane(db, "N64572", "Starlink");
    addPlane(db, "N587GJ", "Starlink");
    const ins = db.query(
      `INSERT INTO first_flights (tail_number, airline, flight_number, origin, destination, departed_at, recorded_at)
       VALUES (?, 'UA', ?, ?, ?, ?, ?)`
    );
    ins.run("N64572", "UAL3878", "MLB", "ORD", NOW - 86400, NOW);
    ins.run("N587GJ", "GJS4574", "ORD", "GRB", NOW - 86400, NOW);
    expect(getFirstFlights(db, ["N64572", "N587GJ"], "UA").map((f) => f.tail_number)).toEqual([
      "N587GJ",
    ]);
    db.close();
  });

  test("a pair missing from the census is scheduled unless something says otherwise", () => {
    const db = makeSyntheticDb();
    db.query(
      "INSERT INTO bts_monthly_routes (month, origin, dest, performed) VALUES ('2026-06', 'ORD', 'GRB', 90)"
    ).run();
    modStation(db, "MLB");
    routeSeen(db, "UA4730", "BFL", "LAX", 40);
    routeSeen(db, "UA3781", "LGB", "SMF", 2);
    routeSeen(db, "UA3870", "MLB", "ORD", 1);
    routeSeen(db, "UA3870", "IAB", "ORD", 60);
    routeSeen(db, "UA6088", "BOI", "GNV", 0.4);
    expect(isScheduledLeg(db, "UA", "BFL", "LAX")).toBe(true);
    expect(isScheduledLeg(db, "UA", "LGB", "SMF")).toBe(true);
    expect(isScheduledLeg(db, "UA", "SBP", "SFO")).toBe(true);
    expect(isScheduledLeg(db, "UA", "MLB", "ORD")).toBe(false);
    expect(isScheduledLeg(db, "UA", "IAB", "ORD")).toBe(false);
    expect(isScheduledLeg(db, "UA", "BOI", "GNV")).toBe(false);
    expect(isScheduledLeg(db, "UA", "ORD", "GRB")).toBe(true);
    db.close();
  });
});

describe("route flight numbers need corroboration", () => {
  test("a once-seen or mis-attributed history row is not a flight on the route", () => {
    const db = makeSyntheticDb();
    const route = db.query(
      `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
       VALUES (?, 'EWR', 'CDG', ?, ?, ?, ?)`
    );
    route.run("UA57", 26400, NOW - 90 * 86400, NOW - 86400, 40);
    route.run("UA8123", 26400, NOW - 9 * 86400, NOW - 9 * 86400, 1);
    route.run("UA3893", 27600, NOW - 60 * 86400, NOW - 86400, 6);
    addPlane(db, "N1", "Starlink");
    // Scheduled right now: the live window vouches for it even though it is new.
    addFlight(db, "N1", "UA9001", "EWR", NOW + 3600, { arrivalAirport: "CDG" });
    const fns = getRouteFlightNumbers(db, "EWR", "CDG", "UA").flightNumbers.map(
      (f) => f.flight_number
    );
    expect(fns).toContain("UA57");
    expect(fns).toContain("UA9001");
    expect(fns).not.toContain("UA8123");
    expect(fns).not.toContain("UA3893");
    db.close();
  });

  test("a mainline long-haul number seen once stands; a regional one does not", () => {
    const db = makeSyntheticDb();
    const route = db.query(
      `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    );
    route.run("UA1", "SFO", "SIN", 59100, NOW - 50 * 86400, NOW - 50 * 86400);
    route.run("UA5201", "SFO", "SIN", 59100, NOW - 50 * 86400, NOW - 50 * 86400);
    route.run("UA2", "SFO", "SIN", 60, NOW - 50 * 86400, NOW - 50 * 86400);
    const fns = getRouteFlightNumbers(db, "SFO", "SIN", "UA").flightNumbers;
    expect(fns).toEqual([{ flight_number: "UA1", times: 1, scheduled: 0 }]);
    db.close();
  });

  test("spellings merge before the sighting rule", () => {
    const db = makeSyntheticDb();
    const route = db.query(
      `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
       VALUES (?, 'HNL', 'OGG', 2400, ?, ?, 1)`
    );
    route.run("HA0011", NOW - 9 * 86400, NOW - 9 * 86400);
    route.run("HA11", NOW - 2 * 86400, NOW - 2 * 86400);
    route.run("HA9101", NOW - 2 * 86400, NOW - 2 * 86400);
    const fns = getRouteFlightNumbers(db, "HNL", "OGG", "HA").flightNumbers;
    expect(fns).toEqual([{ flight_number: "HA11", times: 2, scheduled: 0 }]);
    db.close();
  });

  test("an Alaska number on Hawaiian metal is in Alaska's schedule for the pair", () => {
    const db = makeSyntheticDb();
    addPlane(db, "N373HA", "Starlink", { airline: "HA" });
    addFlight(db, "N373HA", "AS832", "HND", NOW + 3600, { arrivalAirport: "HNL", airline: "HA" });
    addFlight(db, "N373HA", "HA821", "HND", NOW + 7200, { arrivalAirport: "HNL", airline: "HA" });
    const fns = getRouteFlightNumbers(db, "HND", "HNL", "AS").flightNumbers;
    expect(fns).toEqual([{ flight_number: "AS832", times: 1, scheduled: 1 }]);
    db.close();
  });

  test("a SkyWest-for-Alaska row lists under the Alaska number it is sold as", () => {
    const db = makeSyntheticDb();
    addPlane(db, "N195SY", "Starlink", { airline: "AS" });
    addFlight(db, "N195SY", "OO3015", "ACV", NOW + 3600, { arrivalAirport: "SEA", airline: "AS" });
    addFlight(db, "N195SY", "SKW3015", "ACV", NOW + 90000, {
      arrivalAirport: "SEA",
      airline: "AS",
    });
    const fns = getRouteFlightNumbers(db, "ACV", "SEA", "AS").flightNumbers;
    expect(fns).toEqual([{ flight_number: "AS3015", times: 2, scheduled: 1 }]);
    db.close();
  });
});

describe("homepage list", () => {
  test("the list filter's ALL count is the whole equipped list, not the 100 shown", async () => {
    const snap = openSnapshot();
    const equipped = createReaderFactory(snap)("UA").getStarlinkPlanes().length;
    const html = await (
      await createApp(snap).dispatch(req("/", "unitedstarlinktracker.com"))
    ).text();
    const all = html
      .replace(/<!-- -->/g, "")
      .match(/data-filter="all"[^>]*>\s*ALL <span[^>]*>\((\d+)\)/);
    expect(all).not.toBeNull();
    expect(Number(all?.[1])).toBe(equipped);
    snap.close();
  });
});

describe("Alaska SkyWest operator backfill", () => {
  test("N…SY tails read SkyWest; other Alaska tails untouched; rerun is a no-op", () => {
    const db = makeSyntheticDb();
    const plane = (tail: string, op: string) =>
      db
        .query(
          `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
           VALUES ('Embraer E175LR', 'Starlink', NULL, ?, ?, 'horizon', NULL, 'AS')`
        )
        .run(tail, op);
    plane("N171SY", "Horizon Air");
    plane("N650QX", "Horizon Air");
    expect(backfillAlaskaSkyWestOperator(db)).toBe(1);
    expect(backfillAlaskaSkyWestOperator(db)).toBe(0);
    const ops = db
      .query("SELECT TailNumber AS t, OperatedBy AS o FROM starlink_planes ORDER BY t")
      .all() as { t: string; o: string }[];
    expect(ops).toEqual([
      { t: "N171SY", o: "SkyWest Airlines" },
      { t: "N650QX", o: "Horizon Air" },
    ]);
    db.close();
  });
});

describe("migrate", () => {
  const meta = (db: Database, key: string) =>
    (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)
      ?.value ?? null;

  test("analyzes once per index set and runs one-off backfills once", () => {
    const db = makeSyntheticDb();
    migrate(db);
    const analyzed = meta(db, "schema:analyzed_indexes");
    expect(analyzed).toContain("idx_upf_route");
    expect(meta(db, "schema:backfill_alaska_skywest_operator")).not.toBeNull();
    expect(meta(db, "schema:namespace_meta_keys")).not.toBeNull();

    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, airline)
       VALUES ('Embraer E175LR', 'Starlink', NULL, 'N199SY', 'Horizon Air', 'horizon', 'AS')`
    ).run();
    db.query("INSERT INTO meta (key, value) VALUES ('lastUpdated', 'x')").run();
    migrate(db);
    expect(meta(db, "schema:analyzed_indexes")).toBe(analyzed);
    expect(meta(db, "lastUpdated")).toBe("x");
    const op = db.query("SELECT OperatedBy AS o FROM starlink_planes WHERE TailNumber = 'N199SY'");
    expect(op.get()).toEqual({ o: "Horizon Air" });

    db.exec("CREATE INDEX idx_test_only ON meta(value)");
    migrate(db);
    expect(meta(db, "schema:analyzed_indexes")).toContain("idx_test_only");
    db.close();
  });

  test("new Alaska SkyWest listings carry the SkyWest label", () => {
    const db = makeSyntheticDb();
    addDiscoveredStarlinkPlane(
      db,
      "N198SY",
      "Embraer E175LR",
      "Starlink",
      "Horizon Air",
      "horizon",
      {
        airline: "AS",
        evidence: "type_rule",
      }
    );
    const op = db.query("SELECT OperatedBy AS o FROM starlink_planes WHERE TailNumber = 'N198SY'");
    expect(op.get()).toEqual({ o: "SkyWest Airlines" });
    db.close();
  });
});

describe("assignment log on a registration listed twice", () => {
  test("the logging airline's listing decides the flag", () => {
    const db = makeSyntheticDb();
    addPlane(db, "N100SY", "Viasat", { airline: "UA" });
    addPlane(db, "N100SY", "Starlink", { airline: "AS" });
    const leg = {
      flight_number: "AS3015",
      departure_airport: "ACV",
      arrival_airport: "SEA",
      departure_time: NOW + 3600,
      arrival_time: NOW + 7200,
    };
    logFlightAssignments(db, "AS", "N100SY", [leg], NOW);
    logFlightAssignments(db, "UA", "N100SY", [{ ...leg, flight_number: "UA5236" }], NOW);
    const flags = db
      .query("SELECT airline, starlink FROM flight_assignment_log ORDER BY airline")
      .all();
    expect(flags).toEqual([
      { airline: "AS", starlink: 1 },
      { airline: "UA", starlink: 0 },
    ]);
    db.close();
  });
});
