// Alaska's newsroom Starlink tracker: table parsing, the fleet_progress write,
// the complete-type settle and its roster guard, and the page surfaces that
// read it. Fixture mirrors the live markup (ninja_table, 2026-10).

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SHEET_CODE_TO_FAMILY, newestOfficial } from "../src/airlines/aircraft-pages";
import {
  leadCount,
  ownCountAsOf,
  rosterDiffSentence,
  unnamedSentence,
} from "../src/airlines/published-count";
import { AIRLINES } from "../src/airlines/registry";
import { InstallPipelineSection } from "../src/components/fleet/pipeline";
import { RolloutPanel } from "../src/components/home/rollout";
import {
  programmeHeadlineWithChart,
  validateChartAgainstRoster,
} from "../src/database/airline-count";
import {
  CHART_MAX_HEADLINE_AGE_DAYS,
  CHART_MAX_STORE_AGE_DAYS,
  chartDateProblem,
  chartRosterProblem,
  isCalendarDay,
  leftOutTolerance,
  typeSizeTolerance,
  utcDay,
} from "../src/database/chart-bounds";
import { getFleetProgress } from "../src/database/database";
import { programmeHeadline, programmeRoster, tenantProgrammeRoster } from "../src/database/roster";
import { COUNTERS, metrics } from "../src/observability";
import {
  parseAlaskaTracker,
  parseNewsroomDate,
  runAlaskaTrackerSync,
  trackerProgressRows,
} from "../src/scripts/alaska-tracker";
import { buildFreshnessCoverage } from "../src/scripts/data-freshness";
import { createApp } from "../src/server/app";
import { makeSyntheticDb } from "./helpers";

// Chart and listing dates hang off the real clock, since the pages read it: a
// fixed date would walk out of the chart's age bound as the calendar moves.
const day = (offset: number) => utcDay(Date.now() + offset * 86400_000);
const chartDate = day(-30);
const NAMED_BEFORE_CHART = day(-60);
const NAMED_AFTER_CHART = day(-10);
const MONTH_NAMES = "Jan. Feb. March April May June July Aug. Sept. Oct. Nov. Dec.".split(" ");
/** "2026-09-25" → "Sept. 25, 2026", the newsroom's own style. */
const newsroom = (iso: string) =>
  `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8))}, ${iso.slice(0, 4)}`;

