import { describe, expect, test } from "bun:test";
import { metrics } from "../src/observability/metrics";
import { computeShadowKpis, runAdsbSweepShadow } from "../src/scripts/adsb-sweep";
import { addFleet, addFlight, makeSyntheticDb } from "./helpers";

describe("ADS-B shadow KPIs", () => {
  test("accuracy over answered legs, blind share over tracked tails only", () => {
    const kpis = computeShadowKpis(
      [
        { tail_number: "N1", shadow_result: "match" },
        { tail_number: "N2", shadow_result: "mismatch" },
        { tail_number: "N3", shadow_result: "no_assignment" },
        { tail_number: "N9", shadow_result: "no_assignment" },
        { tail_number: "N4", shadow_result: "low_speed" },
        { tail_number: "N5", shadow_result: null },
      ],
      new Set(["N1", "N2", "N3", "N4"])
    );
    expect(kpis.accuracy).toBeGreaterThan(0);
    expect(kpis.accuracy).toBeLessThan(1);
    expect(kpis.blindShare).toBeGreaterThan(0);
    expect(kpis.blindShare).toBeLessThan(1);
  });

  test("nothing to judge → null, never NaN", () => {
    expect(computeShadowKpis([], new Set())).toEqual({ accuracy: null, blindShare: null });
  });

  test("a sweep emits both gauges tagged with airline", async () => {
    const db = makeSyntheticDb();
    const now = Math.floor(Date.now() / 1000);
    addFleet(db, "N106SY", "confirmed");
    addFlight(db, "N106SY", "SKW5425", "ORD", now - 1800);
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          ac: [{ r: "N106SY", flight: "SKW5425", alt_baro: 30000, gs: 420, hex: "a1" }],
        })
      )) as unknown as typeof fetch;

    const gauges: Array<{ name: string; tags?: Record<string, string | number> }> = [];
    const original = metrics.gauge;
    metrics.gauge = (name, _value, tags) => {
      gauges.push({ name, tags });
    };
    try {
      await runAdsbSweepShadow(db, fetcher);
    } finally {
      metrics.gauge = original;
    }
    for (const name of ["adsb_shadow.accuracy", "adsb_shadow.blind_share"]) {
      const g = gauges.find((c) => c.name === name);
      expect(g).toBeDefined();
      expect(typeof g?.tags?.airline).toBe("string");
    }
    db.close();
  });
});
