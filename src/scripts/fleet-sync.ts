/**
 * Fleet Sync Script
 * Syncs United Airlines fleet from FlightRadar24 and spreadsheet to united_fleet table
 */

import type { Database } from "bun:sqlite";
import type { Browser } from "playwright";
import { AIRLINES, type AirlineConfig, enabledAirlines } from "../airlines/registry";
import {
  getMeta,
  initializeDatabase,
  refreshFleetMeta,
  setMeta,
  syncSpreadsheetToFleet,
  upsertFleetAircraft,
} from "../database/database";
import { recordSourceFailure, recordSourceSuccess } from "../database/source-health";
import { COUNTERS, metrics, normalizeAirlineTag, withSpan } from "../observability";
import { type JobHandle, startJob } from "../utils/job-runner";
import { info, error as logError } from "../utils/logger";
import { sleep } from "../utils/sleep";
import { launchFR24Browser, scrapeFlightRadar24Fleet } from "./flightradar24-scraper";

export interface RosterSource {
  /** Regional pages carry their configured subfleet; the primary page none. */
  subfleet?: string;
  aircraft: { registration: string; aircraftType: string }[];
}

export interface RosterEntry {
  registration: string;
  aircraftType: string;
  subfleet: string;
  /** Set only for tails sourced from a regional carrier's own roster page.
   * null otherwise, so upsert's COALESCE preserves any existing operated_by —
   * SkyWest-operated AS E175s must not become "Horizon Air" by type. */
  operator: string | null;
}

/** FR24 pages to scrape for an airline: primary livery page first (fleet-sync
 * treats its failure as fatal), then regional-carrier pages. */
export function rosterSources(cfg: AirlineConfig): Array<{ slug: string; subfleet?: string }> {
  if (!cfg.fr24Slug) return [];
  return [
    { slug: cfg.fr24Slug },
    ...(cfg.regionalCarriers ?? []).map((r) => ({ slug: r.fr24Slug, subfleet: r.subfleet })),
  ];
}

/**
 * Dedupe FR24 source pages into one roster. The primary livery page lists
 * regional tails too (as-asa includes Horizon E175s), so tails dedupe by
 * registration — the overlap can't double-count or inflate the minFleetSanity
 * input. A source page's configured subfleet beats the type classifier;
 * operator is asserted only where the source page proves it.
 */
export function buildRoster(cfg: AirlineConfig, sources: RosterSource[]): RosterEntry[] {
  const byTail = new Map<string, RosterEntry>();
  for (const src of sources) {
    for (const a of src.aircraft) {
      if (byTail.has(a.registration)) continue;
      const subfleet = src.subfleet ?? cfg.classifyFleet?.(a.aircraftType) ?? "mainline";
      const operator = src.subfleet
        ? (cfg.regionalCarriers?.find((r) => r.subfleet === src.subfleet)?.name ?? null)
        : null;
      byTail.set(a.registration, {
        registration: a.registration,
        aircraftType: a.aircraftType,
        subfleet,
        operator,
      });
    }
  }
  return [...byTail.values()];
}

export interface FR24SyncResult {
  airline: string;
  success: boolean;
  total: number;
  new: number;
  updated: number;
  rejected: number;
  error?: string;
}

export const FR24_DEADLINE_ERROR = "deadline";

/**
 * Sync fleet from FlightRadar24 to united_fleet table for one airline.
 */
