/**
 * Write-path guards from the 2026-11 incidents: an FR24 redesign turned type
 * names into united_fleet tails, a deleted sheet tab stalled the UA scrape
 * for two weeks, and an untyped sheet tail turned out to be a balloon.
 */

import { describe, expect, test } from "bun:test";
import { syncSpreadsheetToFleet, upsertFleetAircraft } from "../src/database/database";
import { fleetRejectReason, isAirlinerModel } from "../src/database/fleet-admission";
import { parseExpectedFleetSize, parseFleetRows } from "../src/scripts/flightradar24-scraper";
import {
  FLEET_SHEETS,
  type SheetTab,
  fetchAllSheets,
  parseSheetTabs,
  reconcileSheetTabs,
} from "../src/utils/utils";
import { addPlane, makeSyntheticDb } from "./helpers";

const ac = (slug: string) => `https://www.flightradar24.com/data/aircraft/${slug}`;

describe("parseFleetRows", () => {
  test("role=row layout: registration by slug identity, type from its link", () => {
    const rows = [
      {
        links: [
          { text: "N202HA", href: ac("n202ha") },
          { text: "Airbus A321-271N", href: ac("a21n") },
          { text: "History", href: ac("n202ha") },
        ],
        cells: ["MSN", "Airbus A321-271N", "2017-12-01", "8.9 years", "History"],
      },
      {
        links: [
          { text: "N204HA", href: ac("n204ha") },
          { text: "Airbus A321-271N", href: ac("a21n") },
          { text: "History", href: ac("n204ha") },
        ],
        cells: [],
      },
    ];
    expect(parseFleetRows(rows)).toEqual([
      { registration: "N202HA", aircraftType: "Airbus A321-271N" },
      { registration: "N204HA", aircraftType: "Airbus A321-271N" },
    ]);
  });

  test("type without a link falls back to the type cell", () => {
    const rows = [
      {
        links: [
          { text: "N475HA", href: ac("n475ha") },
          { text: "History", href: ac("n475ha") },
        ],
        cells: ["MSN", "Boeing 717-22A", "2001-01-01", "", "History"],
      },
    ];
    expect(parseFleetRows(rows)).toEqual([
      { registration: "N475HA", aircraftType: "Boeing 717-22A" },
    ]);
  });

  test("legacy table rows and hyphenated registrations still parse", () => {
    const rows = [
      { links: [{ text: "F-HPJA", href: ac("f-hpja") }], cells: ["", "Airbus A380-861"] },
      { links: [{ text: "Airbus A380-861", href: ac("a388") }], cells: ["Airbus A380-861", "10"] },
    ];
    expect(parseFleetRows(rows)).toEqual([
      { registration: "F-HPJA", aircraftType: "Airbus A380-861" },
    ]);
  });

  test("fleet size header in both layouts", () => {
    expect(parseExpectedFleetSize("Number of aircraft in fleet: 1644")).toBe(1644);
    expect(parseExpectedFleetSize("Hawaiian FleetNumber of aircraft62Aircraft")).toBe(62);
    expect(parseExpectedFleetSize("Number of aircraft1,644")).toBe(1644);
    expect(parseExpectedFleetSize("nothing")).toBe(-1);
  });
});

