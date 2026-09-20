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
import { AIRLINES, qatarTypeToStarlink } from "../airlines/registry";
import { initializeDatabase } from "../database/database";
import { BROWSER_USER_AGENT } from "../utils/constants";
import { info, error as logError } from "../utils/logger";
import { type FlyertalkFetcher, applyFlyertalkTails, fetchFlyertalk } from "./flyertalk-common";

const ALLOWED_HOST = "www.flyertalk.com";
const THREAD_ID = 2162391;
const THREAD_URL = `https://${ALLOWED_HOST}/forum/qatar-airways-privilege-club/${THREAD_ID}-qr-starlink-now-live.html`;
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
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html",
  "Accept-Language": "en-US,en;q=0.5",
};

export async function fetchQatarFlyertalkTails(fetcher?: FlyertalkFetcher): Promise<string[]> {
  const seen = new Set<string>();
  let url: string | null = THREAD_URL;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const { html, finalUrl } = await fetchFlyertalk(url, THREAD_ID, HEADERS, fetcher);
    for (const m of html.matchAll(AIRLINES.QR.tailScanPattern)) seen.add(m[0]);
    url = nextPageUrl(html, finalUrl);
    pages++;
  }

  return [...seen].sort();
}

// Forum posts are uncurated; only confirm tails the type rule already says
// should be Starlink. 787-9s/freighters/A380s/unknown types are skipped.
export function qatarFlyertalkTypePasses(aircraftType: string | null): boolean {
  return qatarTypeToStarlink(aircraftType ?? "") === "confirmed";
}

export interface GatedTail {
  tail: string;
  aircraftType: string | null;
}

/** "7 type-gated (787-9 ×6, A380-800 ×1)" */
export function typeGatedSummary(gated: readonly GatedTail[]): string {
  const counts = new Map<string, number>();
  for (const g of gated) {
    const type = g.aircraftType?.replace(/^(Boeing|Airbus)\s+/, "") || "unknown type";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const parts = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${type} ×${n}`);
  return `${gated.length} type-gated${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** Writes the tails that pass the type gate; the rest land in `gated`. */
export function applyQatarFlyertalkTails(
  db: Database,
  tails: string[],
  gated: GatedTail[] = []
): number {
  const typeOf = db.query<{ aircraft_type: string | null }, [string]>(
    "SELECT aircraft_type FROM united_fleet WHERE tail_number = ?"
  );

  const written = applyFlyertalkTails(db, tails, {
    airline: "QR",
    gid: "flyertalk_qr",
    operator: "Qatar Airways",
    gateLabel: "type-gated",
    gate: (tail) => {
      const type = typeOf.get(tail)?.aircraft_type ?? null;
      if (qatarFlyertalkTypePasses(type)) return { aircraftType: type };
      gated.push({ tail, aircraftType: type });
      return null;
    },
  });
  if (gated.length > 0) info(`FlyerTalk QR: ${typeGatedSummary(gated)}`);
  return written;
}

async function syncQatarFlyertalk(): Promise<number> {
  const db = initializeDatabase();
  try {
    const tails = await fetchQatarFlyertalkTails();
    info(`FlyerTalk QR: scraped ${tails.length} unique tails`);
    return applyQatarFlyertalkTails(db, tails);
  } finally {
    db.close();
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
