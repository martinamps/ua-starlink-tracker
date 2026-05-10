/**
 * Route-compare + planner behavior tests against the hermetic /tmp/ua-test.sqlite
 * snapshot. Asserts shapes and bounded ranges (not exact values) so they
 * survive data drift; the SFO-AUS regression guard is the load-bearing case.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { publicAirlines } from "../src/airlines/registry";
import { getSubfleetPenetration } from "../src/database/database";
import {
  type RouteCompareResult,
  compareRoute,
  planItinerary,
} from "../src/scripts/starlink-predictor";
import { createReaderFactory } from "../src/server/context";

const TEST_DB = "/tmp/ua-test.sqlite";
let db: Database;
let hubReader: ReturnType<ReturnType<typeof createReaderFactory>>;
let getReader: (code: string) => ReturnType<ReturnType<typeof createReaderFactory>>;

beforeAll(() => {
  db = new Database(TEST_DB, { readonly: true });
  const factory = createReaderFactory(db);
  hubReader = factory("ALL");
  getReader = (code: string) => factory(code);
});
afterAll(() => db.close());

const find = (o: string, d: string, code: string): RouteCompareResult | undefined =>
  compareRoute(getReader, o, d).find((r) => r.airline === code);

// ── compareRoute ──────────────────────────────────────────────────────────────
//
// Asserts RANGES, not exact values — the test snapshot drifts as the rollout
// progresses. The hard regression target is UA SFO-AUS: the old planItinerary
// path returned ~97% (cherry-picked SFO→OMA→AUS). Mainline penetration is the
// honest answer.

describe("compareRoute", () => {
  type Case = {
    o: string;
    d: string;
    code: string;
    kind: RouteCompareResult["kind"] | "omitted";
    pLo?: number;
    pHi?: number;
    rangeLoMax?: number;
    rangeHiMin?: number;
    rangeHiMax?: number;
    why: string;
  };

  const CASES: Case[] = [
    // SFO-AUS: primary regression guard. Zero observed; both airports served.
    {
      o: "SFO",
      d: "AUS",
      code: "UA",
      kind: "inferred_absent",
      pLo: 0,
      pHi: 0.4,
      why: "no Starlink tail seen → mainline rate, NOT 97% via OMA",
    },
    {
      o: "SFO",
      d: "AUS",
      code: "AS",
      kind: "inferred_absent",
      pLo: 0,
      pHi: 0.4,
      why: "AS serves both, horizon 100% would have appeared → mainline rate",
    },
    { o: "SFO", d: "AUS", code: "HA", kind: "no_data", why: "neither endpoint in HI" },

    // SEA-SFO: UA mixed (express + mainline both observed)
    {
      o: "SEA",
      d: "SFO",
      code: "UA",
      kind: "observed_mixed",
      rangeLoMax: 0.4,
      rangeHiMin: 0.5,
      rangeHiMax: 1.0,
      why: "UA499/737 mainline + UA5xxx/6xxx express both observed",
    },
    {
      o: "SEA",
      d: "SFO",
      code: "AS",
      kind: "inferred_absent",
      pLo: 0,
      pHi: 0.4,
      why: "AS serves both, no AS-prefix direct observed → mainline rate",
    },
    { o: "SEA", d: "SFO", code: "HA", kind: "no_data", why: "routeTypeRule null on mainland-only" },

    // SFO-HNL: HA type rule fires; UA/AS omitted (no Starlink tail at HNL)
    {
      o: "SFO",
      d: "HNL",
      code: "HA",
      kind: "type_rule",
      pLo: 1,
      pHi: 1,
      why: "transpacific A330/A321neo",
    },
    { o: "SFO", d: "HNL", code: "UA", kind: "no_data", why: "UA@HNL=0 (widebodies only)" },

    // OGG-KOA: HA interisland 717
    {
      o: "OGG",
      d: "KOA",
      code: "HA",
      kind: "type_rule",
      pLo: 0,
      pHi: 0,
      why: "interisland 717, no WiFi",
    },
    { o: "OGG", d: "KOA", code: "UA", kind: "no_data", why: "UA does not touch OGG/KOA" },

    // ORD-LAX: UA mainline-only trunk route. Second regression guard.
    {
      o: "ORD",
      d: "LAX",
      code: "UA",
      kind: "observed_single",
      pLo: 0,
      pHi: 0.4,
      why: "UA1967/UA353 observed, both <3000 → mainline only, NOT ~100%",
    },
    { o: "ORD", d: "LAX", code: "AS", kind: "no_data", why: "AS@ORD=0" },
  ];

  test.each(CASES)("$o-$d $code → $kind ($why)", (c) => {
    const r = find(c.o, c.d, c.code);
    if (c.kind === "omitted") {
      expect(r).toBeUndefined();
      return;
    }
    if (c.kind === "no_data") {
      expect(r?.kind).toBe("no_data");
      expect(r?.probability).toBeLessThan(0);
      return;
    }
    expect(r).toBeDefined();
    expect(r!.kind).toBe(c.kind);
    expect(r!.reason.length).toBeGreaterThan(5);

    if (c.kind === "observed_mixed") {
      expect(r!.lo).toBeDefined();
      expect(r!.hi).toBeDefined();
      expect(r!.breakdown.length).toBeGreaterThanOrEqual(2);
      if (c.rangeLoMax !== undefined) expect(r!.lo!).toBeLessThan(c.rangeLoMax);
      if (c.rangeHiMin !== undefined) expect(r!.hi!).toBeGreaterThan(c.rangeHiMin);
      if (c.rangeHiMax !== undefined) expect(r!.hi!).toBeLessThan(c.rangeHiMax);
    } else {
      if (c.pLo !== undefined) expect(r!.probability).toBeGreaterThanOrEqual(c.pLo);
      if (c.pHi !== undefined) expect(r!.probability).toBeLessThanOrEqual(c.pHi);
      if (c.kind !== "type_rule") expect(r!.breakdown.length).toBe(1);
    }
  });

  test("HA SFO-HNL reason mentions A330/A321neo", () => {
    expect(find("SFO", "HNL", "HA")?.reason).toMatch(/A330|A321/i);
  });

  // AS on SFO-HNL: AS800-899 are AS-marketed flights on Hawaiian A330/A321neo
  // metal post-merger (verified: tails N209HA, N213HA in upcoming_flights for
  // AS8xx). When the fixture has those routes cached, AS should map to the
  // hawaiian_metal subfleet at ~100%, NOT mainline 0%.
  test("AS SFO-HNL: maps to hawaiian_metal subfleet, not mainline", () => {
    const r = find("SFO", "HNL", "AS");
    if (r && r.kind !== "no_data" && r.kind !== "inferred_absent") {
      // hawaiian_metal observed: AS800-899 should resolve to ≥90%
      const ha = r.breakdown.find((b) => b.key === "hawaiian_metal");
      expect(ha).toBeDefined();
      expect(ha!.pct).toBeGreaterThanOrEqual(0.9);
    }
  });

  test("HA OGG-KOA reason mentions 717", () => {
    expect(find("OGG", "KOA", "HA")?.reason).toMatch(/717/);
  });

  test("rows sort: confident → inferred → no_data", () => {
    const rank = {
      type_rule: 2,
      observed_single: 2,
      observed_mixed: 2,
      inferred_absent: 1,
      no_data: 0,
    };
    for (const [o, d] of [
      ["SEA", "SFO"],
      ["SFO", "HNL"],
      ["SFO", "AUS"],
    ]) {
      let prev = 99;
      for (const r of compareRoute(getReader, o, d)) {
        const cur = rank[r.kind];
        expect(cur).toBeLessThanOrEqual(prev);
        prev = cur;
      }
    }
  });

  // Structural ceiling: no non-rule result may exceed that airline's
  // best-equipped subfleet rate. This single assertion would have caught
  // the 97% bug and guards every code path that feeds compareRoute.
  test("INVARIANT: probability ≤ max subfleet penetration", () => {
    const ROUTES = [
      ["SFO", "AUS"],
      ["SEA", "SFO"],
      ["SFO", "HNL"],
      ["OGG", "KOA"],
      ["ORD", "LAX"],
      ["DEN", "SAN"],
      ["SEA", "LAX"],
    ];
    const ceiling = new Map<string, number>();
    for (const cfg of publicAirlines()) {
      if (cfg.routeTypeRule) continue;
      const pen = getSubfleetPenetration(db, cfg.code);
      // Same ceiling the model uses: max over per-subfleet penetration,
      // including any penetrationOverride (e.g. AS800-899 on HA metal).
      const pcts = cfg.subfleets.map((sf) => sf.penetrationOverride ?? pen.get(sf.key)?.pct ?? 0);
      ceiling.set(cfg.code, Math.max(0, ...pcts));
    }
    for (const [o, d] of ROUTES) {
      for (const r of compareRoute(getReader, o, d)) {
        if (r.kind === "type_rule" || r.kind === "no_data") continue;
        const ceil = ceiling.get(r.airline);
        expect(ceil).toBeDefined();
        expect(r.hi ?? r.probability).toBeLessThanOrEqual(ceil! + 1e-6);
      }
    }
  });

  test("nonexistent airports → empty", () => {
    expect(compareRoute(getReader, "ZZZ", "YYY")).toEqual([]);
  });

  // OO/SKW prefix collision regression: SkyWest (OO) operates for Alaska,
  // Delta, and American — not just United. The flight_routes glob must NOT
  // attribute OO-prefixed rows to UA Express. Pre-fix, BOI-SEA showed UA at
  // 65% (phantom — UA doesn't fly it).
  test.each([
    ["SEA", "PDX"],
    ["BOI", "SEA"],
  ])("OO collision guard: UA on %s-%s is not observed_*", (o, d) => {
    const r = find(o, d, "UA");
    expect(["no_data", "inferred_absent", undefined]).toContain(r?.kind);
  });

  // SEA-ANC overstatement regression: AS flies it on ~10x daily mainline 737
  // (0% Starlink, structurally invisible) plus ~1x Horizon E175 (100%, the
  // only observable). Pre-fix, observed_single said "AS 100%". Now: when ONLY
  // the high-pen subfleet is seen and a <50% sibling exists, render a range.
  test("low-pen-sibling guard: never observed_single ≥50% when a <50% sibling exists", () => {
    for (const [o, d] of [
      ["SEA", "ANC"],
      ["DEN", "SAN"],
      ["SEA", "LAX"],
      ["SFO", "HNL"],
      ["PDX", "SFO"],
    ]) {
      for (const code of ["AS", "UA"]) {
        const r = find(o, d, code);
        if (r?.kind === "observed_single") {
          // Single is only allowed for the LOW-pen subfleet (no overstatement risk).
          expect(r.probability).toBeLessThan(0.5);
        }
      }
    }
  });

  test("symmetry: every non-routeTypeRule carrier appears on every real route", () => {
    // The bug this guards: AS shows on SFO-HNL but UA doesn't, despite both
    // flying it. Now every carrier without a routeTypeRule renders as one of
    // observed_*/inferred_absent/no_data — never silently absent.
    for (const [o, d] of [
      ["SFO", "AUS"],
      ["SFO", "HNL"],
      ["SEA", "SFO"],
      ["ORD", "LAX"],
    ]) {
      const codes = compareRoute(getReader, o, d).map((r) => r.airline);
      expect(codes).toContain("UA");
      expect(codes).toContain("AS");
    }
  });

  test("no_data rows sort after everything", () => {
    const r = compareRoute(getReader, "SFO", "HNL");
    const noDataIdx = r.findIndex((x) => x.kind === "no_data");
    if (noDataIdx >= 0) {
      for (let i = noDataIdx; i < r.length; i++) {
        expect(r[i].kind).toBe("no_data");
      }
    }
  });
});

