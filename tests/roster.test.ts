/**
 * One fleet denominator: every "N of M" surface reads M (and N) from
 * programmeRoster, so freighters and a programme's exclusions leave all of
 * them at once and they can never disagree.
 */

import { describe, expect, test } from "bun:test";
import {
  getFleetPageData,
  getHubStats,
  getMeta,
  getSubfleetPenetration,
  getTypeProgress,
  refreshFleetMeta,
} from "../src/database/database";
import { fleetRoster, programmeRoster } from "../src/database/roster";
import { makeSyntheticDb } from "./helpers";

// AF: A330 is a programme exclusion, B777F a freighter; E190 flies as express
// here so the two-bucket meta split is exercised.
const ROSTER: Array<[tail: string, type: string, fleet: string, listed: boolean]> = [
  ["F-GSQA", "Boeing 777-300ER", "mainline", true],
  ["F-GSQB", "Boeing 777-300ER", "mainline", true],
  ["F-GSQC", "Boeing 777-300ER", "mainline", false],
  ["F-HBXA", "Embraer E190", "express", true],
  ["F-HBXB", "Embraer E190", "express", false],
  ["F-GZCA", "Airbus A330-203", "mainline", true],
  ["F-GUOB", "Boeing 777F", "mainline", false],
];

function seeded() {
  const db = makeSyntheticDb();
  for (const [tail, type, fleet, listed] of ROSTER) {
    db.query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
       VALUES (?, ?, 'fr24', 1, 1, ?, 'unknown', 'AF')`
    ).run(tail, type, fleet);
    if (listed) {
      db.query(
        `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, DateFound, TailNumber, OperatedBy, fleet, airline)
         VALUES (?, 'Starlink', 'flyertalk_af', '2026-01-01', ?, 'Air France', ?, 'AF')`
      ).run(type, tail, fleet);
    }
  }
  return db;
}

describe("programmeRoster is the one denominator", () => {
  test("drops freighters and programme exclusions, keeps the equipped flag", () => {
    const db = seeded();
    expect(fleetRoster(db, "AF").length).toBe(ROSTER.length);
    const roster = programmeRoster(db, "AF");
    expect(roster.map((t) => t.tail_number).sort()).toEqual(
      ["F-GSQA", "F-GSQB", "F-GSQC", "F-HBXA", "F-HBXB"].sort()
    );
    expect(roster.filter((t) => t.equipped).length).toBe(3);
    db.close();
  });

  test("hub card, subfleet rates, /fleet, type table and meta all agree", () => {
    const db = seeded();
    const roster = programmeRoster(db, "AF");
    const total = roster.length;
    const equipped = roster.filter((t) => t.equipped).length;

    expect(getHubStats(db, ["AF"])[0].fleetTotal).toBe(total);

    const pen = [...getSubfleetPenetration(db, "AF").values()];
    expect(pen.reduce((s, p) => s + p.total, 0)).toBe(total);
    expect(pen.reduce((s, p) => s + p.equipped, 0)).toBe(equipped);

    const page = getFleetPageData(db, ["AF"]);
    expect(page.totalFleet).toBe(total);
    expect(page.totalStarlink).toBe(equipped);

    const inProgramme = getTypeProgress(db, "AF").filter((t) => !t.excluded);
    expect(inProgramme.reduce((s, t) => s + t.total, 0)).toBe(total);
    expect(inProgramme.reduce((s, t) => s + t.equipped, 0)).toBe(equipped);

    refreshFleetMeta(db, "AF");
    expect(Number(getMeta(db, "totalAircraftCount", "AF"))).toBe(total);
    expect(
      Number(getMeta(db, "mainlineStarlink", "AF")) + Number(getMeta(db, "expressStarlink", "AF"))
    ).toBe(equipped);
    db.close();
  });
});