export async function syncFleetFromFR24(
  db: Database,
  cfg: AirlineConfig = AIRLINES.UA,
  sharedBrowser?: Browser,
  signal?: AbortSignal
): Promise<FR24SyncResult> {
  const airlineTag = normalizeAirlineTag(cfg.code);
  return withSpan("fleet_sync.fr24", async (span) => {
    span.setTag("airline", airlineTag);
    const result = {
      airline: cfg.code,
      success: false,
      total: 0,
      new: 0,
      updated: 0,
      rejected: 0,
      error: undefined as string | undefined,
    };

    if (!cfg.fr24Slug) {
      result.error = `${cfg.code}: no fr24Slug configured`;
      return result;
    }

    const sources = rosterSources(cfg);

    try {
      const scraped: RosterSource[] = [];
      for (const [i, src] of sources.entries()) {
        if (i > 0) await sleep(5000);
        if (signal?.aborted) {
          result.error = FR24_DEADLINE_ERROR;
          return result;
        }
        info(`Starting FR24 fleet sync for ${cfg.code} (${src.slug})...`);
        const scrapeResult = await scrapeFlightRadar24Fleet(src.slug, sharedBrowser);
        if (!scrapeResult.success) {
          const err = scrapeResult.error || "FR24 scrape failed";
          logError(`FR24 scrape failed (${cfg.code}/${src.slug})`, err);
          if (i === 0) {
            // Only mainline failure is a full-span error — regional gaps are partial.
            span.setTag("error", true);
            result.error = err;
            metrics.increment(COUNTERS.SCRAPER_SYNC, {
              source: "fr24",
              airline: airlineTag,
              status: "error",
            });
            return result;
          }
          result.error = `partial: ${src.slug} ${err}`;
          span.setTag("partial", true);
          continue;
        }
        info(`FR24 returned ${scrapeResult.aircraft.length} aircraft for ${cfg.code}/${src.slug}`);
        scraped.push({ subfleet: src.subfleet, aircraft: scrapeResult.aircraft });
      }

      // Past its deadline the caller has moved on: a late roster would write
      // into united_fleet beside the next airline's run.
      if (signal?.aborted) {
        result.error = FR24_DEADLINE_ERROR;
        return result;
      }

      const allAircraft = buildRoster(cfg, scraped);
      // The floor counts real registrations only: a parser that returns page
      // chrome ("History", type names) must not clear it on volume.
      const validCount = allAircraft.filter((a) => cfg.tailPattern.test(a.registration)).length;

      if (validCount < cfg.minFleetSanity) {
        result.error = `Suspiciously low aircraft count: ${validCount} valid of ${allAircraft.length} (expected ${cfg.minFleetSanity}+)`;
        logError(`FR24 sync aborted (${cfg.code})`, result.error);
        span.setTag("error", true);
        span.setTag("abort_reason", result.error);
        metrics.increment(COUNTERS.SCRAPER_SYNC, {
          source: "fr24",
          airline: airlineTag,
          status: "aborted",
        });
        return result;
      }

      span.setTag("aircraft.count", allAircraft.length);

      const existingTails = new Set(
        (
          db.query("SELECT tail_number FROM united_fleet WHERE airline = ?").all(cfg.code) as {
            tail_number: string;
          }[]
        ).map((r) => r.tail_number)
      );

      // One transaction for the ~1.6k upserts: one commit, not one per tail.
      const admitted: RosterEntry[] = [];
      db.transaction(() => {
        for (const aircraft of allAircraft) {
          const ok = upsertFleetAircraft(
            db,
            aircraft.registration,
            aircraft.aircraftType,
            "fr24",
            aircraft.subfleet,
            aircraft.operator,
            cfg.code
          );
          if (ok) admitted.push(aircraft);
          else result.rejected++;
        }
      })();
      for (const aircraft of admitted) {
        if (existingTails.has(aircraft.registration)) {
          result.updated++;
        } else {
          result.new++;
          metrics.increment(COUNTERS.PLANES_DISCOVERED, { source: "fr24", airline: airlineTag });
        }
      }

      result.total = admitted.length;
      result.success = true;

      // The roster just changed, so the published totals follow it now, for
      // every airline. /fleet reads the roster live; skipping UA here left
      // its headline behind /fleet until the next hourly scrape.
      // (refreshFleetMeta only stamps lastUpdated for fleet-meta-owned
      // airlines, so UA's stays with the scrape and QR's with the ingester.)
      refreshFleetMeta(db, cfg.code);

      span.setTag("planes.new", result.new);
      span.setTag("planes.updated", result.updated);
      span.setTag("planes.rejected", result.rejected);
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "fr24",
        airline: airlineTag,
        status: result.error ? "partial" : "success",
      });

      info(
        `FR24 sync complete (${cfg.code}): ${result.new} new, ${result.updated} updated, ${result.rejected} rejected`
      );
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      logError(`FR24 sync error (${cfg.code})`, result.error);
      span.setTag("error", true);
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "fr24",
        airline: airlineTag,
        status: "error",
      });
    }

    return result;
  });
}

/**
 * Sync spreadsheet planes to united_fleet table
 */
export async function syncFromSpreadsheet(db: Database): Promise<{
  success: boolean;
  synced: number;
  error?: string;
}> {
  const result = { success: false, synced: 0, error: undefined as string | undefined };

  try {
    info("Starting spreadsheet sync to united_fleet...");
    result.synced = syncSpreadsheetToFleet(db, "UA");
    result.success = true;
    info(`Spreadsheet sync complete: ${result.synced} new planes added to united_fleet`);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logError("Spreadsheet sync error", result.error);
  }

  return result;
}

