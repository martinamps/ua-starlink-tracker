/**
 * Qatar tails held back by name: eleven aircraft whose type's "done" phase
 * doesn't settle them. They must count nowhere as equipped, today and after
 * the 787-9 phase flips, and a flight on their type answers with odds rather
 * than a yes. Hermetic: fresh DBs seeded from the hub's own tail list of
 * 2026-11-23 (tests/fixtures), the 160 aircraft it listed as fitted that day.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import extLib from "../chrome-extension/lib.js";
import {
  AIRLINES,
  qatarEquipmentCodeOfType,
  qatarHeldBackTail,
  qatarHeldBackTails,
  qatarTypeToStarlink,
  wifiPhaseFamilies,
} from "../src/airlines/registry";
import { resolveFlightVerdict, verdictSummary } from "../src/api/check-flight-core";
import { qatarEquipmentToWifi } from "../src/api/qatar-status";
import {
  addDaysISO,
  qatarFittedShares,
  qatarHistoryStats,
  wilsonLowerBound,
} from "../src/api/qatar-verdict";
import {
  getTypeProgress,
  reconcileTypeDeterministicFleets,
  upsertQatarSchedule,
} from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { programmeRoster } from "../src/database/roster";
import { equippedSql } from "../src/database/sql/equipped";
import { createApp } from "../src/server/app";
import { jsonOf, makeFreshDb, mcpTool, utc } from "./helpers";

const HUB = "airlinestarlinktracker.com";
const QR_HOST = "qatarstarlinktracker.com";
const NOW = utc("2026-11-23T08:00:00Z");
const TODAY = "2026-11-23";
const TOMORROW = addDaysISO(TODAY, 1);

const LISTED: Array<[tail: string, type: string]> = readFileSync(
  join(import.meta.dir, "fixtures", "qatar-listed-tails-2026-11-23.csv"),
  "utf8"
)
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => l.split(",") as [string, string]);

// The hub publishes no list of the 787-9s, only their count.
const B789: Array<[string, string]> = Array.from({ length: 29 }, (_, i) => [
  `A7-X${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
  "Boeing 787-9 Dreamliner",
]);
const ROSTER = [...LISTED, ...B789];

const HELD = [
  "A7-BOA",
  "A7-BOB",
  "A7-BOC",
  "A7-BOD",
  "A7-BOE",
  "A7-BOF",
  "A7-BOG",
  "A7-BOH",
  "A7-BOI",
  "A7-BUA",
  "A7-BUB",
];

/** The roster as production holds it before this change: every listed tail
 * settled by its type and listed as a type-rule Starlink plane. */
function seedAsBefore(): Database {
  const db = makeFreshDb();
  const fleet = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, first_seen_source, first_seen_at, last_seen_at, starlink_status, airline)
     VALUES (?, ?, 'mainline', 'test', 1, 1, ?, 'QR')`
  );
  const listing = db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, TailNumber, OperatedBy, fleet, verified_wifi, airline)
     VALUES (?, 'StrLnk', 'type_deterministic', 'type_deterministic', ?, 'Qatar Airways', 'mainline', ?, 'QR')`
  );
  for (const [tail, type] of LISTED) {
    fleet.run(tail, type, "confirmed");
    // One held-back tail carries a stamped listing, as an older writer left some.
    listing.run(type, tail, tail === "A7-BOA" ? "Starlink" : null);
  }
  for (const [tail, type] of B789) fleet.run(tail, type, "unknown");
  return db;
}

const equippedCount = (db: Database) =>
  (
    db
      .query(
        `SELECT COUNT(*) AS n FROM starlink_planes sp WHERE sp.airline = 'QR' AND ${equippedSql("sp")}`
      )
      .get() as { n: number }
  ).n;

function schedule(db: Database, fn: string, date: string, eq: string) {
  const dep = utc(`${date}T06:40:00Z`);
  upsertQatarSchedule(db, {
    flight_number: fn,
    scheduled_date: date,
    departure_airport: "DOH",
    arrival_airport: "LHR",
    departure_time: dep,
    arrival_time: dep + 7 * 3600,
    equipment_code: eq,
    wifi_verdict: qatarEquipmentToWifi(eq),
    flight_status: "SCHEDULED",
    last_updated: NOW,
  });
}

