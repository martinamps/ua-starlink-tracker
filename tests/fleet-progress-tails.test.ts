// Pins the color-grid decode of per-tail install states: the legend-driven
// classification, the count-validation gate that keeps community color drift
// out of the DB, and the segment-scoped storage path.

import { describe, expect, test } from "bun:test";
import {
  computeFleetMovements,
  getFleetProgressTails,
  getPipelineEvents,
  insertPipelineEvents,
  replaceFleetProgressTails,
} from "../src/database/database";
import {
  type GridCell,
  diffPipelineEvents,
  parseProgressTailGrid,
  runFleetProgressTailsSync,
} from "../src/scripts/fleet-progress-tails";
import { makeSyntheticDb } from "./helpers";

const BLUE = "60,120,216"; // complete
const OFF_BLUE = "61,133,198"; // hand-picked "same" blue
const GREEN = "0,255,0"; // verification needed
const PINK = "244,204,204"; // in mod (no location)
const MLB = "102,102,102"; // an open mod line
const ILN = "182,215,168"; // a future mod line
const MYSTERY = "13,37,73"; // in no legend

const c = (v: string, bg = ""): GridCell => ({ v, bg });

// Mirrors the real tab shape: summary block with colored labels in column A,
// then the per-tail grid with the mod-location legend running down column A.
const MAINLINE_GRID: GridCell[][] = [
  [c("Type"), c("738"), c("739"), c("Totals"), c("Of Total")],
  [c("Total"), c("4"), c("3"), c("7"), c("100.0%")],
  [c("Starlink Complete", BLUE), c("1"), c("1"), c("2"), c("28.6%")],
  [c("Verification needed ", GREEN), c("1"), c("0"), c("1"), c("14.3%")],
  [c("In Mod", PINK), c("1"), c("1"), c("2"), c("28.6%")],
  [c("Updated ET"), c("8/31 1am"), c("8/31 1am"), c("")],
  [c(""), c("N76269", BLUE), c("N37281", MLB)],
  [c("Mod locations"), c("N87512", GREEN), c("N24519", PINK)],
  [c("MLB (DG3)", MLB), c("N33262", OFF_BLUE), c("N37282")],
  [c("Future locations??"), c("N14228")],
  [c("ILN (G3)", ILN), c("N79279", ILN)],
];

