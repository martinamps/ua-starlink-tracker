/**
 * Daily ingest of the United Fleet Site "Starlink Progress" workbooks — the
 * per-type install pipeline (Complete / In Mod / Verification needed) that the
 * roster sheets we already scrape don't carry. Counts only: per-tail install
 * state lives in cell colors, which the CSV export strips.
 */

import type { Database } from "bun:sqlite";
import { looksLikeValidTailNumber } from "../airlines/registry";
import { replaceFleetProgress } from "../database/database";
import { COUNTERS, GAUGES, metrics, normalizeAirlineTag, withSpan } from "../observability";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError, warn } from "../utils/logger";
import { fetchSheetCsv } from "../utils/utils";

export type ProgressSegment = "mainline_nb" | "mainline_wb" | "express";

const MAINLINE_PROGRESS_DOC = "1QQyca_aIbxrV7uXuYfNdHuTygHwsaTFC9uf_dZbKWnI";
const EXPRESS_PROGRESS_DOC = "1rADs3NACwfFOgqQATmj9CXWkwFH00yGUwmN1zrrT4u8";

const PROGRESS_SHEETS: Array<{ segment: ProgressSegment; docId: string; gid: number }> = [
  { segment: "mainline_nb", docId: MAINLINE_PROGRESS_DOC, gid: 96918390 },
  { segment: "mainline_wb", docId: MAINLINE_PROGRESS_DOC, gid: 1396514988 },
  { segment: "express", docId: EXPRESS_PROGRESS_DOC, gid: 0 },
];

