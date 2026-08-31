/**
 * Per-tail install-pipeline states from the progress workbooks' cell colors,
 * via the Sheets API grid read (the CSV export the counts ingest uses strips
 * formatting). The workbooks carry their own legend: each summary label's
 * background is that state's color, and each "XXX (line)" mod-location label's
 * background marks tails currently at that station. Colors are community-
 * maintained and drift, so every state must survive a count-validation gate
 * against the same tab's summary rollup before anything is written — a tab
 * whose colors mean something else (express reuses mainline's "W/O Starlink"
 * yellow for its In Mod label) fails the gate and contributes nothing.
 */

import type { Database } from "bun:sqlite";
import { looksLikeValidTailNumber } from "../airlines/registry";
import { replaceFleetProgressTails } from "../database/database";
import { COUNTERS, GAUGES, metrics, normalizeAirlineTag, withSpan } from "../observability";
import type { FleetProgressTailRow, FleetProgressTailState } from "../types";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError, warn } from "../utils/logger";
import { PROGRESS_SHEETS, type ProgressSegment, cleanTypeCode } from "./fleet-progress";

/** One cell: trimmed text plus background as "r,g,b" (0-255 ints), "" if unset. */
export interface GridCell {
  v: string;
  bg: string;
}

const WHITE = "255,255,255";

// Canonical state colors observed across the workbooks — the fallback when a
// tab's own legend doesn't declare a state (the WB tab has no complete label).
const FALLBACK_STATE_COLORS: ReadonlyMap<string, InternalState> = new Map([
  ["60,120,216", "complete"],
  ["0,255,0", "verification_needed"],
  ["244,204,204", "in_mod"],
]);

// Editors hand-pick "the same blue" imperfectly; anything this close to the
// canonical complete blue still means complete.
const COMPLETE_BLUE = [60, 120, 216];
const COMPLETE_DISTANCE = 40;

type InternalState = FleetProgressTailState | "complete";

export type ProgressTailParsedRow = Omit<FleetProgressTailRow, "airline" | "fetched_at">;

export interface TailGridParse {
  /** Rows for states that passed the count gate (never includes complete). */
  rows: ProgressTailParsedRow[];
  /** States whose color tally disagreed with the summary rollup too much. */
  rejected: Array<{ state: string; parsed: number; expected: number | null }>;
  /** Non-legend colors seen on tail cells, for drift logging. */
  unknownColors: Array<{ color: string; count: number }>;
}

function colorDistance(a: string, b: number[]): number {
  const pa = a.split(",").map(Number);
  return Math.sqrt((pa[0] - b[0]) ** 2 + (pa[1] - b[1]) ** 2 + (pa[2] - b[2]) ** 2);
}

interface TabLegend {
  stateColors: Map<string, InternalState>;
  locColors: Map<string, { loc: string; future: boolean }>;
}

