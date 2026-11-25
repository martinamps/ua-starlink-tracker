/**
 * An airline's own stored chart beside the tails this site can name.
 *
 * Alaska publishes connected and pending counts by aircraft type and no
 * per-tail status, so its chart can count aircraft that no source names. The
 * daily tracker job stores the chart in fleet_progress with the chart's own
 * date; this reads it back and attaches it to the programme headline only
 * while it counts more than the named tails. Nothing here is a constant: a
 * figure shows with its stored date or not at all.
 */

import type { Database } from "bun:sqlite";
import { SHEET_CODE_TO_FAMILY } from "../airlines/aircraft-pages";
import { AIRLINES } from "../airlines/registry";
import { getFleetProgress } from "./database";
import {
  type AirlineChartCount,
  type ProgrammeHeadline,
  countRoster,
  programmeHeadline,
  tenantProgrammeRoster,
} from "./roster";
import { equippedSql } from "./sql/equipped";

interface ChartType {
  family: string;
  connected: number;
  total: number;
}

interface StoredChart {
  asOf: string;
  types: ChartType[];
}

/** The stored chart by family; null without a tracker, rows or a chart date. */
function storedChart(db: Database, code: string): StoredChart | null {
  if (!AIRLINES[code]?.officialTracker) return null;
  const rows = getFleetProgress(db, code).filter((r) => r.type_code !== "Totals");
  const asOf = rows.find((r) => r.sheet_updated)?.sheet_updated ?? null;
  if (rows.length === 0 || !asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return null;
  const byFamily = new Map<string, ChartType>();
  for (const r of rows) {
    const family = SHEET_CODE_TO_FAMILY[r.type_code];
    if (!family) continue;
    const t = byFamily.get(family) ?? { family, connected: 0, total: 0 };
    t.connected += r.starlink_complete ?? 0;
    t.total += r.total ?? 0;
    byFamily.set(family, t);
  }
  return byFamily.size > 0 ? { asOf, types: [...byFamily.values()] } : null;
}

/** The day the newest equipped listing in the programme was found, if dated. */
function newestNamedDay(db: Database, airlines: readonly string[]): string | null {
  const marks = airlines.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT MAX(substr(sp.DateFound, 1, 10)) AS d FROM starlink_planes sp
       WHERE sp.airline IN (${marks}) AND sp.DateFound GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
         AND ${equippedSql("sp")}`
    )
    .get(...airlines) as { d: string | null } | null;
  return row?.d ?? null;
}

/**
 * The airline's chart against a programme headline: null unless the chart
 * counts more aircraft than the headline names. `leads` is false when a named
 * tail is newer than the chart, so an old chart never outranks fresher tails.
 */
export function airlineChartCount(
  db: Database,
  code: string,
  headline: ProgrammeHeadline
): AirlineChartCount | null {
  const cfg = AIRLINES[code];
  const chart = storedChart(db, code);
  if (!cfg?.officialTracker || !chart) return null;
  const connected = chart.types.reduce((s, t) => s + t.connected, 0);
  const total = chart.types.reduce((s, t) => s + t.total, 0);
  if (connected <= headline.equipped || total === 0) return null;

  const roster = tenantProgrammeRoster(db, code);
  const ours = countRoster(roster, (t) => t.family);
  const charted = new Map(chart.types.map((t) => [t.family, t]));
  const unnamed = chart.types
    .map((t) => ({ family: t.family, count: t.connected - (ours.get(t.family)?.equipped ?? 0) }))
    .filter((t) => t.count > 0);
  const rosterDiff = [
    ...[...ours].map(([family, o]) => ({
      family,
      ours: o.total,
      chart: charted.get(family)?.total ?? null,
    })),
    ...chart.types
      .filter((t) => !ours.has(t.family))
      .map((t) => ({ family: t.family, ours: 0, chart: t.total as number | null })),
  ].filter((d) => d.ours !== d.chart);

  const named = newestNamedDay(db, [...new Set(roster.map((t) => t.airline))]);
  return {
    connected,
    total,
    asOf: chart.asOf,
    sourceLabel: cfg.officialTracker.label,
    url: cfg.officialTracker.url,
    leads: !named || chart.asOf >= named,
    unnamed,
    rosterDiff,
  };
}

/** programmeHeadline with the airline's own chart attached where it applies. */
export function programmeHeadlineWithChart(db: Database, code: string): ProgrammeHeadline | null {
  const headline = programmeHeadline(db, code);
  if (!headline) return null;
  return { ...headline, airlineCount: airlineChartCount(db, code, headline) };
}
