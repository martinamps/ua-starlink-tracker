// Pins the fleet-site progress workbook parsing (summary rows only — per-tail
// state is color-encoded and deliberately out of scope) and the replace/read path.

import { describe, expect, test } from "bun:test";
import { getFleetProgress, replaceFleetProgress } from "../src/database/database";
import { parseProgressCsv, runFleetProgressSync } from "../src/scripts/fleet-progress";
import { makeSyntheticDb } from "./helpers";

// Mirrors the real tab shape, including the trailing "Of Total" % column.
const MAINLINE_NB_CSV = [
  '"Type","73G","738","738","Totals","Of Total"',
  '"Total","40","67","74","181","100.0%"',
  '"Starlink Complete","0","16","21","37","20.4%"',
  '"W/O Starlink","40","51","53","144","79.6%"',
  '"Verification needed ","0","0","5","5","2.8%"',
  '"In Mod","1","6","3","10","5.5%"',
  '"% Completed","0.0%","23.9%","28.4%","20.4%",""',
  '"Updated ET","6/14 1am","6/14 1am","6/14 1am"," ",""',
  '"","N16701","N37263","N76265","",""',
  '"STARLINK MOD","N24702","N76265","N33266","",""',
  '"MLB (DG3)","N16703","N33264","N37267","",""',
].join("\n");

const EXPRESS_CSV = [
  '"Junk header text Type","Wide E175","Tab#2 E175","Bottom CRJ2","Totals",""',
  '"Total (no Exit/Fltr)","59","66","41","166",""',
  '"Starlink","59","66","0","125",""',
  '"In Mod","0","0","0","0",""',
  '"In Operation","59","66","41","166",""',
  '"% Starlink","100.0%","100.0%","0.0%","75.3%",""',
  '"Updated EST","6/14 1am","6/14 1am","6/14 1am","",""',
  '"","OO/SkyWst","RW/Republic","OO/SkyWst","",""',
  '"Starlink","N106SY","N721YX","N920EV","",""',
].join("\n");

describe("parseProgressCsv", () => {
  test("extracts the Totals rollup and per-type counts from a mainline tab", () => {
    const rows = parseProgressCsv(MAINLINE_NB_CSV, "mainline_nb");
    const totals = rows.find((r) => r.type_code === "Totals");
    expect(totals).toMatchObject({
      segment: "mainline_nb",
      total: 181,
      starlink_complete: 37,
      in_mod: 10,
      verification_needed: 5,
    });
    expect(totals?.sheet_updated).toContain("6/14");
  });

  test("sums duplicate type columns into one row", () => {
    const rows = parseProgressCsv(MAINLINE_NB_CSV, "mainline_nb");
    const b738 = rows.find((r) => r.type_code === "738");
    expect(b738).toMatchObject({ total: 141, starlink_complete: 37, in_mod: 9 });
  });

  test("handles the express tab labels and ignores the tail-listing rows", () => {
    const rows = parseProgressCsv(EXPRESS_CSV, "express");
    const totals = rows.find((r) => r.type_code === "Totals");
    expect(totals).toMatchObject({ total: 166, starlink_complete: 125, in_mod: 0 });
    // Aggregated across the two E175 columns (59 + 66); the second "Starlink"
    // row (tail listing) must not overwrite the summary value.
    const e175 = rows.find((r) => r.type_code === "E175");
    expect(e175?.starlink_complete).toBe(125);
  });

  // Regression, github issue #64: the "Of Total" percentage column rendered as
  // a fake type row ("Total: 2 in mod") because "2.3%" was parsed as a count.
  test("the Of Total percentage column never becomes a type row", () => {
    const rows = parseProgressCsv(MAINLINE_NB_CSV, "mainline_nb");
    expect(rows.map((r) => r.type_code).sort()).toEqual(["738", "73G", "Totals"]);
  });

  test("returns no rows for content without a Totals header", () => {
    expect(parseProgressCsv("not,a,progress,sheet\n1,2,3,4", "express")).toEqual([]);
  });
});

describe("fleet_progress storage", () => {
  test("replace drops rows for types no longer on the sheet and scopes reads by airline", () => {
    const db = makeSyntheticDb();
    const rows = parseProgressCsv(MAINLINE_NB_CSV, "mainline_nb");
    replaceFleetProgress(db, "UA", rows);
    replaceFleetProgress(db, "UA", rows); // idempotent re-run, no duplicate rows
    expect(getFleetProgress(db, "UA").length).toBe(rows.length);

    const without738 = rows.filter((r) => r.type_code !== "738");
    replaceFleetProgress(db, "UA", without738);
    const stored = getFleetProgress(db, "UA");
    expect(stored.length).toBe(without738.length);
    expect(stored.some((r) => r.type_code === "738")).toBe(false);
    expect(stored.every((r) => r.airline === "UA" && r.fetched_at > 0)).toBe(true);
    expect(getFleetProgress(db, "HA")).toEqual([]);
  });
});

describe("runFleetProgressSync", () => {
  test("writes rows from all sheets with an injected fetcher", async () => {
    const db = makeSyntheticDb();
    const fetchCsv = async (docId: string) =>
      docId.includes("1rADs3NACw") ? EXPRESS_CSV : MAINLINE_NB_CSV;
    const result = await runFleetProgressSync(db, fetchCsv);
    expect(result.outcome).toBe("success");
    const stored = getFleetProgress(db, "UA");
    expect(stored.length).toBeGreaterThan(0);
    expect(new Set(stored.map((r) => r.segment))).toEqual(
      new Set(["mainline_nb", "mainline_wb", "express"])
    );
  });

  test("reports error and writes nothing when every sheet fails", async () => {
    const db = makeSyntheticDb();
    const fetchCsv = async () => {
      throw new Error("HTTP 500");
    };
    const result = await runFleetProgressSync(db, fetchCsv);
    expect(result.outcome).toBe("error");
    expect(getFleetProgress(db, "UA")).toEqual([]);
  });
});
