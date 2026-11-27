/**
 * The hub's home list past its 100-row cap. Under the cap the list never said
 * how many rows it held; past it, it printed "100 of N" and "The 100 most
 * recently flown of N" with N the aircraft counted on this site plus a by-type
 * airline's fleet-list sum, added. Every earlier stand-in was under the cap,
 * so this one is seeded past it.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BY_TYPE_METHOD, trackingMethod } from "../src/airlines/published-count";
import { SITES, publicAirlines } from "../src/airlines/registry";
import { reconcileTypeDeterministicFleets } from "../src/database/database";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, bodyOf, elementAttrs, makeFreshDb } from "./helpers";

const HUB = SITES.airline.canonicalHost;
const hubAirlines = publicAirlines();
const byType = hubAirlines.filter((a) => trackingMethod(a) === "type");
const counted = hubAirlines.filter((a) => trackingMethod(a) !== "type");
const NOW = Math.floor(Date.now() / 1000);

/** Each counted airline alone passes the cap's share, so the list is capped
 * whatever the hub lists; sizes differ so no two figures can be confused. */
const equippedOf = (i: number) => 70 + 9 * i;
/** Hawaiian's Airbus types, the ones its type rule marks. */
const BY_TYPE_FLEET = [
  ["Airbus A330-243", 24],
  ["Airbus A321-271N", 18],
] as const;

function seed(byTypeWithFlights: number): Database {
  const db = makeFreshDb();
  counted.forEach((cfg, n) => {
    for (let i = 0; i < equippedOf(n) + 5; i++) {
      const tail = `N${100 + i}${cfg.code}`;
      const on = i < equippedOf(n);
      addFleet(db, tail, on ? "confirmed" : "negative", {
        airline: cfg.code,
        verifiedWifi: on ? "Starlink" : "None",
      });
      if (!on) continue;
      addPlane(db, tail, "Starlink", { airline: cfg.code });
      addFlight(db, tail, `${cfg.iata}${1000 + i}`, "ORD", NOW + 7200, {
        airline: cfg.code,
        lastUpdated: NOW - i * 60 - n,
      });
    }
  });
  for (const cfg of byType) {
    let n = 0;
    for (const [type, count] of BY_TYPE_FLEET) {
      for (let i = 0; i < count; i++) {
        const tail = `N${300 + n}${cfg.code}`;
        db.query(
          `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, first_seen_source, first_seen_at, last_seen_at, starlink_status, airline)
           VALUES (?, ?, 'mainline', 'test', 1, 1, 'confirmed', ?)`
        ).run(tail, type, cfg.code);
        db.query(
          `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, TailNumber, OperatedBy, fleet, airline)
           VALUES (?, 'StrLnk', 'type_deterministic', 'type_deterministic', ?, ?, 'mainline', ?)`
        ).run(type, tail, cfg.name, cfg.code);
        // The freshest rows of all, so these rank inside the cap.
        if (n < byTypeWithFlights) {
          addFlight(db, tail, `${cfg.iata}${10 + n}`, "HNL", NOW + 7200, {
            airline: cfg.code,
            lastUpdated: NOW + 60,
          });
        }
        n++;
      }
    }
  }
  reconcileTypeDeterministicFleets(db);
  return db;
}

const BY_TYPE_SUM = BY_TYPE_FLEET.reduce((s, [, n]) => s + n, 0);
const COUNTED_SUM = counted.reduce((s, _, n) => s + equippedOf(n), 0);
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const element = (html: string, id: string) =>
  html.match(new RegExp(`<([a-z]+)[^>]*\\sid="${id}"[^>]*>[\\s\\S]*?</\\1>`))?.[0] ?? "";

describe("the hub's home list, past its cap", () => {
  const dbs: Database[] = [];
  let some = "";
  let none = "";

  beforeAll(async () => {
    for (const withFlights of [7, 0]) {
      const db = seed(withFlights);
      dbs.push(db);
      const html = (await bodyOf(createApp(db), "/", HUB)).text;
      if (withFlights) some = html;
      else none = html;
    }
  });
  afterAll(() => {
    for (const db of dbs) db.close();
  });

  const rowsOf = (html: string) =>
    [...html.matchAll(/class="js-aircraft-row [^>]*data-airline="([A-Z0-9]+)"/g)].map((m) => m[1]);

  test("the stand-in is past the cap and holds both kinds", () => {
    expect(byType.length).toBe(1);
    expect(counted.length).toBeGreaterThan(0);
    for (const html of [some, none]) {
      expect(rowsOf(html).length).toBeGreaterThan(0);
      expect(rowsOf(html).length).toBeLessThan(COUNTED_SUM + BY_TYPE_SUM);
    }
    const shown = rowsOf(some).filter((code) => code === byType[0].code).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(BY_TYPE_SUM);
    expect(rowsOf(none)).not.toContain(byType[0].code);
  });

  test("nothing on the page divides by, or counts to, the two kinds added", () => {
    const mixed = COUNTED_SUM + BY_TYPE_SUM;
    for (const html of [some, none]) {
      const page = html.replace(/<!-- -->/g, "");
      expect(page).not.toMatch(new RegExp(`(?<![\\d,.])\\d+ of (?:the )?${mixed}(?!\\d)`));
      expect(page).not.toMatch(new RegExp(`flown of ${mixed}(?!\\d)`));
      expect(elementAttrs(html, "search-count")["data-default"]).toBe(
        `${rowsOf(html).length} shown`
      );
      expect(text(element(html, "search-count"))).toBe(`${rowsOf(html).length} shown`);
      expect(text(element(html, "filter-all"))).toBe("ALL");
    }
  });

  test("the note under the list gives each kind against its own whole", () => {
    for (const html of [some, none]) {
      const rows = rowsOf(html);
      const shownByType = rows.filter((code) => code === byType[0].code).length;
      const names = counted.map((a) => a.shortName);
      const namesSaid =
        names.length > 2
          ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
          : names.join(" and ");
      expect(text(element(html, "list-cap"))).toBe(
        `The ${rows.length} most recently flown: ${rows.length - shownByType} of the ${COUNTED_SUM} ${namesSaid} aircraft counted on this site, and ${shownByType || "none"} of ${byType[0].shortName}'s ${BY_TYPE_SUM} on our fleet list, ${BY_TYPE_METHOD}. Search covers only these. See all →`
      );
    }
  });

  test("each tab counts all of its airline's aircraft, not the rows shown", () => {
    for (const html of [some, none]) {
      expect(text(element(html, `filter-${byType[0].code}`))).toBe(
        `${byType[0].name.toUpperCase()} (${BY_TYPE_SUM} by type)`
      );
      counted.forEach((cfg, n) => {
        expect(text(element(html, `filter-${cfg.code}`))).toBe(
          `${cfg.name.toUpperCase()} (${equippedOf(n)})`
        );
      });
    }
  });

  test("the link under the list sits in a paragraph, where the stylesheet underlines it", () => {
    expect(element(some, "list-cap").replace(/<!-- -->/g, "")).toMatch(
      /^<p [^>]*>[\s\S]*<a href="\/fleet" class="text-accent">See all\u00a0→<\/a><\/p>$/
    );
  });
});
