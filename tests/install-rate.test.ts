/**
 * Install Rate Index math: pace and projection under a fixed clock, and the
 * honest-abstention rules (no projection from thin or near-zero series).
 * Page-level coverage (flags, tenancy) rides tenant-matrix + distribution.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { rolloutTargets } from "../src/airlines/targets";
import { createApp } from "../src/server/app";
import {
  type MonthlyInstalls,
  computeInstallRate,
  zeroFillMonths,
} from "../src/utils/install-rate";
import { bodyOf, openSnapshot } from "./helpers";

const NOW = Date.parse("2026-06-15T00:00:00Z");

const months = (...pairs: Array<[string, number]>): MonthlyInstalls[] =>
  pairs.map(([month, installs]) => ({ month, installs }));

const TARGET = {
  label: "1,000 aircraft",
  deadline: "2026-12-31",
  count: 1000,
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
      monthly: months(["2026-03", 30], ["2026-04", 24], ["2026-05", 30], ["2026-06", 99]),
      equipped: 500,
      total: 1400,
      targets: [TARGET],
      nowMs: NOW,
    });
    expect(stats.paceMonthly).toBe(28); // (30+24+30)/3 — the June 99 never counts
  });

  test("on-track projection lands before the deadline", () => {
    const stats = computeInstallRate({
      monthly: months(["2026-03", 100], ["2026-04", 100], ["2026-05", 100]),
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
      monthly: months(["2026-03", 10], ["2026-04", 10], ["2026-05", 10]),
      equipped: 500,
      total: 1400,
      targets: [TARGET],
      nowMs: NOW,
    });
    expect(stats.projections[0].verdict).toBe("behind");
  });

  test("reached targets never project", () => {
    const stats = computeInstallRate({
      monthly: months(["2026-04", 5], ["2026-05", 5]),
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
    for (const thin of [months(["2026-05", 40]), months(["2026-06", 40])]) {
      const stats = computeInstallRate({
        monthly: thin,
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
      monthly: months(
        ["2026-01", 1],
        ["2026-02", 0],
        ["2026-03", 0],
        ["2026-04", 0],
        ["2026-05", 0]
      ),
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
      monthly: months(["2026-03", 50], ["2026-04", 50], ["2026-05", 50]),
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

  test("unknown airlines fail closed", () => {
    expect(() => rolloutTargets("WN")).toThrow();
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
});