function trackerHtml(
  rows: Array<[string, string, string]>,
  dateLine:
    | string
    | null = `This chart was last updated on ${newsroom(chartDate)}, and is refreshed monthly. The next refresh is scheduled for ${newsroom(day(1))}.`
): string {
  const body = rows
    .map(([t, c, p], i) => `<tr data-row_id="${i}"><td>${t}</td><td>${c}</td><td>${p}</td></tr>`)
    .join("\n");
  return `<h4>Percentage of aircraft equipped with Starlink Wi-Fi: 38%</h4>
${dateLine === null ? "" : `<p style="text-align: center;">${dateLine}</p>`}
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
    // A day the calendar doesn't have is no date.
    expect(parseNewsroomDate("Feb. 31, 2026")).toBeNull();
    expect(parseNewsroomDate("Feb. 29, 2027")).toBeNull();
    expect(parseNewsroomDate("Feb. 29, 2028")).toBe("2028-02-29");
    expect(parseNewsroomDate("Sept. 0, 2026")).toBeNull();
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
  // A chart and a fleet list that agree, so the chart passes its bounds.
  const SOUND: Array<[string, string, string]> = [
    ["Embraer 175", "3", "Update complete"],
    ["Boeing 737-8 MAX", "1", "3"],
    ["Boeing 737-9 MAX", "2", "3"],
    ["Boeing 787 Dreamliner", "-", "2"],
  ];
  function soundRoster(): Database {
    const db = makeSyntheticDb();
    seedRoster(db, "Embraer E175LR", 3, "6");
    seedRoster(db, "Boeing 737 MAX 8", 4, "8");
    seedRoster(db, "Boeing 737 MAX 9", 5, "9");
    seedRoster(db, "Boeing 787-9 Dreamliner", 2, "5");
    return db;
  }
  const swap = (label: string, connected: string, pending: string) =>
    SOUND.map((r): [string, string, string] =>
      r[0].includes(label) ? [r[0], connected, pending] : r
    );
  const settledTails = (db: Database) =>
    (
      db
        .query(
          "SELECT (SELECT COUNT(*) FROM starlink_planes WHERE airline = 'AS') + (SELECT COUNT(*) FROM united_fleet WHERE airline = 'AS' AND starlink_status = 'confirmed') AS n"
        )
        .get() as { n: number }
    ).n;
  async function countingRefusals<T>(run: () => Promise<T>) {
    const stages: string[] = [];
    const original = metrics.increment;
    metrics.increment = (name, tags) => {
      if (name === COUNTERS.CHART_REJECTED) {
        expect(tags?.airline).toBe("alaska");
        stages.push(String(tags?.stage));
      }
    };
    try {
      return { result: await run(), stages };
    } finally {
      metrics.increment = original;
    }
  }

  test("stores AS rows and settles a type Alaska calls complete", async () => {
    const db = soundRoster();
    const { result, stages } = await countingRefusals(() =>
      runAlaskaTrackerSync(db, async () => trackerHtml(SOUND))
    );
    expect(result.outcome).toBe("success");
    expect(result.withheld).toBe(0);
    expect(stages).toEqual([]);
    const stored = getFleetProgress(db, "AS");
    expect(stored.length).toBe(result.rows);
    expect(stored.every((r) => r.airline === "AS" && r.fetched_at > 0)).toBe(true);
    // E175 is complete (3 roster ≤ 3 connected): every tail listed.
    expect(result.settled).toBe(3);
    expect(listedCount(db, "Embraer E175LR")).toBe(3);
    // 737-8 MAX still has pending installs: nothing named by type.
    expect(listedCount(db, "Boeing 737 MAX 8")).toBe(0);
  });

  test("refuses to settle when the roster holds more of the type than Alaska counts", async () => {
    const db = soundRoster();
    seedRoster(db, "Boeing 787-9 Dreamliner", 1, "4");
    const result = await runAlaskaTrackerSync(db, async () =>
      trackerHtml(swap("787", "2", "Update complete"))
    );
    // The chart itself is sound, so the E175s settle; only the 787s hold back.
    expect(result.withheld).toBe(0);
    expect(listedCount(db, "Embraer E175LR")).toBe(3);
    expect(listedCount(db, "Boeing 787-9 Dreamliner")).toBe(0);
  });

  const REFUSED: Array<[string, Array<[string, string, string]>, string | null | undefined]> = [
    // The look's repro: a slipped digit on one row, a false "complete" on another.
    [
      "one type's size far from the fleet list",
      swap("175", "930", "Update complete").map((r): [string, string, string] =>
        r[0].includes("9 MAX") ? [r[0], "5", "Update complete"] : r
      ),
      undefined,
    ],
    ["rows missing for types we list", SOUND.filter((r) => !r[0].includes("MAX")), undefined],
    ["no chart date", SOUND, null],
    [
      "a chart date past the headline's age bound",
      SOUND,
      `This chart was last updated on ${newsroom(day(-120))}.`,
    ],
  ];
  for (const [name, rows, dateLine] of REFUSED) {
    test(`a chart refused by its bounds settles no tail: ${name}`, async () => {
      const db = soundRoster();
      const { result, stages } = await countingRefusals(() =>
        runAlaskaTrackerSync(db, async () => trackerHtml(rows, dateLine))
      );
      expect(result.outcome).toBe("success");
      expect(validateChartAgainstRoster(db, "AS")).not.toBeNull();
      expect(result.settled).toBe(0);
      expect(result.withheld).toBeGreaterThan(0);
      expect(settledTails(db)).toBe(0);
      // Counted once as a refused chart and once as a withheld settle.
      expect(stages).toEqual(["sync", "settle"]);
    });
  }

  test("a refused chart with no complete type counts no withheld settle", async () => {
    const db = soundRoster();
    const { result, stages } = await countingRefusals(() =>
      runAlaskaTrackerSync(db, async () => trackerHtml(swap("175", "930", "5")))
    );
    expect(result.withheld).toBe(0);
    expect(stages).toEqual(["sync"]);
  });

  test("a refused chart leaves an earlier sound chart's settle as it was", async () => {
    const db = soundRoster();
    await runAlaskaTrackerSync(db, async () => trackerHtml(SOUND));
    const before = settledTails(db);
    await runAlaskaTrackerSync(db, async () => trackerHtml(swap("175", "930", "Update complete")));
    expect(settledTails(db)).toBe(before);
    // The next sound chart settles a newly complete type again.
    const next = await runAlaskaTrackerSync(db, async () =>
      trackerHtml(swap("9 MAX", "5", "Update complete"))
    );
    expect(next.settled).toBe(5);
    expect(listedCount(db, "Boeing 737 MAX 9")).toBe(5);
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

describe("Alaska's own chart beside the named tails", () => {
  // A roster shaped like the live one in miniature: a type the chart leaves
  // out (737-700), one it sizes differently (787) and one where it counts
  // aircraft nobody has named (737-9 MAX).
  const CHART: Array<[string, string, string]> = [
    ["Embraer 175", "3", "Update complete"],
    ["Boeing 737-8 MAX", "1", "3"],
    ["Boeing 737-9 MAX", "2", "3"],
    ["Boeing 787 Dreamliner", "-", "1"],
  ];

  function list(db: Database, tail: string, type: string, found: string): void {
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
       VALUES (?, 'Starlink', ?, ?, 'Alaska Airlines', 'mainline', NULL, 'AS')`
    ).run(type, found, tail);
  }

  async function seeded(namedOn: string): Promise<Database> {
    const db = makeSyntheticDb();
    seedRoster(db, "Embraer E175LR", 3, "6");
    seedRoster(db, "Boeing 737 MAX 8", 4, "8");
    seedRoster(db, "Boeing 737 MAX 9", 5, "9");
    seedRoster(db, "Boeing 737-700", 2, "7");
    seedRoster(db, "Boeing 787-9 Dreamliner", 2, "5");
    await runAlaskaTrackerSync(db, async () => trackerHtml(CHART));
    db.run("UPDATE starlink_planes SET DateFound = '2026-01-01' WHERE airline = 'AS'");
    list(db, "N800AS", "Boeing 737 MAX 8", namedOn);
    return db;
  }

  test("the chart attaches only while it counts more than the named tails, with its stored date", async () => {
    const db = await seeded(NAMED_BEFORE_CHART);
    const h = programmeHeadlineWithChart(db, "AS");
    const chart = h?.airlineCount;
    expect(chart).toBeTruthy();
    if (!h || !chart) return;
    expect(chart.connected).toBeGreaterThan(h.equipped);
    expect(chart.asOf).toBe(chartDate);
    expect(chart.url).toBe(AIRLINES.AS.officialTracker?.url ?? "");
    // The gap is by type, and the named count plus the gap is the chart's count.
    expect(chart.unnamed.map((u) => u.family)).toEqual(["B737-MAX9"]);
    expect(h.equipped + chart.unnamed.reduce((s, u) => s + u.count, 0)).toBe(chart.connected);
    // Every difference in fleet size is accounted for, family by family.
    const diff = new Map(chart.rosterDiff.map((d) => [d.family, d]));
    expect(diff.get("B737-700")?.chart).toBeNull();
    expect(diff.get("B787")?.ours).toBeGreaterThan(diff.get("B787")?.chart ?? 0);
    expect(chart.rosterDiff.reduce((s, d) => s + d.ours - (d.chart ?? 0), 0)).toBe(
      h.total - chart.total
    );

    // Named tails catch up: the chart no longer counts more, so it drops out.
    for (let i = 0; i < 5; i++)
      list(db, `N9${String(i).padStart(2, "0")}AS`, "Boeing 737 MAX 9", day(-59));
    expect(programmeHeadlineWithChart(db, "AS")?.airlineCount).toBeNull();
    expect(programmeHeadlineWithChart(db, "UA")).toBeNull();
  });

  test("a chart older than the newest named tail shows but does not lead", async () => {
    const fresh = programmeHeadlineWithChart(await seeded(NAMED_BEFORE_CHART), "AS");
    const stale = programmeHeadlineWithChart(await seeded(NAMED_AFTER_CHART), "AS");
    expect(fresh?.airlineCount?.leads).toBe(true);
    expect(stale?.airlineCount?.leads).toBe(false);
    for (const h of [fresh, stale]) {
      if (!h?.airlineCount) throw new Error("chart missing");
      const lead = leadCount({
        starlinkCount: h.equipped,
        totalCount: h.total,
        airlineCount: h.airlineCount,
      });
      expect(lead.n).toBe(h.airlineCount.leads ? h.airlineCount.connected : h.equipped);
      expect(lead.total).toBe(h.airlineCount.leads ? h.airlineCount.total : h.total);
    }
  });

  test("the panel prints both counts, each with whose it is and the chart's date", async () => {
    for (const namedOn of [NAMED_BEFORE_CHART, NAMED_AFTER_CHART]) {
      const h = programmeHeadlineWithChart(await seeded(namedOn), "AS");
      const chart = h?.airlineCount;
      if (!h || !chart) throw new Error("chart missing");
      const html = renderToStaticMarkup(
        RolloutPanel({
          stats: { starlinkCount: h.equipped, totalCount: h.total, airlineCount: chart },
          segments: [],
          airline: AIRLINES.AS,
        })
      );
      const stat = html.slice(html.indexOf('id="starlink-stat"'));
      expect(stat).toContain("Alaska&#x27;s own count");
      expect(stat).toContain(ownCountAsOf(chart));
      expect(stat).toContain(chart.url);
      expect(stat).toMatch(chart.leads ? /We can name/ : /own count<\/a> is/);
      expect(html).toContain("Named by tail:");
      expect(unnamedSentence(AIRLINES.AS, chart)).toMatch(
        /^Alaska counts \d+ 737 MAX 9s? that no source names/
      );
      expect(rosterDiffSentence(AIRLINES.AS, chart)).toMatch(
        /leaves out the \d+ 737-700s on our fleet list/
      );
    }
    // No chart, no second figure: the panel is the named count alone.
    const plain = renderToStaticMarkup(
      RolloutPanel({
        stats: { starlinkCount: 4, totalCount: 16 },
        segments: [],
        airline: AIRLINES.AS,
      })
    );
    expect(plain).not.toContain("own count");
    expect(plain).not.toContain("Named by tail:");
  });
});