// Summary-row labels as they appear in column A, normalized to our fields.
// Mainline uses "Starlink Complete"/"% Completed"/"Updated ET"; express uses
// "Starlink"/"% Starlink"/"Updated EST"/"Total (no Exit/Fltr)".
const LABEL_FIELDS: Array<[RegExp, keyof ParsedSummary]> = [
  [/^total \(no exit/i, "total"],
  [/^total$/i, "total"],
  [/^starlink complete$/i, "complete"],
  [/^completed$/i, "complete"],
  [/^starlink$/i, "complete"],
  [/^in mod$/i, "inMod"],
  [/^verification needed$/i, "verificationNeeded"],
  [/^updated/i, "updated"],
];

interface ParsedSummary {
  total?: string;
  complete?: string;
  inMod?: string;
  verificationNeeded?: string;
  updated?: string;
}

// Single pass over the whole export so newlines inside quoted cells stay part
// of the cell instead of shearing the row.
function parseCsvGrid(csvText: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  const endRow = () => {
    cells.push(field.replace(/\r$/, ""));
    if (cells.some((c) => c.trim() !== "")) rows.push(cells);
    cells = [];
    field = "";
  };
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (ch === '"') {
      if (inQuotes && csvText[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      cells.push(field);
      field = "";
    } else if (ch === "\n" && !inQuotes) {
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || cells.length > 0) endRow();
  return rows;
}

function toCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.replace(/[,%\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Sheet column headers carry positional junk ("Tab#2 E175", "Wide E175",
// "Bottom CRJ2") — the real type code is the last token.
function cleanTypeCode(header: string): string {
  const trimmed = header.trim();
  const last = trimmed.split(/\s+/).at(-1) ?? "";
  return last.length >= 2 ? last : trimmed;
}

export interface ProgressTypeRow {
  segment: ProgressSegment;
  type_code: string;
  total: number | null;
  starlink_complete: number | null;
  in_mod: number | null;
  verification_needed: number | null;
  sheet_updated: string | null;
}

/** Parse one progress tab's CSV into per-type rows plus the "Totals" rollup. */
export function parseProgressCsv(csvText: string, segment: ProgressSegment): ProgressTypeRow[] {
  const grid = parseCsvGrid(csvText);
  const headerIdx = grid.findIndex((row) => row.some((c) => c.trim() === "Totals"));
  if (headerIdx === -1) return [];
  const header = grid[headerIdx];

  const columns: Array<{ col: number; type: string }> = [];
  for (let col = 1; col < header.length; col++) {
    const name = cleanTypeCode(header[col] ?? "");
    if (name) columns.push({ col, type: name });
  }
  if (columns.length === 0) return [];

  const summaries = new Map<number, ParsedSummary>();
  for (const { col } of columns) summaries.set(col, {});
  let sheetUpdated: string | null = null;

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    // The summary block ends where the per-tail listing starts.
    if (row.slice(1).some((c) => looksLikeValidTailNumber(c.trim()))) break;
    const label = (row[0] ?? "").trim();
    if (!label) continue;
    const field = LABEL_FIELDS.find(([re]) => re.test(label))?.[1];
    if (!field) continue;
    // First matching row wins, except "Total (no Exit/Fltr)" which beats a
    // plain "Total" — the no-exit figure is the operating denominator.
    const preferredTotal = field === "total" && /no exit/i.test(label);
    for (const { col } of columns) {
      const summary = summaries.get(col);
      if (!summary || (summary[field] !== undefined && !preferredTotal)) continue;
      const value = (row[col] ?? "").trim();
      if (value === "") continue;
      summary[field] = value;
      if (field === "updated" && !sheetUpdated) sheetUpdated = value;
    }
  }

  const byType = new Map<string, ProgressTypeRow>();
  for (const { col, type } of columns) {
    const s = summaries.get(col) ?? {};
    const parsed: ProgressTypeRow = {
      segment,
      type_code: type,
      total: toCount(s.total),
      starlink_complete: toCount(s.complete),
      in_mod: toCount(s.inMod),
      verification_needed: toCount(s.verificationNeeded),
      sheet_updated: s.updated?.trim() || sheetUpdated,
    };
    if (
      parsed.total === null &&
      parsed.starlink_complete === null &&
      parsed.in_mod === null &&
      parsed.verification_needed === null
    ) {
      continue;
    }
    const existing = byType.get(type);
    if (!existing) {
      byType.set(type, parsed);
      continue;
    }
    // The sheet splits some types across two columns — fold them into one row.
    const add = (a: number | null, b: number | null) =>
      a === null && b === null ? null : (a ?? 0) + (b ?? 0);
    existing.total = add(existing.total, parsed.total);
    existing.starlink_complete = add(existing.starlink_complete, parsed.starlink_complete);
    existing.in_mod = add(existing.in_mod, parsed.in_mod);
    existing.verification_needed = add(existing.verification_needed, parsed.verification_needed);
  }

  return [...byType.values()];
}

export interface FleetProgressSyncResult {
  outcome: "success" | "partial" | "error";
  segments: number;
  rows: number;
}

export async function runFleetProgressSync(
  db: Database,
  fetchCsv: typeof fetchSheetCsv = fetchSheetCsv
): Promise<FleetProgressSyncResult> {
  return withSpan(
    "scraper.fleet_progress",
    async (span): Promise<FleetProgressSyncResult> => {
      span.setTag("job.type", "background");
      const airlineTag = normalizeAirlineTag("UA");
      const allRows: ProgressTypeRow[] = [];
      let failed = 0;

      for (const sheet of PROGRESS_SHEETS) {
        try {
          const rows = parseProgressCsv(await fetchCsv(sheet.docId, sheet.gid), sheet.segment);
          if (rows.length === 0) throw new Error("no progress rows parsed");
          allRows.push(...rows);
        } catch (err) {
          failed++;
          warn(`fleet-progress: ${sheet.segment} fetch/parse failed`, err);
        }
      }

      const outcome: FleetProgressSyncResult["outcome"] =
        failed === PROGRESS_SHEETS.length ? "error" : failed > 0 ? "partial" : "success";
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "fleet_progress",
        airline: airlineTag,
        status: outcome,
      });
      span.setTag("result", outcome);

      if (outcome === "error") {
        logError("fleet-progress: all progress sheets failed; nothing written");
        return { outcome, segments: 0, rows: 0 };
      }

      replaceFleetProgress(db, "UA", allRows);

      // One gauge per segment rollup so dashboards/monitors can watch the
      // pipeline (and catch a parse regression as a sudden drop to zero).
      const totalsRows = allRows.filter((r) => r.type_code === "Totals");
      for (const rollup of totalsRows) {
        const states: Array<[string, number | null]> = [
          ["total", rollup.total],
          ["complete", rollup.starlink_complete],
          ["in_mod", rollup.in_mod],
          ["verification_needed", rollup.verification_needed],
        ];
        for (const [state, value] of states) {
          if (value !== null) {
            metrics.gauge(GAUGES.FLEET_PROGRESS_COUNT, value, {
              segment: rollup.segment,
              state,
              airline: airlineTag,
            });
          }
        }
      }

      const summary = totalsRows
        .map(
          (r) => `${r.segment}: ${r.starlink_complete}/${r.total} complete, ${r.in_mod ?? 0} in mod`
        )
        .join("; ");
      info(`fleet-progress sync ${outcome}: ${allRows.length} rows (${summary})`);
      return { outcome, segments: PROGRESS_SHEETS.length - failed, rows: allRows.length };
    },
    { "job.type": "background" }
  );
}

export function startFleetProgressJob(db: Database): JobHandle {
  return startJob({
    name: "fleet_progress",
    intervalMs: 24 * 3600 * 1000,
    initialDelayMs: 5 * 60 * 1000,
    run: async () => {
      await runFleetProgressSync(db);
    },
  });
}
