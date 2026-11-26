// Where Alaska's chart counts more of a mainline type than this site names by
// tail, the Alaska pages say both figures and why, from stored data, and stop
// saying it by themselves once the figures meet.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mainlineChartNote, typeGapSentences } from "../src/airlines/published-count";
import { AIRLINES } from "../src/airlines/registry";
import { airlineChartGaps, programmeHeadlineWithChart } from "../src/database/airline-count";
import { utcDay } from "../src/database/chart-bounds";
import { refreshFleetMeta } from "../src/database/database";
import { runAlaskaTrackerSync } from "../src/scripts/alaska-tracker";
import { createApp } from "../src/server/app";
import { makeSyntheticDb } from "./helpers";

const AS_HOST = "alaskastarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";
const day = (offset: number) => utcDay(Date.now() + offset * 86400_000);
const MONTH_NAMES = "Jan. Feb. March April May June July Aug. Sept. Oct. Nov. Dec.".split(" ");
const newsroom = (iso: string) =>
  `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8))}, ${iso.slice(0, 4)}`;

const CHART: Array<[string, string, string]> = [
  ["Embraer 175", "3", "Update complete"],
  ["Boeing 737-8 MAX", "2", "2"],
  ["Boeing 737-9 MAX", "2", "3"],
  ["Boeing 737-800", "-", "2"],
];

const chartHtml = () =>
  `<p>This chart was last updated on ${newsroom(day(-30))}, and is refreshed monthly.</p>
<table aria-label="Starlink tracker"><thead><tr><th>Aircraft type</th><th>Connected</th><th>Pending update</th></tr></thead>
<tbody>${CHART.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

function seedRoster(db: Database, type: string, n: number, prefix: string, fleet: string): void {
  const now = Math.floor(Date.now() / 1000);
  const q = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
     VALUES (?, ?, 'fr24', ?, ?, ?, 'unknown', 'AS')`
  );
  for (let i = 0; i < n; i++)
    q.run(`N${prefix}${String(i).padStart(2, "0")}AS`, type, now, now, fleet);
}

function name(db: Database, tail: string, type: string): void {
  db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
     VALUES (?, 'Starlink', ?, ?, 'Alaska Airlines', 'mainline', NULL, 'AS')`
  ).run(type, day(-60), tail);
}

/** Two MAX 8s named of the two the chart counts; no MAX 9 named of its two. */
async function seeded(): Promise<Database> {
  const db = makeSyntheticDb();
  seedRoster(db, "Embraer E175LR", 3, "6", "horizon");
  seedRoster(db, "Boeing 737 MAX 8", 4, "8", "mainline");
  seedRoster(db, "Boeing 737 MAX 9", 5, "9", "mainline");
  seedRoster(db, "Boeing 737-800", 2, "5", "mainline");
  await runAlaskaTrackerSync(db, async () => chartHtml());
  name(db, "N800AS", "Boeing 737 MAX 8");
  name(db, "N801AS", "Boeing 737 MAX 8");
  // The regional and mainline totals the fleet page's split line reads.
  refreshFleetMeta(db, "AS");
  return db;
}

const strip = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

async function page(db: Database, host: string, path: string): Promise<string> {
  const r = await createApp(db).dispatch(
    new Request(`http://x${path}`, { headers: { Host: host } })
  );
  expect(r.status).toBe(200);
  return strip(await r.text());
}

const count = (text: string, needle: string) => text.split(needle).length - 1;
const NO_TAIL = "It doesn't say which aircraft";

