/**
 * Install Rate Index math: pace and projection under a fixed clock, and the
 * honest-abstention rules (no projection from thin or near-zero series).
 * Page-level coverage (flags, tenancy) rides tenant-matrix + distribution.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { airlinesWithTargetEntry, rolloutTargets } from "../src/airlines/targets";
import {
  chartDescription,
  chartModel,
  cumulativeSeries,
  measuredPaceText,
  nearestPaceGap,
  paceWindowSpan,
  requiredMonthlyPace,
} from "../src/components/charts/rollout-math";
import { createApp } from "../src/server/app";
import {
  type DailyInstalls,
  type MonthlyInstalls,
  computeInstallRate,
  excludeMassWriteDays,
  zeroFillMonths,
} from "../src/utils/install-rate";
import { addFleet, bodyOf, makeSyntheticDb, openSnapshot } from "./helpers";

const NOW = Date.parse("2026-06-15T00:00:00Z");

const months = (...pairs: Array<[string, number]>): MonthlyInstalls[] =>
  pairs.map(([month, installs]) => ({ month, installs }));

/** Spread a month's installs over distinct days, a handful each. The mass-write
 * guard exists to catch one-date dumps, so pace fixtures have to look like a
 * rollout rather than an import. */
function daysIn(month: string, installs: number, perDay = 4): DailyInstalls[] {
  const out: DailyInstalls[] = [];
  let left = installs;
  for (let day = 1; left > 0 && day <= 28; day++) {
    const n = Math.min(perDay, left);
    out.push({ day: `${month}-${String(day).padStart(2, "0")}`, installs: n });
    left -= n;
  }
  return out;
}

const daily = (...pairs: Array<[string, number]>): DailyInstalls[] =>
  pairs.flatMap(([month, installs]) => daysIn(month, installs));

const TARGET = {
  label: "1,000 aircraft",
  deadline: "2026-12-31",
  count: 1000,
  statedOn: "2026-01-01",
  source: { title: "src", url: "https://example.com" },
};

