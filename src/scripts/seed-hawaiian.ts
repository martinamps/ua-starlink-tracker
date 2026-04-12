#!/usr/bin/env bun
/**
 * One-time Hawaiian Airlines bootstrap.
 *
 * Hawaiian's Starlink rollout is type-deterministic and complete (Sep 2024),
 * so per-tail discovery/verification adds no signal — apply the type→status
 * map to the FR24 roster and we're done. See ops/hawaiian-sourcing.md.
 *
 *   bun run seed-hawaiian -- --dry-run     # print the table, no writes
 *   bun run seed-hawaiian -- --apply       # write to DB
 */

import { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import { hawaiianTypeToStarlink } from "../api/alaska-status";
import { DB_PATH } from "../utils/constants";
import { info } from "../utils/logger";
import { scrapeFlightRadar24Fleet } from "./flightradar24-scraper";

interface SeedRow {
  tail: string;
  aircraftType: string;
  verdict: "Starlink" | "None" | "pending";
  status: "confirmed" | "negative" | "unknown";
}

async function buildRoster(): Promise<SeedRow[]> {
  const cfg = AIRLINES.HA;
  if (!cfg.fr24Slug) throw new Error("HA.fr24Slug missing");
  info(`Fetching FR24 roster for ${cfg.fr24Slug}...`);
  const scrape = await scrapeFlightRadar24Fleet(cfg.fr24Slug);
  if (!scrape.success) throw new Error(`FR24 scrape failed: ${scrape.error}`);
  if (scrape.aircraft.length < cfg.minFleetSanity) {
    throw new Error(
      `Roster suspiciously small: ${scrape.aircraft.length} < minFleetSanity ${cfg.minFleetSanity}`
    );
  }
  return scrape.aircraft.map((a) => {
    const verdict = hawaiianTypeToStarlink(a.aircraftType);
    return {
      tail: a.registration,
      aircraftType: a.aircraftType,
      verdict,
      status: verdict === "Starlink" ? "confirmed" : verdict === "pending" ? "unknown" : "negative",
    };
  });
}

function printTable(rows: SeedRow[]) {
  const byType = new Map<string, { verdict: string; n: number }>();
  for (const r of rows) {
    const k = r.aircraftType || "(unknown)";
    const e = byType.get(k) ?? { verdict: r.verdict, n: 0 };
    e.n++;
    byType.set(k, e);
  }
  console.log(`\n=== Hawaiian seed · ${rows.length} tails from FR24 ===`);
  console.log("  Type                 n   verdict");
  for (const [k, v] of [...byType.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(3)}   ${v.verdict}`);
  }
  const counts = { Starlink: 0, None: 0, pending: 0 };
  for (const r of rows) counts[r.verdict]++;
  console.log(
    `\n  Starlink=${counts.Starlink}  None=${counts.None}  pending=${counts.pending}  total=${rows.length}\n`
  );
}

function apply(db: Database, rows: SeedRow[]) {
  const now = Math.floor(Date.now() / 1000);
  const HA_INSTALL_DATE = "2024-09-24";
  const fleetUpsert = db.query(`
    INSERT INTO united_fleet
      (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at,
       fleet, operated_by, starlink_status, verified_wifi, verified_at, airline)
    VALUES (?, ?, 'ha_seed', ?, ?, 'mainline', 'Hawaiian Airlines', ?, ?, ?, 'HA')
    ON CONFLICT(tail_number) DO UPDATE SET
      aircraft_type = COALESCE(excluded.aircraft_type, aircraft_type),
      last_seen_at = excluded.last_seen_at,
      starlink_status = excluded.starlink_status,
      verified_wifi = excluded.verified_wifi,
      verified_at = excluded.verified_at,
      airline = 'HA'
  `);
  const planeUpsert = db.query(`
    INSERT OR IGNORE INTO starlink_planes
      (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
    VALUES (?, 'Starlink', 'ha_seed', 'HA-mainline', ?, ?, 'Hawaiian Airlines', 'mainline', 'Starlink', 'HA')
  `);

  const tx = db.transaction(() => {
    for (const r of rows) {
      const wifi = r.verdict === "Starlink" ? "Starlink" : r.verdict === "None" ? "None" : null;
      fleetUpsert.run(r.tail, r.aircraftType, now, now, r.status, wifi, wifi ? now : null);
      if (r.verdict === "Starlink") {
        planeUpsert.run(r.aircraftType, HA_INSTALL_DATE, r.tail);
      }
    }
  });
  tx();
  info(
    `Applied ${rows.length} HA tails (${rows.filter((r) => r.verdict === "Starlink").length} → starlink_planes)`
  );
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
