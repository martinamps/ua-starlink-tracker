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
import { addDiscoveredStarlinkPlane, setMeta, upsertFleetAircraft } from "../database/database";
import { DB_PATH } from "../utils/constants";
import { info } from "../utils/logger";
import { launchFR24Browser, scrapeFlightRadar24Fleet } from "./flightradar24-scraper";

interface SeedRow {
  tail: string;
  aircraftType: string;
  subfleet: "mainline" | "horizon";
  operator: string;
  verdict: AlaskaWifi;
}

async function buildRoster(): Promise<SeedRow[]> {
  const cfg = AIRLINES.AS;
  if (!cfg.fr24Slug) throw new Error("AS.fr24Slug missing");

  // Regional sources first so Horizon E175s pick up the correct operator
  // before the broader as-asa page (which also lists them) fills in the rest.
  const sources = [
    ...(cfg.regionalCarriers ?? []).map((r) => ({ slug: r.fr24Slug, operator: r.name })),
    { slug: cfg.fr24Slug, operator: cfg.name },
  ];

  // FR24's as-asa page covers the full Alaska livery fleet (including regional
  // E175s); qx-qxe overlaps. Dedupe by tail so the meta counts don't inflate.
  const byTail = new Map<string, SeedRow>();
  const failures: string[] = [];
  const browser = await launchFR24Browser();
  try {
    for (const { slug, operator } of sources) {
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
      for (const a of scrape.aircraft) {
        if (byTail.has(a.registration)) continue;
        // Classify by aircraft type, not source slug or registration suffix —
        // SkyWest-for-Alaska E175s and N***MK Horizon tails both belong in
        // the horizon subfleet despite not being QX-registered.
        const subfleet = (cfg.classifyFleet?.(a.aircraftType) ?? "mainline") as
          | "mainline"
          | "horizon";
        byTail.set(a.registration, {
          tail: a.registration,
          aircraftType: a.aircraftType,
          subfleet,
          // Operator is type-derived, not source-derived: when qx-qxe times out
          // the regional rows would otherwise carry as-asa's "Alaska Airlines".
          operator:
            subfleet === "horizon" ? (cfg.regionalCarriers?.[0]?.name ?? operator) : operator,
          // Verdict derived from subfleet so they can never disagree.
          verdict: subfleet === "horizon" ? "Starlink" : null,
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const rows = [...byTail.values()];

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
  // Q1 2026 earnings call (April 21, 2026): full regional E175 fleet is Starlink-equipped.
  const AS_E175_CONFIRM_DATE = "2026-04-21";

  const tx = db.transaction(() => {
    for (const r of rows) {
      const isStarlink = r.verdict === "Starlink";
      upsertFleetAircraft(
        db,
        r.tail,
        r.aircraftType,
        "as_seed",
        r.subfleet,
        r.operator,
        "AS",
        isStarlink ? { starlinkStatus: "confirmed", verifiedWifi: "Starlink" } : undefined
      );
      if (isStarlink) {
        // fleet keeps the airline-correct subfleet ("horizon") — getFleetStats()
        // rolls non-mainline into express, and the AS UI reads p.fleet === "horizon".
        addDiscoveredStarlinkPlane(db, r.tail, r.aircraftType, "Starlink", r.operator, r.subfleet, {
          sheetGid: "as_seed",
          dateFound: AS_E175_CONFIRM_DATE,
          airline: "AS",
        });
      }
    }
  });
  tx();

  const total = rows.length;
  const horizonRows = rows.filter((r) => r.subfleet === "horizon");
  const mainlineRows = rows.filter((r) => r.subfleet === "mainline");
  const expressTotal = horizonRows.length;
  const expressStarlink = horizonRows.filter((r) => r.verdict === "Starlink").length;
  const mainlineTotal = mainlineRows.length;

  setMeta(db, "totalAircraftCount", total, "AS");
  setMeta(db, "expressTotal", expressTotal, "AS");
  setMeta(db, "expressStarlink", expressStarlink, "AS");
  setMeta(db, "expressPercentage", percent(expressStarlink, expressTotal), "AS");
  setMeta(db, "mainlineTotal", mainlineTotal, "AS");
  setMeta(db, "mainlineStarlink", 0, "AS");
  setMeta(db, "mainlinePercentage", "0.00", "AS");
  setMeta(db, "lastUpdated", new Date().toISOString(), "AS");

  info(
    `Applied ${total} AS tails: ${expressStarlink} regional E175 → confirmed, ${mainlineTotal} mainline → unknown`
  );
}

function percent(n: number, d: number): string {
  return d > 0 ? ((n / d) * 100).toFixed(2) : "0.00";
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
