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

import { initializeDatabase, updateShipNumber } from "../database/database";
import { info, error as logError } from "../utils/logger";

const SHIP_SHEET_ID = "1ZlYgN_IZmd6CSx_nXnuP0L0PiodapDRx3RmNkIpxXAo";
const SHIP_SHEET_GIDS = [
  0, 1, 948315825, 735685210, 3, 4, 5, 6, 70572532, 7, 8, 10, 12, 15, 13, 2098141434,
];

const TAIL_RE = /^N[0-9A-Z]{2,5}$/;

async function fetchSheet(gid: number): Promise<string> {
  const url = `https://docs.google.com/spreadsheets/d/${SHIP_SHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
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

export async function syncShipNumbers(): Promise<number> {
  const db = initializeDatabase();
  let updated = 0;

  try {
    for (const gid of SHIP_SHEET_GIDS) {
      let csv: string;
      try {
        csv = await fetchSheet(gid);
      } catch (err) {
        logError(`Failed to fetch ship sheet gid=${gid}`, err);
        continue;
      }

      const lines = csv.split("\n");
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = parseCsvLine(lines[i]);
        const tail = cols[1]?.replace(/"/g, "").trim();
        const ship = cols[2]?.replace(/"/g, "").trim();
        if (!tail || !ship || !TAIL_RE.test(tail)) continue;
        updateShipNumber(db, tail, ship);
        updated++;
      }
    }
  } finally {
    db.close();
  }

  return updated;
}

if (import.meta.main) {
  syncShipNumbers()
    .then((count) => {
      info(`Ship number sync complete: ${count} rows updated`);
      console.log(`Updated ${count} ship numbers`);
    })
    .catch((err) => {
      logError("Ship number sync failed", err);
      process.exit(1);
    });
}
