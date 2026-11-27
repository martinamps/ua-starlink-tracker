/**
 * Daily ingest of Alaska's own Starlink installation tracker
 * (news.alaskaair.com, refreshed monthly): connected and pending counts per
 * aircraft type, as an HTML table. Alaska publishes no per-tail wifi anywhere
 * (alaskaair.com flight status, seat maps and fleet pages carry none), so this
 * is the only automatable first-party signal for its mainline.
 *
 * Writes:
 *  - fleet_progress rows under AS (segments express / mainline_nb /
 *    mainline_wb, and partner for Hawaiian's A321neo/A330, which Alaska's
 *    chart counts too), read by /fleet, the type pages' official counts, the
 *    freshness gauge and the fleet_progress.count gauges;
 *  - for a type Alaska marks "Update complete", a type-rule listing for every
 *    roster tail of that type in its operator's roster
 *    (settleOfficiallyCompleteType's guard applies), and only from a chart
 *    that passes chart-bounds.ts: a refused chart settles no tail.
 */

import type { Database } from "bun:sqlite";
import { normalizeAircraftType } from "../airlines/aircraft-families";
import { AIRLINES } from "../airlines/registry";
import { validateChartAgainstRoster } from "../database/airline-count";
import {
  CHART_MAX_CELL,
  CHART_MAX_STORE_AGE_DAYS,
  ChartRejected,
  chartDateProblem,
  isCalendarDay,
  reportChartRejected,
  utcDay,
} from "../database/chart-bounds";
import {
  equippedCountByFamily,
  initializeDatabase,
  metaJobStamps,
  replaceFleetProgress,
  settleOfficiallyCompleteType,
} from "../database/database";
import { recordSyncOutcome } from "../database/source-health";
import { COUNTERS, GAUGES, metrics, normalizeAirlineTag, withSpan } from "../observability";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError, warn } from "../utils/logger";
import {
  type ProgressSegment,
  type ProgressTypeRow,
  emitFleetProgressCounts,
} from "./fleet-progress";

const TRACKER_URL = AIRLINES.AS.officialTracker?.url ?? "";
const USER_AGENT = "ua-starlink-tracker (+https://unitedstarlinktracker.com)";

// Family → the fleet_progress type code the type pages already map
// (SHEET_CODE_TO_FAMILY) and the roster whose tails it names.
const FAMILY_CODE: Readonly<
  Record<string, { code: string; segment: ProgressSegment; airline: "AS" | "HA" }>
> = {
  E175: { code: "E175", segment: "express", airline: "AS" },
  "B737-800": { code: "738", segment: "mainline_nb", airline: "AS" },
  "B737-900": { code: "739", segment: "mainline_nb", airline: "AS" },
  "B737-MAX8": { code: "38M", segment: "mainline_nb", airline: "AS" },
  "B737-MAX9": { code: "39M", segment: "mainline_nb", airline: "AS" },
  B787: { code: "789", segment: "mainline_wb", airline: "AS" },
  A321: { code: "321", segment: "partner", airline: "HA" },
  A330: { code: "332", segment: "partner", airline: "HA" },
};

export interface TrackerRow {
  label: string;
  family: string;
  connected: number;
  pending: number;
}

