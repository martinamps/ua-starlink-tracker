/**
 * One definition of "equipped": the SQL predicate and its JS twin must agree
 * on every evidence combination, and every surface that counts Starlink tails
 * must count the same set.
 */

import { describe, expect, test } from "bun:test";
import {
  countStarlinkPlanes,
  getFleetPageData,
  getFlightAssignments,
  getHubStats,
  updateFlights,
} from "../src/database/database";
import {
  equippedSql,
  isEquipped,
  rowEvidence,
  starlinkFlag,
  tailEquippedSql,
  tailEvidence,
} from "../src/database/sql/equipped";
import { makeSyntheticDb } from "./helpers";

const LISTINGS = [undefined, null, "Starlink", "Viasat"] as const;
const SETTLES = [undefined, "unknown", "confirmed", "negative"] as const;

function seeded() {
  const db = makeSyntheticDb();
  const cases: Array<{
    tail: string;
    listed: { verified_wifi: string | null } | null;
    fleet: { starlink_status: string } | null;
  }> = [];
  let i = 0;
  for (const wifi of LISTINGS) {
    for (const status of SETTLES) {
      const tail = `N${100 + i++}EQ`;
      if (wifi !== undefined) {
        db.query(
          `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
           VALUES ('Boeing 737-800', 'Starlink', '0', '2026-01-01', ?, 'United Airlines', 'mainline', ?, 'UA')`
        ).run(tail, wifi);
      }
      if (status !== undefined) {
        db.query(
          `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, verified_wifi, airline)
           VALUES (?, 'Boeing 737-800', 'fr24', 1, 1, 'mainline', ?, ?, 'UA')`
        ).run(
          tail,
          status,
          status === "confirmed" ? "Starlink" : status === "negative" ? "Viasat" : null
        );
      }
      cases.push({
        tail,
        listed: wifi === undefined ? null : { verified_wifi: wifi },
        fleet: status === undefined ? null : { starlink_status: status },
      });
    }
  }
  return { db, cases };
}

describe("equipped: SQL predicate and JS twin", () => {
  test("agree on every listing × settle combination", () => {
    const { db, cases } = seeded();
    const sqlEquipped = new Set(
      (
        db
          .query(`SELECT TailNumber AS t FROM starlink_planes sp WHERE ${equippedSql("sp")}`)
          .all() as { t: string }[]
      ).map((r) => r.t)
    );
    for (const c of cases) {
      expect(sqlEquipped.has(c.tail), c.tail).toBe(isEquipped(tailEvidence(c)));
      const probe = db.query(`SELECT ${tailEquippedSql("?")} AS e`).get(c.tail) as { e: number };
      expect(probe.e === 1, c.tail).toBe(isEquipped(tailEvidence(c)));
    }
    db.close();
  });

  test("a negative settle outranks any listing; an unlisted confirm is not equipped", () => {
    expect(
      tailEvidence({
        listed: { verified_wifi: "Starlink" },
        fleet: { starlink_status: "negative" },
      })
    ).toBe("settled_negative");
    expect(tailEvidence({ listed: null, fleet: { starlink_status: "confirmed" } })).toBe(
      "fleet_confirmed"
    );
    expect(isEquipped("fleet_confirmed")).toBe(false);
    expect(starlinkFlag("fleet_confirmed")).toBe(1);
    expect(starlinkFlag("unknown")).toBeNull();
  });

  test("check-flight rows classify with the same ranking", () => {
    const { db, cases } = seeded();
    const now = Math.floor(Date.now() / 1000);
    for (const c of cases) {
      if (!c.listed) continue;
      updateFlights(db, c.tail, [
        {
          flight_number: `UA${c.tail.slice(1, 4)}`,
          departure_airport: "SFO",
          arrival_airport: "ORD",
          departure_time: now + 3600,
          arrival_time: now + 7200,
        },
      ]);
    }
    const rows = getFlightAssignments(
      db,
      cases.map((c) => `UA${c.tail.slice(1, 4)}`),
      now,
      now + 86400,
      "UA"
    );
    expect(rows.length).toBe(cases.filter((c) => c.listed).length);
    for (const r of rows) {
      const c = cases.find((x) => x.tail === r.tail_number);
      expect(rowEvidence(r), r.tail_number).toBe(tailEvidence(c as (typeof cases)[number]));
      const logged = db
        .query("SELECT starlink FROM flight_assignment_log WHERE tail_number = ?")
        .get(r.tail_number) as { starlink: number | null };
      expect(logged.starlink, r.tail_number).toBe(starlinkFlag(rowEvidence(r)));
    }
    db.close();
  });

  test("headline, hub card and /fleet count the same tails", () => {
    const { db, cases } = seeded();
    const onRoster = cases.filter((c) => c.fleet && isEquipped(tailEvidence(c))).length;
    const headline = countStarlinkPlanes(db, "UA");
    expect(headline).toBe(cases.filter((c) => isEquipped(tailEvidence(c))).length);
    const page = getFleetPageData(db, ["UA"]);
    expect(page.totalStarlink).toBe(onRoster);
    expect(page.families.reduce((s, f) => s + f.starlink, 0)).toBe(page.totalStarlink);
    expect(getHubStats(db, ["UA"])[0].starlink).toBe(headline);
    db.close();
  });
});
