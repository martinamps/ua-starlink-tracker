/**
 * Itinerary planner time budget, foreign-hub gate and nonstop baseline, plus
 * the MCP text built on them (firm-NO table, airport validation, past dates).
 * Snapshot tests assert invariants over many pairs, never specific routings;
 * the synthetic fixture pins the behaviors the snapshot is too sparse to reach.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createReaderFactory } from "../src/database/reader";
import {
  ENFORCE_ITINERARY_TIME_BUDGET,
  elapsedHours,
  itineraryHourBudget,
  planItinerary,
  routeBaseline,
} from "../src/scripts/starlink-predictor";
import {
  AIRPORT_COORDS,
  AIRPORT_COUNTRY,
  airportCountry,
  hubAllowedForTrip,
} from "../src/utils/airport-geo";
import {
  addFleet,
  addPlane,
  makeSyntheticDb,
  mcpDirect,
  openSnapshot,
  toolText,
  utc,
} from "./helpers";

type Reader = ReturnType<ReturnType<typeof createReaderFactory>>;

const PAIRS: Array<[string, string]> = [
  ["SFO", "EWR"],
  ["IAH", "CLE"],
  ["ORD", "LGA"],
  ["DEN", "IAD"],
  ["SFO", "JAX"],
  ["LAX", "ORD"],
  ["EWR", "MCO"],
  ["IAD", "BOS"],
  ["SFO", "AUS"],
  ["SEA", "ORD"],
  ["SFO", "DEN"],
  // Small-city pairs with no United nonstop: every option is a connection.
  ["ROA", "BOI"],
  ["IND", "CLE"],
  ["BIL", "ROC"],
  ["RDM", "CAE"],
  ["MSN", "SAV"],
  ["SAN", "PHX"],
];

function assertPlannerInvariants(reader: Reader, o: string, d: string) {
  const base = routeBaseline(reader, o, d);
  expect(base, `${o}-${d} baseline`).not.toBeNull();
  if (!base) return;
  expect(typeof base.duration_hours).toBe("number");
  expect(base.duration_hours).toBeGreaterThan(0);
  expect(base.expected_starlink_hours).toBeCloseTo(base.probability * base.duration_hours, 6);

  const budget = itineraryHourBudget(base.duration_hours);
  // Only a regularly-flown nonstop holds its budget unconditionally; a sparse
  // or absent one yields to the fastest connection rather than empty out.
  const firm = base.duration_source === "schedule" || base.duration_source === "route_history";
  const opts = { maxItineraries: 12, maxStops: 2 };
  const planned = planItinerary(reader, o, d, opts);
  if (!firm) {
    const full = (its: typeof planned) => its.some((it) => it.coverage === "full");
    const unbudgeted = planItinerary(reader, o, d, { ...opts, enforceTimeBudget: false });
    expect(full(planned), `${o}-${d} lost every full connection`).toBe(full(unbudgeted));
    const fitsNonstop = unbudgeted.some(
      (it) => it.coverage === "full" && it.via.length > 0 && elapsedHours(it) <= budget
    );
    if (ENFORCE_ITINERARY_TIME_BUDGET && base.duration_source === "sparse_history" && fitsNonstop) {
      for (const it of planned.filter((i) => i.coverage === "full" && i.via.length > 0)) {
        expect(elapsedHours(it), `${o}-${d} sparse nonstop budget`).toBeLessThanOrEqual(
          budget + 1e-9
        );
      }
    }
  }
  for (const it of planned) {
    const label = `${o}-${d} via ${it.via.join(",") || "direct"}`;
    expect(it.total_flight_hours, label).not.toBeNull();
    if (ENFORCE_ITINERARY_TIME_BUDGET && firm && it.via.length > 0) {
      expect(elapsedHours(it), label).toBeLessThanOrEqual(budget + 1e-9);
    }
    for (const hub of it.via) expect(hubAllowedForTrip(o, d, hub), label).toBe(true);
  }
}

describe("AIRPORT_COUNTRY", () => {
  test("every entry is a coordinate-table airport with an ISO-2 country, never US", () => {
    for (const [code, country] of Object.entries(AIRPORT_COUNTRY)) {
      expect(AIRPORT_COORDS[code], code).toBeDefined();
      expect(country).toMatch(/^[A-Z]{2}$/);
      expect(country).not.toBe("US");
    }
  });

  test("defaults: mapped airports are US, unknown codes are null", () => {
    expect(airportCountry("YKM")).toBe("US");
    expect(airportCountry("SJU")).toBe("US");
    expect(airportCountry("YHZ")).toBe("CA");
    expect(airportCountry("QQQ")).toBeNull();
  });

  test("the hub gate applies only to US-domestic trips and fails open", () => {
    expect(hubAllowedForTrip("SFO", "EWR", "YHZ")).toBe(false);
    expect(hubAllowedForTrip("SFO", "EWR", "ORD")).toBe(true);
    expect(hubAllowedForTrip("SFO", "EWR", "QQQ")).toBe(true);
    expect(hubAllowedForTrip("YVR", "YYZ", "ORD")).toBe(true);
    expect(hubAllowedForTrip("SFO", "YYZ", "YVR")).toBe(true);
  });
});

describe("planner invariants (snapshot)", () => {
  let db: Database;
  let reader: Reader;
  beforeAll(() => {
    db = openSnapshot();
    reader = createReaderFactory(db)("UA");
  });
  afterAll(() => db.close());

  test.each(PAIRS)("%s → %s: within budget, no foreign hub, numeric baseline", (o, d) => {
    assertPlannerInvariants(reader, o, d);
  });

  test("a pair with any United flight_routes row is never reported as having no nonstop", () => {
    const rows = db
      .query(
        `SELECT origin, destination FROM flight_routes WHERE flight_number GLOB 'UA[0-9]*'
         GROUP BY origin, destination ORDER BY SUM(seen_count) ASC LIMIT 40`
      )
      .all() as Array<{ origin: string; destination: string }>;
    for (const { origin, destination } of rows) {
      const base = routeBaseline(reader, origin, destination);
      if (base) expect(base.duration_source, `${origin}-${destination}`).not.toBe("great_circle");
    }
  });

  test("/api/plan-route adds a baseline object without dropping existing keys", async () => {
    const { createApp } = await import("../src/server/app");
    const app = createApp(db);
    const r = await app.dispatch(
      new Request("http://x/api/plan-route?origin=SFO&destination=EWR", {
        headers: { Host: "unitedstarlinktracker.com" },
      })
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["origin", "destination", "itineraries", "baseline"])
    );
    expect(Array.isArray(body.itineraries)).toBe(true);
    expect(typeof body.baseline.duration_hours).toBe("number");
    expect(typeof body.baseline.probability).toBe("number");
    expect(typeof body.baseline.expected_starlink_hours).toBe("number");
    expect(body.baseline.route).toBe("SFO-EWR");
  });
});

// SFO→EWR where the person's own express flight (UA5222) is a firm NO. On the
// same day: a Starlink connection via ORD inside the time budget, one via
// Toronto (foreign hub on a domestic trip), and one via DEN→MCI that flies
// ~10h against a 5.5h nonstop.
describe("synthetic SFO→EWR", () => {
  const DATE = "2027-06-09";
  const H = 3600;
  let sdb: Database;
  let factory: ReturnType<typeof createReaderFactory>;
  let reader: Reader;

  const leg = (
    tail: string,
    fn: string,
    dep: string,
    arr: string,
    depIso: string,
    hours: number
  ) => {
    const t = utc(depIso);
    sdb
      .query(
        `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
      )
      .run(tail, fn, dep, arr, t, t + Math.round(hours * H), t);
  };

  beforeAll(() => {
    sdb = makeSyntheticDb();
    addPlane(sdb, "N1002", null);
    addFleet(sdb, "N1002", "negative", { verifiedWifi: "None" });
    leg("N1002", "UA5222", "SFO", "EWR", `${DATE}T16:00:00Z`, 5.5);

    for (const t of ["N2001", "N2002", "N2003", "N2004", "N2005", "N2006", "N2007"]) {
      addPlane(sdb, t, "Starlink");
    }
    leg("N2001", "UA5301", "SFO", "ORD", `${DATE}T15:00:00Z`, 4);
    leg("N2002", "UA5302", "ORD", "EWR", `${DATE}T21:00:00Z`, 2);
    leg("N2003", "UA5401", "SFO", "YYZ", `${DATE}T15:00:00Z`, 4.5);
    leg("N2004", "UA5402", "YYZ", "EWR", `${DATE}T21:00:00Z`, 1.5);
    leg("N2005", "UA5501", "SFO", "DEN", `${DATE}T15:00:00Z`, 2.5);
    leg("N2006", "UA5502", "DEN", "MCI", `${DATE}T19:00:00Z`, 3.5);
    leg("N2007", "UA5503", "MCI", "EWR", `${DATE}T23:30:00Z`, 4);

    factory = createReaderFactory(sdb);
    reader = factory("UA");
  });
  afterAll(() => sdb.close());

  const mid = () => utc(`${DATE}T12:00:00Z`);
  const vias = () =>
    planItinerary(reader, "SFO", "EWR", { targetDateUnix: mid() }).map((it) => it.via.join(">"));

  test("the ORD connection survives; the foreign hub never appears", () => {
    const v = vias();
    expect(v).toContain("ORD");
    expect(v.some((x) => x.includes("YYZ"))).toBe(false);
  });

  test("the 2-stop detour is over budget and dropped", () => {
    if (!ENFORCE_ITINERARY_TIME_BUDGET) return;
    expect(vias()).not.toContain("DEN>MCI");
    assertPlannerInvariants(reader, "SFO", "EWR");
  });

  const mcp = (scope: "UA" | "ALL", method: string, params: unknown) =>
    mcpDirect(scope, factory, method, params);

  test("firm NO: verdict first, the person's flight shows 0%, no 'None WiFi'", async () => {
    // Hub scope: no FR24 reverse lookup, so the fixture is hermetic.
    const json = await mcp("ALL", "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "ua 5222", date: DATE },
    });
    const text: string = json.result.content[0].text;
    expect(text.startsWith("❌ No Starlink")).toBe(true);
    expect(text).not.toContain("None WiFi");
    expect(text).toContain("<present_verbatim>");
    const rows = text.split("\n").filter((l) => l.startsWith("|") && l.includes("UA5222"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toContain("| 0% (");
    expect(text).not.toContain("YYZ");
  });

  test("unknown airport codes are tool errors; real ones are not", async () => {
    for (const name of ["plan_starlink_itinerary", "predict_route_starlink"]) {
      for (const origin of ["XXX", "SF0", "SFOO"]) {
        const bad = await mcp("UA", "tools/call", {
          name,
          arguments: { origin, destination: "EWR" },
        });
        expect(bad.result.isError, `${name} ${origin}`).toBe(true);
        expect(bad.result.content[0].text).toContain("Unknown airport code");
      }
      const good = await mcp("UA", "tools/call", {
        name,
        arguments: { origin: "sfo", destination: "EWR" },
      });
      expect(good.result.isError, name).toBeUndefined();
    }
  });

  test("plan_starlink_itinerary always shows the nonstop with numeric hours", async () => {
    for (const date of [DATE, "2099-01-01"]) {
      const json = await mcp("UA", "tools/call", {
        name: "plan_starlink_itinerary",
        arguments: { origin: "SFO", destination: "EWR", date },
      });
      const text: string = json.result.content[0].text;
      // Either the planner's own direct row or the explicit baseline line.
      expect(text).toMatch(/(Nonstop baseline|\*\*DIRECT\*\*)[^\n]*~\d+(\.\d)?h flying/);
    }
  });

  test("predict_route_starlink's alternatives table never prints '~0' or '—' hours", async () => {
    const json = await mcp("UA", "tools/call", {
      name: "predict_route_starlink",
      arguments: { origin: "SFO", destination: "BOS" },
    });
    const text: string = json.result.content[0].text;
    for (const row of text.split("\n").filter((l) => l.includes("direct — baseline"))) {
      expect(row).not.toContain("| ~0 |");
      expect(row).not.toContain("| — |");
      expect(row).toMatch(/\| ~?\d+(\.\d)?[hm] \|$/);
    }
  });

  test("tools declare read-only annotations", async () => {
    const json = await mcp("UA", "tools/list", {});
    for (const tool of json.result.tools) {
      expect(typeof tool.title).toBe("string");
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(typeof tool.annotations.openWorldHint).toBe("boolean");
    }
  });
});

// IND→CLE has no United nonstop, so the great-circle estimate is a nonstop
// nobody can book and its ORD connection runs well past a budget built from it.
// ROA→BOI carries a two-sighting charter (UA3302-style) whose short block time
// would budget out the only real connection. EWR→SMF is the other side of the
// same sparse history: a real seasonal nonstop (UA2624, 7 sightings over two
// weeks) that must keep a DEN connection in and a MCO detour out. IAH→CLE is
// the control: a regularly-flown nonstop still budgets out a DEN detour.
describe("synthetic pairs with no or a sparsely seen United nonstop", () => {
  const DATE = "2027-06-10";
  const H = 3600;
  let sdb: Database;
  let factory: ReturnType<typeof createReaderFactory>;
  let reader: Reader;
  let n = 0;

  const leg = (fn: string, dep: string, arr: string, depIso: string, hours: number) => {
    const tail = `N3${String(++n).padStart(3, "0")}`;
    addPlane(sdb, tail, "Starlink");
    const t = utc(depIso);
    sdb
      .query(
        `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
      )
      .run(tail, fn, dep, arr, t, t + Math.round(hours * H), t);
  };
  const history = (fn: string, o: string, d: string, hours: number, seen: number, spanDays = 0) => {
    const t = utc(`${DATE}T00:00:00Z`);
    sdb
      .query(
        `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(fn, o, d, Math.round(hours * H), t - spanDays * 86400, t, seen);
  };

  beforeAll(() => {
    sdb = makeSyntheticDb();
    leg("UA5601", "IND", "ORD", `${DATE}T13:00:00Z`, 1.4);
    leg("UA5602", "ORD", "CLE", `${DATE}T16:00:00Z`, 1.5);
    leg("UA5701", "ROA", "ORD", `${DATE}T12:00:00Z`, 2.4);
    leg("UA5702", "ORD", "BOI", `${DATE}T16:00:00Z`, 3.8);
    history("UA3302", "ROA", "BOI", 4.5, 2);
    leg("UA5901", "EWR", "DEN", `${DATE}T12:00:00Z`, 4.3);
    leg("UA5902", "DEN", "SMF", `${DATE}T17:30:00Z`, 2.5);
    leg("UA5903", "EWR", "MCO", `${DATE}T12:00:00Z`, 2.7);
    leg("UA5904", "MCO", "SMF", `${DATE}T16:00:00Z`, 6.3);
    history("UA2624", "EWR", "SMF", 6.5, 7, 15);
    leg("UA5801", "IAH", "DEN", `${DATE}T12:00:00Z`, 2.5);
    leg("UA5802", "DEN", "CLE", `${DATE}T16:00:00Z`, 3.5);
    history("UA544", "IAH", "CLE", 3, 50);
    factory = createReaderFactory(sdb);
    reader = factory("UA");
  });
  afterAll(() => sdb.close());

  const plan = (o: string, d: string, enforceTimeBudget?: boolean) =>
    planItinerary(reader, o, d, {
      maxStops: 2,
      targetDateUnix: utc(`${DATE}T12:00:00Z`),
      enforceTimeBudget,
    });
  const planText = async (o: string, d: string): Promise<string> =>
    toolText(
      await mcpDirect("UA", factory, "tools/call", {
        name: "plan_starlink_itinerary",
        arguments: { origin: o, destination: d, date: DATE },
      })
    ).text;

  test.each([
    ["IND", "CLE", "great_circle"],
    ["ROA", "BOI", "sparse_history"],
  ])("%s → %s keeps its hub connection (%s baseline)", (o, d, source) => {
    const base = routeBaseline(reader, o, d);
    expect(base?.duration_source).toBe(source);
    const full = plan(o, d).filter((it) => it.coverage === "full");
    expect(full.length).toBeGreaterThan(0);
    expect(full.some((it) => it.via.length === 1)).toBe(true);
  });

  test("a sparsely seen real nonstop keeps its budget while a connection fits it", () => {
    const base = routeBaseline(reader, "EWR", "SMF");
    expect(base?.duration_source).toBe("sparse_history");
    if (!base || !ENFORCE_ITINERARY_TIME_BUDGET) return;
    expect(plan("EWR", "SMF", false).some((it) => it.via.includes("MCO"))).toBe(true);
    const planned = plan("EWR", "SMF");
    expect(planned.some((it) => it.via.includes("DEN"))).toBe(true);
    expect(planned.some((it) => it.via.includes("MCO"))).toBe(false);
    const budget = itineraryHourBudget(base.duration_hours);
    for (const it of planned) expect(elapsedHours(it)).toBeLessThanOrEqual(budget + 1e-9);
  });

  test("plan_starlink_itinerary never denies a nonstop flight_routes has seen", async () => {
    const text = await planText("EWR", "SMF");
    expect(text).toContain("UA2624");
    expect(text).toContain("seen only occasionally");
    expect(text).not.toContain("No United nonstop");
    expect(text).not.toContain("no nonstop to fall back on");
  });

  test("a regularly-flown nonstop still budgets out long detours", () => {
    if (!ENFORCE_ITINERARY_TIME_BUDGET) return;
    expect(routeBaseline(reader, "IAH", "CLE")?.duration_source).toBe("route_history");
    expect(plan("IAH", "CLE").some((it) => it.via.includes("DEN"))).toBe(false);
  });

  test("plan_starlink_itinerary never tells the person to book a nonstop that doesn't exist", async () => {
    const text = await planText("IND", "CLE");
    expect(text).toContain("No United nonstop");
    expect(text).not.toContain("Nonstop baseline");
    expect(text).not.toContain("booking the nonstop");
  });
});

describe("MCP text edge cases (snapshot)", () => {
  let db: Database;
  let reader: Reader;
  beforeAll(() => {
    db = openSnapshot();
    reader = createReaderFactory(db)("UA");
  });
  afterAll(() => db.close());

  test("a past date is not described as 'not yet published'", async () => {
    const { text } = toolText(
      await mcpDirect("UA", () => reader, "tools/call", {
        name: "check_flight",
        arguments: { flight_number: "UA5685", date: "2020-01-01" },
      })
    );
    expect(text).toContain("in the past");
    expect(text).not.toContain("not yet published");
  });

  test("an invalid flight number names the expected shape", async () => {
    const { text, isError } = toolText(
      await mcpDirect("UA", () => reader, "tools/call", {
        name: "check_flight",
        arguments: { flight_number: "UA 544 2026", date: "2099-01-01" },
      })
    );
    expect(isError).toBe(true);
    expect(text).toContain("not a valid flight number");
  });
});