describe("zeroFillMonths", () => {
  test("fills gaps through the current month", () => {
    const filled = zeroFillMonths(months(["2026-01", 3], ["2026-04", 2]), NOW);
    expect(filled.map((m) => m.month)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
    expect(filled.map((m) => m.installs)).toEqual([3, 0, 0, 2, 0, 0]);
  });

  test("empty in, empty out", () => {
    expect(zeroFillMonths([], NOW)).toEqual([]);
  });
});

describe("computeInstallRate", () => {
  test("pace averages the last three complete months, current month excluded", () => {
    const stats = computeInstallRate({
      daily: daily(["2026-03", 30], ["2026-04", 24], ["2026-05", 30], ["2026-06", 99]),
      equipped: 500,
      total: 1400,
      targets: [TARGET],
      nowMs: NOW,
    });
    expect(stats.paceMonthly).toBe(28); // (30+24+30)/3 — the June 99 never counts
  });

  test("on-track projection lands before the deadline", () => {
    const stats = computeInstallRate({
      daily: daily(["2026-03", 100], ["2026-04", 100], ["2026-05", 100]),
      equipped: 800,
      total: 1400,
      targets: [TARGET],
      nowMs: NOW,
    });
    const [p] = stats.projections;
    expect(p.verdict).toBe("on_track");
    expect(p.projectedMonth).toBe("2026-08"); // 200 remaining / 100 per month
  });

  test("behind verdict when the straight line overshoots the deadline", () => {
    const stats = computeInstallRate({
      daily: daily(["2026-03", 10], ["2026-04", 10], ["2026-05", 10]),
      equipped: 500,
      total: 1400,
      targets: [TARGET],
      nowMs: NOW,
    });
    expect(stats.projections[0].verdict).toBe("behind");
  });

  test("reached targets never project", () => {
    const stats = computeInstallRate({
      daily: daily(["2026-04", 5], ["2026-05", 5]),
      equipped: 1000,
      total: 1400,
      targets: [TARGET],
      nowMs: NOW,
    });
    expect(stats.projections[0].verdict).toBe("reached");
    expect(stats.projections[0].projectedMonth).toBeNull();
  });

  test("abstains with under two complete months of history", () => {
    // One complete month (May, with June current) is an anecdote, not a rate.
    for (const thin of [daily(["2026-05", 40]), daily(["2026-06", 40])]) {
      const stats = computeInstallRate({
        daily: thin,
        equipped: 500,
        total: 1400,
        targets: [TARGET],
        nowMs: NOW,
      });
      expect(stats.paceMonthly).toBeNull();
      expect(stats.projections[0].verdict).toBe("no_data");
    }
  });

  test("abstains at a near-zero pace instead of projecting decades out", () => {
    const stats = computeInstallRate({
      daily: daily(["2026-01", 1], ["2026-02", 0], ["2026-03", 0], ["2026-04", 0], ["2026-05", 0]),
      equipped: 500,
      total: 1400,
      targets: [TARGET],
      nowMs: NOW,
    });
    expect(stats.projections[0].verdict).toBe("no_data");
    expect(stats.projections[0].projectedMonth).toBeNull();
  });

  test("fractional targets resolve against the tracked total", () => {
    const stats = computeInstallRate({
      daily: daily(["2026-03", 50], ["2026-04", 50], ["2026-05", 50]),
      equipped: 300,
      total: 700,
      targets: [
        {
          label: "half the fleet",
          deadline: "2026-12-31",
          fractionOfTracked: 0.5,
          source: TARGET.source,
        },
      ],
      nowMs: NOW,
    });
    expect(stats.projections[0].targetCount).toBe(350);
    expect(stats.projections[0].verdict).toBe("on_track");
  });

  test("a fraction target spanning tenants measures BOTH halves over the same roster", () => {
    // The AS shape on production numbers: AS 99/350, HA 42/61. Alaska stated a
    // share of the merged Alaska+Hawaiian fleet, so the denominator is both
    // readers' totals — and so is the numerator. Threading only the denominator
    // through published "206 aircraft · 107 to go" against a real gap of 65.
    const stats = computeInstallRate({
      daily: daily(["2026-03", 20], ["2026-04", 20], ["2026-05", 20]),
      equipped: 99,
      total: 350,
      targets: [
        {
          label: "half the combined fleet",
          deadline: "2026-12-31",
          fractionOfTracked: 0.5,
          fractionSpans: ["AS", "HA"],
          statedOn: "2026-01-01",
          source: TARGET.source,
        },
      ],
      scopeFor: (t) =>
        t.fractionSpans
          ? { equipped: 141, total: 411, label: "Alaska and Hawaiian" }
          : { equipped: 99, total: 350, label: null },
      nowMs: NOW,
    });
    const [p] = stats.projections;
    expect(p.targetCount).toBe(206); // ceil(0.5 * 411), not 175
    expect(p.derivedFrom).toBe(411);
    // The invariant: remaining is target minus the SAME roster's equipped.
    expect(p.scope).toEqual({ equipped: 141, total: 411, label: "Alaska and Hawaiian" });
    expect(p.remaining).toBe(65);
    expect(p.targetCount - p.scope.equipped).toBe(p.remaining);
  });

  test("a fraction over the airline's own fleet figure resolves against that figure", () => {
    // Alaska's "1/3 of fleet (134 aircraft) ... 50% by YE" is half of ~402,
    // 717s included; half of our 389 would be a target Alaska never set.
    const stats = computeInstallRate({
      daily: daily(["2026-03", 20], ["2026-04", 20], ["2026-05", 20]),
      equipped: 105,
      total: 347,
      targets: [
        {
          label: "half the combined fleet",
          deadline: "2026-12-31",
          fractionOfTracked: 0.5,
          fractionSpans: ["AS", "HA"],
          statedFleet: { count: 402, basis: "1/3 = 134" },
          statedOn: "2026-01-01",
          source: TARGET.source,
        },
      ],
      scopeFor: () => ({ equipped: 147, total: 389, label: "Alaska and Hawaiian" }),
      nowMs: NOW,
    });
    const [p] = stats.projections;
    expect(p.targetCount).toBe(201);
    expect(p.derivedFrom).toBe(402);
    expect(p.derivedFromStated).toBe(true);
    expect(p.remaining).toBe(54);
  });

  test("every stated fraction names its own fleet figure when it has one", () => {
    const half = rolloutTargets("AS").find((t) => t.fractionOfTracked === 0.5);
    expect(half?.statedFleet?.count).toBe(402);
  });

  test("an impossible roster projects nothing instead of a confident verdict", () => {
    // equipped is a live row count, total a separately scraped meta value;
    // nothing ties them to one snapshot. A fixture with 102 installs against a
    // roster of 6 rendered "Reached — already there" and 1700%.
    const stats = computeInstallRate({
      daily: daily(["2026-03", 20], ["2026-04", 20], ["2026-05", 20]),
      equipped: 102,
      total: 6,
      targets: [{ ...TARGET, count: undefined, fractionOfTracked: 1 }],
      nowMs: NOW,
    });
    expect(stats.rosterDisagrees).toBe(true);
    const [p] = stats.projections;
    expect(p.rosterDisagrees).toBe(true);
    expect(p.verdict).toBe("no_data");
    expect(p.projectedMonth).toBeNull();
  });

  test("a consistent roster is untouched by the impossible-pair guard", () => {
    const stats = computeInstallRate({
      daily: daily(["2026-03", 20], ["2026-04", 20], ["2026-05", 20]),
      equipped: 6,
      total: 6,
      targets: [{ ...TARGET, count: undefined, fractionOfTracked: 1 }],
      nowMs: NOW,
    });
    expect(stats.rosterDisagrees).toBe(false);
    expect(stats.projections[0].verdict).toBe("reached");
  });

  test("a derived count is flagged; a stated count is not", () => {
    const stats = computeInstallRate({
      daily: daily(["2026-03", 20], ["2026-04", 20], ["2026-05", 20]),
      equipped: 100,
      total: 700,
      targets: [
        TARGET,
        { ...TARGET, count: undefined, fractionOfTracked: 1, label: "entire fleet" },
      ],
      nowMs: NOW,
    });
    const [stated, derived] = stats.projections;
    // A count the airline published may be attributed to it; one we computed
    // off our own roster may not.
    expect(stated.derived).toBe(false);
    expect(stated.derivedFrom).toBeNull();
    expect(derived.derived).toBe(true);
    expect(derived.derivedFrom).toBe(700);
  });
});

describe("excludeMassWriteDays", () => {
  test("a one-date import is dropped while the busiest real day survives", () => {
    // The live UA shape: ~200 days of 1-3, a handful up to 16, and a single
    // sheet-tab import of 121 on 2025-12-03 that INSTALL_FILTER cannot see
    // (numeric gid '13' looks nothing like a seed).
    const series: DailyInstalls[] = [];
    for (let i = 1; i <= 20; i++)
      series.push({ day: `2025-11-${String(i).padStart(2, "0")}`, installs: (i % 3) + 1 });
    series.push({ day: "2025-12-02", installs: 16 });
    series.push({ day: "2025-12-03", installs: 121 });

    const { kept, excluded } = excludeMassWriteDays(series);
    expect(excluded.map((d) => d.day)).toEqual(["2025-12-03"]);
    expect(kept.some((d) => d.day === "2025-12-02" && d.installs === 16)).toBe(true);
    expect(kept.length).toBe(series.length - 1);
  });

  test("a tenant whose only history is one bulk write keeps nothing", () => {
    // AS/HA today: were their seed gids ever to stop self-labelling, a single
    // 90-tail date must not become the whole install rate. The day under test
    // is excluded from its own threshold, so it cannot vouch for itself.
    const { kept, excluded } = excludeMassWriteDays([{ day: "2026-04-21", installs: 90 }]);
    expect(kept).toEqual([]);
    expect(excluded).toHaveLength(1);
  });

  test("a sustained high rate is a rollout, not an import", () => {
    // Threshold scales with the busy end of normal, so an airline genuinely
    // installing 30 a day never trips the guard.
    const series = Array.from({ length: 12 }, (_, i) => ({
      day: `2026-05-${String(i + 1).padStart(2, "0")}`,
      installs: 30,
    }));
    expect(excludeMassWriteDays(series).excluded).toEqual([]);
  });

  test("an import never inflates the pace or the chart", () => {
    const organic = daily(["2026-03", 12], ["2026-04", 12], ["2026-05", 12]);
    const withImport = [...organic, { day: "2026-04-20", installs: 118 }];
    const opts = { equipped: 100, total: 1400, targets: [TARGET], nowMs: NOW };
    const clean = computeInstallRate({ ...opts, daily: organic });
    const dirty = computeInstallRate({ ...opts, daily: withImport });

    expect(dirty.paceMonthly).toBe(clean.paceMonthly);
    expect(dirty.months).toEqual(clean.months);
    // …and the page is told, so the footnote's promise is checkable.
    expect(dirty.excludedDays).toEqual([{ day: "2026-04-20", installs: 118 }]);
    expect(clean.excludedDays).toEqual([]);
  });

  test("empty in, empty out", () => {
    expect(excludeMassWriteDays([])).toEqual({ kept: [], excluded: [] });
  });
});

describe("rollout chart math", () => {
  const stats = computeInstallRate({
    daily: [
      ...daily(["2026-03", 30], ["2026-04", 24], ["2026-05", 30]),
      { day: "2026-04-10", installs: 200 },
    ],
    equipped: 400,
    total: 1400,
    targets: [TARGET],
    nowMs: NOW,
  });

  test("the cumulative line ends on the live equipped count, import drawn apart", () => {
    const series = cumulativeSeries(stats);
    expect(series?.now[1]).toBe(400);
    expect(series?.imports.map((i) => i.installs)).toEqual([200]);
    expect(series?.actual.length).toBe(2);
  });

  test("needed pace is what is left over the months left, not a constant", () => {
    const [p] = stats.projections;
    const needed = requiredMonthlyPace(p, NOW);
    expect(needed).not.toBeNull();
    expect(needed as number).toBeGreaterThan(p.remaining / 7);
    expect(needed as number).toBeLessThan(p.remaining / 6);
    expect(nearestPaceGap(stats)?.actual).toBe(stats.paceMonthly as number);
    expect(requiredMonthlyPace(p, Date.parse("2027-01-15T00:00:00Z"))).toBeNull();
  });
});

describe("a month of our own making is said as the measured pace carried forward", () => {
  const stats = computeInstallRate({
    daily: daily(["2026-03", 30], ["2026-04", 24], ["2026-05", 30]),
    equipped: 400,
    total: 1400,
    targets: [TARGET],
    nowMs: NOW,
  });

  test("the pace is named with the months it was measured over", () => {
    expect(paceWindowSpan(stats)).not.toBe("");
    expect(measuredPaceText(stats)).toBe(
      `the ${paceWindowSpan(stats)} pace of about ${Math.round(stats.paceMonthly as number)} a month`
    );
  });

  test("the chart's spoken summary states its months under that condition", () => {
    const model = chartModel(stats);
    if (!model) throw new Error("no chart model: nothing is tested");
    const said = chartDescription(model, "Example Air");
    expect(stats.projections[0].projectedMonth).not.toBeNull();
    expect(said).toContain(`If ${measuredPaceText(stats)} holds:`);
    expect(said).not.toContain("At the current pace");
    expect(said.indexOf("reached around")).toBeGreaterThan(said.indexOf(" holds:"));
  });

  test("with no pace there is no pace sentence and no month", () => {
    const thin = computeInstallRate({
      daily: daily(["2026-05", 30]),
      equipped: 30,
      total: 1400,
      targets: [TARGET],
      nowMs: NOW,
    });
    expect(measuredPaceText(thin)).toBeNull();
    const model = chartModel(thin);
    if (model) expect(chartDescription(model, "Example Air")).not.toContain("reached around");
  });
});

describe("rolloutTargets config", () => {
  test("every source is a real https URL and every deadline parses", () => {
    for (const code of ["UA", "HA", "AS", "QR"]) {
      for (const t of rolloutTargets(code)) {
        expect(t.source.url).toMatch(/^https:\/\//);
        expect(Number.isNaN(Date.parse(t.deadline))).toBe(false);
        expect(t.count !== undefined || t.fractionOfTracked !== undefined).toBe(true);
      }
    }
  });

  test("every target says when the airline stated it, on or before its deadline", () => {
    // Without a stated-on date a reader cannot tell current guidance from a
    // two-year-old statement; the page reads every target as equally fresh.
    for (const code of airlinesWithTargetEntry()) {
      for (const t of rolloutTargets(code)) {
        expect(t.statedOn, `${code}/${t.label} has no statedOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(t.statedOn < t.deadline, `${code}/${t.label} stated after its own deadline`).toBe(
          true
        );
      }
    }
  });

  test("no two targets of one airline lean on the same source link", () => {
    // Two claims behind one generic link is indistinguishable from one claim
    // with no source: neither can be checked against the other.
    for (const code of airlinesWithTargetEntry()) {
      const urls = rolloutTargets(code).map((t) => t.source.url);
      expect(new Set(urls).size, `${code} reuses a source URL across targets`).toBe(urls.length);
    }
  });

  test("every registered airline has a decided entry", () => {
    // The real fail-closed invariant, asserted here rather than thrown on every
    // page render: rolloutTargets() runs from the footer nav of every tenant,
    // so throwing there would 500 the whole site over one missing config row.
    const decided = new Set(airlinesWithTargetEntry());
    for (const code of Object.keys(AIRLINES)) {
      expect(decided.has(code), `${code} has no ROLLOUT_TARGETS entry`).toBe(true);
    }
  });

  test("an unknown airline degrades to no targets instead of throwing", () => {
    expect(rolloutTargets("WN")).toEqual([]);
  });

  test("every fractionSpans code is a registered airline", () => {
    // A typo here would silently drop a carrier from the denominator and
    // publish a smaller target under the airline's own byline.
    for (const code of Object.keys(AIRLINES)) {
      for (const t of rolloutTargets(code)) {
        for (const span of t.fractionSpans ?? []) {
          expect(AIRLINES[span], `${code} target spans unknown airline ${span}`).toBeDefined();
        }
      }
    }
  });
});

describe("/install-rate page", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp(openSnapshot());
  });

  test("UA page carries the dated quotable sentence and a sourced target", async () => {
    const { status, text } = await bodyOf(app, "/install-rate", SITES.united.canonicalHost);
    expect(status).toBe(200);
    expect(text).toContain('id="install-rate-stat-ua"');
    expect(text).toContain("As of");
    // SSR interleaves <!-- --> markers, so match the date term alone.
    expect(text).toMatch(/[A-Z][a-z]+ \d{1,2}, \d{4}/);
    for (const t of rolloutTargets("UA")) {
      expect(text).toContain(t.source.url);
    }
  });

  test("hub page covers every public airline", async () => {
    const { status, text } = await bodyOf(app, "/install-rate", SITES.airline.canonicalHost);
    expect(status).toBe(200);
    for (const code of ["ua", "ha", "as"]) {
      expect(text).toContain(`id="install-rate-stat-${code}"`);
    }
  });

  test("a count we derived is labelled as ours, not the airline's", async () => {
    // UA's "Entire fleet" target has no stated count — it resolves off our own
    // roster, so the page must not present the number as United's figure.
    expect(rolloutTargets("UA").some((t) => t.count === undefined)).toBe(true);
    const { text } = await bodyOf(app, "/install-rate", SITES.united.canonicalHost);
    expect(text).toContain("Fleet size is our count, not United&#x27;s.");
  });
});

describe("/install-rate with a running pace", () => {
  const UA = SITES.united.canonicalHost;
  let page: string;
  let fleet: string;
  let rows: string[];

  // 40 dated installs in each of the last six full months, on a fleet of 1,000.
  beforeAll(async () => {
    const db = makeSyntheticDb();
    const now = new Date();
    const listing = db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
       VALUES ('Boeing 737-900', 'StrLnk', '5', 'mainline', ?, ?, 'United Airlines', 'mainline', 'Starlink', 'UA')`
    );
    let n = 0;
    for (let back = 6; back >= 1; back--) {
      for (let i = 0; i < 40; i++) {
        const day = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1 + (i % 27))
        );
        const tail = `N${10000 + n++}`;
        listing.run(day.toISOString().slice(0, 10), tail);
        addFleet(db, tail, "confirmed", { verifiedWifi: "Starlink" });
      }
    }
    for (let i = n; i < 1000; i++)
      addFleet(db, `N${50000 + i}`, "negative", { verifiedWifi: "Viasat" });
    const meta = db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    for (const key of ["totalAircraftCount", "mainlineTotal", "combinedTotal"]) {
      meta.run(`UA:${key}`, "1000");
    }
    meta.run("UA:expressTotal", "0");
    meta.run("UA:lastUpdated", now.toISOString());
    const app = createApp(db);
    const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
    page = text((await bodyOf(app, "/install-rate", UA)).text);
    fleet = text((await bodyOf(app, "/fleet", UA)).text);
    rows = [...page.matchAll(/<p class="mt-1 text-sm text-secondary">(Due [^<]*)<\/p>/g)].map(
      (m) => m[1]
    );
    db.close();
  });

  test("the fixture has open targets with a month of ours beside them", () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => /reached in [A-Z][a-z]{2} \d{4}/.test(r))).toBe(true);
  });

  test("each month of ours carries the pace and the months it was measured over", () => {
    // "Due <date> · N to go" is the airline's date and our count; anything
    // after that is ours to qualify.
    for (const ours of rows.flatMap((r) => r.split(" · ").slice(2))) {
      expect(ours).toMatch(
        /^(reached in [A-Z][a-z]{2} \d{4} if|more than four years out at) the [A-Z][a-z]{2}.*\d{4} pace of about [\d,]+ a month( holds)?$/
      );
    }
    expect(page).not.toContain("at current pace");
    expect(page).not.toContain("At the current pace");
  });

  test("the page says the month is no forecast, and an airline's own date stays credited", () => {
    expect(page).toContain("that pace carried forward unchanged, not a forecast");
    for (const t of rolloutTargets("UA")) expect(page).toContain(t.source.url);
    expect(rows.every((r) => r.startsWith("Due "))).toBe(true);
  });

  test("the fleet page's link promises no more than the page gives", () => {
    const link = fleet.match(/<a href="\/install-rate" class="text-accent[^>]*>([^<]*)<\/a>/)?.[1];
    expect(link).toBeDefined();
    expect(link).toContain("against stated targets");
    expect(link).not.toMatch(/project|finish|forecast/i);
  });
});