describe("fleet admission", () => {
  test("registrations must match the airline's pattern", () => {
    const db = makeSyntheticDb();
    const opts = { aircraftType: "Boeing 757-224", isNew: true };
    expect(fleetRejectReason(db, "UA", "Boeing 757-224", opts)).toBe("invalid_registration");
    expect(fleetRejectReason(db, "UA", "History", opts)).toBe("invalid_registration");
    expect(fleetRejectReason(db, "UA", "A7-ALA", opts)).toBe("invalid_registration");
    expect(fleetRejectReason(db, "UA", "N12345", opts)).toBeNull();
    expect(fleetRejectReason(db, "AF", "F-HPJA", opts)).toBeNull();
    expect(fleetRejectReason(db, "QR", "A7-ALA", opts)).toBeNull();
    db.close();
  });

  test("an untyped newcomer the FAA file calls a non-airliner is refused", () => {
    const db = makeSyntheticDb();
    db.query(
      "INSERT INTO faa_registry (tail_number, faa_status, faa_model, last_refreshed) VALUES (?, 'V', ?, 1)"
    ).run("N99971", "AEROSTAR INTERNATIONAL INC RX 8");
    const untypedNew = { aircraftType: null, isNew: true };
    expect(fleetRejectReason(db, "UA", "N99971", untypedNew)).toBe("non_airliner");
    // Typed, already a member, or absent from the FAA file: not this gate's call.
    expect(fleetRejectReason(db, "UA", "N99971", { aircraftType: "E175", isNew: true })).toBeNull();
    expect(fleetRejectReason(db, "UA", "N99971", { aircraftType: null, isNew: false })).toBeNull();
    expect(fleetRejectReason(db, "UA", "N99972", untypedNew)).toBeNull();
    db.close();
  });

  test("FAA legal-entity names for airliner makers pass", () => {
    for (const model of [
      "YABORA INDUSTRIA AERONAUTICA S ERJ 170-200 LL",
      "MHI RJ AVIATION ULC CL-600-2C10",
      "BOEING 737-924ER",
      "AIRBUS A321-271NX",
      "EMBRAER S A ERJ 170-200 LR",
      "DE HAVILLAND AIRCRAFT OF CANADA DHC-8-402",
    ]) {
      expect(isAirlinerModel(model)).toBe(true);
    }
    expect(isAirlinerModel("AEROSTAR INTERNATIONAL INC RX 8")).toBe(false);
    expect(isAirlinerModel("CESSNA 172S")).toBe(false);
  });

  test("upsertFleetAircraft refuses a type name and writes nothing", () => {
    const db = makeSyntheticDb();
    const ok = upsertFleetAircraft(db, "Boeing 757-224", "", "fr24", "mainline", null, "UA");
    expect(ok).toBe(false);
    expect(db.query("SELECT 1 FROM united_fleet WHERE tail_number = 'Boeing 757-224'").get()).toBe(
      null
    );
    expect(
      upsertFleetAircraft(db, "N99973", "Boeing 757-224", "fr24", "mainline", null, "UA")
    ).toBe(true);
    db.close();
  });

  test("sheet sync skips an untyped balloon but keeps typed tails", () => {
    const db = makeSyntheticDb();
    db.query(
      "INSERT INTO faa_registry (tail_number, faa_status, faa_model, last_refreshed) VALUES (?, 'V', ?, 1)"
    ).run("N99974", "AEROSTAR INTERNATIONAL INC RX 8");
    addPlane(db, "N99974", null, { aircraft: "" });
    addPlane(db, "N99975", null, { aircraft: "Boeing 737-900" });
    syncSpreadsheetToFleet(db, "UA");
    const tails = (
      db
        .query("SELECT tail_number FROM united_fleet WHERE tail_number IN ('N99974','N99975')")
        .all() as {
        tail_number: string;
      }[]
    ).map((r) => r.tail_number);
    expect(tails).toEqual(["N99975"]);
    db.close();
  });
});

describe("sheet tab reconciliation", () => {
  test("parses the htmlview tab list", () => {
    const html = `items.push({name: "E175", pageUrl: "x", gid: "13",initialSheet: ("13" == gid)});
      items.push({name: "63\\/4", pageUrl: "x", gid: "10",initialSheet: ("10" == gid)});`;
    expect(parseSheetTabs(html)).toEqual([
      { gid: 13, name: "E175" },
      { gid: 10, name: "63/4" },
    ]);
  });

  test("vanished tabs split on whether anything is listed from them", () => {
    const live: SheetTab[] = [
      { gid: 1, name: "a" },
      { gid: 4, name: "Future" },
    ];
    const r = reconcileSheetTabs([1, 2, 3], live, new Set(["3"]));
    expect(r.fetch).toEqual([1]);
    expect(r.vanishedEmpty).toEqual([2]);
    expect(r.vanishedListed).toEqual([3]);
    expect(r.added).toEqual([{ gid: 4, name: "Future" }]);
  });

  test("unreadable tab list falls back to every known gid", () => {
    expect(reconcileSheetTabs([1, 2], null, new Set()).fetch).toEqual([1, 2]);
  });

  const csv = "Aircraft,Reg #,WiFi\nE175,N12345,StrLnk\n";
  const liveMinus = (gone: number) => async (docId: string) =>
    FLEET_SHEETS.find((s) => s.docId === docId)
      ?.gids.filter((g) => g !== gone)
      .map((gid) => ({ gid, name: String(gid) })) ?? null;
  const goneGid = FLEET_SHEETS[0].gids[3];

  test("a deleted empty tab is skipped and the scrape succeeds", async () => {
    const fetched: number[] = [];
    const result = await fetchAllSheets({
      fetchTabs: liveMinus(goneGid),
      fetchCsv: async (_doc, gid) => {
        fetched.push(gid);
        return csv;
      },
    });
    expect(fetched).not.toContain(goneGid);
    expect(result.starlinkAircraft.length).toBeGreaterThan(0);
  });

  test("a deleted tab that still has listings refuses", async () => {
    await expect(
      fetchAllSheets({
        listedGids: new Set([String(goneGid)]),
        fetchTabs: liveMinus(goneGid),
        fetchCsv: async () => csv,
      })
    ).rejects.toThrow(/deleted upstream/);
  });

  test("a transient error on a live tab still aborts the whole run", async () => {
    await expect(
      fetchAllSheets({
        fetchTabs: liveMinus(-1),
        fetchCsv: async (_doc, gid) => {
          if (gid === 13) throw new Error("HTTP error! Status: 503");
          return csv;
        },
      })
    ).rejects.toThrow(/partial DELETE/);
  });
});