describe("parseProgressTailGrid", () => {
  test("decodes states from the tab's own legend and keeps complete out of storage", () => {
    const parse = parseProgressTailGrid(MAINLINE_GRID, "mainline_nb");
    expect(parse.rejected).toEqual([]);
    const byTail = new Map(parse.rows.map((r) => [r.tail, r]));

    // MLB's color means "in mod at MLB"; the plain pink means in mod, line unknown.
    expect(byTail.get("N37281")).toMatchObject({ state: "in_mod", mod_location: "MLB" });
    expect(byTail.get("N24519")).toMatchObject({ state: "in_mod", mod_location: null });
    expect(byTail.get("N87512")).toMatchObject({ state: "verification_needed" });
    // A future-location color is queued, not in mod.
    expect(byTail.get("N79279")).toMatchObject({ state: "scheduled", mod_location: "ILN" });
    // Complete (exact blue or an editor's near-blue) is tallied for validation
    // but never stored; unpainted tails don't appear at all.
    expect(byTail.has("N76269")).toBe(false);
    expect(byTail.has("N33262")).toBe(false);
    expect(byTail.has("N37282")).toBe(false);
    expect(parse.rows).toHaveLength(4);
    expect(parse.rows.every((r) => r.sheet_updated === "8/31 1am")).toBe(true);
  });

  test("a color the legend doesn't know is reported, not guessed at", () => {
    const grid = MAINLINE_GRID.map((row) => [...row]);
    grid[8] = [c("MLB (DG3)", MLB), c("N33262", MYSTERY), c("N37282")];
    const parse = parseProgressTailGrid(grid, "mainline_nb");
    expect(parse.unknownColors).toEqual([{ color: MYSTERY, count: 1 }]);
    expect(parse.rows.some((r) => r.tail === "N33262")).toBe(false);
  });

  test("a duplicated tail is only counted once", () => {
    const grid = MAINLINE_GRID.map((row) => [...row]);
    grid.push([c(""), c("N37281", MLB)]);
    const parse = parseProgressTailGrid(grid, "mainline_nb");
    expect(parse.rows.filter((r) => r.tail === "N37281")).toHaveLength(1);
    expect(parse.rejected).toEqual([]);
  });

  // The express tab reuses mainline's "W/O Starlink" yellow as its In Mod
  // label color, painting excluded airframes as false in-mod positives — the
  // count gate must drop the state (and scheduled with it) rather than serve it.
  test("a state whose color tally contradicts the summary rollup is dropped", () => {
    const YELLOW = "255,242,204";
    const grid: GridCell[][] = [
      [c("Type"), c("CRJ2"), c("Totals")],
      [c("Total (no Exit/Fltr)"), c("5"), c("5")],
      [c("Starlink", BLUE), c("0"), c("0")],
      [c("In Mod", YELLOW), c("0"), c("0")],
      [c("Updated EST"), c("6/14 1am")],
      [c(""), c("N920EV", YELLOW)],
      [c(""), c("N921EV", YELLOW)],
      [c(""), c("N922EV", YELLOW)],
      [c(""), c("N923EV", YELLOW)],
    ];
    const parse = parseProgressTailGrid(grid, "express");
    expect(parse.rows).toEqual([]);
    expect(parse.rejected).toContainEqual({ state: "in_mod", parsed: 4, expected: 0 });
  });

  test("a state missing from the summary block only passes when no tails claim it", () => {
    // No "Verification needed" summary row: green tails have nothing to
    // validate against and must be dropped.
    const grid: GridCell[][] = [
      [c("Type"), c("777"), c("Totals")],
      [c("Total"), c("2"), c("2")],
      [c("In Mod", PINK), c("1"), c("1")],
      [c(""), c("N78002", PINK)],
      [c(""), c("N78008", GREEN)],
    ];
    const parse = parseProgressTailGrid(grid, "mainline_wb");
    expect(parse.rows).toEqual([
      {
        segment: "mainline_wb",
        type_code: "777",
        tail: "N78002",
        state: "in_mod",
        mod_location: null,
        sheet_updated: null,
      },
    ]);
    expect(parse.rejected).toContainEqual({
      state: "verification_needed",
      parsed: 1,
      expected: null,
    });
  });

  test("returns nothing for a grid without a Totals header", () => {
    expect(parseProgressTailGrid([[c("nope")]], "express")).toMatchObject({ rows: [] });
  });
});

describe("fleet_progress_tails storage", () => {
  test("replace is segment-scoped and reads are airline-scoped", () => {
    const db = makeSyntheticDb();
    const parse = parseProgressTailGrid(MAINLINE_GRID, "mainline_nb");
    replaceFleetProgressTails(db, "UA", "mainline_nb", parse.rows);
    replaceFleetProgressTails(db, "UA", "mainline_nb", parse.rows); // idempotent
    replaceFleetProgressTails(db, "UA", "mainline_wb", [
      {
        segment: "mainline_wb",
        type_code: "777",
        tail: "N78002",
        state: "in_mod",
        mod_location: "HKG",
        sheet_updated: null,
      },
    ]);
    expect(getFleetProgressTails(db, "UA")).toHaveLength(parse.rows.length + 1);

    // A segment whose next parse validated nothing serves nothing stale.
    replaceFleetProgressTails(db, "UA", "mainline_nb", []);
    const remaining = getFleetProgressTails(db, "UA");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ tail: "N78002", state: "in_mod", mod_location: "HKG" });
    expect(remaining[0].fetched_at).toBeGreaterThan(0);
    expect(getFleetProgressTails(db, "HA")).toEqual([]);
  });
});

describe("diffPipelineEvents", () => {
  const row = (
    tail: string,
    state: "in_mod" | "verification_needed" | "scheduled",
    loc: string | null = null
  ) => ({
    segment: "mainline_nb" as const,
    type_code: "738",
    tail,
    state,
    mod_location: loc,
    sheet_updated: null,
  });

  test("announces entries, install completions, and queue assignments", () => {
    const old = [row("N11111", "in_mod"), row("N22222", "in_mod"), row("N44444", "scheduled")];
    const next = [
      row("N11111", "in_mod", "MLB"), // unchanged state — silent
      row("N22222", "verification_needed"), // finished install
      row("N33333", "in_mod", "RFD"), // new arrival
      row("N44444", "in_mod", "ILN"), // queued tail reached its line
      row("N55555", "scheduled", "INT"), // newly queued
    ];
    const events = diffPipelineEvents(old, next, "mainline_nb");
    expect(events.map((e) => `${e.tail}:${e.event}`).sort()).toEqual([
      "N22222:to_verification",
      "N33333:entered_mod",
      "N44444:entered_mod",
      "N55555:queued",
    ]);
    expect(events.find((e) => e.tail === "N33333")?.mod_location).toBe("RFD");
  });

  test("an empty previous snapshot emits nothing (bootstrap)", () => {
    expect(diffPipelineEvents([], [row("N11111", "in_mod")], "mainline_nb")).toEqual([]);
  });
});

