#!/usr/bin/env bun
/**
 * Southwest Airlines fleet bootstrap.
 *
 * Two writes, one story:
 *  - Roster (~800 737s from FR24): all starlink_status='unknown' — the honest
 *    fleet-odds denominator. Southwest has no per-tail oracle and settles tail
 *    assignments ~1h out, so nothing here is settled by type or schedule.
 *  - Equipped tails: the curated evidence log in
 *    src/airlines/southwest-equipped.ts, applied as per-tail 'observed'
 *    evidence with the record's own evidenced date — never a batch run date.
 *
 * Idempotent: re-run after appending a record to the curated log and only the
 * new tails settle. A future automated-discovery job should append to the
 * curated log (see its module doc) and re-run this, or call
 * applySouthwestEquipped() directly.
 *
 *   bun run seed-southwest -- --dry-run      # print the table, no writes
 *   bun run seed-southwest -- --apply        # FR24 roster + curated tails
 *   bun run seed-southwest -- --tails-only --apply   # curated tails only (no FR24)
 */

import { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import {
  SOUTHWEST_EQUIPPED_TAILS,
  type SouthwestEquippedTail,
  validateSouthwestEquipped,
} from "../airlines/southwest-equipped";
import {
  addDiscoveredStarlinkPlane,
  refreshFleetMeta,
  upsertFleetAircraft,
} from "../database/database";
import { DB_PATH } from "../utils/constants";
import { info } from "../utils/logger";
import { type RosterSource, buildRoster, rosterSources } from "./fleet-sync";
import { launchFR24Browser, scrapeFlightRadar24Fleet } from "./flightradar24-scraper";

interface RosterRow {
  tail: string;
  aircraftType: string;
  operator: string | null;
}

async function scrapeRoster(): Promise<RosterRow[]> {
  const cfg = AIRLINES.WN;
  if (!cfg.fr24Slug) throw new Error("WN.fr24Slug missing");

  const sources = rosterSources(cfg);
  const scraped: RosterSource[] = [];
  const browser = await launchFR24Browser();
  try {
    for (const { slug } of sources) {
      info(`Fetching FR24 roster for ${slug}...`);
      const scrape = await scrapeFlightRadar24Fleet(slug, browser);
      if (!scrape.success) throw new Error(`FR24 scrape failed for ${slug}: ${scrape.error}`);
      scraped.push({ subfleet: undefined, aircraft: scrape.aircraft });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const rows = buildRoster(cfg, scraped).map(
    (r): RosterRow => ({ tail: r.registration, aircraftType: r.aircraftType, operator: r.operator })
  );
  if (rows.length < cfg.minFleetSanity) {
    throw new Error(
      `Roster suspiciously small: ${rows.length} < minFleetSanity ${cfg.minFleetSanity}`
    );
  }
  return rows;
}

/**
 * Settle the curated equipped tails: per-tail 'observed' evidence, dated with
 * each record's own evidenced date (DateFound), provider-aware verified_wifi.
 * Exposed for a future discovery job that wants to write without the CLI.
 */
export function applySouthwestEquipped(
  db: Database,
  records: readonly SouthwestEquippedTail[] = SOUTHWEST_EQUIPPED_TAILS
): void {
  const problems = validateSouthwestEquipped(records);
  if (problems.length > 0) {
    throw new Error(`southwest-equipped log invalid:\n  ${problems.join("\n  ")}`);
  }
  const tx = db.transaction(() => {
    for (const r of records) {
      upsertFleetAircraft(db, r.tail, r.aircraftType, "wn_curated", "mainline", null, "WN", {
        starlinkStatus: "confirmed",
        verifiedWifi: r.provider,
        evidence: "observed",
        // Same rule as DateFound below: the record's own evidenced date, never
        // the run date, or the fleet page reads "verified today" for a tail
        // whose evidence is months old.
        observedAt: Math.floor(Date.parse(`${r.equippedOn}T00:00:00Z`) / 1000),
      });
      addDiscoveredStarlinkPlane(db, r.tail, r.aircraftType, r.provider, null, "mainline", {
        sheetGid: "wn_curated",
        airline: "WN",
        dateFound: r.equippedOn,
        evidence: "observed",
      });
    }
  });
  tx();
}

function applyRoster(db: Database, rows: RosterRow[]) {
  const tx = db.transaction(() => {
    for (const r of rows) {
      // No seedVerdict: an unlisted WN tail is 'unknown', full stop — there is
      // no type rule that could settle a Southwest 737 either way.
      upsertFleetAircraft(db, r.tail, r.aircraftType, "wn_seed", "mainline", r.operator, "WN");
    }
  });
  tx();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dbPath = args.find((a) => a.startsWith("--db="))?.slice(5) ?? DB_PATH;
  const doApply = args.includes("--apply");
  const tailsOnly = args.includes("--tails-only");

  const problems = validateSouthwestEquipped();
  if (problems.length > 0) {
    console.error(`southwest-equipped log invalid:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }

  const roster = tailsOnly ? [] : await scrapeRoster();

  console.log("\n=== Southwest seed ===");
  if (!tailsOnly) console.log(`  Roster: ${roster.length} tails from FR24 (all unknown)`);
  console.log(`  Curated equipped tails: ${SOUTHWEST_EQUIPPED_TAILS.length}`);
  for (const r of SOUTHWEST_EQUIPPED_TAILS) {
    console.log(`   ${r.tail}  ${r.aircraftType}  ${r.provider}  since ${r.equippedOn}`);
  }

  if (doApply) {
    const db = new Database(dbPath);
    if (!tailsOnly) applyRoster(db, roster);
    applySouthwestEquipped(db);
    refreshFleetMeta(db, "WN");
    db.close();
    info(
      `Applied WN seed: ${roster.length} roster tails, ${SOUTHWEST_EQUIPPED_TAILS.length} curated equipped`
    );
  } else {
    console.log("  (dry-run — pass --apply to write)\n");
  }
}
