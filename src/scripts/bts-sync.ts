/**
 * BTS Marketing Carrier On-Time (table FGK) shadow ingest. Once a month BTS
 * publishes carrier-reported per-flight data (~2-month lag) with the tail that
 * actually flew every UA-marketed domestic flight, including the regionals
 * that don't report anywhere else. We keep aggregates only — per-operator
 * active-tail counts, per-tail departure counts, per-route departures — and
 * emit fleet-delta metrics vs united_fleet. Shadow only: nothing here feeds
 * the serving path. Domestic-only caveat: widebodies barely appear. The tail
 * and route tables have no readers yet — they back the planned route-share
 * denominator and parked-tail audits.
 */

import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { bodyClassOf, getBtsIngestedMonths, replaceBtsMonth } from "../database/database";
import {
  COUNTERS,
  GAUGES,
  metrics,
  normalizeAircraftType,
  normalizeAirlineTag,
  normalizeOpCarrier,
  withSpan,
} from "../observability";
import type { BtsMonthAggregates } from "../types";
import { downloadZipToTemp, spawnLines, splitCsvLine } from "../utils/bulk-data";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError, warn } from "../utils/logger";

const PREZIP_BASE = "https://transtats.bts.gov/PREZIP";
const FILE_PREFIX = "On_Time_Marketing_Carrier_On_Time_Performance_Beginning_January_2018";

// Publication runs ~2 months behind; look back a little further to catch up
// after outages without walking the whole archive.
const PUBLICATION_LAG_MONTHS = 2;
const CATCHUP_MONTHS = 4;

export type LineSource = AsyncIterable<string> | Iterable<string>;

export interface BtsSyncDeps {
  /** Returns CSV lines for a month's file, or null when BTS hasn't published it yet. */
  loadMonth?: (year: number, month: number) => Promise<LineSource | null>;
}

export interface BtsSyncResult {
  outcome: "ingested" | "noop" | "error";
  month: string | null;
  rows: number;
}