const verdict = (db: Database, fn: string, date = TOMORROW) =>
  resolveFlightVerdict(AIRLINES.QR, createReaderFactory(db)("QR"), fn, date, {
    now: NOW,
    lookupTail: null,
  });

describe("the held-back list", () => {
  test("names the eleven, each with its evidence and a dated reason", () => {
    expect(
      qatarHeldBackTails()
        .map(([t]) => t)
        .sort()
    ).toEqual(HELD);
    for (const [tail, h] of qatarHeldBackTails()) {
      expect(h.reason.length, tail).toBeGreaterThan(40);
      expect(h.asOf, tail).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
    }
  });

  test("the two leased 787-8s carry the thinnest grade, the nine 777s a stronger one", () => {
    for (const t of ["A7-BUA", "A7-BUB"]) {
      expect(qatarHeldBackTail(t)?.evidence).toBe("reported_parked");
    }
    expect(qatarHeldBackTail("A7-BOA")?.evidence).toBe("passenger_reports");
    expect(qatarHeldBackTail("A7-BOE")?.evidence).toBe("count_only");
  });

  test("each entry's equipment code is its roster type's", () => {
    const typeOf = new Map(LISTED);
    for (const [tail, h] of qatarHeldBackTails()) {
      expect(qatarEquipmentCodeOfType(typeOf.get(tail)), tail).toBe(h.equipment);
    }
  });

  test("the rule holds a named tail back whatever its type says, and no other", () => {
    expect(qatarTypeToStarlink("Boeing 777-367(ER)", "A7-BOA")).toBe("unknown");
    expect(qatarTypeToStarlink("Boeing 787-8 Dreamliner", "a7-bub")).toBe("unknown");
    expect(qatarTypeToStarlink("Boeing 777-3DZ(ER)", "A7-BAA")).toBe("confirmed");
    expect(qatarTypeToStarlink("Boeing 777-367(ER)")).toBe("confirmed");
  });

  test("the rule settles 149 of the listed 160 today, and 178 once the 787-9 flips", () => {
    const settled = (phases?: Record<string, "confirmed" | "rolling" | "negative">) =>
      ROSTER.filter(([tail, type]) => qatarTypeToStarlink(type, tail, phases) === "confirmed")
        .length;
    expect(LISTED.length).toBe(160);
    expect(settled()).toBe(149);
    expect(settled({ ...wifiPhaseFamilies("QR"), "B787-9": "confirmed" })).toBe(178);
  });
});