describe("pipeline_events storage + movements feed", () => {
  test("insert dedupes repeats within the window and the feed merges installs", () => {
    const db = makeSyntheticDb();
    const draft = {
      tail: "N33333",
      type_code: "738",
      segment: "mainline_nb",
      event: "entered_mod" as const,
      mod_location: "RFD",
    };
    expect(insertPipelineEvents(db, "UA", [draft])).toBe(1);
    expect(insertPipelineEvents(db, "UA", [draft])).toBe(0); // sheet flap — silent
    expect(getPipelineEvents(db, "UA")).toHaveLength(1);
    expect(getPipelineEvents(db, "HA")).toEqual([]);

    // A fresh confirmed install joins the feed alongside the sheet event.
    const today = new Date().toISOString().slice(0, 10);
    db.query(`
      INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
      VALUES ('737-924ER', 'Starlink', 'discovery', 'UA-mainline', ?, 'N44501', 'United Airlines', 'mainline', 'Starlink', 'UA')
    `).run(today);
    const movements = computeFleetMovements(db, ["UA"]);
    const kinds = new Map(movements.map((m) => [m.tail, m.kind]));
    expect(kinds.get("N33333")).toBe("entered_mod");
    expect(kinds.get("N44501")).toBe("confirmed");
    // Newest first, and every row carries a displayable date.
    const dates = movements.map((m) => m.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });
});

describe("runFleetProgressTailsSync", () => {
  test("writes validated rows from every sheet with an injected fetcher", async () => {
    const db = makeSyntheticDb();
    // Each tab needs its own tails — one airframe is never in two segments.
    let call = 0;
    const fetchGrid = async () => {
      const n = call++;
      return MAINLINE_GRID.map((row) =>
        row.map((cell) =>
          /^N\d{5}$/.test(cell.v) ? { ...cell, v: `N${n + 1}${cell.v.slice(2)}` } : cell
        )
      );
    };
    const result = await runFleetProgressTailsSync(db, fetchGrid, "test-key");
    expect(result.outcome).toBe("success");
    expect(result.rows).toBe(12);
    const stored = getFleetProgressTails(db, "UA");
    expect(new Set(stored.map((r) => r.segment))).toEqual(
      new Set(["mainline_nb", "mainline_wb", "express"])
    );
    expect(stored.every((r) => r.airline === "UA")).toBe(true);
  });

  test("second sync records transition events; the first (bootstrap) records none", async () => {
    const db = makeSyntheticDb();
    // Only the NB tab has data; a tail must not exist in two segments.
    const oneTab = (grid: GridCell[][]) => async (_doc: string, gid: number) =>
      gid === 96918390 ? grid : [[c("")]];
    await runFleetProgressTailsSync(db, oneTab(MAINLINE_GRID), "test-key");
    expect(getPipelineEvents(db, "UA")).toEqual([]);

    // N37282 (unpainted) turns pink: it entered a mod line since yesterday.
    const changed = MAINLINE_GRID.map((row) =>
      row.map((cell) => (cell.v === "N37282" ? { ...cell, bg: PINK } : cell))
    );
    // Keep the summary honest: 738 column now has 2 in mod (3 total in Totals).
    changed[4] = [c("In Mod", PINK), c("1"), c("2"), c("3"), c("42.9%")];
    await runFleetProgressTailsSync(db, oneTab(changed), "test-key");
    const events = getPipelineEvents(db, "UA");
    expect(events.some((e) => e.tail === "N37282" && e.event === "entered_mod")).toBe(true);
    // Unchanged tails re-announced nothing.
    expect(events.every((e) => e.tail === "N37282")).toBe(true);
  });

  test("skips without an API key and reports error when every fetch fails", async () => {
    const db = makeSyntheticDb();
    expect((await runFleetProgressTailsSync(db, async () => [], "")).outcome).toBe("skipped");
    const failing = async () => {
      throw new Error("HTTP 500");
    };
    expect((await runFleetProgressTailsSync(db, failing, "test-key")).outcome).toBe("error");
    expect(getFleetProgressTails(db, "UA")).toEqual([]);
  });
});
