// Alaska's newsroom Starlink tracker: table parsing, the fleet_progress write,
// the complete-type settle and its roster guard, and the page surfaces that
// read it. Fixture mirrors the live markup (ninja_table, 2026-10).

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SHEET_CODE_TO_FAMILY, newestOfficial } from "../src/airlines/aircraft-pages";
import { InstallPipelineSection } from "../src/components/fleet/pipeline";
import { getFleetProgress } from "../src/database/database";
import { programmeHeadline, programmeRoster, tenantProgrammeRoster } from "../src/database/roster";
import {
  parseAlaskaTracker,
  parseNewsroomDate,
  runAlaskaTrackerSync,
  trackerProgressRows,
} from "../src/scripts/alaska-tracker";
import { buildFreshnessCoverage } from "../src/scripts/data-freshness";
import { makeSyntheticDb } from "./helpers";

function trackerHtml(rows: Array<[string, string, string]>): string {
  const body = rows
    .map(([t, c, p], i) => `<tr data-row_id="${i}"><td>${t}</td><td>${c}</td><td>${p}</td></tr>`)
    .join("\n");
  return `<h4>Percentage of aircraft equipped with Starlink Wi-Fi: 38%</h4>
<p style="text-align: center;">This chart was last updated on Sept. 25, 2026, and is refreshed monthly. The next refresh is scheduled for Oct. 26, 2026.</p>
<table class="unrelated"><tr><td>nav</td></tr></table>
<table data-footable_id="103542" aria-label="Starlink tracker" class="foo-table ninja_footable">
<thead><tr class="footable-header"><th scope="col">Aircraft type</th><th scope="col">Connected</th><th scope="col">Pending update</th></tr></thead>
<tbody>${body}</tbody><!--ninja_tobody_rendering_done--></table>`;
}

const LIVE_ROWS: Array<[string, string, string]> = [
  ["Embraer 175", "93", "Update complete"],
  ["Boeing 737-800", "-", "59"],
  ["Boeing 737-8 MAX", "12", "8"],
  ["Boeing 737-900 ER", "-", "79"],
  ["Boeing 737-9 MAX", "-", "80"],
  ["Airbus A321-200neo", "18", "Update complete"],
  ["Airbus A330", "24", "Update complete"],
  ["Boeing 787 Dreamliner", "-", "5"],
];

