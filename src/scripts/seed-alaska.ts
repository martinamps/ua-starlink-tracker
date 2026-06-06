#!/usr/bin/env bun
/**
 * Alaska Airlines fleet bootstrap.
 *
 * Two sub-fleets, two stories:
 *  - Regional (Horizon + SkyWest-for-Alaska E175s, ~90 jets): fully Starlink-
 *    equipped per the Q1 2026 earnings call (April 21, 2026) — type-deterministic,
 *    seed verdict='confirmed' like seed-hawaiian.ts.
 *  - Mainline (737/787, ~250 jets): mid-rollout, no first-party oracle. The
 *    alaskaair.com __data.json endpoint has no wifi field, so we seed
 *    starlink_status='unknown' and let the verifier + discovery loops settle.
 *
 *   bun run seed-alaska -- --dry-run     # print the table, no writes
 *   bun run seed-alaska -- --apply       # write to DB
 */

import { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import type { AlaskaWifi } from "../api/alaska-status";
import {
  addDiscoveredStarlinkPlane,
  refreshFleetMeta,
  upsertFleetAircraft,
} from "../database/database";
import { DB_PATH } from "../utils/constants";
import { info } from "../utils/logger";
import { type RosterSource, buildRoster, rosterSources } from "./fleet-sync";
import { launchFR24Browser, scrapeFlightRadar24Fleet } from "./flightradar24-scraper";

interface SeedRow {
  tail: string;
  aircraftType: string;
  subfleet: "mainline" | "horizon";
  /** null = source page didn't prove an operator; writes preserve/fall back. */
  operator: string | null;
  verdict: AlaskaWifi;
}

async function scrapeRoster(): Promise<SeedRow[]> {
  const cfg = AIRLINES.AS;
  if (!cfg.fr24Slug) throw new Error("AS.fr24Slug missing");

  const sources = rosterSources(cfg);

  // buildRoster dedupes the as-asa/qx-qxe overlap; operator is asserted only
  // for qx-qxe-sourced tails, so as-asa rows can't misattribute Horizon E175s
  // to "Alaska Airlines" or inflate the counts.
  const scraped: RosterSource[] = [];
  const failures: string[] = [];
  const browser = await launchFR24Browser();
  try {
    for (const { slug, subfleet } of sources) {
      info(`Fetching FR24 roster for ${slug}...`);
      const scrape = await scrapeFlightRadar24Fleet(slug, browser);
      if (!scrape.success) {
        // Non-fatal per source — qx-qxe is flaky and redundant when as-asa
        // returns the full livery roster. The minFleetSanity check below is
        // the real gate.
        info(`FR24 scrape failed for ${slug} (${scrape.error}); continuing`);
        failures.push(slug);
        continue;
      }
      scraped.push({ subfleet, aircraft: scrape.aircraft });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const rows = buildRoster(cfg, scraped).map(
    (r): SeedRow => ({
      tail: r.registration,
      aircraftType: r.aircraftType,
      subfleet: r.subfleet as "mainline" | "horizon",
      operator: r.operator,
      // Verdict derived from subfleet so they can never disagree.
      verdict: r.subfleet === "horizon" ? "Starlink" : null,
    })
  );

  if (rows.length < cfg.minFleetSanity) {
    const failed = failures.length ? ` (FR24 failed for: ${failures.join(", ")})` : "";
    throw new Error(
      `Roster suspiciously small: ${rows.length} < minFleetSanity ${cfg.minFleetSanity}${failed}`
    );
  }
  return rows;
}

function printTable(rows: SeedRow[]) {
  const byType = new Map<string, { verdict: string; n: number }>();
  for (const r of rows) {
    const k = r.aircraftType || "(unknown)";
    const e = byType.get(k) ?? { verdict: r.verdict ?? "unknown", n: 0 };
    e.n++;
    byType.set(k, e);
  }
  console.log(`\n=== Alaska seed · ${rows.length} tails from FR24 (mainline + Horizon) ===`);
  console.log("  Type                       n   verdict");
  for (const [k, v] of [...byType.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(26)} ${String(v.n).padStart(3)}   ${v.verdict}`);
  }
  const starlink = rows.filter((r) => r.verdict === "Starlink").length;
  const unknown = rows.length - starlink;
  console.log(`\n  Starlink=${starlink}  unknown=${unknown}  total=${rows.length}\n`);
}

function apply(db: Database, rows: SeedRow[]) {
  const tx = db.transaction(() => {
    for (const r of rows) {
      const isStarlink = r.verdict === "Starlink";
      // The Horizon verdict is a TYPE rule (earnings-call "all regional E175s
      // are equipped"), not a per-tail observation — evidence:'type_rule'
      // keeps verified stamps NULL and leaves the tails verifier-eligible so
      // the per-tail verifier confirms them organically. Contrast
      // flyertalk-common, whose tails were individually spotted ('observed').
      upsertFleetAircraft(
        db,
        r.tail,
        r.aircraftType,
        "as_seed",
        r.subfleet,
        r.operator,
        "AS",
        isStarlink
          ? { starlinkStatus: "confirmed", verifiedWifi: null, evidence: "type_rule" }
          : undefined
      );
      if (isStarlink) {
        // fleet keeps the airline-correct subfleet ("horizon") — getFleetStats()
        // rolls non-mainline into express, and the AS UI reads p.fleet === "horizon".
        addDiscoveredStarlinkPlane(db, r.tail, r.aircraftType, "Starlink", r.operator, r.subfleet, {
          sheetGid: "as_seed",
          airline: "AS",
          evidence: "type_rule",
        });
      }
    }
  });
  tx();

  refreshFleetMeta(db, "AS");

  const horizon = rows.filter((r) => r.subfleet === "horizon").length;
  const mainline = rows.filter((r) => r.subfleet === "mainline").length;
  info(
    `Applied ${rows.length} AS tails: ${horizon} regional E175 → confirmed, ${mainline} mainline → unknown`
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dbPath = args.find((a) => a.startsWith("--db="))?.slice(5) ?? DB_PATH;
  const doApply = args.includes("--apply");

  const rows = await scrapeRoster();
  printTable(rows);

  if (doApply) {
    const db = new Database(dbPath);
    apply(db, rows);
    db.close();
  } else {
    console.log("  (dry-run — pass --apply to write)\n");
  }
}