describe("chart bounds", () => {
  test("a chart date is a real day, not in the future and not past its age bound", () => {
    const today = "2026-11-25";
    expect(isCalendarDay("2026-02-31")).toBe(false);
    expect(isCalendarDay("<script>")).toBe(false);
    expect(chartDateProblem("2026-10-26", today, CHART_MAX_HEADLINE_AGE_DAYS)).toBeNull();
    expect(chartDateProblem(today, today, CHART_MAX_HEADLINE_AGE_DAYS)).toBeNull();
    expect(chartDateProblem("2026-11-26", today, CHART_MAX_HEADLINE_AGE_DAYS)?.reason).toBe(
      "date_future"
    );
    expect(chartDateProblem("2099-10-26", today, CHART_MAX_STORE_AGE_DAYS)?.reason).toBe(
      "date_future"
    );
    expect(chartDateProblem("2026-02-31", today, CHART_MAX_STORE_AGE_DAYS)?.reason).toBe(
      "date_invalid"
    );
    expect(chartDateProblem("2026-06-01", today, CHART_MAX_HEADLINE_AGE_DAYS)?.reason).toBe(
      "date_old"
    );
    // A late refresh is still storable; a year-old date is a misprinted year.
    expect(chartDateProblem("2026-06-01", today, CHART_MAX_STORE_AGE_DAYS)).toBeNull();
    expect(chartDateProblem("2016-10-26", today, CHART_MAX_STORE_AGE_DAYS)?.reason).toBe(
      "date_old"
    );
  });

  // The two lists as they stood when the bounds were chosen: one 787 apart,
  // and the chart without the 737-700s.
  const LISTED = new Map(
    Object.entries({
      E175: 93,
      "B737-800": 59,
      "B737-MAX8": 20,
      "B737-900": 79,
      "B737-MAX9": 80,
      A321: 18,
      A330: 24,
      B787: 6,
      "B737-700": 11,
    }).map(([family, total]) => [family, { total }])
  );
  const charted = (over: Record<string, number | null> = {}) =>
    [...LISTED]
      .filter(([family]) => family !== "B737-700")
      .map(([family, o]) => ({ family, total: family === "B787" ? 5 : o.total }))
      .map((t) => ({ ...t, total: over[t.family] ?? t.total, connected: 0 }))
      .filter((t) => over[t.family] !== null);

  test("a chart near the fleet list passes; a slipped digit or a missing row does not", () => {
    expect(chartRosterProblem(charted(), LISTED)).toBeNull();
    // Alaska's next real chart: a few aircraft either way in a type.
    for (const [family, o] of LISTED) {
      if (family === "B737-700") continue;
      const tol = typeSizeTolerance(o.total);
      expect(chartRosterProblem(charted({ [family]: o.total + tol }), LISTED)).toBeNull();
      expect(chartRosterProblem(charted({ [family]: o.total + tol + 1 }), LISTED)?.reason).toBe(
        "type_size"
      );
    }
    // 930 for 93, and 39 for 93.
    expect(chartRosterProblem(charted({ E175: 930 }), LISTED)?.reason).toBe("type_size");
    expect(chartRosterProblem(charted({ E175: 39 }), LISTED)?.reason).toBe("type_size");
    // A type nobody lists.
    expect(
      chartRosterProblem([...charted(), { family: "B747", total: 500, connected: 500 }], LISTED)
        ?.reason
    ).toBe("type_size");
    // The 737-700s may be left out; a whole listed type of 59 may not.
    const all = [...LISTED.values()].reduce((s, o) => s + o.total, 0);
    expect(LISTED.get("B737-700")?.total).toBeLessThanOrEqual(leftOutTolerance(all));
    expect(chartRosterProblem(charted({ "B737-800": null }), LISTED)?.reason).toBe(
      "types_left_out"
    );
  });
});