export interface ParsedTracker {
  /** The chart's own "last updated" date, YYYY-MM-DD. */
  asOf: string | null;
  rows: TrackerRow[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Sept. 25, 2026" / "September 25, 2026" → "2026-09-25"; null for a date
 * the calendar doesn't have ("Feb. 31"). */
export function parseNewsroomDate(raw: string): string | null {
  const m = raw.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const iso = `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return isCalendarDay(iso) ? iso : null;
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** A count cell: "-" and blank are 0, "Update complete" in the pending column
 * is 0; anything else non-numeric, or longer than a fleet of one type can be,
 * is unparseable (null). */
function countCell(raw: string): number | null {
  const t = raw.trim();
  if (t === "" || /^[-–—]+$/.test(t) || /complete/i.test(t)) return 0;
  const n = Number(t.replace(/,/g, ""));
  return Number.isInteger(n) && n >= 0 && n <= CHART_MAX_CELL ? n : null;
}

/** Throws when the table is missing, any row fails to parse, or the chart's
 * date is in the future or over a year old: a half-read or impossible chart
 * must never replace the last good one. A date line that can't be read at all
 * leaves the chart undated, and an undated chart never reaches a headline. */
export function parseAlaskaTracker(html: string, today = utcDay()): ParsedTracker {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  const table =
    tables.find((t) => /aria-label="[^"]*starlink tracker/i.test(t)) ??
    tables.find((t) => /connected/i.test(t) && /pending/i.test(t));
  if (!table) throw new Error("tracker table not found");

  const headers = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) =>
    cellText(m[1]).toLowerCase()
  );
  const typeCol = headers.findIndex((h) => h.includes("type"));
  const connectedCol = headers.findIndex((h) => h.includes("connected"));
  const pendingCol = headers.findIndex((h) => h.includes("pending"));
  if (typeCol < 0 || connectedCol < 0 || pendingCol < 0) {
    throw new Error(`tracker headers changed: ${headers.join(" | ")}`);
  }

  const body = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
  const rows: TrackerRow[] = [];
  for (const tr of body.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length === 0) continue;
    const label = cells[typeCol] ?? "";
    const connected = countCell(cells[connectedCol] ?? "");
    const pending = countCell(cells[pendingCol] ?? "");
    if (!label || connected === null || pending === null) {
      throw new Error(`unparseable tracker row: ${cells.join(" | ")}`);
    }
    rows.push({ label, family: normalizeAircraftType(label), connected, pending });
  }
  if (rows.length === 0) throw new Error("tracker table has no rows");

  const dateLine = html.match(/last updated on\s*([^<]{0,40})/i)?.[1];
  const asOf = dateLine ? parseNewsroomDate(dateLine) : null;
  const dated = asOf ? chartDateProblem(asOf, today, CHART_MAX_STORE_AGE_DAYS) : null;
  if (dated) throw new ChartRejected(dated);
  return { asOf, rows };
}

/** Tracker rows → fleet_progress rows, plus one "Totals" rollup per segment. */
export function trackerProgressRows(parsed: ParsedTracker): ProgressTypeRow[] {
  const out: ProgressTypeRow[] = [];
  const totals = new Map<ProgressSegment, ProgressTypeRow>();
  for (const r of parsed.rows) {
    const mapped = FAMILY_CODE[r.family];
    if (!mapped) continue;
    const row: ProgressTypeRow = {
      segment: mapped.segment,
      type_code: mapped.code,
      total: r.connected + r.pending,
      starlink_complete: r.connected,
      in_mod: null,
      verification_needed: null,
      sheet_updated: parsed.asOf,
    };
    out.push(row);
    const t = totals.get(mapped.segment) ?? {
      ...row,
      type_code: "Totals",
      total: 0,
      starlink_complete: 0,
    };
    t.total = (t.total ?? 0) + (row.total ?? 0);
    t.starlink_complete = (t.starlink_complete ?? 0) + (row.starlink_complete ?? 0);
    totals.set(mapped.segment, t);
  }
  return [...out, ...totals.values()];
}

export interface AlaskaTrackerResult {
  outcome: "success" | "error";
  rows: number;
  settled: number;
  /** Types the chart called complete that were not settled, because the chart
   * failed its bounds. */
  withheld: number;
}

async function fetchTrackerHtml(): Promise<string> {
  const res = await fetch(TRACKER_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function runAlaskaTrackerSync(
  db: Database,
  fetchHtml: () => Promise<string> = fetchTrackerHtml,
  today = utcDay()
): Promise<AlaskaTrackerResult> {
  return withSpan(
    "scraper.alaska_tracker",
    async (span): Promise<AlaskaTrackerResult> => {
      span.setTag("job.type", "background");
      const airlineTag = normalizeAirlineTag("AS");
      let parsed: ParsedTracker;
      try {
        parsed = parseAlaskaTracker(await fetchHtml(), today);
      } catch (err) {
        if (err instanceof ChartRejected) reportChartRejected("AS", "parse", err.problem);
        warn("alaska-tracker: fetch/parse failed; keeping the last stored chart", err);
        metrics.increment(COUNTERS.SCRAPER_SYNC, {
          source: "alaska_tracker",
          airline: airlineTag,
          status: "error",
        });
        span.setTag("result", "error");
        return { outcome: "error", rows: 0, settled: 0, withheld: 0 };
      }

      const unknown = parsed.rows.filter((r) => !FAMILY_CODE[r.family]);
      if (unknown.length > 0) {
        warn(`alaska-tracker: unmapped types skipped: ${unknown.map((r) => r.label).join(", ")}`);
      }
      const rows = trackerProgressRows(parsed);
      if (!rows.some((r) => r.type_code !== "Totals")) {
        logError("alaska-tracker: no Alaska types on the tracker; nothing written");
        metrics.increment(COUNTERS.SCRAPER_SYNC, {
          source: "alaska_tracker",
          airline: airlineTag,
          status: "error",
        });
        return { outcome: "error", rows: 0, settled: 0, withheld: 0 };
      }
      replaceFleetProgress(db, "AS", rows, { wholeAirline: true });
      emitFleetProgressCounts(
        "AS",
        rows.filter((r) => r.type_code === "Totals")
      );
      // Stored either way, since /fleet shows it as Alaska's with its date;
      // a chart far from our fleet list is kept out of the headline by the
      // read and reported here once a day, where the job's log is read.
      const offList = validateChartAgainstRoster(db, "AS", today);
      if (offList) reportChartRejected("AS", "sync", offList);

      const complete = parsed.rows.filter(
        (r) => FAMILY_CODE[r.family] && r.pending === 0 && r.connected > 0
      );
      // A settle names every tail of a type as equipped, and nothing takes
      // that back when a later chart reads otherwise. The bounds judge the
      // chart as one reading: a garbled row elsewhere means the parse or the
      // page slipped, and "Update complete" came through the same slip. So a
      // refused chart settles nothing, the sound-looking rows included.
      let settled = 0;
      let withheld = 0;
      if (offList) {
        withheld = complete.length;
        if (withheld > 0) {
          reportChartRejected("AS", "settle", {
            reason: offList.reason,
            detail: `${offList.detail}; not settling ${complete.map((r) => r.label).join(", ")}`,
          });
        }
      } else {
        for (const r of complete) {
          const mapped = FAMILY_CODE[r.family];
          const res = settleOfficiallyCompleteType(db, mapped.airline, r.family, r.connected);
          settled += res.settled;
          if (res.skipped === "roster_exceeds_official") {
            warn(
              `alaska-tracker: ${r.label} marked complete at ${r.connected}, but the roster has ${res.roster}; not settling`
            );
          }
        }
      }

      const equipped = {
        AS: equippedCountByFamily(db, "AS"),
        HA: equippedCountByFamily(db, "HA"),
      };
      for (const r of parsed.rows) {
        const mapped = FAMILY_CODE[r.family];
        if (!mapped) continue;
        metrics.gauge(
          GAUGES.FLEET_PROGRESS_UNATTRIBUTED,
          Math.max(0, r.connected - (equipped[mapped.airline].get(r.family) ?? 0)),
          { aircraft_type: r.family, airline: normalizeAirlineTag(mapped.airline) }
        );
      }

      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "alaska_tracker",
        airline: airlineTag,
        status: "success",
      });
      span.setTag("result", "success");
      const summary = parsed.rows
        .filter((r) => FAMILY_CODE[r.family])
        .map((r) => `${FAMILY_CODE[r.family].code} ${r.connected}/${r.connected + r.pending}`)
        .join(", ");
      info(
        `alaska-tracker sync: chart ${parsed.asOf ?? "undated"}; ${summary}; ${settled} tails settled${withheld > 0 ? `; ${withheld} complete types withheld, chart refused` : ""}`
      );
      return { outcome: "success", rows: rows.length, settled, withheld };
    },
    { "job.type": "background" }
  );
}

export function startAlaskaTrackerJob(db: Database): JobHandle | undefined {
  if (!AIRLINES.AS.enabled || !TRACKER_URL) return undefined;
  return startJob({
    name: "alaska_tracker",
    stamps: metaJobStamps(db),
    intervalMs: 24 * 3600 * 1000,
    initialDelayMs: 4 * 60 * 1000,
    run: async () => {
      // "error" covers the page that loads with no types on it, too.
      recordSyncOutcome(db, "alaska_tracker", "AS", (await runAlaskaTrackerSync(db)).outcome);
    },
  });
}

if (import.meta.main) {
  const db = initializeDatabase();
  runAlaskaTrackerSync(db)
    .then((r) => {
      console.log(JSON.stringify(r));
      db.close();
    })
    .catch((e) => {
      logError("alaska-tracker CLI failed", e);
      db.close();
      process.exit(1);
    });
}
