/**
 * The published fleet denominator comes from the roster, not the sheet.
 *
 * The hourly scrape counts every row of every sheet tab and wrote those sums
 * straight into the meta keys that getTotalCount/getFleetStats serve. The
 * community sheet's express tabs carry SkyWest's entire operation (their
 * Delta/American/Alaska flying included), which inflated the published UA
 * fleet to 1,818 against a real roster of ~1,641 — understating coverage by
 * ~3.5 points overall and ~18 points on express. united_fleet (FR24-sourced)
 * agrees with United's own pipeline sheet to within ~1%, so it wins whenever
 * it has rows; the sheet tallies remain only as a fallback floor.
 */

import { describe, expect, test } from "bun:test";
import { getFleetStats, getTotalCount, updateDatabase } from "../src/database/database";
import type { FleetStats } from "../src/types";
import { addFleet, makeSyntheticDb } from "./helpers";

const inflatedSheetStats: FleetStats = {
  express: { total: 674, starlink: 342, unverified: 0, percentage: 50.7 },
  mainline: { total: 1144, starlink: 184, unverified: 0, percentage: 16.1 },
};

const sheetRoster = [
  { TailNumber: "N101UA", Aircraft: "E175", WiFi: "Starlink", fleet: "express" as const },
  {
    TailNumber: "N102UA",
    Aircraft: "Boeing 737-900",
    WiFi: "Starlink",
    fleet: "mainline" as const,
  },
];

describe("fleet denominator source of truth", () => {
  test("a populated roster overrides the sheet's inflated tallies", () => {
    const db = makeSyntheticDb();
    // Roster: 3 express + 5 mainline = 8 aircraft the fleet sync actually saw.
    for (let i = 0; i < 3; i++) addFleet(db, `N90${i}EX`, "confirmed");
    for (let i = 0; i < 5; i++) addFleet(db, `N91${i}ML`, null);
    db.query("UPDATE united_fleet SET fleet = 'express' WHERE tail_number LIKE 'N90%'").run();
    db.query("UPDATE united_fleet SET fleet = 'mainline' WHERE tail_number LIKE 'N91%'").run();

    const refusal = updateDatabase(db, 1818, sheetRoster, inflatedSheetStats);
    expect(refusal).toBeNull();

    // Published totals are the roster's 8, not the sheet's 1,818.
    expect(getTotalCount(db, "UA")).toBe(8);
    const stats = getFleetStats(db, "UA");
    expect(stats.express.total).toBe(3);
    expect(stats.mainline.total).toBe(5);
    db.close();
  });

  test("with no roster rows the sheet tallies survive as the fallback", () => {
    const db = makeSyntheticDb();
    const refusal = updateDatabase(db, 1818, sheetRoster, inflatedSheetStats);
    expect(refusal).toBeNull();
    expect(getTotalCount(db, "UA")).toBe(1818);
    expect(getFleetStats(db, "UA").express.total).toBe(674);
    db.close();
  });

  test("the scrape's lastUpdated stamp survives the roster recompute", () => {
    // stampLastUpdated is ownership-gated: UA's configured owner is the scrape,
    // so refreshFleetMeta's own stamp attempt must be a no-op — lastUpdated
    // must exist (the scrape wrote it) and stay a valid ISO timestamp.
    const db = makeSyntheticDb();
    addFleet(db, "N900EX", "confirmed");
    updateDatabase(db, 1818, sheetRoster, inflatedSheetStats);
    const stamped = db.query("SELECT value FROM meta WHERE key = 'UA:lastUpdated'").get() as {
      value: string;
    } | null;
    expect(stamped).not.toBeNull();
    expect(Number.isFinite(Date.parse(stamped?.value ?? ""))).toBe(true);
    db.close();
  });
});
