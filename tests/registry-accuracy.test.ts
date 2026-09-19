/**
 * Registry/data-quality fixes that change values, never shapes: Hawaiian
 * metal flying AS numbers, freighters out of passenger denominators, the
 * body-class table, united.com's regional None flap, and sheet WiFi typos.
 * Hermetic: in-memory DBs cloned from the snapshot schema.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  AIRCRAFT_FAMILY_KEYS,
  isFreighterFamily,
  normalizeAircraftType,
} from "../src/airlines/aircraft-families";
import { AIRLINES, withOperatingPartners } from "../src/airlines/registry";
import {
  bodyClassOf,
  computeWifiConsensus,
  getFleetPageData,
  getTotalCount,
  refreshFleetMeta,
} from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { claimSheetDisagreementReport } from "../src/scripts/fleet-discovery";
import { carrierPrediction, describeCarrierPrediction } from "../src/scripts/starlink-predictor";
import type { BodyClass } from "../src/types";
import { looksLikeStarlinkTypo, normalizeSheetWifi } from "../src/utils/utils";
import { addFleet, addFlight, addPlane, makeSyntheticDb } from "./helpers";

const asSubfleet = (fn: string) => AIRLINES.AS.subfleets.find((s) => s.match(fn))?.key ?? null;

describe("AS subfleets", () => {
  test.each([
    ["AS851", "hawaiian_metal"],
    ["AS961", "hawaiian_metal"],
    ["ASA999", "hawaiian_metal"],
    ["AS1042", "hawaiian_interisland"],
    ["AS1226", "hawaiian_interisland"],
    ["AS1", "mainline"],
    ["AS799", "mainline"],
    ["AS1300", "mainline"],
    ["AS1999", "mainline"],
    ["AS2100", "horizon"],
    ["AS8999", "horizon"],
    ["ASA9411", null],
  ])("%s → %p", (fn, key) => {
    expect(asSubfleet(fn)).toBe(key);
  });

  test("subfleet ranges never overlap", () => {
    for (let n = 1; n <= 9999; n++) {
      expect(AIRLINES.AS.subfleets.filter((s) => s.match(`AS${n}`)).length).toBeLessThanOrEqual(1);
    }
  });

  test("interisland prediction is 0% with the 717 reason, not the mainline blend", () => {
    const db = makeSyntheticDb();
    addFleet(db, "N801AK", "unknown", { airline: "AS", aircraftType: "Boeing 737 MAX 8" });
    const answer = carrierPrediction(AIRLINES.AS, createReaderFactory(db)("AS"), "AS1042");
    if (answer.kind !== "penetration") throw new Error(`expected penetration, got ${answer.kind}`);
    expect(answer.pen.pct).toBe(0);
    expect(describeCarrierPrediction(AIRLINES.AS, answer)).toMatch(/717/);
    db.close();
  });
});

describe("operating partners", () => {
  test("AS assignment reads span HA; carriers without partners are unchanged", () => {
    expect(new Set(withOperatingPartners(["AS"]))).toEqual(new Set(["AS", "HA"]));
    expect(withOperatingPartners(["UA"])).toEqual(["UA"]);
    const hub = withOperatingPartners(["UA", "HA", "AS"]);
    expect(hub.length).toBe(new Set(hub).size);
  });

  test("AS reader resolves an AS-numbered flight on HA metal; counts stay AS-only", () => {
    const db = makeSyntheticDb();
    const dep = Math.floor(Date.now() / 1000) + 3600;
    addPlane(db, "N217HA", "Starlink", { airline: "HA", aircraft: "Airbus A321-271N" });
    addFlight(db, "N217HA", "ASA961", "HNL", dep, { arrivalAirport: "PDX", airline: "HA" });
    const factory = createReaderFactory(db);
    const as = factory("AS");
    const rows = as.getFlightAssignments(["AS961", "ASA961"], dep - 60, dep + 60);
    expect(rows.map((r) => r.tail_number)).toEqual(["N217HA"]);
    expect(as.countStarlinkPlanes()).toBe(0);
    expect(factory("UA").getFlightAssignments(["AS961", "ASA961"], dep - 60, dep + 60)).toEqual([]);
    db.close();
  });
});

describe("rollout copy", () => {
  test("no phaseNote hardcodes an E175 fleet count", () => {
    for (const cfg of Object.values(AIRLINES)) {
      expect(cfg.rollout.phaseNote).not.toMatch(/\b\d{2,}\b[^.]*E175/);
    }
  });
});

describe("freighters", () => {
  test.each([
    ["Boeing 737-804(BCF)", true],
    ["Boeing 737-890(BCF)", true],
    ["Boeing 737-790(BDSF)", true],
    ["Boeing 777-F", true],
    ["Boeing 777-FDZ", true],
    ["Boeing 737-924(ER)", false],
    ["Boeing 777-2DZ(LR)", false],
    ["Boeing 777-3DZ(ER)", false],
    ["Boeing 737 MAX 8", false],
    ["Airbus A321-271NX", false],
    ["Embraer E175LR", false],
  ])("%s → freighter %p", (raw, want) => {
    expect(isFreighterFamily(normalizeAircraftType(raw))).toBe(want);
  });

  test("kept in the roster, dropped from fleet totals and fleet-page families", () => {
    const db = makeSyntheticDb();
    addFleet(db, "N217HA", "confirmed", { airline: "HA", aircraftType: "Airbus A321-271N" });
    addFleet(db, "N717HA", "negative", { airline: "HA", aircraftType: "Boeing 717-22A" });
    addFleet(db, "N571AS", "unknown", { airline: "HA", aircraftType: "Boeing 737-804(BCF)" });
    refreshFleetMeta(db, "HA");
    expect(getTotalCount(db, "HA")).toBe(2);
    const page = getFleetPageData(db, ["HA"]);
    expect(page.families.some((f) => isFreighterFamily(f.family))).toBe(false);
    expect(
      (db.query("SELECT COUNT(*) n FROM united_fleet WHERE airline='HA'").get() as { n: number }).n
    ).toBe(3);
    db.close();
  });
});

describe("bodyClassOf", () => {
  const EXPECTED: Record<string, BodyClass> = {
    "B737-MAX10": "narrowbody",
    "B737-MAX8": "narrowbody",
    "B737-MAX9": "narrowbody",
    B737F: "narrowbody",
    "B737-700": "narrowbody",
    "B737-800": "narrowbody",
    "B737-900": "narrowbody",
    B717: "narrowbody",
    B747F: "widebody",
    B747: "widebody",
    B757: "narrowbody",
    B767: "widebody",
    B777F: "widebody",
    B777: "widebody",
    B787: "widebody",
    A319: "narrowbody",
    A320: "narrowbody",
    A321: "narrowbody",
    A330: "widebody",
    A350: "widebody",
    A380: "widebody",
    E175: "regional",
    "ERJ-145": "regional",
    "CRJ-200": "regional",
    "CRJ-550": "regional",
    "CRJ-700": "regional",
  };

  test("every family has an explicit expected class", () => {
    expect(new Set(AIRCRAFT_FAMILY_KEYS)).toEqual(new Set(Object.keys(EXPECTED)));
  });

  test.each(Object.entries(EXPECTED))("%s → %s", (family, body) => {
    expect(bodyClassOf(family)).toBe(body);
  });
});

describe("computeWifiConsensus — regional None flap", () => {
  const DAY = 86400;
  function seed(tail: string, providersNewestFirst: string[], opts: { ageDays?: number[] } = {}) {
    const db = makeSyntheticDb();
    const now = Math.floor(Date.now() / 1000);
    providersNewestFirst.forEach((p, i) => {
      const age = opts.ageDays?.[i] ?? i + 1;
      db.query(
        `INSERT INTO starlink_verification_log
           (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
         VALUES (?, 'united', ?, ?, ?, 1, 'UA')`
      ).run(tail, now - age * DAY, p === "Starlink" ? 1 : 0, p);
    });
    return db;
  }
  const verdictOf = (db: Database, tail: string) => {
    const c = computeWifiConsensus(db, tail, { airline: "UA" });
    db.close();
    return c.verdict;
  };

  test("None streak after prior Starlink is not a negative", () => {
    const v = verdictOf(seed("N641SY", ["None", "None", "None", "Starlink", "Starlink"]), "N641SY");
    expect(v === null || v === "Starlink").toBe(true);
  });

  test("a named competing provider still flips the tail", () => {
    expect(verdictOf(seed("N1", ["Viasat", "Viasat", "Viasat", "Starlink"]), "N1")).toBe("Viasat");
  });

  test("None with no Starlink history stays None", () => {
    expect(verdictOf(seed("N786SK", Array(14).fill("None")), "N786SK")).toBe("None");
  });

  test("Starlink outside the window still discounts in-window None", () => {
    const db = seed("N2", ["None", "None", "None", "None", "None", "Starlink"], {
      ageDays: [1, 2, 3, 4, 5, 40],
    });
    expect(verdictOf(db, "N2")).toBeNull();
  });

  test("alaska-source None rows are not discounted", () => {
    const db = makeSyntheticDb();
    const now = Math.floor(Date.now() / 1000);
    const ins = db.query(
      `INSERT INTO starlink_verification_log
         (tail_number, source, checked_at, has_starlink, wifi_provider, tail_confirmed, airline)
       VALUES ('N3AK', ?, ?, ?, ?, 1, 'AS')`
    );
    ins.run("united", now - 10 * DAY, 1, "Starlink");
    for (let i = 1; i <= 3; i++) ins.run("alaska", now - i * DAY, 0, "None");
    const c = computeWifiConsensus(db, "N3AK", { airline: "AS" });
    expect(c.verdict).toBe("None");
    db.close();
  });
});

describe("claimSheetDisagreementReport", () => {
  test("reports once per verdict per 7 days", () => {
    const db = makeSyntheticDb();
    const t0 = 1_800_000_000;
    expect(claimSheetDisagreementReport(db, "N786SK", "None", t0)).toBe(true);
    expect(claimSheetDisagreementReport(db, "N786SK", "None", t0 + 86400)).toBe(false);
    expect(claimSheetDisagreementReport(db, "N786SK", "Viasat", t0 + 2 * 86400)).toBe(true);
    expect(claimSheetDisagreementReport(db, "N786SK", "Viasat", t0 + 10 * 86400)).toBe(true);
    db.close();
  });
});

describe("normalizeSheetWifi", () => {
  test.each([
    ["StrLnk", "express", "StrLnk"],
    ["Starlink", "express", "Starlink"],
    ["Starlink ", "mainline", "Starlink"],
    ["Stalink", "mainline", "Starlink"],
    [" strlnk", "express", "StrLnk"],
    ["Starlnk", "express", "StrLnk"],
    ["Strlink", "mainline", "Starlink"],
    ["ViaSatKA", "mainline", null],
    ["No", "express", null],
    ["", "express", null],
    [undefined, "express", null],
  ] as const)("%p (%s) → %p", (raw, fleet, want) => {
    expect(normalizeSheetWifi(raw, fleet)).toBe(want);
  });

  test("typo detector flags near-misses, not other providers", () => {
    expect(looksLikeStarlinkTypo("Starlik")).toBe(true);
    expect(looksLikeStarlinkTypo("ViaSatKA")).toBe(false);
    expect(looksLikeStarlinkTypo("Start 2026")).toBe(false);
    expect(looksLikeStarlinkTypo("Starlink")).toBe(false);
  });
});
