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
  isStarlinkProvider,
  rowEvidence,
  starlinkFlag,
  tailEquippedSql,
  tailEvidence,
} from "../src/database/sql/equipped";
import { addDays, modHoldsUntil, modNoteHolds, utcToday } from "../src/utils/sheet-mod-note";
import { makeSyntheticDb } from "./helpers";

const LISTINGS = [undefined, null, "Starlink", "Viasat", "None", ""] as const;
const SETTLES = [undefined, null, "unknown", "confirmed", "negative"] as const;
// The sheet's hangar note: none, one that holds, one the sheet doubts, one lapsed.
const NOTES = ["none", "holds", "unsure", "lapsed"] as const;

function seeded() {
  const db = makeSyntheticDb();
  const cases: Array<{
    tail: string;
    listed: { verified_wifi: string | null } | null;
    fleet: { starlink_status: string | null } | null;
    inMod: boolean;
  }> = [];
  let i = 0;
  const today = utcToday();
  for (const note of NOTES) {
    for (const wifi of LISTINGS) {
      for (const status of SETTLES) {
        const tail = `N${100 + i++}EQ`;
        if (note !== "none") {
          const n = {
            tail,
            station: "MIA",
            started: addDays(today, -40),
            due_back: addDays(today, note === "lapsed" ? -10 : 10),
            unsure: note === "unsure",
          };
          db.query(
            `INSERT INTO sheet_mod_notes (airline, tail_number, station, started, due_back, unsure, holds_until, read_at)
             VALUES ('UA', ?, ?, ?, ?, ?, ?, 1)`
          ).run(tail, n.station, n.started, n.due_back, n.unsure ? 1 : 0, modHoldsUntil(n));
        }
        seedCase(tail, wifi, status, note === "holds");
      }
    }
  }
  return { db, cases };

  function seedCase(
    tail: string,
    wifi: (typeof LISTINGS)[number],
    status: (typeof SETTLES)[number],
    inMod: boolean
  ) {
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
      inMod,
    });
  }
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

  test("a listing names a provider or it doesn't: 'None' and '' are other providers", () => {
    for (const verified_wifi of ["None", ""]) {
      expect(tailEvidence({ listed: { verified_wifi }, fleet: null })).toBe("verified_other");
    }
    expect(
      tailEvidence({ listed: { verified_wifi: null }, fleet: { starlink_status: null } })
    ).toBe("listed");
  });

  test("tailEquippedSql with an airline reads only that airline's listing", () => {
    const db = makeSyntheticDb();
    const list = (airline: string, wifi: string | null) =>
      db
        .query(
          `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
           VALUES ('ERJ-175', 'Starlink', '0', '2026-01-01', 'N200XA', 'SkyWest', 'express', ?, ?)`
        )
        .run(wifi, airline);
    list("AS", "Starlink");
    list("UA", "Viasat");
    const probe = (airline?: string) =>
      (
        db
          .query(`SELECT ${airline ? tailEquippedSql("?", "?") : tailEquippedSql("?")} AS e`)
          .get(...(airline ? ["N200XA", airline] : ["N200XA"])) as { e: number }
      ).e;
    expect(probe("AS")).toBe(1);
    expect(probe("UA")).toBe(0);
    expect(probe("HA")).toBe(0);
    expect(probe()).toBe(1);
    db.close();
  });

  test("a negative settle only un-equips the listing under the same airline", () => {
    const db = makeSyntheticDb();
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
       VALUES ('ERJ-175', 'Starlink', '0', '2026-01-01', 'N201XA', 'SkyWest', 'express', 'Starlink', 'AS')`
    ).run();
    db.query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, verified_wifi, airline)
       VALUES ('N201XA', 'ERJ-175', 'fr24', 1, 1, 'express', 'negative', 'Viasat', 'UA')`
    ).run();
    const e = db.query(`SELECT ${tailEquippedSql("?", "?")} AS e`).get("N201XA", "AS") as {
      e: number;
    };
    expect(e.e).toBe(1);
    expect(
      isEquipped(
        tailEvidence({
          listed: { verified_wifi: "Starlink" },
          fleet: { starlink_status: "negative" },
        })
      )
    ).toBe(false);
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
    // A listing held by a hangar note is left out, like an unlisted tail.
    expect(rows.length).toBe(cases.filter((c) => c.listed && tailEvidence(c) !== "in_mod").length);
    expect(cases.some((c) => tailEvidence(c) === "in_mod")).toBe(true);
    for (const r of rows) {
      const c = cases.find((x) => x.tail === r.tail_number);
      expect(rowEvidence(r), r.tail_number).toBe(tailEvidence(c as (typeof cases)[number]));
    }
    for (const c of cases) {
      if (!c.listed) continue;
      const logged = db
        .query("SELECT starlink FROM flight_assignment_log WHERE tail_number = ?")
        .get(c.tail) as { starlink: number | null };
      expect(logged.starlink, c.tail).toBe(starlinkFlag(tailEvidence(c)));
    }
    db.close();
  });

  test("a hangar note holds back only a listing nobody has observed", () => {
    const listed = { verified_wifi: null };
    expect(tailEvidence({ listed, fleet: null, inMod: true })).toBe("in_mod");
    expect(isEquipped("in_mod")).toBe(false);
    expect(starlinkFlag("in_mod")).toBe(0);
    expect(tailEvidence({ listed: { verified_wifi: "Starlink" }, fleet: null, inMod: true })).toBe(
      "verified"
    );
    expect(tailEvidence({ listed: null, fleet: null, inMod: true })).toBe("unknown");
    expect(modNoteHolds({ unsure: true, holds_until: "9999-12-31" })).toBe(false);
    expect(modNoteHolds({ unsure: false, holds_until: "2000-01-01" })).toBe(false);
    expect(modNoteHolds(null)).toBe(false);
  });

  test("every equipped tail renders in a Starlink provider bucket", () => {
    const { db } = seeded();
    const page = getFleetPageData(db, ["UA"]);
    const buckets = page.allTails.filter((t) => isStarlinkProvider(t.provider));
    expect(buckets.length).toBe(page.totalStarlink);
    // The seed covers every evidence combination, so both buckets are present:
    // a square that is counted but unconfirmed must not fall back to "unknown".
    expect(buckets.some((t) => t.provider === "starlink")).toBe(true);
    expect(buckets.some((t) => t.provider === "starlink_listed")).toBe(true);
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
