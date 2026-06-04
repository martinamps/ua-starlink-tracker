#!/usr/bin/env bun
/**
 * Sync Alaska mainline Starlink tails from FlyerTalk thread #2201647.
 *
 * alaskaair.com exposes no per-tail wifi-provider field on any surface; the
 * FlyerTalk wikipost is the only public oracle for the 737/787 rollout. Same
 * fidelity tradeoff as flyertalk-qatar. The wikipost is the curated list and
 * renders on page 1, so we fetch once and parse only the "Starlink Installed"
 * section. FlyerTalk 403s the prod ASN; ship via residential-sync.
 */

import type { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import {
  addDiscoveredStarlinkPlane,
  initializeDatabase,
  refreshFleetMeta,
  upsertFleetAircraft,
} from "../database/database";
import { BROWSER_USER_AGENT } from "../utils/constants";
import { info, error as logError } from "../utils/logger";

const ALLOWED_HOST = "www.flyertalk.com";
const THREAD_ID = 2201647;
const THREAD_URL = `https://${ALLOWED_HOST}/forum/alaska-airlines-atmos-rewards/${THREAD_ID}-starlink-wi-fi-e75s-began-12-2025-737s-began-4-2026-a.html`;

const HEADERS = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html",
  "Accept-Language": "en-US,en;q=0.5",
};

function extractInstalled(html: string): string[] {
  const wiki = html.match(new RegExp(`id="wikipost-${THREAD_ID}"[\\s\\S]*?END WIKIPOST`, "i"))?.[0];
  if (!wiki) throw new Error("wikipost block not found — page layout changed");
  // Only the curated "Installed" list confirms in-service Starlink. Require an
  // explicit terminator header — an editor renaming one would otherwise let the
  // slice swallow in-progress tails (which pass the AS-mainline DB-gate).
  const installed = wiki.match(
    /Starlink Installed[\s\S]*?(?=Installations in Progress|Installations Planned|No Starlink Planned)/i
  )?.[0];
  if (!installed)
    throw new Error('"Starlink Installed" section bounds not found — wikipost headings changed');
  // Scan with the registry pattern; prose noise (e.g. "N1" engine-speed talk)
  // is rejected by the AS-mainline DB-gate in applyAlaskaFlyertalkTails.
  return [...new Set(installed.match(AIRLINES.AS.tailScanPattern) ?? [])].sort();
}

export async function fetchAlaskaFlyertalkTails(): Promise<string[]> {
  const res = await fetch(THREAD_URL, { headers: HEADERS, redirect: "error" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${THREAD_URL}`);
  const html = new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()));
  return extractInstalled(html);
}

export function applyAlaskaFlyertalkTails(db: Database, tails: string[]): number {
  if (tails.length === 0) return 0;

  const lookup = db.query<{ aircraft_type: string | null; fleet: string }, [string]>(
    "SELECT aircraft_type, fleet FROM united_fleet WHERE tail_number = ? AND airline = 'AS'"
  );

  let written = 0;
  const tx = db.transaction((rows: string[]) => {
    for (const tail of rows) {
      const known = lookup.get(tail);
      // DB-gate: only confirm tails fleet-sync already knows as AS mainline.
      // E175s are type-deterministic via AS typeDeterministicWifi — skip to keep
      // this writer scoped to the gap it fills.
      if (!known || known.fleet !== "mainline") continue;
      upsertFleetAircraft(
        db,
        tail,
        known.aircraft_type,
        "flyertalk_as",
        "mainline",
        "Alaska Airlines",
        "AS",
        { starlinkStatus: "confirmed", verifiedWifi: "Starlink" }
      );
      addDiscoveredStarlinkPlane(
        db,
        tail,
        known.aircraft_type,
        "Starlink",
        "Alaska Airlines",
        "mainline",
        {
          sheetGid: "flyertalk_as",
          airline: "AS",
        }
      );
      written++;
    }
  });
  tx(tails);

  info(`FlyerTalk AS sync: ${written}/${tails.length} tails written (AS-mainline-gated)`);
  return written;
}

async function syncAlaskaFlyertalk(): Promise<number> {
  const db = initializeDatabase();
  try {
    const tails = await fetchAlaskaFlyertalkTails();
    info(`FlyerTalk AS: scraped ${tails.length} installed tails from wikipost`);
    const n = applyAlaskaFlyertalkTails(db, tails);
    if (n > 0) refreshFleetMeta(db, "AS");
    return n;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    fetchAlaskaFlyertalkTails()
      .then((tails) => {
        console.log(`\n${tails.length} AS mainline tails in "Starlink Installed":`);
        console.log(tails.join(" "));
        console.log("\n(dry-run — pass without --dry-run to write)\n");
      })
      .catch((e) => {
        logError("Alaska FlyerTalk dry-run failed", e);
        process.exit(1);
      });
  } else {
    syncAlaskaFlyertalk()
      .then((n) => info(`Alaska FlyerTalk sync complete: ${n} tails`))
      .catch((e) => {
        logError("Alaska FlyerTalk sync failed", e);
        process.exit(1);
      });
  }
}