function seedRoster(db: Database, type: string, n: number, prefix: string): void {
  const now = Math.floor(Date.now() / 1000);
  const q = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
     VALUES (?, ?, 'fr24', ?, ?, 'mainline', 'unknown', 'AS')`
  );
  for (let i = 0; i < n; i++) q.run(`N${prefix}${String(i).padStart(2, "0")}AS`, type, now, now);
}

function listedCount(db: Database, type: string): number {
  return (
    db
      .query("SELECT COUNT(*) AS n FROM starlink_planes WHERE airline = 'AS' AND aircraft = ?")
      .get(type) as { n: number }
  ).n;
}

describe("parseAlaskaTracker", () => {
  test("reads every row as a family with integer counts and an ISO chart date", () => {
    const parsed = parseAlaskaTracker(trackerHtml(LIVE_ROWS));
    expect(parsed.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.rows.length).toBe(LIVE_ROWS.length);
    for (const r of parsed.rows) {
      expect(typeof r.family).toBe("string");
      expect(Number.isInteger(r.connected) && r.connected >= 0).toBe(true);
      expect(Number.isInteger(r.pending) && r.pending >= 0).toBe(true);
    }
    // "-" connected and "Update complete" pending are both zero, not parse failures.
    const b738 = parsed.rows.find((r) => r.family === "B737-800");
    expect(b738?.connected).toBe(0);
    expect(parsed.rows.find((r) => r.family === "E175")?.pending).toBe(0);
  });

  test("throws rather than half-read a changed table", () => {
    expect(() => parseAlaskaTracker("<p>no table here</p>")).toThrow();
    expect(() => parseAlaskaTracker(trackerHtml([["Boeing 737-8 MAX", "twelve", "8"]]))).toThrow();
    const noHeaders = trackerHtml(LIVE_ROWS).replace(/Connected/g, "Live");
    expect(() => parseAlaskaTracker(noHeaders)).toThrow();
  });

  test("newsroom dates parse in both abbreviated and long forms", () => {
    expect(parseNewsroomDate("Sept. 25, 2026")).toBe("2026-09-25");
    expect(parseNewsroomDate("October 1, 2026")).toBe("2026-10-01");
    expect(parseNewsroomDate("soon")).toBeNull();
  });
});

describe("trackerProgressRows", () => {
  test("maps every chart row to a type code and rolls each segment into a Totals row", () => {
    const rows = trackerProgressRows(parseAlaskaTracker(trackerHtml(LIVE_ROWS)));
    const types = rows.filter((r) => r.type_code !== "Totals");
    expect(types.length).toBeGreaterThan(0);
    for (const seg of new Set(types.map((r) => r.segment))) {
      const segTypes = types.filter((r) => r.segment === seg);
      const total = rows.find((r) => r.segment === seg && r.type_code === "Totals");
      expect(total?.total).toBe(segTypes.reduce((s, r) => s + (r.total ?? 0), 0));
      expect(total?.starlink_complete).toBe(
        segTypes.reduce((s, r) => s + (r.starlink_complete ?? 0), 0)
      );
    }
    // Hawaiian's Airbus rows are on Alaska's chart; they stay, in their own segment.
    const partner = rows.filter((r) => r.segment === "partner" && r.type_code !== "Totals");
    expect(partner.length).toBeGreaterThan(0);
    for (const r of partner) expect(SHEET_CODE_TO_FAMILY[r.type_code]).toMatch(/^A3/);
  });
});

describe("runAlaskaTrackerSync", () => {
  test("stores AS rows and settles a type Alaska calls complete", async () => {
    const db = makeSyntheticDb();
    seedRoster(db, "Embraer E175LR", 3, "6");
    seedRoster(db, "Boeing 737 MAX 8", 4, "9");
    const result = await runAlaskaTrackerSync(db, async () => trackerHtml(LIVE_ROWS));
    expect(result.outcome).toBe("success");
    const stored = getFleetProgress(db, "AS");
    expect(stored.length).toBe(result.rows);
    expect(stored.every((r) => r.airline === "AS" && r.fetched_at > 0)).toBe(true);
    // E175 is complete (3 roster ≤ 93 connected): every tail listed.
    expect(listedCount(db, "Embraer E175LR")).toBe(3);
    // 737-8 MAX still has pending installs: nothing named by type.
    expect(listedCount(db, "Boeing 737 MAX 8")).toBe(0);
  });

  test("refuses to settle when the roster holds more of the type than Alaska counts", async () => {
    const db = makeSyntheticDb();
    seedRoster(db, "Boeing 787-9 Dreamliner", 6, "7");
    const rows = LIVE_ROWS.map((r): [string, string, string] =>
      r[0].includes("787") ? [r[0], "5", "Update complete"] : r
    );
    await runAlaskaTrackerSync(db, async () => trackerHtml(rows));
    expect(listedCount(db, "Boeing 787-9 Dreamliner")).toBe(0);
  });

  test("a failed fetch keeps the last stored chart", async () => {
    const db = makeSyntheticDb();
    await runAlaskaTrackerSync(db, async () => trackerHtml(LIVE_ROWS));
    const before = getFleetProgress(db, "AS");
    const result = await runAlaskaTrackerSync(db, async () => {
      throw new Error("HTTP 503");
    });
    expect(result.outcome).toBe("error");
    expect(getFleetProgress(db, "AS")).toEqual(before);
  });
});

describe("tracker surfaces", () => {
  test("the freshness gauge covers AS fleet_progress", () => {
    expect(buildFreshnessCoverage().fleet_progress).toContain("AS");
  });

  test("the later-dated official count wins, the tracker on a tie", () => {
    const fact = { count: 12, all: false, asOf: "2026-09-25", sourceLabel: "f", url: "u" };
    const live = { ...fact, sourceLabel: "t" };
    expect(newestOfficial(fact, null)).toBe(fact);
    expect(newestOfficial(null, live)).toBe(live);
    expect(newestOfficial(fact, live)).toBe(live);
    expect(newestOfficial({ ...fact, asOf: "2026-10-01" }, live).asOf).toBe("2026-10-01");
  });

  test("the fleet page attributes AS rows to Alaska's tracker, not the community sheet", async () => {
    const db = makeSyntheticDb();
    await runAlaskaTrackerSync(db, async () => trackerHtml(LIVE_ROWS));
    const html = renderToStaticMarkup(
      InstallPipelineSection({ progress: getFleetProgress(db, "AS"), tails: [], movements: [] }) ??
        ""
    );
    expect(html).toContain("news.alaskaair.com");
    expect(html).not.toContain("community progress sheet");
  });
});

describe("programme headline", () => {
  function seedHa(db: Database, type: string, n: number, prefix: string): void {
    const now = Math.floor(Date.now() / 1000);
    const q = db.query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
       VALUES (?, ?, 'ha_seed', ?, ?, 'mainline', 'confirmed', 'HA')`
    );
    for (let i = 0; i < n; i++) q.run(`N${prefix}${i}HA`, type, now, now);
  }

  test("Alaska's headline adds Hawaiian's Airbus jets, never its 717s; per-airline rosters stay single-operator", () => {
    const db = makeSyntheticDb();
    seedRoster(db, "Embraer E175LR", 3, "6");
    seedRoster(db, "Boeing 737 MAX 8", 4, "9");
    seedHa(db, "Airbus A321-271N", 2, "21");
    seedHa(db, "Airbus A330-243", 2, "33");
    seedHa(db, "Boeing 717-22A", 2, "71");
    const h = programmeHeadline(db, "AS");
    const own = programmeRoster(db, "AS").length;
    const partnerTails = tenantProgrammeRoster(db, "AS").filter((t) => t.airline === "HA");
    expect(h).not.toBeNull();
    expect(h?.total).toBe(own + partnerTails.length);
    expect(partnerTails.length).toBeGreaterThan(0);
    expect(partnerTails.every((t) => t.family === "A321" || t.family === "A330")).toBe(true);
    expect(h?.partners.reduce((s, p) => s + p.total, 0)).toBe(partnerTails.length);
    expect(typeof h?.noun).toBe("string");
    expect(programmeRoster(db, "AS").every((t) => t.airline === "AS")).toBe(true);
    expect(programmeHeadline(db, "UA")).toBeNull();
  });
});
