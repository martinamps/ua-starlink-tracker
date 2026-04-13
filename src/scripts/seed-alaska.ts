#!/usr/bin/env bun
/**
 * Alaska Airlines fleet bootstrap.
 *
 * Unlike Hawaiian (type-deterministic, complete), Alaska is mid-rollout
 * per-tail (E175 first Dec 2025, ~half by end 2026, all by end 2027). So we
 * seed the roster with starlink_status='unknown' and let the verifier +
 * discovery loops settle individual tails over time. The alaskaair.com
 * __data.json endpoint has no wifi field yet (still hardcodes
 * isHawaiian ? Starlink : Wi-Fi client-side), so there is no first-party
 * per-tail oracle until that changes.
 *
 *   bun run seed-alaska -- --dry-run     # print the table, no writes
 *   bun run seed-alaska -- --apply       # write to DB
 */

import { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import { setMeta, upsertFleetAircraft } from "../database/database";
import { DB_PATH } from "../utils/constants";
import { info } from "../utils/logger";
import { scrapeFlightRadar24Fleet } from "./flightradar24-scraper";

interface SeedRow {
  tail: string;
  aircraftType: string;
  subfleet: string;
  operator: string;
}

const HORIZON_SLUG = "qx-qxe";

async function buildRoster(): Promise<SeedRow[]> {
  const cfg = AIRLINES.AS;
  if (!cfg.fr24Slug) throw new Error("AS.fr24Slug missing");

  const rows: SeedRow[] = [];
  for (const [slug, subfleet, operator] of [
    [cfg.fr24Slug, "mainline", "Alaska Airlines"],
    [HORIZON_SLUG, "horizon", "Horizon Air"],
  ] as const) {
    info(`Fetching FR24 roster for ${slug}...`);
    const scrape = await scrapeFlightRadar24Fleet(slug);
    if (!scrape.success) throw new Error(`FR24 scrape failed (${slug}): ${scrape.error}`);
    for (const a of scrape.aircraft) {
      rows.push({ tail: a.registration, aircraftType: a.aircraftType, subfleet, operator });
    }
  }

  if (rows.length < cfg.minFleetSanity) {
    throw new Error(
      `Roster suspiciously small: ${rows.length} < minFleetSanity ${cfg.minFleetSanity}`
    );
  }
  return rows;
}

function printTable(rows: SeedRow[]) {
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.aircraftType, (byType.get(r.aircraftType) ?? 0) + 1);
  console.log(`\n=== Alaska seed · ${rows.length} tails from FR24 (mainline + Horizon) ===`);
  console.log("  Type                       n");
  for (const [k, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(26)} ${String(n).padStart(3)}`);
  }
  const bySub = { mainline: 0, horizon: 0 };
  for (const r of rows) bySub[r.subfleet as keyof typeof bySub]++;
  console.log(
    `\n  mainline=${bySub.mainline}  horizon=${bySub.horizon}  total=${rows.length}  (all status=unknown — per-tail rollout)\n`
  );
}

function apply(db: Database, rows: SeedRow[]) {
  const tx = db.transaction(() => {
    for (const r of rows) {
      upsertFleetAircraft(db, r.tail, r.aircraftType, "as_seed", r.subfleet, r.operator, "AS");
    }
  });
  tx();

  const total = rows.length;
  setMeta(db, "totalAircraftCount", total, "AS");
  setMeta(db, "mainlineStarlink", 0, "AS");
  setMeta(db, "mainlineTotal", total, "AS");
  setMeta(db, "mainlinePercentage", "0.00", "AS");
  setMeta(db, "lastUpdated", new Date().toISOString(), "AS");

  info(`Applied ${total} AS tails (status=unknown; verifier + discovery will settle)`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dbPath = args.find((a) => a.startsWith("--db="))?.slice(5) ?? DB_PATH;
  const doApply = args.includes("--apply");

  const rows = await buildRoster();
  printTable(rows);

  if (doApply) {
    const db = new Database(dbPath);
    apply(db, rows);
    db.close();
  } else {
    console.log("  (dry-run — pass --apply to write)\n");
  }
}