describe("the chart's gap, type by type", () => {
  test("only a type the chart counts more of is a gap, with the chart's own figures", async () => {
    const db = await seeded();
    const gaps = airlineChartGaps(db, "AS");
    if (!gaps) throw new Error("gaps missing");
    expect(gaps.asOf).toBe(day(-30));
    expect(gaps.types.map((t) => t.family)).toEqual(["B737-MAX9"]);
    const [max9] = gaps.types;
    expect(max9.connected).toBeGreaterThan(max9.named);
    expect(max9.total).toBe(5);
    expect(gaps.mainline?.connected).toBe(
      (gaps.mainline?.named ?? 0) + max9.connected - max9.named
    );
  });

  test("the sentence carries Alaska's name and the chart's date, and both of our cases", async () => {
    const db = await seeded();
    const none = airlineChartGaps(db, "AS");
    if (!none) throw new Error("gaps missing");
    expect(typeGapSentences(AIRLINES.AS, none)).toMatch(
      /^Alaska counts \d+ of its \d+ 737 MAX 9s with Starlink \(its chart of [A-Z][a-z]{2} \d{1,2}, \d{4}\)\. It doesn't say which aircraft, so we list none by tail yet\.$/
    );
    expect(mainlineChartNote(AIRLINES.AS, none)).toMatch(
      /^named by tail; Alaska counts \d+ as of [A-Z][a-z]{2} \d{1,2}, \d{4}$/
    );

    name(db, "N900AS", "Boeing 737 MAX 9");
    const some = airlineChartGaps(db, "AS");
    if (!some) throw new Error("gaps missing");
    expect(typeGapSentences(AIRLINES.AS, some)).toMatch(
      /It doesn't say which aircraft, and we list \d+ by tail\.$/
    );

    // Two types behind, one of them with nothing named.
    db.run("DELETE FROM starlink_planes WHERE TailNumber = 'N801AS'");
    db.run("DELETE FROM starlink_planes WHERE TailNumber = 'N900AS'");
    const two = airlineChartGaps(db, "AS");
    if (!two) throw new Error("gaps missing");
    expect(typeGapSentences(AIRLINES.AS, two)).toMatch(
      /^Alaska counts \d+ of its \d+ 737 MAX 8s and \d+ of its \d+ 737 MAX 9s with Starlink \(its chart of [^)]+\)\. It doesn't say which aircraft, and by tail we list \d+ of the 737 MAX 8s and none of the 737 MAX 9s\.$/
    );
  });

  test("the gap goes by itself once the named tails meet the chart", async () => {
    const db = await seeded();
    name(db, "N900AS", "Boeing 737 MAX 9");
    name(db, "N901AS", "Boeing 737 MAX 9");
    expect(airlineChartGaps(db, "AS")).toBeNull();
    expect(await page(db, AS_HOST, "/fleet")).not.toContain(NO_TAIL);
  });

  test("a type's gap shows even while the fleet totals don't favour the chart", async () => {
    const db = await seeded();
    name(db, "N802AS", "Boeing 737 MAX 8");
    name(db, "N803AS", "Boeing 737 MAX 8");
    const h = programmeHeadlineWithChart(db, "AS");
    expect(h?.airlineCount).toBeNull();
    expect(h?.chartGaps?.types.map((t) => t.family)).toEqual(["B737-MAX9"]);
    // Mainline as a whole is level, so only the type is said.
    expect(h?.chartGaps?.mainline).toBeNull();
  });

  test("an airline with no chart has no gap", () => {
    expect(airlineChartGaps(makeSyntheticDb(), "UA")).toBeNull();
    expect(airlineChartGaps(makeSyntheticDb(), "AS")).toBeNull();
  });
});

describe("the pages say it once, and keep our own count in the heading", () => {
  test("/fleet says both figures under the heading, once", async () => {
    const db = await seeded();
    const gaps = airlineChartGaps(db, "AS");
    if (!gaps) throw new Error("gaps missing");
    const fleet = await page(db, AS_HOST, "/fleet");
    expect(count(fleet, typeGapSentences(AIRLINES.AS, gaps) ?? "missing")).toBe(1);
    expect(count(fleet, mainlineChartNote(AIRLINES.AS, gaps) ?? "missing")).toBe(1);
  });

  test("the home page gives the chart's mainline figure with its date, once", async () => {
    const db = await seeded();
    const home = await page(db, AS_HOST, "/");
    expect(home).toMatch(
      /Alaska's own chart counts \d+ mainline jets as of [A-Z][a-z]{2} \d{1,2}, \d{4} and doesn't say which\./
    );
    expect(count(home, "Alaska's own chart counts")).toBe(1);
    // The hero panel names the type; the answer below no longer repeats it.
    expect(count(home, "that no source names by tail yet")).toBe(1);
  });

  test("a type page says why fewer squares are lit than Alaska counts", async () => {
    const db = await seeded();
    const max9 = await page(db, AS_HOST, "/fleet/737-max-9");
    expect(max9).toContain(
      "Alaska doesn't say which aircraft it counts, so we list none by tail yet."
    );
    // A fresh database: the app keeps a rendered page for a while.
    const some = await seeded();
    name(some, "N900AS", "Boeing 737 MAX 9");
    expect(await page(some, AS_HOST, "/fleet/737-max-9")).toMatch(
      /Alaska doesn't say which aircraft it counts, so we list only \d+ by tail\./
    );
    // Level with the chart: the older note stands.
    expect(await page(db, AS_HOST, "/fleet/737-max-8")).not.toContain("which aircraft it counts");
  });

  test("the hub no longer says Alaska's own jets are checked against alaskaair.com", async () => {
    const hub = await page(await seeded(), HUB_HOST, "/airlines/alaska");
    expect(hub).not.toContain("checked one aircraft at a time against alaskaair.com");
    expect(hub).not.toContain("Checked plane by plane against alaskaair.com");
    expect(hub).toContain("alaskaair.com shows which aircraft flies a flight, not its Wi-Fi");
  });
});