export const monthKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}`;

/** Months worth probing, newest first, given the publication lag. */
export function candidateMonths(now: Date): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  for (let back = PUBLICATION_LAG_MONTHS; back <= CATCHUP_MONTHS; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return out;
}

/** Aggregate the UA-marketed rows of one month's CSV without keeping raw rows. */
export async function aggregateBtsCsv(lines: LineSource): Promise<BtsMonthAggregates> {
  let header: Record<string, number> | null = null;
  const operators = new Map<string, { flights: number; performed: number; tails: Set<string> }>();
  const tails = new Map<string, { op_carrier: string; departures: number }>();
  const routes = new Map<string, number>();
  let rows = 0;

  for await (const line of lines) {
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line);
    if (!header) {
      header = {};
      // The export pads some header names with spaces ("Operating_Airline ").
      cells.forEach((name, i) => {
        header![name.trim()] = i;
      });
      continue;
    }
    const get = (name: string) => (cells[header![name] ?? -1] ?? "").trim();
    if (get("Marketing_Airline_Network") !== "UA") continue;
    rows++;

    const opCarrier = get("Operating_Airline") || "unknown";
    const tail = get("Tail_Number").toUpperCase();
    const cancelled = Number(get("Cancelled") || "0") > 0;
    const diverted = Number(get("Diverted") || "0") > 0;
    const origin = get("Origin");
    const dest = get("Dest");

    const op = operators.get(opCarrier) ?? { flights: 0, performed: 0, tails: new Set<string>() };
    op.flights++;
    if (!cancelled) op.performed++;
    if (tail) op.tails.add(tail);
    operators.set(opCarrier, op);

    if (tail && !cancelled) {
      // First-seen operator wins for tails transferred between operators mid-month.
      const t = tails.get(tail) ?? { op_carrier: opCarrier, departures: 0 };
      t.departures++;
      tails.set(tail, t);
    }
    // Diverted flights departed but didn't complete the scheduled route.
    if (!cancelled && !diverted && origin && dest) {
      const key = `${origin}-${dest}`;
      routes.set(key, (routes.get(key) ?? 0) + 1);
    }
  }

  return {
    rows,
    operators: [...operators.entries()].map(([op_carrier, v]) => ({
      op_carrier,
      flights: v.flights,
      performed: v.performed,
      distinct_tails: v.tails.size,
    })),
    tails: [...tails.entries()].map(([tail_number, v]) => ({ tail_number, ...v })),
    routes: [...routes.entries()].map(([key, performed]) => {
      const [origin, dest] = key.split("-");
      return { origin, dest, performed };
    }),
  };
}

/** Compare a month's active tails against united_fleet; widebodies are excluded
 * from the inactive list because this dataset is domestic-only. */
export function computeFleetDeltas(
  db: Database,
  aggregates: BtsMonthAggregates
): { missingFromFleet: string[]; inactiveInFleet: string[] } {
  const fleet = db
    .query("SELECT tail_number, aircraft_type FROM united_fleet WHERE airline = 'UA'")
    .all() as Array<{ tail_number: string; aircraft_type: string | null }>;
  const fleetTails = new Set(fleet.map((r) => r.tail_number));
  const btsTails = new Set(aggregates.tails.map((t) => t.tail_number));

  const missingFromFleet = [...btsTails].filter((t) => !fleetTails.has(t)).sort();
  const inactiveInFleet = fleet
    .filter(
      (r) =>
        !btsTails.has(r.tail_number) &&
        bodyClassOf(normalizeAircraftType(r.aircraft_type)) !== "widebody"
    )
    .map((r) => r.tail_number)
    .sort();
  return { missingFromFleet, inactiveInFleet };
}

async function downloadMonth(year: number, month: number): Promise<LineSource | null> {
  const url = `${PREZIP_BASE}/${FILE_PREFIX}_${year}_${month}.zip`;
  const downloaded = await downloadZipToTemp(url, {
    prefix: "bts-fgk-",
    maxTimeSec: 900,
    notFoundOk: true,
  });
  if (!downloaded) return null;
  const { dir, zipPath } = downloaded;

  const list = Bun.spawnSync(["unzip", "-Z1", zipPath]);
  const csvName = list.stdout
    .toString()
    .split("\n")
    .find((n) => n.trim().toLowerCase().endsWith(".csv"))
    ?.trim();
  if (!csvName) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("BTS zip contained no CSV");
  }

  const lines = spawnLines(["unzip", "-p", zipPath, csvName]);
  // Wrap so the temp dir is removed when the stream is fully consumed or abandoned.
  async function* withCleanup(): AsyncGenerator<string> {
    try {
      yield* lines;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return withCleanup();
}

export async function runBtsSync(db: Database, deps: BtsSyncDeps = {}): Promise<BtsSyncResult> {
  return withSpan(
    "scraper.bts_sync",
    async (span): Promise<BtsSyncResult> => {
      span.setTag("job.type", "background");
      const airlineTag = normalizeAirlineTag("UA");
      const loadMonth = deps.loadMonth ?? downloadMonth;
      const ingested = new Set(getBtsIngestedMonths(db));

      let failedMonths = 0;
      for (const { year, month } of candidateMonths(new Date())) {
        const key = monthKey(year, month);
        if (ingested.has(key)) continue; // already have it — older gaps can still backfill
        try {
          const lines = await loadMonth(year, month);
          if (!lines) continue; // not published yet — try the previous month

          const aggregates = await aggregateBtsCsv(lines);
          if (aggregates.rows === 0) throw new Error(`BTS ${key} parsed to zero UA rows`);
          replaceBtsMonth(db, key, aggregates);

          const deltas = computeFleetDeltas(db, aggregates);
          for (const op of aggregates.operators) {
            metrics.gauge(GAUGES.BTS_ACTIVE_TAILS, op.distinct_tails, {
              op_carrier: normalizeOpCarrier(op.op_carrier),
              airline: airlineTag,
            });
          }
          metrics.gauge(GAUGES.BTS_FLEET_DELTA, deltas.missingFromFleet.length, {
            kind: "missing_from_fleet",
            airline: airlineTag,
          });
          metrics.gauge(GAUGES.BTS_FLEET_DELTA, deltas.inactiveInFleet.length, {
            kind: "inactive_in_fleet",
            airline: airlineTag,
          });
          metrics.increment(COUNTERS.SCRAPER_SYNC, {
            source: "bts",
            airline: airlineTag,
            status: "success",
          });

          if (deltas.missingFromFleet.length > 0) {
            const sample = deltas.missingFromFleet.slice(0, 20).join(", ");
            warn(
              `bts-sync ${key}: ${deltas.missingFromFleet.length} active tails missing from united_fleet: ${sample}`
            );
          }
          const totalTails = aggregates.tails.length;
          info(
            `bts-sync ingested ${key}: ${aggregates.rows} UA-marketed rows, ${totalTails} active tails, ` +
              `${deltas.missingFromFleet.length} missing from fleet, ${deltas.inactiveInFleet.length} fleet tails inactive (narrowbody/regional)`
          );
          span.setTag("result", "ingested");
          span.setTag("month", key);
          return { outcome: "ingested", month: key, rows: aggregates.rows };
        } catch (err) {
          // A bad newer file (download failure, renamed column) must not block
          // backfilling an older month still in the catch-up window.
          failedMonths++;
          logError(`bts-sync ${key} failed`, err);
          metrics.increment(COUNTERS.SCRAPER_SYNC, {
            source: "bts",
            airline: airlineTag,
            status: "error",
          });
        }
      }

      if (failedMonths > 0) {
        span.setTag("error", true);
        return { outcome: "error", month: null, rows: 0 };
      }
      span.setTag("result", "noop");
      return { outcome: "noop", month: null, rows: 0 };
    },
    { "job.type": "background" }
  );
}

export function startBtsSyncJob(db: Database): JobHandle {
  return startJob({
    name: "bts_sync",
    intervalMs: 24 * 3600 * 1000,
    initialDelayMs: 45 * 60 * 1000,
    run: async () => {
      await runBtsSync(db);
    },
  });
}
