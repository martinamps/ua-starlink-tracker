/**
 * The per-leg estimate's decay math and the board's history data, on
 * synthetic draws: a leg that changed metal must read its new mix, not the
 * window's average, and the history must describe exactly the draws behind it.
 */

import { describe, expect, test } from "bun:test";
import { legHistory } from "../src/api/route-flights";
import { oddsCellHtml } from "../src/components/odds-history";
import {
  LEG_MIN_DRAWS,
  LEG_WEIGHTING,
  type LegDraw,
  drawWeight,
  legEstimate,
  legTrend,
} from "../src/scripts/leg-estimate";

const DAY = 86400;
const NOW = Date.parse("2026-10-05T12:00:00Z") / 1000;
const SHARE: Record<string, number> = { "757": 0, A321neo: 1 };
const share = (f: string) => SHARE[f];

const draw = (daysAgo: number, starlink: boolean): LegDraw => ({
  t: NOW - daysAgo * DAY,
  tail: starlink ? "N14511" : "N78866",
  equipped: starlink,
  family: starlink ? "A321neo" : "757",
  type: starlink ? "Airbus A321-271NX" : "Boeing 757-33N",
  source: "adsb",
});

/** One departure a day: `oldDays` at the old rate, then `newDays` at the new one. */
function regime(oldDays: number, oldStarlink: boolean, newDays: number, newStarlink: boolean) {
  const draws: LegDraw[] = [];
  for (let d = oldDays + newDays - 1; d >= newDays; d--) draws.push(draw(d, oldStarlink));
  for (let d = newDays - 1; d >= 0; d--) draws.push(draw(d, newStarlink));
  return draws;
}

const EQUAL = { ...LEG_WEIGHTING, halfLifeDays: null, windowDays: 60 };

describe("legEstimate", () => {
  test("0% for six weeks then 100% for two reads high, where equal weights read low", () => {
    const draws = regime(42, false, 14, true);
    const decayed = legEstimate(draws, share, NOW).probability ?? 0;
    const flat = legEstimate(draws, share, NOW, EQUAL).probability ?? 1;
    expect(decayed).toBeGreaterThan(0.7);
    expect(flat).toBeLessThan(0.3);
  });

  test("the mirror case reads low", () => {
    const draws = regime(42, true, 14, false);
    expect(legEstimate(draws, share, NOW).probability ?? 1).toBeLessThan(0.3);
  });

  test("a steady leg reads its rate whatever the weighting", () => {
    const draws = Array.from({ length: 56 }, (_, i) => draw(i, i % 2 === 0)).reverse();
    const decayed = legEstimate(draws, share, NOW).probability ?? 0;
    const flat = legEstimate(draws, share, NOW, EQUAL).probability ?? 0;
    expect(decayed).toBeGreaterThan(0.35);
    expect(decayed).toBeLessThan(0.65);
    expect(Math.abs(decayed - flat)).toBeLessThan(0.1);
  });

  test("a draw one half-life old weighs half a fresh one", () => {
    expect(drawWeight(0, LEG_WEIGHTING)).toBe(1);
    expect(drawWeight((LEG_WEIGHTING.halfLifeDays ?? 0) * DAY, LEG_WEIGHTING)).toBeCloseTo(0.5, 9);
    expect(drawWeight(30 * DAY, EQUAL)).toBe(1);
  });

  test("the effective count sits below the raw count once draws age", () => {
    const est = legEstimate(regime(42, false, 14, true), share, NOW);
    expect(est.count).toBe(56);
    expect(est.effective).toBeGreaterThan(0);
    expect(est.effective).toBeLessThan(est.count);
    const flat = legEstimate(regime(42, false, 14, true), share, NOW, EQUAL);
    expect(flat.effective).toBeCloseTo(flat.count, 9);
  });

  test("too few draws answer with the type share; none known, with nothing", () => {
    const few = [draw(1, true), draw(2, false)].slice(0, LEG_MIN_DRAWS - 1);
    const est = legEstimate(few, share, NOW);
    expect(est.enough).toBe(false);
    expect(est.probability).toBeGreaterThan(0);
    expect(est.probability).toBeLessThan(1);
    expect(legEstimate(few, () => undefined, NOW).probability).toBeNull();
  });

  test("draws outside the window or after now are ignored", () => {
    const old = Array.from({ length: 10 }, (_, i) => draw(LEG_WEIGHTING.windowDays + 1 + i, true));
    expect(legEstimate(old, share, NOW).count).toBe(0);
    expect(legEstimate([draw(-1, true)], share, NOW).count).toBe(0);
  });
});

describe("legTrend", () => {
  test("flags the regime change in the direction it moved", () => {
    expect(legTrend(regime(42, false, 14, true), NOW)).toBe("up");
    expect(legTrend(regime(42, true, 14, false), NOW)).toBe("down");
  });

  test("stays quiet on a steady leg and on too few recent draws", () => {
    const steady = Array.from({ length: 56 }, (_, i) => draw(i, i % 2 === 0)).reverse();
    expect(legTrend(steady, NOW)).toBeNull();
    const thin = [...regime(42, false, 0, true), draw(1, true), draw(2, true)];
    expect(legTrend(thin, NOW)).toBeNull();
  });
});

describe("legHistory", () => {
  const draws = regime(42, false, 14, true);
  const h = legHistory(draws, "America/Los_Angeles", NOW);

  test("eight seven-day spans, oldest first, counting only the draws inside them", () => {
    expect(h.weeks.length).toBe(8);
    for (const [i, w] of h.weeks.entries()) {
      expect(Object.keys(w).sort()).toEqual(["flights", "starlink", "start"]);
      expect(w.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(w.starlink).toBeLessThanOrEqual(w.flights);
      if (i > 0) {
        const gap = Date.parse(w.start) - Date.parse(h.weeks[i - 1].start);
        expect(gap / 1000 / DAY).toBe(7);
      }
    }
    expect(h.weeks.reduce((n, w) => n + w.flights, 0)).toBe(56);
    expect(h.weeks.at(-1)).toMatchObject({ flights: 7, starlink: 7 });
    expect(h.weeks[0]).toMatchObject({ starlink: 0 });
  });

  test("the latest six departures, newest first, with display types", () => {
    expect(h.recent.length).toBe(6);
    for (const f of h.recent) {
      expect(Object.keys(f).sort()).toEqual(["date", "starlink", "tail", "type"]);
      expect(f.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.type).toBe("A321neo");
      expect(f.starlink).toBe(true);
    }
    const dates = h.recent.map((f) => f.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  test("the trend's two sides are plain counts", () => {
    expect(h.last_14_days).toEqual({ flights: 14, starlink: 14 });
    expect(h.window).toEqual({ flights: 56, starlink: 14 });
  });

  test("the odds cell wires its card through aria-describedby", () => {
    const row = {
      flight_number: "UA2278",
      probability: 0.75,
      n_observations: 56,
      n_effective: 12.4,
      trend: "up" as const,
      history: h,
      basis: "flight_history" as const,
      enough_history: true,
      odds_label: "75%",
      assignment: null,
    };
    const html = oddsCellHtml(row as unknown as Parameters<typeof oddsCellHtml>[0]);
    expect(html).toContain('aria-describedby="odds-history-UA2278"');
    expect(html).toContain('id="odds-history-UA2278" role="tooltip" hidden');
    expect(html.match(/<rect class="oh-(track|none)"/g)?.length).toBe(8);
    expect(html).toContain("56 flights, weighted to recent");
    expect(html).toContain("over 8 weeks");
    expect(html).toContain("↑");
    expect(html).toContain("Weighted toward recent flights.");
  });
});