// ── planItinerary (unchanged behavior) ────────────────────────────────────────

describe("planItinerary", () => {
  const CASES: Array<[string, string, number, string]> = [
    ["SEA", "LAX", 1, "direct AS route"],
    ["HNL", "LAX", 1, "direct HA route"],
    ["SEA", "BOI", 1, "AS spoke"],
    ["ZZZ", "YYY", 0, "nonexistent → empty"],
  ];

  test.each(CASES)("%s → %s: ≥%d itineraries", (o, d, minN) => {
    const its = planItinerary(hubReader, o, d, { maxItineraries: 5 });
    expect(its.length).toBeGreaterThanOrEqual(minN);
  });

  test("itinerary shape: legs, joint probability, totals", () => {
    const its = planItinerary(hubReader, "SEA", "LAX", { maxItineraries: 3 });
    for (const it of its) {
      expect(it.legs.length).toBeGreaterThan(0);
      expect(it.joint_probability).toBeGreaterThanOrEqual(0);
      expect(it.joint_probability).toBeLessThanOrEqual(1);
      expect(it.at_least_one_probability).toBeGreaterThanOrEqual(it.joint_probability);
      for (const leg of it.legs) {
        expect(leg.route).toMatch(/^[A-Z]{3}-[A-Z]{3}$/);
        expect(leg.probability).toBeGreaterThanOrEqual(0);
        expect(leg.probability).toBeLessThanOrEqual(1);
      }
    }
  });

  test("maxStops is respected", () => {
    for (const maxStops of [0, 1, 2]) {
      const its = planItinerary(hubReader, "SEA", "LAX", { maxStops, maxItineraries: 10 });
      for (const it of its) {
        expect(it.legs.length).toBeLessThanOrEqual(maxStops + 1);
      }
    }
  });

  test("origin == destination returns empty", () => {
    expect(planItinerary(hubReader, "SEA", "SEA")).toEqual([]);
    expect(planItinerary(hubReader, "sea", "SEA")).toEqual([]);
  });
});