// The legend lives in column A: summary labels carry their state's color, and
// "XXX (line)" entries carry their station's color. A "Future locations"
// heading flips subsequent stations to not-yet-open; "Mod locations" flips
// back (the legend repeats beside long tail listings).
function parseLegend(grid: GridCell[][]): TabLegend {
  const stateColors = new Map<string, InternalState>();
  const locColors = new Map<string, { loc: string; future: boolean }>();
  let future = false;
  for (const row of grid) {
    const cell = row[0];
    if (!cell?.v) continue;
    const label = cell.v;
    const color = cell.bg;
    if (color && color !== WHITE) {
      if (/^(starlink complete|starlink|completed)$/i.test(label)) {
        if (!stateColors.has(color)) stateColors.set(color, "complete");
      } else if (/^verification needed/i.test(label)) {
        if (!stateColors.has(color)) stateColors.set(color, "verification_needed");
      } else if (/^in mod$/i.test(label)) {
        if (!stateColors.has(color)) stateColors.set(color, "in_mod");
      }
      const loc = label.match(/^([A-Z]{3})\s*\(/);
      if (loc && !locColors.has(color)) locColors.set(color, { loc: loc[1], future });
    }
    if (/future locations/i.test(label)) future = true;
    else if (/^mod locations?$/i.test(label)) future = false;
  }
  return { stateColors, locColors };
}

function toCount(raw: string | undefined): number | null {
  if (!raw || raw.includes("%")) return null;
  const n = Number(raw.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Community counts and colors are both hand-maintained and drift by a tail or
// two; a small gap is normal, a large one means the colors don't mean what the
// legend says (or the legend changed).
function withinTolerance(parsed: number, expected: number | null): boolean {
  if (expected === null) return parsed === 0;
  return Math.abs(parsed - expected) <= Math.max(2, Math.ceil(expected * 0.25));
}

/** Decode one tab's grid into validated per-tail pipeline rows. */
export function parseProgressTailGrid(grid: GridCell[][], segment: ProgressSegment): TailGridParse {
  const empty: TailGridParse = { rows: [], rejected: [], unknownColors: [] };
  const headerIdx = grid.findIndex((row) => row.some((c) => c.v === "Totals"));
  if (headerIdx === -1) return empty;
  const header = grid[headerIdx];

  const legend = parseLegend(grid);
  let totalsCol = -1;
  const columns: Array<{ col: number; type: string }> = [];
  for (let col = 1; col < header.length; col++) {
    const raw = header[col]?.v ?? "";
    if (raw === "Totals") {
      totalsCol = col;
      continue;
    }
    const name = cleanTypeCode(raw);
    if (!name || /^total$/i.test(name)) continue;
    columns.push({ col, type: name });
  }
  if (columns.length === 0) return empty;

  // Summary rollup (Totals column, else the sum across type columns) — the
  // expected tally each color-derived state must match.
  const expected = new Map<InternalState, number | null>();
  let sheetUpdated: string | null = null;
  let tailStart = headerIdx + 1;
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.slice(1).some((c) => looksLikeValidTailNumber(c.v))) {
      tailStart = r;
      break;
    }
    tailStart = r + 1;
    const label = row[0]?.v ?? "";
    let field: InternalState | null = null;
    if (/^(starlink complete|starlink|completed)$/i.test(label)) field = "complete";
    else if (/^in mod$/i.test(label)) field = "in_mod";
    else if (/^verification needed/i.test(label)) field = "verification_needed";
    else if (/^updated/i.test(label) && !sheetUpdated) {
      sheetUpdated = row.slice(1).find((c) => c.v)?.v ?? null;
    }
    if (!field || expected.has(field)) continue;
    if (totalsCol !== -1) {
      expected.set(field, toCount(row[totalsCol]?.v));
    } else {
      const parts = columns.map(({ col }) => toCount(row[col]?.v)).filter((n) => n !== null);
      expected.set(field, parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : null);
    }
  }

  // Classify every tail cell by color. Precedence: the tab's own state colors,
  // then its mod-location colors, then the cross-tab fallbacks, then near-blue
  // as complete. First sighting wins for duplicated tails.
  const tally = new Map<InternalState, number>();
  const candidates: ProgressTailParsedRow[] = [];
  const unknown = new Map<string, number>();
  const seen = new Set<string>();
  for (let r = tailStart; r < grid.length; r++) {
    for (const { col, type } of columns) {
      const cell = grid[r]?.[col];
      if (!cell || !looksLikeValidTailNumber(cell.v) || seen.has(cell.v)) continue;
      seen.add(cell.v);
      const color = cell.bg;
      if (!color || color === WHITE) continue;
      let state: InternalState | null = legend.stateColors.get(color) ?? null;
      let loc: string | null = null;
      if (!state) {
        const locEntry = legend.locColors.get(color);
        if (locEntry) {
          state = locEntry.future ? "scheduled" : "in_mod";
          loc = locEntry.loc;
        }
      }
      state ??= FALLBACK_STATE_COLORS.get(color) ?? null;
      if (!state && colorDistance(color, COMPLETE_BLUE) < COMPLETE_DISTANCE) state = "complete";
      if (!state) {
        unknown.set(color, (unknown.get(color) ?? 0) + 1);
        continue;
      }
      tally.set(state, (tally.get(state) ?? 0) + 1);
      if (state === "complete") continue;
      candidates.push({
        segment,
        type_code: type,
        tail: cell.v,
        state,
        mod_location: loc,
        sheet_updated: sheetUpdated,
      });
    }
  }

  // The gate: each stored state must roughly match the tab's own rollup.
  // "scheduled" has no summary row — it rides on in_mod's verdict, since both
  // come from the same location-color legend.
  const rejected: TailGridParse["rejected"] = [];
  const accepted = new Set<FleetProgressTailState>();
  const inModOk = withinTolerance(tally.get("in_mod") ?? 0, expected.get("in_mod") ?? null);
  if (inModOk) {
    accepted.add("in_mod");
    accepted.add("scheduled");
  } else {
    rejected.push({
      state: "in_mod",
      parsed: tally.get("in_mod") ?? 0,
      expected: expected.get("in_mod") ?? null,
    });
  }
  const verifParsed = tally.get("verification_needed") ?? 0;
  if (withinTolerance(verifParsed, expected.get("verification_needed") ?? null)) {
    accepted.add("verification_needed");
  } else {
    rejected.push({
      state: "verification_needed",
      parsed: verifParsed,
      expected: expected.get("verification_needed") ?? null,
    });
  }

  return {
    rows: candidates.filter((c) => accepted.has(c.state)),
    rejected,
    unknownColors: [...unknown.entries()].map(([color, count]) => ({ color, count })),
  };
}

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Fetch one tab as a GridCell matrix via the Sheets API (public sheet + API
 * key — no OAuth). Two calls: gid→title, then the formatted grid. */
export async function fetchSheetGrid(
  docId: string,
  gid: number,
  apiKey: string
): Promise<GridCell[][]> {
  const metaRes = await fetch(
    `${SHEETS_API}/${docId}?fields=sheets.properties(sheetId,title)&key=${apiKey}`
  );
  if (!metaRes.ok) throw new Error(`sheets meta HTTP ${metaRes.status}`);
  const meta = (await metaRes.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const title = meta.sheets?.find((s) => s.properties?.sheetId === gid)?.properties?.title;
  if (!title) throw new Error(`no tab with gid ${gid}`);

  // A1:Z500 covers every workbook's used range; the express tab's raw grid is
  // ~1000 formatted rows of mostly nothing.
  const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'!A1:Z500`);
  const gridRes = await fetch(
    `${SHEETS_API}/${docId}?ranges=${range}&fields=sheets(data(rowData(values(formattedValue,effectiveFormat.backgroundColor))))&key=${apiKey}`
  );
  if (!gridRes.ok) throw new Error(`sheets grid HTTP ${gridRes.status}`);
  const doc = (await gridRes.json()) as {
    sheets?: Array<{
      data?: Array<{
        rowData?: Array<{
          values?: Array<{
            formattedValue?: string;
            effectiveFormat?: { backgroundColor?: { red?: number; green?: number; blue?: number } };
          }>;
        }>;
      }>;
    }>;
  };
  const rowData = doc.sheets?.[0]?.data?.[0]?.rowData ?? [];
  return rowData.map((row) =>
    (row.values ?? []).map((cell) => {
      const bg = cell.effectiveFormat?.backgroundColor;
      return {
        v: (cell.formattedValue ?? "").trim(),
        bg: bg
          ? [bg.red ?? 0, bg.green ?? 0, bg.blue ?? 0].map((c) => Math.round(c * 255)).join(",")
          : "",
      };
    })
  );
}

export interface FleetProgressTailsSyncResult {
  outcome: "success" | "partial" | "error" | "skipped";
  segments: number;
  rows: number;
}

export async function runFleetProgressTailsSync(
  db: Database,
  fetchGrid: typeof fetchSheetGrid = fetchSheetGrid,
  apiKey: string | undefined = process.env.SHEETS_API_KEY
): Promise<FleetProgressTailsSyncResult> {
  if (!apiKey) {
    info("fleet-progress-tails: SHEETS_API_KEY not set; per-tail ingest skipped");
    return { outcome: "skipped", segments: 0, rows: 0 };
  }
  return withSpan(
    "scraper.fleet_progress_tails",
    async (span): Promise<FleetProgressTailsSyncResult> => {
      span.setTag("job.type", "background");
      const airlineTag = normalizeAirlineTag("UA");
      let failed = 0;
      let written = 0;

      for (const sheet of PROGRESS_SHEETS) {
        try {
          const parse = parseProgressTailGrid(
            await fetchGrid(sheet.docId, sheet.gid, apiKey),
            sheet.segment
          );
          for (const rej of parse.rejected) {
            warn(
              `fleet-progress-tails: ${sheet.segment} ${rej.state} failed the count gate ` +
                `(colors say ${rej.parsed}, summary says ${rej.expected ?? "n/a"}) — state dropped`
            );
          }
          if (parse.unknownColors.length > 0) {
            const detail = parse.unknownColors.map((u) => `${u.color}×${u.count}`).join(" ");
            warn(`fleet-progress-tails: ${sheet.segment} unrecognized cell colors: ${detail}`);
          }
          replaceFleetProgressTails(db, "UA", sheet.segment, parse.rows);
          written += parse.rows.length;

          const byState = new Map<string, number>();
          for (const r of parse.rows) byState.set(r.state, (byState.get(r.state) ?? 0) + 1);
          for (const state of ["in_mod", "verification_needed", "scheduled"]) {
            metrics.gauge(GAUGES.FLEET_PROGRESS_TAILS, byState.get(state) ?? 0, {
              segment: sheet.segment,
              state,
              airline: airlineTag,
            });
          }
        } catch (err) {
          failed++;
          warn(`fleet-progress-tails: ${sheet.segment} fetch/parse failed`, err);
        }
      }

      const outcome: FleetProgressTailsSyncResult["outcome"] =
        failed === PROGRESS_SHEETS.length ? "error" : failed > 0 ? "partial" : "success";
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "fleet_progress_tails",
        airline: airlineTag,
        status: outcome,
      });
      span.setTag("result", outcome);
      if (outcome === "error") {
        logError("fleet-progress-tails: every progress sheet failed; nothing written");
      } else {
        info(
          `fleet-progress-tails sync ${outcome}: ${written} pipeline tails across ${
            PROGRESS_SHEETS.length - failed
          } segments`
        );
      }
      return { outcome, segments: PROGRESS_SHEETS.length - failed, rows: written };
    },
    { "job.type": "background" }
  );
}

export function startFleetProgressTailsJob(db: Database): JobHandle {
  return startJob({
    name: "fleet_progress_tails",
    intervalMs: 24 * 3600 * 1000,
    initialDelayMs: 7 * 60 * 1000,
    run: async () => {
      await runFleetProgressTailsSync(db);
    },
  });
}
