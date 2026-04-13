/**
 * Fleet Sync Script
 * Syncs United Airlines fleet from FlightRadar24 and spreadsheet to united_fleet table
 */

import { AIRLINES, type AirlineConfig, enabledAirlines } from "../airlines/registry";
import {
  initializeDatabase,
  syncSpreadsheetToFleet,
  upsertFleetAircraft,
} from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag, withSpan } from "../observability";
import { info, error as logError } from "../utils/logger";
import { launchFR24Browser, scrapeFlightRadar24Fleet } from "./flightradar24-scraper";

/**
 * Sync fleet from FlightRadar24 to united_fleet table for one airline.
 */
export async function syncFleetFromFR24(
  cfg: AirlineConfig = AIRLINES.UA,
  sharedBrowser?: import("playwright").Browser
): Promise<{
  airline: string;
  success: boolean;
  total: number;
  new: number;
  updated: number;
  error?: string;
}> {
  const airlineTag = normalizeAirlineTag(cfg.code);
  return withSpan("fleet_sync.fr24", async (span) => {
    span.setTag("airline", airlineTag);
    const result = {
      airline: cfg.code,
      success: false,
      total: 0,
      new: 0,
      updated: 0,
      error: undefined as string | undefined,
    };

    if (!cfg.fr24Slug) {
      result.error = `${cfg.code}: no fr24Slug configured`;
      return result;
    }

    const sources = [
      { slug: cfg.fr24Slug, operator: cfg.name, subfleet: undefined as string | undefined },
      ...(cfg.regionalCarriers ?? []).map((r) => ({
        slug: r.fr24Slug,
        operator: r.name,
        subfleet: r.subfleet,
      })),
    ];

    try {
      type Scraped = {
        registration: string;
        aircraftType: string;
        subfleet: string;
        operator: string;
      };
      const allAircraft: Scraped[] = [];
      for (const [i, src] of sources.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 5000));
        info(`Starting FR24 fleet sync for ${cfg.code} (${src.slug})...`);
        const scrapeResult = await scrapeFlightRadar24Fleet(src.slug, sharedBrowser);
        if (!scrapeResult.success) {
          result.error = scrapeResult.error || "FR24 scrape failed";
          logError(`FR24 scrape failed (${cfg.code}/${src.slug})`, result.error);
          span.setTag("error", true);
          return result;
        }
        info(`FR24 returned ${scrapeResult.aircraft.length} aircraft for ${cfg.code}/${src.slug}`);
        for (const a of scrapeResult.aircraft) {
          allAircraft.push({
            registration: a.registration,
            aircraftType: a.aircraftType,
            subfleet: src.subfleet ?? cfg.classifyFleet?.(a.aircraftType) ?? "mainline",
            operator: src.operator,
          });
        }
      }

      if (allAircraft.length < cfg.minFleetSanity) {
        result.error = `Suspiciously low aircraft count: ${allAircraft.length} (expected ${cfg.minFleetSanity}+)`;
        logError(`FR24 sync aborted (${cfg.code})`, result.error);
        span.setTag("error", true);
        return result;
      }

      span.setTag("aircraft.count", allAircraft.length);

      const db = initializeDatabase();

      try {
        const existingTails = new Set(
          (
            db.query("SELECT tail_number FROM united_fleet WHERE airline = ?").all(cfg.code) as {
              tail_number: string;
            }[]
          ).map((r) => r.tail_number)
        );

        for (const aircraft of allAircraft) {
          const isNew = !existingTails.has(aircraft.registration);
          upsertFleetAircraft(
            db,
            aircraft.registration,
            aircraft.aircraftType,
            "fr24",
            aircraft.subfleet,
            aircraft.operator,
            cfg.code
          );
          if (isNew) {
            result.new++;
            metrics.increment(COUNTERS.PLANES_DISCOVERED, { source: "fr24", airline: airlineTag });
          } else {
            result.updated++;
          }
        }

        result.total = allAircraft.length;
        result.success = true;

        span.setTag("planes.new", result.new);
        span.setTag("planes.updated", result.updated);
        metrics.increment(COUNTERS.SCRAPER_SYNC, { source: "fr24", airline: airlineTag });

        info(`FR24 sync complete (${cfg.code}): ${result.new} new, ${result.updated} updated`);
      } finally {
        db.close();
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      logError(`FR24 sync error (${cfg.code})`, result.error);
      span.setTag("error", true);
    }

    return result;
  });
}

/**
 * Sync spreadsheet planes to united_fleet table
 */
export async function syncFromSpreadsheet(): Promise<{
  success: boolean;
  synced: number;
  error?: string;
}> {
  const result = { success: false, synced: 0, error: undefined as string | undefined };

  try {
    info("Starting spreadsheet sync to united_fleet...");

    const db = initializeDatabase();

    try {
      result.synced = syncSpreadsheetToFleet(db);
      result.success = true;
      info(`Spreadsheet sync complete: ${result.synced} new planes added to united_fleet`);
    } finally {
      db.close();
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    logError("Spreadsheet sync error", result.error);
  }

  return result;
}

/**
 * Full fleet sync: FR24 (per enabled airline) + spreadsheet (UA-only)
 */
export async function syncFullFleet(): Promise<{
  fr24: Array<{
    airline: string;
    success: boolean;
    total: number;
    new: number;
    updated: number;
    error?: string;
  }>;
  spreadsheet: { success: boolean; synced: number; error?: string };
}> {
  const fr24: Awaited<ReturnType<typeof syncFleetFromFR24>>[] = [];
  const browser = await launchFR24Browser();
  try {
    for (const [i, cfg] of enabledAirlines().entries()) {
      if (!cfg.fr24Slug) continue;
      if (i > 0) await new Promise((r) => setTimeout(r, 5000));
      fr24.push(await syncFleetFromFR24(cfg, browser));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Spreadsheet sync remains UA-only — no other airline has a community sheet.
  const spreadsheetResult = await syncFromSpreadsheet();

  return { fr24, spreadsheet: spreadsheetResult };
}

/**
 * Start automatic daily fleet sync
 * Runs FR24 sync once per day to keep united_fleet populated
 */
export function startFleetSync() {
  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 minutes after startup

  const runSync = async () => {
    try {
      await withSpan(
        "fleet_sync.run",
        async (span) => {
          span.setTag("job.type", "background");

          info("Starting scheduled FR24 fleet sync...");
          const result = await syncFullFleet();

          for (const r of result.fr24) {
            span.setTag(`fr24.${r.airline}.success`, r.success ? 1 : 0);
            span.setTag(`fr24.${r.airline}.total`, r.total);
            span.setTag(`fr24.${r.airline}.new`, r.new);
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

  // Run daily
  setInterval(() => {
    runSync().catch((err) => logError("Fleet sync scheduler error", err));
  }, SYNC_INTERVAL_MS);

  // Initial sync after 5 minutes (give server time to stabilize)
  setTimeout(() => {
    runSync().catch((err) => logError("Initial fleet sync failed", err));
  }, INITIAL_DELAY_MS);

  info(
    `Fleet sync scheduled (every ${SYNC_INTERVAL_MS / 1000 / 3600}h, first run in ${INITIAL_DELAY_MS / 1000 / 60}min)`
  );
}

// CLI usage
if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args[0] || "full";

  console.log(`Fleet sync mode: ${mode}\n`);

  if (mode === "fr24") {
    syncFleetFromFR24()
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
    syncFromSpreadsheet()
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
    syncFullFleet()
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
