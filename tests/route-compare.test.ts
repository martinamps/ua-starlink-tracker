/**
 * Route-compare + planner behavior tests against the hermetic readonly
 * snapshot at TEST_DB (see tests/helpers.ts). Asserts shapes and bounded ranges (not exact values) so they
 * survive data drift; the SFO-AUS regression guard is the load-bearing case.
 */
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, publicAirlines } from "../src/airlines/registry";
import { getSubfleetPenetration } from "../src/database/database";
import {
  type RouteCompareResult,
  carrierPrediction,
  compareRoute,
  joinSentences,
  planItinerary,
  subfleetPenetration,
} from "../src/scripts/starlink-predictor";
import { createReaderFactory } from "../src/server/context";
import { airportDistanceMiles, detourBoundMiles } from "../src/utils/airport-geo";
import { addFlight, makeSyntheticDb, openSnapshot } from "./helpers";

let db: Database;
let hubReader: ReturnType<ReturnType<typeof createReaderFactory>>;
let getReader: (code: string) => ReturnType<ReturnType<typeof createReaderFactory>>;

beforeAll(() => {
  db = openSnapshot();
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

// ── planItinerary ─────────────────────────────────────────────────────────────

describe("planItinerary", () => {
  const CASES: Array<[string, string, number, string]> = [
    ["SEA", "LAX", 1, "direct AS route"],
    ["HNL", "LAX", 1, "direct HA route"],
    ["ZZZ", "YYY", 0, "nonexistent → empty"],
  ];
  // SEA→BOI is a 400 mi hop whose only Starlink path in the snapshot
  // backtracks through SFO, so the detour gate is right to return nothing —
  // it stays in the invariant sweep but has no meaningful count to assert.
  const PAIRS = [...CASES.map(([o, d]) => [o, d]), ["SEA", "BOI"]];

  test.each(CASES)("%s → %s: ≥%d itineraries", (o, d, minN) => {
    const its = planItinerary(hubReader, o, d, { maxItineraries: 5 });
    expect(its.length).toBeGreaterThanOrEqual(minN);
  });

  test("no itinerary exceeds the geographic detour bound", () => {
    for (const [o, d] of PAIRS) {
      const direct = airportDistanceMiles(o, d);
      if (direct === null) continue;
      for (const it of planItinerary(hubReader, o, d, { maxItineraries: 10 })) {
        let path = 0;
        for (const leg of it.legs) {
          const [a, b] = leg.route.split("-");
          path += airportDistanceMiles(a, b) ?? 0;
        }
        // +1 mi absorbs float noise; the bound is what matters.
        expect(path).toBeLessThanOrEqual(detourBoundMiles(direct) + 1);
      }
    }
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

// ── planItinerary detour + census gates (synthetic, deterministic) ────────────
// Real airports (the static coord table drives the geometry) with
// `minLegProbability: 0` so the probability model can't hide an edge.

describe("planItinerary geographic gates", () => {
  let sdb: Database;
  let reader: ReturnType<typeof getReader>;
  const NO_PROB = { maxItineraries: 10, minLegProbability: 0 } as const;
  const vias = (o: string, d: string) =>
    planItinerary(reader, o, d, NO_PROB).map((it) => it.via.join(","));

  beforeAll(() => {
    sdb = makeSyntheticDb();
    let n = 5000;
    const edge = (dep: string, arr: string) =>
      addFlight(sdb, `N${n}X`, `UA${n++}`, dep, 1, { arrivalAirport: arr });
    // Direct OGG→SFO, plus two Starlink-flown detours that must never be
    // offered for OGG→SFO: OGG→ORD→SFO (2.6x) and a SAT→SFO leg the partial
    // fallback would otherwise pair with a fabricated OGG→SAT positioning hop.
    edge("OGG", "SFO");
    edge("OGG", "ORD");
    edge("ORD", "SFO");
    edge("SAT", "SFO");
    // LAX is genuinely on the way OGG→SFO (1.12x); its Starlink LAX→SFO leg
    // is the one partial the gates should keep.
    edge("LAX", "SFO");
    reader = createReaderFactory(sdb)("UA");
  });
  afterAll(() => sdb.close());

  test("direct survives; the ORD backtrack and the fabricated SAT hop do not", () => {
    const v = vias("OGG", "SFO");
    expect(v).toContain("");
    expect(v).not.toContain("ORD");
    expect(v).not.toContain("SAT");
  });

  test("an on-the-way partial survives while no census exists to refute it", () => {
    // bts_monthly_routes is empty → getServedRoutePairs() is null → the
    // route-existence gate fails OPEN and keeps the geographically-valid LAX option.
    expect(reader.getServedRoutePairs()).toBeNull();
    expect(vias("OGG", "SFO")).toContain("LAX");
  });

  test("the census never applies to a scope that is not exactly UA", () => {
    // bts_monthly_routes is UA-marketed; using it to judge an AS/HA/hub
    // positioning leg would reject every route United does not fly.
    expect(createReaderFactory(sdb)("ALL").getServedRoutePairs()).toBeNull();
  });

  test("an origin outside the coordinate table disables the detour gate, not the planner", () => {
    // QQQ has no coordinates, so nothing can be proven a detour. The SAT→SFO
    // leg must come back as a partial rather than the planner returning [].
    expect(vias("QQQ", "SFO").length).toBeGreaterThan(0);
  });

  // Mutates the census, so it must stay LAST in this describe.
  test("the census rejects a positioning leg on a route United never flies", () => {
    const ins = sdb.query(
      "INSERT INTO bts_monthly_routes (month, origin, dest, performed) VALUES ('2026-05', ?, ?, 1)"
    );
    // A non-empty census that omits OGG-LAX proves the positioning leg is
    // fabricated; adding it brings the option back.
    ins.run("SFO", "LAX");
    expect(vias("OGG", "SFO")).not.toContain("LAX");
    ins.run("OGG", "LAX");
    expect(vias("OGG", "SFO")).toContain("LAX");
  });
});

// ── carrierPrediction (registry answers for model-less carriers) ─────────────

describe("carrierPrediction", () => {
  function asReaderWithMainline(tails: number) {
    const sdb = makeSyntheticDb();
    const insert = sdb.query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, airline)
       VALUES (?, 'Boeing 737-900', 'test', 1, 1, 'mainline', 'AS')`
    );
    for (let i = 0; i < tails; i++) insert.run(`N${100 + i}AS`);
    return { sdb, reader: createReaderFactory(sdb)("AS") };
  }

  test("penetration floor: below MIN total → no_model, at floor → penetration", () => {
    const small = asReaderWithMainline(4);
    expect(carrierPrediction(AIRLINES.AS, small.reader, "AS1").kind).toBe("no_model");
    small.sdb.close();

    const enough = asReaderWithMainline(5);
    const answer = carrierPrediction(AIRLINES.AS, enough.reader, "AS1");
    if (answer.kind !== "penetration") throw new Error(`expected penetration, got ${answer.kind}`);
    expect(answer.pen.synthetic).toBe(false);
    if (!answer.pen.synthetic) {
      expect(answer.pen.total).toBe(5);
      expect(answer.pen.equipped).toBe(0);
    }
    enough.sdb.close();
  });

  test("mismatched reader scope fails closed to no_model (never another roster's counts)", () => {
    const answer = carrierPrediction(AIRLINES.AS, getReader("HA"), "AS1");
    expect(answer.kind).toBe("no_model");
  });

  test("split-phase carriers return type_split, never a blended number", () => {
    for (const [cfg, confirmedFamily, otherFamily] of [
      [AIRLINES.HA, "A330", "B717"],
      [AIRLINES.QR, "B777", "B787"],
    ] as const) {
      const answer = carrierPrediction(cfg, getReader(cfg.code), `${cfg.iata}50`);
      if (answer.kind !== "type_split") throw new Error(`${cfg.code}: expected type_split`);
      const phases = answer.groups.map((g) => g.phase);
      expect(phases).toContain("confirmed");
      expect(phases.some((p) => p === "negative" || p === "rolling")).toBe(true);
      const families = answer.groups.flatMap((g) => g.families);
      expect(families).toContain(confirmedFamily);
      expect(families).toContain(otherFamily);
    }
  });

  test("override subfleets resolve synthetic — counts are not even present", () => {
    const sf = AIRLINES.AS.subfleets.find((s) => s.key === "hawaiian_metal");
    if (!sf) throw new Error("hawaiian_metal subfleet missing");
    const pen = subfleetPenetration(new Map(), sf);
    if (!pen?.synthetic) throw new Error("expected synthetic penetration");
    expect(pen.pct).toBe(1);
    expect("equipped" in pen).toBe(false);
    expect("total" in pen).toBe(false);
  });
});

describe("joinSentences", () => {
  test("exactly one terminal period whether the fragment has one or not", () => {
    expect(joinSentences("No trailing period", "Already has one.")).toBe(
      "No trailing period. Already has one."
    );
    expect(joinSentences("Ends with bang!", null, "", "last")).toBe("Ends with bang! last.");
  });
});
