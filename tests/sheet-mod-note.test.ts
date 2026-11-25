/**
 * The fleet sheet's hangar notes are free text typed by strangers: the parser
 * reads one grammar, keeps none of the cell's own text, and returns nothing
 * for anything it isn't sure of. Install order moves a tail up the verifier's
 * queue and nothing else.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FittingPanel, fittingPhrase } from "../src/components/fleet/pipeline";
import {
  countStarlinkPlanes,
  getFleetPageData,
  getNextPlanesToVerify,
  updateDatabase,
} from "../src/database/database";
import {
  applySubfleetOrder,
  getSheetModNotes,
  replaceSheetModNotes,
} from "../src/database/sheet-mod-notes";
import { getTailRecord } from "../src/database/tails";
import type { SheetModNote } from "../src/types";
import { addDays, modHoldsUntil, parseModNote, utcToday } from "../src/utils/sheet-mod-note";
import { type SheetOrderRow, subfleetOrderScores } from "../src/utils/subfleet-order";
import { FLEET_SHEETS, fetchAllSheets } from "../src/utils/utils";
import { makeSyntheticDb } from "./helpers";

const TODAY = "2026-11-25";
const parse = (note: string, toReceiveStarlink?: string) =>
  parseModNote({ note, toReceiveStarlink }, TODAY);

describe("parseModNote", () => {
  test("reads the sheet's usual forms", () => {
    expect(parse("MIA Mod SL 11/2/26 ERS 12/17")).toEqual({
      station: "MIA",
      started: "2026-11-02",
      due_back: "2026-12-17",
      unsure: false,
    });
    // A return in the new year, extra spaces, mixed case, no space before the date.
    expect(parse("RFD Mod Next/SL 11/15/26 ERS  1/1")?.due_back).toBe("2027-01-01");
    expect(parse("HKG MOD SL 11/8/26 ERS 12/27 ")?.station).toBe("HKG");
    expect(parse("RFD Mod NEXT/SL11/5/26 ERS 12/21")?.started).toBe("2026-11-05");
    // No return date given: a note without one, not a guess.
    expect(parse("MLB Mod SL 11/21/26 ERS ")?.due_back).toBeNull();
    expect(parse("MLB Mod SL 11/23/26")?.due_back).toBeNull();
    // A start typed without its year takes the year nearest today.
    expect(parse("INT Mod NEXT/SL 10/17 ERS  12/27")?.started).toBe("2026-10-17");
  });

  test("keeps the sheet's own doubt as doubt", () => {
    expect(parse("MIA Mod SL? 11/9/26 ERS 1/23")?.unsure).toBe(true);
    expect(parse("SAL MOD SL??? 11/1/26 ERS")?.unsure).toBe(true);
    expect(parse("PNS Mod Next/STC  11/8/26 ERS 1/11", "Yes")?.unsure).toBe(true);
    expect(parse("PNS Mod Next/STC  11/8/26 ERS 1/11")).toBeNull();
    expect(parse("PNS Mod Next/STC  11/8/26 ERS 1/11", "No")).toBeNull();
  });

  test("returns nothing for a cell it isn't sure of", () => {
    for (const cell of [
      "",
      "   ",
      "INT Mod NEXT 10/27 ERS 11/25", // interior only
      "VCV Stored 3/1/26 ERS 12/31", // stored, not a mod
      "XMN Mod SL 11/1626 ERS 12/6", // mistyped start
      "MLB Mod SL 11/227/26 ERS", // mistyped start
      "IAB Mod SL 11/11/26 RTS", // back in service, or due back? unclear
      "MIA Mod SL 13/2/26 ERS 12/17", // no month 13
      "MIA Mod SL 2/30/26", // no Feb 30
      "MIA Mod SL 11/2/19 ERS 12/17", // years away from today
      "MIA Mod SL 11/2/26 ERS 12/17 call 555-0100",
      "MIA Mod SL/WIFI 11/2/26", // a word we don't know
      "MIAMI Mod SL 11/2/26",
      "Mod SL 11/2/26",
      "<script>alert(1)</script> MIA Mod SL 11/2/26",
      "MIA Mod SL 11/2/26 ERS 12/17<img src=x onerror=alert(1)>",
      "MIA Mod SL 11/2/26'; DROP TABLE starlink_planes;--",
      `MIA Mod SL 11/2/26 ${"A".repeat(5000)}`,
      "MIA Mod SL １１/2/26", // full-width digits
    ]) {
      expect(parse(cell), cell).toBeNull();
    }
    expect(parseModNote({ note: null }, TODAY)).toBeNull();
    expect(parseModNote({ note: undefined }, TODAY)).toBeNull();
  });

  test("a return date that isn't one drops the date, not the note", () => {
    expect(parse("MIA Mod SL 11/2/26 ERS 2/30")).toEqual({
      station: "MIA",
      started: "2026-11-02",
      due_back: null,
      unsure: false,
    });
    // More than MAX_VISIT_DAYS after the start: not a hangar visit's length.
    expect(parse("MIA Mod SL 11/2/26 ERS 10/30")?.due_back).toBeNull();
  });

  test("every parsed field has a fixed shape, whatever the cell", () => {
    const hostile = ["MIA Mod SL 11/2/26 ERS 12/17", "abc Mod sl?/next 1/5 ers 2/3"];
    for (const cell of hostile) {
      const n = parse(cell);
      if (!n) continue;
      expect(n.station).toMatch(/^[A-Z]{3}$/);
      expect(n.started).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (n.due_back !== null) expect(n.due_back).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof n.unsure).toBe("boolean");
    }
  });
});

const note = (over: Partial<SheetModNote> = {}): SheetModNote => {
  const base = { station: "MIA", started: "2026-11-02", due_back: "2026-12-17" as string | null };
  const n = { ...base, ...over };
  return {
    airline: "UA",
    tail: "N37257",
    unsure: false,
    holds_until: modHoldsUntil(n),
    read_at: 1,
    ...n,
  };
};

describe("fittingPhrase", () => {
  test("carries the sheet's date, or none", () => {
    expect(fittingPhrase(note(), TODAY)).toBe(
      "being fitted with Starlink at MIA (Miami, FL), due back about Dec 17"
    );
    expect(fittingPhrase(note({ due_back: null }), TODAY)).toBe(
      "being fitted with Starlink at MIA (Miami, FL)"
    );
    expect(fittingPhrase(note({ due_back: "2026-11-23" }), TODAY)).toContain(
      "was due back about Nov 23"
    );
    // An unknown station stays a bare code; a doubted note claims no fit.
    const doubted = fittingPhrase(note({ station: "ZZZ", unsure: true }), TODAY);
    expect(doubted).toStartWith("in a hangar at ZZZ, possibly for Starlink");
    expect(doubted).not.toContain("being fitted");
  });

  test("the panel escapes what it prints", () => {
    const html = renderToStaticMarkup(
      FittingPanel({ fitting: [note({ tail: "<b>N1</b>", station: "<i>" })] })
    );
    expect(html).not.toContain("<b>N1</b>");
    expect(html).not.toContain("<i>");
    expect(renderToStaticMarkup(FittingPanel({ fitting: [] }))).toBe("");
  });
});

const csv = (rows: string[]) =>
  ['38M,Reg #,AC #,WiFi,"Status - Mod , Paint, New, Stored ONLY",To Rcv Starlink', ...rows].join(
    "\n"
  );

const MAINLINE_DOC = FLEET_SHEETS.find((s) => s.fleet === "mainline")?.docId;

async function readSheet(rows: string[]) {
  return fetchAllSheets({
    today: TODAY,
    fetchTabs: async () => null,
    fetchCsv: async (doc, gid) => (doc === MAINLINE_DOC && gid === 6 ? csv(rows) : csv([])),
  });
}

describe("sheet read", () => {
  test("keeps hangar notes for rows whatever their Wi-Fi cell says", async () => {
    const read = await readSheet([
      "37E,N37257,7257,ViaSatKA,MIA Mod SL 11/2/26 ERS 12/17,",
      "37E,N47524,7524,Starlink,RFD Mod Next/SL 11/15/26 ERS  1/1,",
      "37E,N17301,7301,ViaSatKA,IAB Mod SL 11/11/26 RTS,",
      "37E,N68821,3821,Starlink,INT Mod NEXT 10/27 ERS 11/25,",
      "37E,not a tail,7999,ViaSatKA,MIA Mod SL 11/2/26 ERS 12/17,",
    ]);
    expect(read.modNotes.map((n) => n.tail).sort()).toEqual(["N37257", "N47524"]);
    expect(read.starlinkAircraft.map((a) => a.TailNumber).sort()).toEqual(["N47524", "N68821"]);
    expect(read.sheetOrder.length).toBe(4);
    for (const r of read.sheetOrder) {
      expect(typeof r.fleetNumber).toBe("number");
      expect(typeof r.listed).toBe("boolean");
    }
  });
});

const STATS = {
  express: { total: 0, starlink: 0, unverified: 0, percentage: 0 },
  mainline: { total: 3, starlink: 2, unverified: 0, percentage: 0 },
  combined: { total: 3, starlink: 2, unverified: 0, percentage: 0 },
};
const listing = (tail: string) => ({
  TailNumber: tail,
  Aircraft: "737 MAX 9",
  WiFi: "Starlink",
  sheet_gid: "70572532",
  sheet_type: "39M",
  fleet: "mainline",
  OperatedBy: "United Airlines",
});
const roster = (db: ReturnType<typeof makeSyntheticDb>, tail: string, status = "unknown") =>
  db
    .query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
       VALUES (?, 'Boeing 737 MAX 9', 'fr24', 1, 1, 'mainline', ?, 'UA')`
    )
    .run(tail, status);

describe("hangar notes in the database", () => {
  test("a note that holds keeps an unobserved listing out of every count", () => {
    const db = makeSyntheticDb();
    const today = utcToday();
    for (const t of ["N47524", "N47525", "N37257"]) roster(db, t);
    const rows = [listing("N47524"), listing("N47525")];
    updateDatabase(db, 3, rows, STATS, "UA", []);
    const before = countStarlinkPlanes(db, "UA");
    expect(before).toBe(2);

    const held = {
      tail: "N47524",
      station: "RFD",
      started: addDays(today, -10),
      due_back: addDays(today, 30),
      unsure: false,
    };
    const unlisted = { ...held, tail: "N37257", station: "MIA" };
    updateDatabase(db, 3, rows, STATS, "UA", [held, unlisted]);
    expect(countStarlinkPlanes(db, "UA")).toBe(before - 1);
    const page = getFleetPageData(db, "UA");
    expect(page.totalStarlink).toBe(before - 1);
    expect(page.sheetFitting.map((n) => n.tail).sort()).toEqual(["N37257", "N47524"]);
    // A note adds no tail to a count: the unlisted jet is labelled, nothing more.
    expect(page.allTails.length).toBe(3);

    const record = getTailRecord(db, "UA", "N47524");
    expect(record?.kind).not.toBe("listed");
    expect(record?.fitting?.station).toBe("RFD");
    expect(getTailRecord(db, "UA", "N47525")?.fitting).toBeNull();

    // Observed on Starlink: the observation outranks the note.
    db.query(
      "UPDATE starlink_planes SET verified_wifi = 'Starlink' WHERE TailNumber = 'N47524'"
    ).run();
    expect(countStarlinkPlanes(db, "UA")).toBe(before);

    // The sheet drops the note: the next read drops ours.
    updateDatabase(db, 3, rows, STATS, "UA", []);
    expect(getSheetModNotes(db, "UA")).toEqual([]);
    // A caller with no notes to give leaves the stored ones alone.
    updateDatabase(db, 3, rows, STATS, "UA", [held]);
    updateDatabase(db, 3, rows, STATS, "UA");
    expect(getSheetModNotes(db, "UA").length).toBe(1);
    db.close();
  });

  test("a doubted or lapsed note holds nothing back", () => {
    const db = makeSyntheticDb();
    const today = utcToday();
    roster(db, "N47524");
    updateDatabase(db, 1, [listing("N47524")], STATS, "UA", []);
    const base = { tail: "N47524", station: "RFD", started: addDays(today, -60) };
    replaceSheetModNotes(db, "UA", [{ ...base, due_back: addDays(today, 5), unsure: true }]);
    expect(countStarlinkPlanes(db, "UA")).toBe(1);
    replaceSheetModNotes(db, "UA", [{ ...base, due_back: addDays(today, -20), unsure: false }]);
    expect(countStarlinkPlanes(db, "UA")).toBe(1);
    expect(getSheetModNotes(db, "UA")).toEqual([]);
    db.close();
  });
});

describe("sub-fleet order", () => {
  const group = (n: number, listed: (i: number) => boolean): SheetOrderRow[] =>
    Array.from({ length: n }, (_, i) => ({
      tail: `N${7400 + i}`,
      group: "g",
      fleetNumber: 7400 + i,
      listed: listed(i),
    }));

  test("scores a listed, uncounted tail by its counted neighbours", () => {
    // A hole at 7406 in a counted run; 7410 and 7411 are not fitted yet.
    const rows = group(12, (i) => i <= 9);
    const counted = new Set(rows.slice(0, 10).map((r) => r.tail));
    counted.delete("N7406");
    const scores = subfleetOrderScores(rows, counted);
    expect([...scores.keys()]).toEqual(["N7406"]);
    const score = scores.get("N7406") ?? 0;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
    // The hangar note outranks order.
    expect(subfleetOrderScores(rows, counted, new Set(["N7406"])).size).toBe(0);
  });

  test("says nothing on a finished sub-fleet or among uncounted neighbours", () => {
    const done = group(10, () => true);
    const all = new Set(done.map((r) => r.tail).filter((t) => t !== "N7405"));
    expect(subfleetOrderScores(done, all).size).toBe(0);
    expect(
      subfleetOrderScores(
        group(10, () => true),
        new Set(["N7400"])
      ).size
    ).toBe(0);
  });

  test("moves the tail up the queue without making anything due sooner", () => {
    const db = makeSyntheticDb();
    const rows = group(12, (i) => i <= 9);
    for (const r of rows) roster(db, r.tail);
    updateDatabase(
      db,
      12,
      rows.slice(0, 10).map((r) => listing(r.tail)),
      STATS,
      "UA",
      []
    );
    db.query(
      "UPDATE starlink_planes SET verified_wifi = 'Viasat' WHERE TailNumber = 'N7406'"
    ).run();
    const dueBefore = db
      .query("SELECT tail_number, next_check_after, starlink_status FROM united_fleet ORDER BY 1")
      .all();
    const countBefore = countStarlinkPlanes(db, "UA");

    expect(applySubfleetOrder(db, "UA", rows)).toBe(1);
    expect(getNextPlanesToVerify(db, 1, "UA")[0].tail_number).toBe("N7406");
    expect(
      db
        .query("SELECT tail_number, next_check_after, starlink_status FROM united_fleet ORDER BY 1")
        .all()
    ).toEqual(dueBefore);
    expect(countStarlinkPlanes(db, "UA")).toBe(countBefore);
    expect(getNextPlanesToVerify(db, 100, "UA").length).toBe(12);

    // Once counted, the hint is withdrawn on the next read.
    db.query(
      "UPDATE starlink_planes SET verified_wifi = 'Starlink' WHERE TailNumber = 'N7406'"
    ).run();
    db.query(
      "UPDATE united_fleet SET starlink_status = 'confirmed' WHERE tail_number = 'N7406'"
    ).run();
    expect(applySubfleetOrder(db, "UA", rows)).toBe(0);
    const max = db.query("SELECT MAX(discovery_priority) AS p FROM united_fleet").get() as {
      p: number;
    };
    expect(max.p).toBeLessThanOrEqual(1);
    db.close();
  });
});
