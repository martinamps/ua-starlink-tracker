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
import { addFleet, bodyOf, makeFreshDb, req } from "./helpers";

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

  // The home page, /newly-equipped and /embed link the feed whenever the log
  // has a row, datable or not, so a 404 here was a dead link on three pages.
  test("a feed with nothing it can date is a valid feed of no entries, where pages link it", async () => {
    const bare = makeFreshDb();
    bare
      .query(
        `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
         VALUES ('Boeing 737 MAX 9', 'Starlink', '4', '', 'unknown', 'N400BD', 'United Airlines', 'mainline', 'Starlink', 1, 'UA')`
      )
      .run();
    addFleet(bare, "N400BD", "confirmed", { verifiedWifi: "Starlink" });
    const only = createApp(bare);
    const log = await bodyOf(only, "/newly-equipped", UA);
    expect(log.status).toBe(200);
    expect(log.text).toContain('href="/feed.xml"');

    const res = await only.dispatch(req("/feed.xml", UA));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    const feed = await res.text();
    expect(feed).toStartWith('<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns=');
    expect(feed.trimEnd()).toEndWith("</feed>");
    expect(feed).not.toContain("<entry>");
    expect(feed).not.toContain("N400BD");
    expect(feed).not.toContain("1970");
    // Atom requires these of a feed whatever it holds.
    for (const tag of ["<title>", "<id>", "<updated>", "<author>"]) expect(feed).toContain(tag);
    const stamps = [...feed.matchAll(/<updated>([^<]*)<\/updated>/g)].map((m) => m[1]);
    expect(stamps.length).toBe(1);
    expect(stamps[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(stamps[0])).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(stamps[0])).toBeGreaterThan(Date.now() - 2 * DAY_MS);
  });

  test("an empty feed is dated by the data's own stamp when there is one", async () => {
    const bare = makeFreshDb();
    bare
      .query(
        `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
         VALUES ('Boeing 737 MAX 9', 'Starlink', '4', '', '', 'N401BD', 'United Airlines', 'mainline', 'Starlink', 1, 'UA')`
      )
      .run();
    addFleet(bare, "N401BD", "confirmed", { verifiedWifi: "Starlink" });
    const stamp = new Date(Date.now() - 3 * 3600_000).toISOString();
    bare.query("INSERT INTO meta (key, value) VALUES ('UA:lastUpdated', ?)").run(stamp);
    const { status, text } = await bodyOf(createApp(bare), "/feed.xml", UA);
    expect(status).toBe(200);
    expect(text).not.toContain("<entry>");
    expect(text).toContain(`<updated>${stamp.slice(0, 19)}Z</updated>`);
  });

  test("with no install log at all nothing links the feed, and it stays a 404", async () => {
    const none = createApp(makeFreshDb());
    expect((await bodyOf(none, "/feed.xml", UA)).status).toBe(404);
    expect((await bodyOf(none, "/newly-equipped", UA)).status).toBe(404);
    expect((await bodyOf(none, "/", UA)).text).not.toContain("/feed.xml");
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

describe("a listing dated after today", () => {
  const iso = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
  const AHEAD: Array<[string, string]> = [
    ["N501FT", iso(1)],
    ["N502FT", iso(30)],
    ["N503FT", "2099-01-01"],
    ["N504FT", "9999-12-31"],
  ];
  let ahead: Database;
  let feed: string;

  beforeAll(async () => {
    ahead = makeFreshDb();
    const add = ahead.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, verified_at, airline)
       VALUES ('Boeing 737 MAX 9', 'Starlink', '4', '', ?, ?, 'United Airlines', 'mainline', 'Starlink', 1, 'UA')`
    );
    for (const [tail, found] of [...AHEAD, ["N500TD", iso(0)], ["N499YD", iso(-1)]]) {
      add.run(found, tail);
      addFleet(ahead, tail, "confirmed", { verifiedWifi: "Starlink" });
    }
    feed = (await bodyOf(createApp(ahead), "/feed.xml", UA)).text;
  });

  test("is left out of the feed, like an undated one", () => {
    for (const [tail] of AHEAD) expect(feed).not.toContain(tail);
    expect(feed).not.toContain("2099");
    expect(feed).not.toContain("9999");
  });

  test("today's and yesterday's listings stay in", () => {
    expect(feed).toContain("N500TD");
    expect(feed).toContain("N499YD");
    expect(feed.split("<entry>").length - 1).toBe(2);
  });

  test("the feed's own stamp is its newest entry's, never a day ahead", () => {
    const stamps = [...feed.matchAll(/<updated>([^<]*)<\/updated>/g)].map((m) => m[1]);
    expect(stamps[0]).toBe(`${iso(0)}T12:00:00Z`);
    for (const stamp of stamps) expect(stamp.slice(0, 10) <= iso(0)).toBe(true);
  });

  test("it stays on the log page and in the count", async () => {
    const { text } = await bodyOf(createApp(ahead), "/newly-equipped", UA);
    for (const [tail] of AHEAD) expect(text).toContain(tail);
    expect(countStarlinkPlanes(ahead, "UA")).toBe(AHEAD.length + 2);
  });
});