/** The slowest healthy airline takes about 20 s. */
export const FR24_AIRLINE_DEADLINE_MS = 120_000;
const BROWSER_CLOSE_GRACE_MS = 10_000;

export interface FullFleetDeps {
  launch?: () => Promise<Browser>;
  syncOne?: (
    db: Database,
    cfg: AirlineConfig,
    browser: Browser,
    signal: AbortSignal
  ) => Promise<FR24SyncResult>;
  airlines?: AirlineConfig[];
  deadlineMs?: number;
  gapMs?: number;
  spreadsheet?: typeof syncFromSpreadsheet;
}

function failedSync(cfg: AirlineConfig, err: unknown): FR24SyncResult {
  return {
    airline: cfg.code,
    success: false,
    total: 0,
    new: 0,
    updated: 0,
    rejected: 0,
    error: err instanceof Error ? err.message : String(err),
  };
}

async function closeBrowser(browser: Browser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BROWSER_CLOSE_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Full fleet sync: FR24 (per enabled airline) + spreadsheet (UA-only)
 *
 * page.evaluate has no timeout, so a hung FR24 page never returns and the
 * browser's ~1.7 GB stays held (24 Nov, Qatar). Each airline races a deadline;
 * when it trips, the browser is closed (which rejects the hung call) and the
 * next airline launches a fresh one.
 */
export async function syncFullFleet(
  db: Database,
  deps: FullFleetDeps = {}
): Promise<{
  fr24: FR24SyncResult[];
  spreadsheet: { success: boolean; synced: number; error?: string };
}> {
  const {
    launch = launchFR24Browser,
    syncOne = syncFleetFromFR24,
    airlines = enabledAirlines(),
    deadlineMs = FR24_AIRLINE_DEADLINE_MS,
    gapMs = 5000,
    spreadsheet = syncFromSpreadsheet,
  } = deps;
  const fr24: FR24SyncResult[] = [];
  let browser: Browser | null = null;
  try {
    for (const [i, cfg] of airlines.entries()) {
      if (!cfg.fr24Slug) continue;
      if (i > 0) await sleep(gapMs);
      try {
        browser ??= await launch();
      } catch (err) {
        logError(`fleet-sync: FR24 browser launch failed (${cfg.code})`, err);
        fr24.push(failedSync(cfg, err));
        continue;
      }

      const abort = new AbortController();
      const run = syncOne(db, cfg, browser, abort.signal).catch((err) => failedSync(cfg, err));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        run,
        new Promise<typeof FR24_DEADLINE_ERROR>((resolve) => {
          timer = setTimeout(() => resolve(FR24_DEADLINE_ERROR), deadlineMs);
        }),
      ]);
      clearTimeout(timer);

      if (outcome !== FR24_DEADLINE_ERROR) {
        fr24.push(outcome);
        continue;
      }

      abort.abort();
      logError(
        `fleet-sync: FR24 ${cfg.code} (${cfg.fr24Slug}) exceeded ${deadlineMs / 1000}s; closing browser`
      );
      metrics.increment(COUNTERS.SCRAPER_SYNC, {
        source: "fr24",
        airline: normalizeAirlineTag(cfg.code),
        status: "timeout",
      });
      fr24.push(failedSync(cfg, FR24_DEADLINE_ERROR));
      const hung = browser;
      browser = null;
      await closeBrowser(hung);
    }
  } finally {
    if (browser) await closeBrowser(browser);
  }

  // Spreadsheet sync remains UA-only — no other airline has a community sheet.
  const spreadsheetResult = await spreadsheet(db);

  return { fr24, spreadsheet: spreadsheetResult };
}

const FLEET_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FLEET_SYNC_MIN_DELAY_MS = 5 * 60 * 1000;
const FLEET_SYNC_META_KEY = "fleetSyncStartedAt";

/** Delay the boot run until 24h after the last one. Every deploy (the daily OG
 * refresh included) re-ran the full FR24 scrape 5 min after boot: 14 runs in
 * 9.5 days, 3 on 2026-09-20. A missing or unparseable stamp runs promptly. */
export function fleetSyncInitialDelayMs(lastStartedAt: string | null, nowMs = Date.now()): number {
  const last = lastStartedAt ? Date.parse(lastStartedAt) : Number.NaN;
  if (!Number.isFinite(last)) return FLEET_SYNC_MIN_DELAY_MS;
  return Math.max(FLEET_SYNC_MIN_DELAY_MS, last + FLEET_SYNC_INTERVAL_MS - nowMs);
}

