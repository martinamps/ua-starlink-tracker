/**
 * One flight, one answer on a planner card. A leg on an assigned verified
 * plane reads "Yes", and so does a card whose every leg does; the time line
 * under the headline once printed the ranking's own share (95%, the swap
 * allowance) beside that Yes, which reads as a second answer. It now reads
 * from the legs as shown: no percent when every leg says Yes, and a Yes leg
 * counts all its hours on a mixed card. Ranking is untouched.
 */

import { describe, expect, test } from "bun:test";
import { renderResults } from "../src/client/route-planner";
import { probLabel } from "../src/components/ui/format";

type LegIn = { route: string; fn: string; p: number; h: number; confirmed?: boolean };

const leg = ({ route, fn, p, h, confirmed }: LegIn) => ({
  route,
  flight_number: fn,
  probability: p,
  confidence: "high",
  n_observations: 12,
  duration_hours: h,
  ...(confirmed ? { confirmed: true } : {}),
});

function itinerary(legs: LegIn[]) {
  const total = legs.reduce((s, l) => s + l.h, 0);
  const expected = legs.reduce((s, l) => s + l.p * l.h, 0);
  return {
    legs: legs.map(leg),
    via: legs.slice(1).map((l) => l.route.split("-")[0]),
    coverage: "full" as const,
    joint_probability: legs.reduce((p, l) => p * l.p, 1),
    at_least_one_probability: 1 - legs.reduce((p, l) => p * (1 - l.p), 1),
    total_flight_hours: total,
    expected_starlink_hours: expected,
  };
}

function card(legs: LegIn[]): string {
  const out = { innerHTML: "" };
  renderResults(out, { itineraries: [itinerary(legs)] }, false);
  return out.innerHTML;
}

/** The line right under the headline. */
const timeLine = (html: string) =>
  html.match(/<div class="text-xs text-muted mb-3">([^<]*)<\/div>/)?.[1] ?? "";

/** Every percent the card prints, in reading order. */
const percents = (html: string) => html.match(/\d+%/g) ?? [];

describe("planner card: one answer per flight", () => {
  test("a nonstop on a verified plane prints Yes and no percent", () => {
    const html = card([{ route: "DEN-ORD", fn: "UA4421", p: 0.95, h: 2.0, confirmed: true }]);
    expect(html).toContain(">Yes <span");
    expect(timeLine(html)).toBe("~2.0h flying, all on Starlink planes");
    expect(percents(html)).toEqual([]);
  });

  test("a connection whose every leg says Yes prints no percent either", () => {
    const html = card([
      { route: "SFO-DEN", fn: "UA488", p: 0.95, h: 2.5, confirmed: true },
      { route: "DEN-ORD", fn: "UA4421", p: 0.9, h: 2.4, confirmed: true },
    ]);
    expect(html).toContain(">Yes <span");
    expect(timeLine(html)).toBe("~4.9h flying, all on Starlink planes");
    expect(percents(html)).toEqual([]);
  });

  test("a mixed card counts its Yes leg whole, and agrees with its headline", () => {
    const html = card([
      { route: "SFO-DEN", fn: "UA488", p: 0.95, h: 2.0, confirmed: true },
      { route: "DEN-ORD", fn: "UA1234", p: 0.5, h: 2.0 },
    ]);
    // 2.0h × 1 + 2.0h × 0.5 of 4.0h: the legs as shown, not the ranking's 0.95.
    expect(timeLine(html)).toBe("~3.0h of ~4.0h flying expected on Starlink (75%)");
    // Headline is the joint of the legs as shown (1 × 50%); the legs print Yes and 50%.
    expect(percents(html)).toEqual(["50%", "75%", "50%"]);
    expect(html).toContain('">Yes</span>');
  });

  test("a card with no confirmed leg keeps the figure it is ranked by", () => {
    const legs = [
      { route: "SFO-DEN", fn: "UA488", p: 0.8, h: 2.5 },
      { route: "DEN-ORD", fn: "UA1234", p: 0.6, h: 2.4 },
    ];
    const it = itinerary(legs);
    expect(timeLine(card(legs))).toBe(
      `~${it.expected_starlink_hours.toFixed(1)}h of ~4.9h flying expected on Starlink (${probLabel(it.expected_starlink_hours / it.total_flight_hours)})`
    );
  });

  test("a confirmed leg with no known duration drops the line rather than guess", () => {
    const body = itinerary([
      { route: "SFO-DEN", fn: "UA488", p: 0.95, h: 2.0, confirmed: true },
      { route: "DEN-ORD", fn: "UA1234", p: 0.5, h: 2.0 },
    ]);
    (body.legs[1] as { duration_hours: number | null }).duration_hours = null;
    const out = { innerHTML: "" };
    renderResults(out, { itineraries: [body] }, false);
    expect(timeLine(out.innerHTML)).toBe("");
  });
});
