/**
 * /api/fleet-discovery compares verified tails against the community sheet.
 * Jobs skip a boot run that isn't due, so a new process can serve for up to an
 * hour before its first sheet scrape: the sheet list must come from the stored
 * roster, or every verified tail reads as missing from the sheet until then.
 */
import { describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { addDiscoveredStarlinkPlane, updateDatabase } from "../src/database/database";
import { recordSourceSuccess } from "../src/database/source-health";
import { createApp } from "../src/server/app";
import type { FleetStats } from "../src/types";
import { addFleet, jsonOf, makeSyntheticDb } from "./helpers";

const STATS: FleetStats = {
  express: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
  mainline: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
};

type DiscoveryBody = {
  discovered_not_in_spreadsheet: Array<{ tail_number: string }>;
  spreadsheet_cache: { size: number; updated_at: number; updated_at_formatted: string | null };
};

const SHEET_TAILS = ["N101SY", "N102SY", "N103SY"];

function storedRoster() {
  const db = makeSyntheticDb();
  updateDatabase(
    db,
    900,
    SHEET_TAILS.map((t) => ({
      TailNumber: t,
      Aircraft: "E175",
      WiFi: "StrLnk",
      sheet_gid: "200",
      sheet_type: "E175",
      fleet: "express" as const,
      OperatedBy: "SkyWest",
    })),
    STATS,
    "UA"
  );
  for (const t of SHEET_TAILS) {
    addFleet(db, t, "confirmed", { aircraftType: "E175", verifiedWifi: "Starlink" });
  }
  // Found by discovery, not on the sheet: the one tail the list is for.
  addDiscoveredStarlinkPlane(db, "N201SY", "E175", "Starlink", "SkyWest", "express", {
    airline: "UA",
    evidence: "observed",
  });
  addFleet(db, "N201SY", "confirmed", { aircraftType: "E175", verifiedWifi: "Starlink" });
  return db;
}

describe("/api/fleet-discovery in a process that has not scraped the sheet", () => {
  test("lists no sheet-listed tail as missing from the sheet", async () => {
    const db = storedRoster();
    const app = createApp(db);
    const body = (await jsonOf(
      app,
      "/api/fleet-discovery",
      SITES.united.canonicalHost
    )) as DiscoveryBody;

    const missing = body.discovered_not_in_spreadsheet.map((r) => r.tail_number);
    for (const t of SHEET_TAILS) expect(missing).not.toContain(t);
    expect(missing).toContain("N201SY");
    expect(body.spreadsheet_cache.size).toBe(SHEET_TAILS.length);
    db.close();
  });

  test("dates the list by the last accepted sheet read", async () => {
    const db = storedRoster();
    const at = Date.UTC(2026, 10, 27, 3, 0, 0);
    recordSourceSuccess(db, "sheet_scrape", "UA", at);
    const body = (await jsonOf(
      createApp(db),
      "/api/fleet-discovery",
      SITES.united.canonicalHost
    )) as DiscoveryBody;
    expect(body.spreadsheet_cache.updated_at).toBe(at);
    expect(body.spreadsheet_cache.updated_at_formatted).toBe(new Date(at).toISOString());
    db.close();
  });
});