describe("reconcile takes the held-back tails out of every count", () => {
  test("160 listed before, 149 after; the eleven are un-settled and unlisted", () => {
    const db = seedAsBefore();
    expect(equippedCount(db)).toBe(160);

    expect(reconcileTypeDeterministicFleets(db)).toBe(11);

    expect(equippedCount(db)).toBe(149);
    const held = db
      .query(
        `SELECT tail_number, starlink_status, verified_wifi FROM united_fleet
         WHERE airline = 'QR' AND tail_number IN (${HELD.map(() => "?").join(",")})`
      )
      .all(...HELD) as Array<{ starlink_status: string; verified_wifi: string | null }>;
    expect(held.length).toBe(11);
    // "unknown", never "negative": not confirmed is not a no.
    expect(held.every((r) => r.starlink_status === "unknown" && r.verified_wifi === null)).toBe(
      true
    );
    const listed = db
      .query(
        `SELECT COUNT(*) AS n FROM starlink_planes WHERE TailNumber IN (${HELD.map(() => "?").join(",")})`
      )
      .get(...HELD) as { n: number };
    expect(listed.n).toBe(0);
    // The rows stay on the roster: the daily fleet pull would only re-add them.
    expect(programmeRoster(db, "QR").filter((t) => HELD.includes(t.tail_number)).length).toBe(11);
    expect(programmeRoster(db, "QR").filter((t) => t.equipped).length).toBe(149);

    const byType = new Map(getTypeProgress(db, "QR").map((t) => [t.key, t]));
    expect(byType.get("B777")).toMatchObject({ equipped: 55, total: 64 });
    expect(byType.get("B787-8")).toMatchObject({ equipped: 30, total: 32 });
    expect(byType.get("A350")).toMatchObject({ equipped: 64, total: 64 });
    db.close();
  });

  test("a second run changes nothing, and never re-lists them", () => {
    const db = seedAsBefore();
    reconcileTypeDeterministicFleets(db);
    expect(reconcileTypeDeterministicFleets(db)).toBe(0);
    expect(equippedCount(db)).toBe(149);
    db.close();
  });

  test("a held-back tail arriving fresh from the fleet pull is never listed", () => {
    const db = makeFreshDb();
    db.query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, first_seen_source, first_seen_at, last_seen_at, starlink_status, airline)
       VALUES ('A7-BOB', 'Boeing 777-367(ER)', 'mainline', 'test', 1, 1, 'unknown', 'QR'),
              ('A7-BAA', 'Boeing 777-3DZ(ER)', 'mainline', 'test', 1, 1, 'unknown', 'QR')`
    ).run();
    expect(reconcileTypeDeterministicFleets(db)).toBe(1);
    expect(equippedCount(db)).toBe(1);
    db.close();
  });
});

describe("fitted share per scheduled type", () => {
  const roster = ROSTER.map(([tail_number, aircraft_type]) => ({ tail_number, aircraft_type }));

  test("only the two types with held-back aircraft have one", () => {
    const shares = qatarFittedShares(roster);
    expect([...shares.keys()].sort()).toEqual(["77W", "788"]);
    expect(shares.get("77W")).toMatchObject({ held: 9, total: 57, share: 48 / 57 });
    expect(shares.get("788")).toMatchObject({ held: 2, total: 32, share: 30 / 32 });
  });

  test("a type whose held-back aircraft have left the roster answers by type again", () => {
    const without = roster.filter((r) => !r.tail_number.startsWith("A7-BU"));
    expect(qatarFittedShares(without).has("788")).toBe(false);
  });

  test("an empty roster keeps the entry with no share: never a yes", () => {
    expect(qatarFittedShares([]).get("77W")).toMatchObject({ held: 9, total: null, share: null });
  });

  test("history odds on a held-back type are scaled by its share; others are untouched", () => {
    const shares = qatarFittedShares(roster);
    const days = (eq: string) =>
      Array.from({ length: 20 }, (_, i) => {
        const date = addDaysISO(TODAY, -(i + 1));
        return {
          departure_airport: "DOH",
          arrival_airport: "LHR",
          departure_time: utc(`${date}T06:40:00Z`),
          service_date: date,
          equipment_code: eq,
          flight_status: "ARRIVED",
        };
      });
    const far = addDaysISO(TODAY, 20);
    const b777 = qatarHistoryStats(days("77W"), far, TODAY, shares);
    expect(b777.probability).toBeCloseTo(wilsonLowerBound(20, 20) * (48 / 57), 10);
    expect(b777.partly?.map((t) => t.equipment_code)).toEqual(["77W"]);
    const a350 = qatarHistoryStats(days("359"), far, TODAY, shares);
    expect(a350.probability).toBe(wilsonLowerBound(20, 20));
    expect(a350.partly).toBeUndefined();
  });
});

describe("flight answers on a type with held-back aircraft", () => {
  function seeded(): Database {
    const db = seedAsBefore();
    reconcileTypeDeterministicFleets(db);
    schedule(db, "QR1", TOMORROW, "77W");
    schedule(db, "QR5", TOMORROW, "788");
    schedule(db, "QR15", TOMORROW, "359");
    schedule(db, "QR17", TOMORROW, "77L");
    return db;
  }

  test("777-300ER and 787-8 give odds; A350 and 777-200LR keep their yes", async () => {
    const db = seeded();
    const b777 = await verdict(db, "QR1");
    expect(b777.kind).toBe("qatar");
    if (b777.kind !== "qatar") return;
    expect(b777.hasStarlink).toBeNull();
    expect(b777.qclass).toBe("partly");
    expect(b777.probability).toBeCloseTo(48 / 57, 10);
    expect(b777.reason).toContain("48 of Qatar's 57 777-300ERs");
    expect(b777.reason).not.toContain("fully fitted");
    expect(verdictSummary(b777)).toMatchObject({
      hasStarlink: null,
      confidence: "type",
      observations: 0,
    });

    const b788 = await verdict(db, "QR5");
    expect(b788.kind === "qatar" && b788.hasStarlink).toBeNull();
    expect(b788.kind === "qatar" && b788.probability).toBeCloseTo(30 / 32, 10);

    for (const fn of ["QR15", "QR17"]) {
      const v = await verdict(db, fn);
      expect(v.kind === "qatar" && v.hasStarlink, fn).toBe(true);
      expect(v.kind === "qatar" && v.probability, fn).toBeUndefined();
    }
    db.close();
  });

  test("with no roster to count from, it still isn't a yes", async () => {
    const db = makeFreshDb();
    schedule(db, "QR1", TOMORROW, "77W");
    const v = await verdict(db, "QR1");
    expect(v.kind === "qatar" && v.hasStarlink).toBeNull();
    expect(v.kind === "qatar" && v.probability).toBeUndefined();
    db.close();
  });

  // Runs on the wall clock: the handlers take no injected time.
  describe("on the wire", () => {
    const day = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const db = seedAsBefore();
    reconcileTypeDeterministicFleets(db);
    schedule(db, "QR1", day, "77W");
    schedule(db, "QR15", day, "359");
    const app = createApp(db);
    const q = (fn: string) => `flight_number=${fn}&date=${day}`;

    test("check-any-flight: same keys and types, hasStarlink null and a probability", async () => {
      const partly = await jsonOf(app, `/api/check-any-flight?${q("QR1")}`, HUB);
      const yes = await jsonOf(app, `/api/check-any-flight?${q("QR15")}`, HUB);
      expect(yes.hasStarlink).toBe(true);
      expect(partly.hasStarlink).toBeNull();
      expect(partly.probability).toBeCloseTo(48 / 57, 10);
      expect(partly.confidence).toBe("type");
      expect(partly.basis).toBe("schedule");
      // Additive only: every key of the yes answer is still there, same type.
      for (const k of Object.keys(yes)) expect(partly, k).toHaveProperty(k);
      expect(Object.keys(partly).filter((k) => !(k in yes))).toEqual(["probability"]);
      expect(Object.keys(partly.flights[0])).toEqual(Object.keys(yes.flights[0]));
    });

    test("the Qatar host's check-flight moves the same way", async () => {
      const partly = await jsonOf(app, `/api/check-flight?${q("QR1")}`, QR_HOST);
      expect(partly.hasStarlink).toBeNull();
      expect(partly.confidence).toBe("type");
      expect(partly.probability).toBeCloseTo(48 / 57, 10);
    });

    test("MCP check_flight says likely with the share, not yes", async () => {
      const { text } = await mcpTool(app, HUB, "check_flight", {
        flight_number: "QR1",
        date: day,
      });
      expect(text).toContain("Likely");
      expect(text).toContain("84%");
      expect(text).not.toContain("Yes, by scheduled aircraft type");
    });

    test("extension 2.2.0: a predicted badge with the share, never the installed rung", async () => {
      const claim = extLib.normalizeClaim(
        await jsonOf(app, `/api/check-any-flight?${q("QR1")}`, HUB)
      );
      expect(claim.status).toBe("predicted");
      expect(claim.predictionConfidence).toBeNull();
      expect(extLib.shouldBadge(claim)).toBe(true);
      expect(extLib.badgeLabel(claim)).toBe("Starlink ~84%");
      const a350 = extLib.normalizeClaim(
        await jsonOf(app, `/api/check-any-flight?${q("QR15")}`, HUB)
      );
      expect(a350.status).toBe("installed");
    });

    test("the hub's Qatar page says most, not every one, for the two types", async () => {
      const r = await app.dispatch(
        new Request("http://x/airlines/qatar", { headers: { Host: HUB } })
      );
      const html = await r.text();
      expect(html).toContain("9 second-hand not confirmed");
      expect(html).toContain("2 leased not confirmed");
    });
  });
});
