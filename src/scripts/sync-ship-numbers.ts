#!/usr/bin/env bun
/**
 * Sync ship numbers from the public mainline fleet spreadsheet into
 * united_fleet.ship_number. United.com shows ship numbers (#3237) instead of
 * tail numbers (N14237) for mainline flights, so the verifier needs this
 * mapping to resolve which aircraft it actually scraped.
 *
 * CSV columns: Model, Reg #, AC #, ...
 *   col[1] = tail number, col[2] = ship number
 */

import type { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import { initializeDatabase, setMeta, updateShipNumber } from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability/metrics";
import { BROWSER_USER_AGENT } from "../utils/constants";
import { info, error as logError } from "../utils/logger";

const SHIP_SHEET_ID = "1ZlYgN_IZmd6CSx_nXnuP0L0PiodapDRx3RmNkIpxXAo";
const SHIP_SHEET_GIDS = [
  0, 1, 948315825, 735685210, 3, 4, 5, 6, 70572532, 7, 8, 10, 12, 15, 13, 2098141434,
];

async function fetchSheet(gid: number): Promise<string> {
  const url = `https://docs.google.com/spreadsheets/d/${SHIP_SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      "Accept-Language": "en-US,en;q=0.5",
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for gid=${gid}`);
  return res.text();
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export type ShipSyncStatus = "error" | "partial" | "noop" | "success";

export interface ShipSyncResult {
  status: ShipSyncStatus;
  fetchedGids: number;
  failedGids: number;
  rowsSeen: number;
  changed: number;
}

export const SHIP_NUMBERS_SYNCED_AT = "ship_numbers_synced_at";

/** Per-gid fetch failures are absorbed so one bad tab never costs the rest,
 * which is exactly why the outcome has to be counted: without it a run where
 * every tab 403s looked identical to a clean one. */
export function shipSyncStatus(r: Omit<ShipSyncResult, "status">): ShipSyncStatus {
  if (r.fetchedGids === 0) return "error";
  if (r.failedGids > 0) return "partial";
  return r.changed === 0 ? "noop" : "success";
}

export async function syncShipNumbers(deps: {
  db: Database;
  fetchSheet?: (gid: number) => Promise<string>;
}): Promise<ShipSyncResult> {
  const { db } = deps;
  const fetchGid = deps.fetchSheet ?? fetchSheet;
  const counts = { fetchedGids: 0, failedGids: 0, rowsSeen: 0, changed: 0 };

  for (const gid of SHIP_SHEET_GIDS) {
    let csv: string;
    try {
      csv = await fetchGid(gid);
      counts.fetchedGids++;
    } catch (err) {
      counts.failedGids++;
      logError(`Failed to fetch ship sheet gid=${gid}`, err);
      continue;
    }

    const lines = csv.split("\n");
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = parseCsvLine(lines[i]);
      const tail = cols[1]?.replace(/"/g, "").trim();
      const ship = cols[2]?.replace(/"/g, "").trim();
      if (!tail || !ship || !AIRLINES.UA.tailPattern.test(tail)) continue;
      counts.rowsSeen++;
      counts.changed += updateShipNumber(db, tail, ship);
    }
  }

  const status = shipSyncStatus(counts);
  metrics.increment(COUNTERS.SCRAPER_SYNC, {
    source: "ship_numbers",
    airline: normalizeAirlineTag("UA"),
    status,
  });
  const summary = `${counts.fetchedGids}/${SHIP_SHEET_GIDS.length} sheets, ${counts.rowsSeen} rows, ${counts.changed} changed`;
  if (status === "error") {
    throw new Error(`Ship number sync failed: ${summary}`);
  }
  setMeta(db, SHIP_NUMBERS_SYNCED_AT, new Date().toISOString(), "UA");
  info(`Ship number sync ${status}: ${summary}`);
  return { status, ...counts };
}

if (import.meta.main) {
  syncShipNumbers({ db: initializeDatabase() })
    .then((r) => {
      console.log(`Ship numbers ${r.status}: ${r.changed} changed of ${r.rowsSeen} rows`);
    })
    .catch((err) => {
      logError("Ship number sync failed", err);
      process.exit(1);
    });
}