describe("a hostile chart never leads", () => {
  const AS_HOST = "alaskastarlinktracker.com";
  const GOOD: Array<[string, string, string]> = [
    ["Embraer 175", "3", "Update complete"],
    ["Boeing 737-8 MAX", "1", "3"],
    ["Boeing 737-9 MAX", "2", "3"],
    ["Boeing 787 Dreamliner", "-", "1"],
  ];
  const row = (i: number, connected: string, pending?: string) =>
    GOOD.map((r, j): [string, string, string] =>
      j === i ? [r[0], connected, pending ?? r[2]] : r
    );
  const dated = (iso: string) =>
    `This chart was last updated on ${newsroom(iso)}, and is refreshed monthly.`;

  async function site(): Promise<Database> {
    const db = makeSyntheticDb();
    seedRoster(db, "Embraer E175LR", 3, "6");
    seedRoster(db, "Boeing 737 MAX 8", 4, "8");
    seedRoster(db, "Boeing 737 MAX 9", 5, "9");
    seedRoster(db, "Boeing 737-700", 2, "7");
    seedRoster(db, "Boeing 787-9 Dreamliner", 2, "5");
    await runAlaskaTrackerSync(db, async () => trackerHtml(GOOD));
    db.run("UPDATE starlink_planes SET DateFound = '2026-01-01' WHERE airline = 'AS'");
    return db;
  }

  const strip = (h: string) =>
    h
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .replace(/ (?=['.,])/g, "")
      .trim();

  async function surfaces(db: Database) {
    const app = createApp(db);
    const get = async (path: string) => {
      const r = await app.dispatch(new Request(`http://x${path}`, { headers: { Host: AS_HOST } }));
      expect(r.status).toBe(200);
      return r.text();
    };
    const [home, fleet, badge, llms] = await Promise.all(
      ["/", "/fleet", "/badge.svg", "/llms.txt"].map(get)
    );
    return {
      home,
      title: home.match(/<title>([^<]*)/)?.[1] ?? "",
      h1: strip(home.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? ""),
      description: (home.match(/name="description" content="([^"]*)/)?.[1] ?? "").replace(
        /&#x27;|&#39;/g,
        "'"
      ),
      stat: strip(home.match(/<div id="starlink-stat">[\s\S]*?<\/div>/)?.[0] ?? ""),
      cite: strip(fleet.match(/<p id="cite-this"[\s\S]*?<\/p>/)?.[0] ?? ""),
      fleetDek: strip(fleet.match(/<h1[\s\S]*?<\/h1>\s*<p[\s\S]*?<\/p>/)?.[0] ?? ""),
      badge: strip(badge),
      llms,
    };
  }

  /** The title, the H1 and the badge carry our named count, whatever the chart says. */
  function expectOursWhereNoRoom(s: Awaited<ReturnType<typeof surfaces>>, db: Database): void {
    const h = programmeHeadline(db, "AS");
    if (!h) throw new Error("no programme headline");
    const ours = `${h.equipped} of ${h.total}`;
    expect(s.title).toContain(ours);
    expect(s.h1).toContain(ours);
    expect(s.badge).toContain(ours);
  }

  /** Alaska's figure is nowhere: every headline surface is our count alone. */
  function expectChartAbsent(s: Awaited<ReturnType<typeof surfaces>>): void {
    for (const text of [s.title, s.h1, s.description, s.stat, s.cite, s.fleetDek, s.badge]) {
      expect(text).not.toContain("own count");
    }
    expect(s.llms).not.toContain("The element gives two figures");
    expect(s.home).not.toContain("alert(1)");
  }

  test("a good chart leads the panel with its owner and date; title, H1 and badge stay ours", async () => {
    const db = await site();
    const chart = programmeHeadlineWithChart(db, "AS")?.airlineCount;
    if (!chart?.leads) throw new Error("the good chart should lead");
    const s = await surfaces(db);
    expectOursWhereNoRoom(s, db);
    const theirs = `${chart.connected} of ${chart.total}`;
    const credit = `Alaska's own count ${ownCountAsOf(chart)}`;
    // Wherever Alaska's figure stands, its owner and its date stand with it.
    for (const text of [s.stat, s.description, s.fleetDek]) {
      expect(text).toContain(theirs);
      expect(text).toMatch(/Alaska's own count/);
      expect(text).toContain(ownCountAsOf(chart));
    }
    expect(s.stat).toContain(credit);
    expect(s.cite).toContain(theirs);
    expect(s.cite).toContain("Alaska's own count, as of");
    expect(s.llms).toContain(`${theirs} ${ownCountAsOf(chart)}`);
    for (const text of [s.title, s.h1, s.badge]) expect(text).not.toContain(theirs);
  });

  // [name, the page the tracker reads next, whether that read is refused outright]
  const PAGES: Array<[string, string, "refused" | "stored"]> = [
    ["a date years ahead", trackerHtml(GOOD, dated("2099-10-26")), "refused"],
    ["a date tomorrow", trackerHtml(GOOD, dated(day(1))), "refused"],
    ["a date ten years back", trackerHtml(GOOD, dated("2016-10-26")), "refused"],
    ["Feb. 31", trackerHtml(GOOD, "This chart was last updated on Feb. 31, 2026."), "stored"],
    [
      "an unreadable date",
      trackerHtml(GOOD, "This chart was last updated on Octember 45th."),
      "stored",
    ],
    ["no date line", trackerHtml(GOOD, null), "stored"],
    ["a slipped digit, 30 for 3", trackerHtml(row(0, "30"), dated(day(-2))), "stored"],
    [
      "a count past any fleet",
      trackerHtml(row(2, "99999999999999999999"), dated(day(-2))),
      "refused",
    ],
    ["a four-digit count", trackerHtml(row(2, "1000"), dated(day(-2))), "refused"],
    ["a negative count", trackerHtml(row(2, "-4"), dated(day(-2))), "refused"],
    ["a percent for a count", trackerHtml(row(2, "40%"), dated(day(-2))), "refused"],
    [
      "a row missing from the table",
      trackerHtml([GOOD[0], GOOD[2], GOOD[3]], dated(day(-2))),
      "stored",
    ],
    [
      "markup in a cell and the date",
      trackerHtml(
        row(2, "<b>2</b><script>alert(1)</script>"),
        `${dated(day(-2))}<script>alert(1)</script>`
      ),
      "refused",
    ],
    ["a row given twice", trackerHtml([...GOOD, GOOD[2]], dated(day(-2))), "stored"],
  ];

  test.each(PAGES)("%s: our count leads everywhere", async (_name, html, fate) => {
    const db = await site();
    const before = getFleetProgress(db, "AS").map((r) => ({ ...r, fetched_at: 0 }));
    const result = await runAlaskaTrackerSync(db, async () => html).catch(() => null);
    const after = getFleetProgress(db, "AS").map((r) => ({ ...r, fetched_at: 0 }));
    if (fate === "refused") {
      // The last good chart stays, and it is the one that may still lead.
      expect(result?.outcome).toBe("error");
      expect(after).toEqual(before);
      const s = await surfaces(db);
      expectOursWhereNoRoom(s, db);
      expect(s.stat).toContain(ownCountAsOf({ asOf: chartDate }));
      return;
    }
    const chart = programmeHeadlineWithChart(db, "AS")?.airlineCount ?? null;
    const s = await surfaces(db);
    expectOursWhereNoRoom(s, db);
    if (chart) {
      // Markup stripped to the count it wrapped is a readable chart: it may
      // lead only as itself, with a real date.
      expect(isCalendarDay(chart.asOf)).toBe(true);
      expect(chart.asOf <= utcDay()).toBe(true);
      expect(s.home).not.toContain("alert(1)");
    } else {
      expectChartAbsent(s);
    }
  });

  test("an unmapped type with a large count changes nothing", async () => {
    const db = await site();
    const good = programmeHeadlineWithChart(db, "AS")?.airlineCount;
    await runAlaskaTrackerSync(db, async () =>
      trackerHtml([...GOOD, ["Boeing 747 Jumbo", "500", "0"]])
    );
    const chart = programmeHeadlineWithChart(db, "AS")?.airlineCount;
    expect(chart?.connected).toBe(good?.connected ?? -1);
    expect(chart?.total).toBe(good?.total ?? -1);
    expectOursWhereNoRoom(await surfaces(db), db);
  });

  // Stored rows gone wrong after the write: the read holds the same bounds.
  const STORED: Array<[string, string[]]> = [
    [
      "a stored date that is no date",
      ["UPDATE fleet_progress SET sheet_updated = '<script>' WHERE airline = 'AS'"],
    ],
    [
      "a stored date in the future",
      ["UPDATE fleet_progress SET sheet_updated = '2099-10-26' WHERE airline = 'AS'"],
    ],
    [
      "a stored Feb. 31",
      ["UPDATE fleet_progress SET sheet_updated = '2026-02-31' WHERE airline = 'AS'"],
    ],
    [
      "a stored chart past its age bound",
      [
        `UPDATE fleet_progress SET sheet_updated = '${day(-(CHART_MAX_HEADLINE_AGE_DAYS + 1))}' WHERE airline = 'AS'`,
      ],
    ],
    [
      "a stored null count",
      [
        "UPDATE fleet_progress SET starlink_complete = NULL WHERE airline = 'AS' AND type_code = '39M'",
      ],
    ],
    [
      "a stored negative total",
      ["UPDATE fleet_progress SET total = -5 WHERE airline = 'AS' AND type_code = '789'"],
    ],
    [
      "a stored count above its total",
      [
        "UPDATE fleet_progress SET starlink_complete = total + 1 WHERE airline = 'AS' AND type_code = '39M'",
      ],
    ],
    [
      "a stored 930 for 93",
      [
        "UPDATE fleet_progress SET starlink_complete = starlink_complete * 10, total = total * 10 WHERE airline = 'AS' AND type_code = 'E175'",
      ],
    ],
    ["no stored chart", ["DELETE FROM fleet_progress WHERE airline = 'AS'"]],
  ];

  test.each(STORED)("%s: the chart leaves every headline", async (_name, sql) => {
    const db = await site();
    for (const q of sql) db.run(q);
    expect(programmeHeadlineWithChart(db, "AS")?.airlineCount).toBeNull();
    const s = await surfaces(db);
    expectOursWhereNoRoom(s, db);
    expectChartAbsent(s);
  });

  test("the fleet list moving away from a good chart takes it out of the headline", async () => {
    const db = await site();
    expect(programmeHeadlineWithChart(db, "AS")?.airlineCount).toBeTruthy();
    seedRoster(db, "Boeing 737-800", 20, "4");
    expect(programmeHeadlineWithChart(db, "AS")?.airlineCount).toBeNull();
    const s = await surfaces(db);
    expectOursWhereNoRoom(s, db);
    expectChartAbsent(s);
  });
});