/** Daily FR24 roster sync keeping united_fleet populated. */
export function startFleetSync(db: Database): JobHandle {
  let initialDelayMs = FLEET_SYNC_MIN_DELAY_MS;
  try {
    initialDelayMs = fleetSyncInitialDelayMs(getMeta(db, FLEET_SYNC_META_KEY, "ALL"));
  } catch (err) {
    logError("Fleet sync: could not read last-run stamp; running on the boot schedule", err);
  }

  const runSync = async () => {
    try {
      // Stamped on start, not success, so a crash-looping deploy can't re-run it.
      setMeta(db, FLEET_SYNC_META_KEY, new Date().toISOString(), "ALL");
      await withSpan(
        "fleet_sync.run",
        async (span) => {
          span.setTag("job.type", "background");

          info("Starting scheduled FR24 fleet sync...");
          const result = await syncFullFleet(db);

          for (const r of result.fr24) {
            span.setTag(`fr24.${r.airline}.success`, r.success ? 1 : 0);
            span.setTag(`fr24.${r.airline}.total`, r.total);
            span.setTag(`fr24.${r.airline}.new`, r.new);
            // success with an error set = a regional roster was missing.
            if (r.success && !r.error) recordSourceSuccess(db, "fleet_roster", r.airline);
            else
              recordSourceFailure(db, "fleet_roster", r.airline, r.success ? "partial" : "error");
            if (r.success) {
              info(
                `Scheduled fleet sync (${r.airline}): ${r.total} aircraft (${r.new} new, ${r.updated} updated)`
              );
            } else {
              logError(`Scheduled FR24 sync failed (${r.airline})`, r.error);
            }
          }

          if (result.spreadsheet.success) {
            info(`Spreadsheet sync: ${result.spreadsheet.synced} new planes added to fleet`);
          }
        },
        { "job.type": "background" }
      );
    } catch (err) {
      logError("Scheduled fleet sync error", err);
    }
  };

  const handle = startJob({
    name: "fleet_sync",
    intervalMs: FLEET_SYNC_INTERVAL_MS,
    initialDelayMs,
    run: runSync,
  });

  info(
    `Fleet sync scheduled (every ${FLEET_SYNC_INTERVAL_MS / 1000 / 3600}h, first run in ${Math.round(initialDelayMs / 1000 / 60)}min)`
  );
  return handle;
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args[0] || "full";

  console.log(`Fleet sync mode: ${mode}\n`);
  const db = initializeDatabase();

  if (mode === "fr24") {
    syncFleetFromFR24(db)
      .then((result) => {
        console.log("\n=== FR24 Sync Results ===");
        console.log(`Success: ${result.success}`);
        console.log(`Total aircraft: ${result.total}`);
        console.log(`New: ${result.new}`);
        console.log(`Updated: ${result.updated}`);
        if (result.error) console.log(`Error: ${result.error}`);
      })
      .catch((err) => {
        console.error("FR24 sync failed:", err);
        process.exit(1);
      });
  } else if (mode === "spreadsheet") {
    syncFromSpreadsheet(db)
      .then((result) => {
        console.log("\n=== Spreadsheet Sync Results ===");
        console.log(`Success: ${result.success}`);
        console.log(`Synced: ${result.synced}`);
        if (result.error) console.log(`Error: ${result.error}`);
      })
      .catch((err) => {
        console.error("Spreadsheet sync failed:", err);
        process.exit(1);
      });
  } else {
    syncFullFleet(db)
      .then((result) => {
        console.log("\n=== Full Fleet Sync Results ===");
        for (const r of result.fr24) {
          console.log(`\nFR24 (${r.airline}):`);
          console.log(`  Success: ${r.success}`);
          console.log(`  Total: ${r.total}`);
          console.log(`  New: ${r.new}`);
          console.log(`  Updated: ${r.updated}`);
          if (r.error) console.log(`  Error: ${r.error}`);
        }
        console.log("\nSpreadsheet:");
        console.log(`  Success: ${result.spreadsheet.success}`);
        console.log(`  Synced: ${result.spreadsheet.synced}`);
        if (result.spreadsheet.error) console.log(`  Error: ${result.spreadsheet.error}`);
      })
      .catch((err) => {
        console.error("Full fleet sync failed:", err);
        process.exit(1);
      });
  }
}
