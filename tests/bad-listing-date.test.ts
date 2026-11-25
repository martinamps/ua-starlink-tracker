/**
 * One listing whose DateFound is not a calendar day must not take a page down.
 *
 * Every page that charts or paces installs reads one daily series. A date like
 * "unknown" in it threw in the chart's month arithmetic (/timeline and
 * /install-rate answered 500), and an empty one, sorting first, became the
 * series' opening month and took the home page, /fleet and the sitemap with
 * it. The row stays counted; it is only left out of the series.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { countStarlinkPlanes, getDailyInstalls } from "../src/database/database";
import { createApp } from "../src/server/app";
import { computeInstallRate } from "../src/utils/install-rate";
import { addFleet, bodyOf, makeFreshDb } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const DAY_MS = 86_400_000;
const NOT_DAYS = ["unknown", "", "11/19/2026", "2026-13-45", "2026-02-30"];

let db: Database;
let app: ReturnType<typeof createApp>;
let listed = 0;

function list(tail: string, found: string) {
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
     VALUES ('Boeing 737 MAX 9', 'Starlink', '4', '', ?, ?, 'United Airlines', 'mainline', 'Starlink', 1, 'UA')`
  ).run(found, tail);
  addFleet(db, tail, "confirmed", { verifiedWifi: "Starlink" });
  listed++;
}

beforeAll(() => {
  db = makeFreshDb();
  // Four months of ordinary finds, so the pace and the chart have a series.
  for (let i = 0; i < 12; i++) {
    list(`N${100 + i}GD`, new Date(Date.now() - (5 + i * 10) * DAY_MS).toISOString().slice(0, 10));
  }
  NOT_DAYS.forEach((found, i) => list(`N${200 + i}BD`, found));
  // A sheet listing our check contradicts (the feed's "reported" kind), undated.
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
     VALUES ('Boeing 737 MAX 9', 'Starlink', '4', '', 'unknown', 'N300RP', 'United Airlines', 'mainline', 'Viasat', ?, 'UA')`
  ).run(Math.floor(Date.now() / 1000) - 3600);
  app = createApp(db);
});

describe("a listing dated with something that is not a day", () => {
  test("is counted, and left out of the daily series", () => {
    expect(countStarlinkPlanes(db, "UA")).toBe(listed);
    const days = getDailyInstalls(db, "UA");
    expect(days.length).toBeGreaterThan(0);
    for (const d of days) expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(days.reduce((sum, d) => sum + d.installs, 0)).toBe(listed - NOT_DAYS.length);
  });

  test.each([
    [UA, "/timeline"],
    [UA, "/install-rate"],
    [HUB, "/install-rate"],
    [UA, "/"],
    [UA, "/fleet"],
    [UA, "/newly-equipped"],
    [UA, "/sitemap.xml"],
    [HUB, "/"],
  ])("%s%s answers", async (host, path) => {
    const { status, text } = await bodyOf(app, path, host);
    expect(status).toBe(200);
    expect(text).not.toContain("Invalid Date");
    expect(text).not.toContain("NaN");
    if (path === "/install-rate") expect(text).toContain('id="install-rate-stat-ua"');
    if (path === "/timeline") expect(text).toMatch(/<h1[\s>]/);
  });

  // Feed readers showed the epoch as a 55-year-old item, or sorted it first;
  // "2026-13-45" went out raw as an <updated> no reader can parse.
  test.each([UA, HUB])(
    "%s/feed.xml dates every entry with a real day, and itself",
    async (host) => {
      const { status, text } = await bodyOf(app, "/feed.xml", host);
      expect(status).toBe(200);
      expect(text).not.toContain("1970");
      for (let i = 0; i < NOT_DAYS.length; i++) expect(text).not.toContain(`N${200 + i}BD`);
      expect(text).not.toContain("N300RP");
      const stamps = [...text.matchAll(/<updated>([^<]*)<\/updated>/g)].map((m) => m[1]);
      const entries = text.split("<entry>").length - 1;
      expect(entries).toBeGreaterThan(0);
      // One per entry plus the feed's own: Atom requires each.
      expect(stamps.length).toBe(entries + 1);
      for (const stamp of stamps) {
        expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00Z$/);
        expect(new Date(stamp).toISOString()).toBe(stamp.replace("Z", ".000Z"));
      }
      // The feed's own stamp is its newest entry's.
      expect(stamps[0]).toBe([...stamps].sort().at(-1) as string);
    }
  );

  test("the undated listings stay on the log page the feed links to", async () => {
    const { text } = await bodyOf(app, "/newly-equipped", UA);
    expect(text).toContain("N200BD");
  });

  test("a feed with nothing it can date is a 404, not an empty or 1970 document", async () => {
    const bare = makeFreshDb();
    bare
      .query(
        `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
         VALUES ('Boeing 737 MAX 9', 'Starlink', '4', '', 'unknown', 'N400BD', 'United Airlines', 'mainline', 'Starlink', 1, 'UA')`
      )
      .run();
    addFleet(bare, "N400BD", "confirmed", { verifiedWifi: "Starlink" });
    const only = createApp(bare);
    expect((await bodyOf(only, "/newly-equipped", UA)).status).toBe(200);
    const feed = await bodyOf(only, "/feed.xml", UA);
    expect(feed.status).toBe(404);
    expect(feed.text).not.toContain("1970");
  });

  test("the pace math skips such a day whoever hands it one", () => {
    const stats = computeInstallRate({
      daily: [
        { day: "", installs: 1 },
        { day: "unknown", installs: 1 },
        { day: null as unknown as string, installs: 1 },
        { day: "2026-08-03", installs: 2 },
        { day: "2026-09-10", installs: 3 },
      ],
      equipped: 8,
      total: 100,
      targets: [],
      nowMs: Date.parse("2026-11-23T00:00:00Z"),
    });
    expect(stats.days.map((d) => d.day)).toEqual(["2026-08-03", "2026-09-10"]);
    expect(stats.months[0].month).toBe("2026-08");
    for (const m of stats.months) expect(m.month).toMatch(/^\d{4}-\d{2}$/);
  });
});
