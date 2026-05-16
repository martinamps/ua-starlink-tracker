#!/usr/bin/env bun
/**
 * Sync Qatar Starlink tails from FlyerTalk thread #2162391.
 *
 * Qatar has no first-party per-tail wifi oracle — qoreservices returns only
 * IATA equipment codes. The FlyerTalk thread is the highest-fidelity public
 * source: enthusiasts post A7-XXX registrations as they spot the antenna or
 * fly the aircraft. The wikipost is empty so we walk every page via rel=next.
 *
 * The result is treated as a confirmation list (777/A350 fleets are 100% done
 * per QR press, Dec 2025) — `upsertFleetAircraft` only flips
 * status='unknown'→'confirmed', so any tail already settled by another path
 * is left alone.
 */

import type { Database } from "bun:sqlite";
import { qatarTypeToStarlink } from "../airlines/registry";
import {
  addDiscoveredStarlinkPlane,
  initializeDatabase,
  upsertFleetAircraft,
} from "../database/database";
import { info, error as logError } from "../utils/logger";

const ALLOWED_HOST = "www.flyertalk.com";
const THREAD_URL = `https://${ALLOWED_HOST}/forum/qatar-airways-privilege-club/2162391-qr-starlink-now-live.html`;
const QR_TAIL_RE = /\bA7-[A-Z]{3}\b/g;
const NEXT_RE = /rel="next"\s+href="([^"]+)"/i;
const MAX_PAGES = 60;

function nextPageUrl(html: string, base: string): string | null {
  const m = html.match(NEXT_RE);
  if (!m) return null;
  try {
    const u = new URL(m[1], base);
    return u.protocol === "https:" && u.hostname === ALLOWED_HOST ? u.href : null;
  } catch {
    return null;
  }
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Accept: "text/html",
  "Accept-Language": "en-US,en;q=0.5",
};

export async function fetchQatarFlyertalkTails(): Promise<string[]> {
  const seen = new Set<string>();
  let url: string | null = THREAD_URL;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const res = await fetch(url, { headers: HEADERS, redirect: "error" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    // FlyerTalk serves windows-1252; treat as bytes and only keep ASCII matches.
    const html = new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()));
    for (const m of html.matchAll(QR_TAIL_RE)) seen.add(m[0]);
    url = nextPageUrl(html, url);
    pages++;
  }

  return [...seen].sort();
}

export async function syncQatarFlyertalk(db?: Database): Promise<number> {
  const owns = !db;
  const handle = db ?? initializeDatabase();
  try {
    const tails = await fetchQatarFlyertalkTails();
    info(`FlyerTalk QR: scraped ${tails.length} unique tails`);
    if (tails.length === 0) return 0;

    const typeOf = handle.query<{ aircraft_type: string | null }, [string]>(
      "SELECT aircraft_type FROM united_fleet WHERE tail_number = ?"
    );

    let written = 0;
    const tx = handle.transaction((rows: string[]) => {
      for (const tail of rows) {
        const type = typeOf.get(tail)?.aircraft_type ?? null;
        // Forum posts are uncurated; only confirm tails the type rule already
        // says should be Starlink. 787s/freighters/A380s/unknown types skipped.
        if (qatarTypeToStarlink(type ?? "") !== "confirmed") continue;
        upsertFleetAircraft(handle, tail, type, "flyertalk_qr", "mainline", "Qatar Airways", "QR", {
          starlinkStatus: "confirmed",
          verifiedWifi: "Starlink",
        });
        addDiscoveredStarlinkPlane(handle, tail, type, "Starlink", "Qatar Airways", "mainline", {
          sheetGid: "flyertalk_qr",
          airline: "QR",
        });
        written++;
      }
    });
    tx(tails);

    info(`FlyerTalk QR sync: ${written}/${tails.length} tails written (type-gated)`);
    return written;
  } finally {
    if (owns) handle.close();
  }
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    fetchQatarFlyertalkTails()
      .then((tails) => {
        console.log(`\n${tails.length} unique QR tails found:`);
        console.log(tails.join(" "));
        console.log("\n(dry-run — pass without --dry-run to write)\n");
      })
      .catch((e) => {
        logError("Qatar FlyerTalk dry-run failed", e);
        process.exit(1);
      });
  } else {
    syncQatarFlyertalk()
      .then((n) => info(`Qatar FlyerTalk sync complete: ${n} tails`))
      .catch((e) => {
        logError("Qatar FlyerTalk sync failed", e);
        process.exit(1);
      });
  }
}
