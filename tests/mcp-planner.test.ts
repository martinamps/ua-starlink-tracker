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
  type Itinerary,
  USUAL_TIME_DAYS,
  elapsedHours,
  emptyPlanMessage,
  fitsHourBudget,
  itineraryHourBudget,
  planItinerary,
  planRoute,
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

  test("malformed airport codes are tool errors; well-formed ones are not", async () => {
    for (const name of ["plan_starlink_itinerary", "predict_route_starlink"]) {
      // A well-formed code nothing has seen is answered, not refused: the
      // tracker holds no complete airport list to call it unknown from.
      const unseen = await mcp("UA", "tools/call", {
        name,
        arguments: { origin: "XXX", destination: "EWR" },
      });
      expect(unseen.result.isError, name).toBeUndefined();
      expect(unseen.result.content[0].text).toContain("no United Airlines flights on record");
      for (const origin of ["SF0", "SFOO"]) {
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

// The planner once kept one flight number per pair, the best odds with no
// time, so three connections in four showed a second flight that had left
// before the first one landed. Later legs now leave after the previous one
// usually lands (plus a minimum connection), or the connection isn't shown.
describe("synthetic connections at usual times", () => {
  const DATE = "2027-06-11";
  const H = 3600;
  let sdb: Database;
  let factory: ReturnType<typeof createReaderFactory>;
  let reader: Reader;
  let n = 0;

  const leg = (fn: string, dep: string, arr: string, depIso: string, hours: number) => {
    const tail = `N7${String(++n).padStart(3, "0")}`;
    addPlane(sdb, tail, "Starlink");
    const t = utc(depIso);
    sdb
      .query(
        `INSERT INTO upcoming_flights (tail_number, flight_number, departure_airport, arrival_airport, departure_time, arrival_time, last_updated, airline)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'UA')`
      )
      .run(tail, fn, dep, arr, t, t + Math.round(hours * H), t);
  };
  // Earlier departures in the assignment log, one per local date given.
  const logged = (fn: string, dep: string, arr: string, dates: string[]) => {
    for (const d of dates) {
      const t = utc(`${d}T15:00:00Z`);
      sdb
        .query(
          `INSERT INTO flight_assignment_log (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number, starlink, departure_time, arrival_time, first_seen, last_seen)
           VALUES ('UA', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
        )
        .run(fn, d, dep, arr, `N8${String(++n).padStart(3, "0")}`, t, t + 2 * H, t, t);
    }
  };

  beforeAll(() => {
    sdb = makeSyntheticDb();
    // SFO 8:00 AM → DEN lands 11:30 AM. 6002 leaves DEN before that; 6003 at 1:00 PM.
    leg("UA6001", "SFO", "DEN", `${DATE}T15:00:00Z`, 2.5);
    leg("UA6002", "DEN", "BOS", `${DATE}T16:30:00Z`, 4);
    leg("UA6003", "DEN", "BOS", `${DATE}T19:00:00Z`, 4);
    // SFO → IAH lands 2:00 PM; the only IAH→BOS left at 1:00 PM.
    leg("UA6011", "SFO", "IAH", `${DATE}T15:00:00Z`, 4);
    leg("UA6012", "IAH", "BOS", `${DATE}T18:00:00Z`, 3.5);
    // A red-eye: LAX 11:00 PM → IAH 4:30 AM, on to MIA at 6:30 AM the next day.
    leg("UA6021", "LAX", "IAH", "2027-06-12T06:00:00Z", 3.5);
    leg("UA6022", "IAH", "MIA", "2027-06-12T11:30:00Z", 2.5);
    // 6001 flew the two Fridays before: three days on record, a usual time.
    logged("UA6001", "SFO", "DEN", ["2027-05-28", "2027-06-04"]);
    // SEA 8:00 AM → DEN lands 11:30 AM. 6032 (1:00 PM) is seen Monday to
    // Thursday only; 6033 (2:00 PM) on Fridays, the searched weekday.
    leg("UA6031", "SEA", "DEN", `${DATE}T15:00:00Z`, 2.5);
    leg("UA6032", "DEN", "MCO", "2027-06-10T19:00:00Z", 4);
    leg("UA6033", "DEN", "MCO", `${DATE}T20:00:00Z`, 4);
    logged("UA6032", "DEN", "MCO", ["2027-06-07", "2027-06-08", "2027-06-09"]);
    logged("UA6033", "DEN", "MCO", ["2027-06-04", "2027-05-28"]);
    factory = createReaderFactory(sdb);
    reader = factory("UA");
  });
  afterAll(() => sdb.close());

  const mid = () => utc(`${DATE}T12:00:00Z`);
  const plan = (o: string, d: string) =>
    planItinerary(reader, o, d, { maxItineraries: 12, targetDateUnix: mid() });

  test("a later leg is the one that leaves after the first lands", () => {
    const viaDen = plan("SFO", "BOS").find((it) => it.via.join(">") === "DEN");
    expect(viaDen).toBeDefined();
    if (!viaDen) return;
    expect(viaDen.legs.map((l) => l.flight_number)).toEqual(["UA6001", "UA6003"]);
    expect(viaDen.schedule).toBe("same_day");
    expect(viaDen.connection_minutes).toEqual([90]);
    expect(viaDen.elapsed_hours).toBeCloseTo(8, 6);
    expect(viaDen.legs[0].typical_departure).toBe("8:00 AM");
    expect(viaDen.legs[0].typical_arrival).toBe("11:30 AM");
    expect(viaDen.legs[1].typical_departure).toBe("1:00 PM");
    expect(viaDen.legs.map((l) => l.date)).toEqual([DATE, DATE]);
  });

  test("a hub whose only onward flight has left is not offered", () => {
    for (const it of plan("SFO", "BOS")) {
      expect(it.via.includes("IAH") && it.coverage === "full").toBe(false);
    }
  });

  test("every timed connection leaves at least an hour after the previous leg lands", () => {
    for (const [o, d] of [
      ["SFO", "BOS"],
      ["LAX", "MIA"],
    ]) {
      for (const it of plan(o, d).filter((i) => i.schedule === "same_day")) {
        for (const wait of it.connection_minutes ?? []) {
          expect(wait).not.toBeNull();
          expect(wait as number).toBeGreaterThanOrEqual(60);
          expect(wait as number).toBeLessThanOrEqual(6 * 60);
        }
      }
    }
  });

  test("a leg that flies the next day carries that day's date", () => {
    const viaIah = plan("LAX", "MIA").find((it) => it.via.join(">") === "IAH");
    expect(viaIah).toBeDefined();
    if (!viaIah) return;
    expect(viaIah.schedule).toBe("same_day");
    expect(viaIah.legs.map((l) => l.date)).toEqual([DATE, "2027-06-12"]);
    expect(viaIah.connection_minutes).toEqual([120]);
  });

  test("an undated plan keeps the times but names no date", () => {
    const viaDen = planItinerary(reader, "SFO", "BOS", { maxItineraries: 12 }).find(
      (it) => it.via.join(">") === "DEN"
    );
    expect(viaDen?.legs.map((l) => l.flight_number)).toEqual(["UA6001", "UA6003"]);
    expect(viaDen?.legs.every((l) => l.date === undefined)).toBe(true);
  });

  test("a time is usual only on repeated sightings", () => {
    const viaDen = plan("SFO", "BOS").find((it) => it.via.join(">") === "DEN");
    const [first, second] = viaDen?.legs ?? [];
    expect(first?.days_seen).toBe(USUAL_TIME_DAYS);
    expect(first?.time_basis).toBe("usual");
    // 6003 is on record for its one scheduled day alone.
    expect(second?.days_seen).toBe(1);
    expect(second?.time_basis === "usual").toBe(false);
  });

  test("a later leg seen on the searched weekday beats an earlier one that isn't", () => {
    const viaDen = plan("SEA", "MCO").find((it) => it.via.join(">") === "DEN");
    expect(viaDen?.legs.map((l) => l.flight_number)).toEqual(["UA6031", "UA6033"]);
    expect(viaDen?.legs[1].runs_on_date).toBe(true);
    // Undated, no weekday is asked about: the earlier connection stands.
    const undated = planItinerary(reader, "SEA", "MCO", { maxItineraries: 12 }).find(
      (it) => it.via.join(">") === "DEN"
    );
    expect(undated?.legs.map((l) => l.flight_number)).toEqual(["UA6031", "UA6032"]);
    expect(undated?.legs.every((l) => l.runs_on_date === undefined)).toBe(true);
  });

  test("the MCP planner says when a time was seen once, not 'usually'", async () => {
    const json = await mcpDirect("UA", factory, "tools/call", {
      name: "plan_starlink_itinerary",
      arguments: { origin: "SFO", destination: "BOS", date: DATE },
    });
    const text: string = json.result.content[0].text;
    expect(text).toContain("1:00 PM–7:00 PM (seen on 1 day only, not yet a usual time)");
    expect(text).not.toContain("usually 1:00 PM");
    expect(text).toContain("some seen on only one or two days");
  });

  test("the MCP planner prints each leg's usual time and the connection", async () => {
    const json = await mcpDirect("UA", factory, "tools/call", {
      name: "plan_starlink_itinerary",
      arguments: { origin: "SFO", destination: "BOS", date: DATE },
    });
    const text: string = json.result.content[0].text;
    expect(text).toContain("usually 8:00 AM–11:30 AM");
    expect(text).toContain("to connect in DEN");
    expect(text).not.toContain("UA6002");
  });
});

describe("the planner's time budget", () => {
  const it = (flying: number, stops: number, elapsed: number | null): Itinerary => ({
    via: Array.from({ length: stops }, (_, i) => `H${i}`),
    legs: [],
    joint_probability: 0.5,
    at_least_one_probability: 0.5,
    coverage: "full",
    total_flight_hours: flying,
    expected_starlink_hours: flying / 2,
    coverage_ratio: 0.5,
    elapsed_hours: elapsed,
  });
  // MSY-SFO: a 4.9h nonstop, so a 7.4h budget.
  const budget = itineraryHourBudget(4.9);

  test("a timed connection is held to the same flying yardstick as an untimed one", () => {
    // Via IAH: 5.7h flying, 2h 46m to connect, 8.5h door to door.
    expect(fitsHourBudget(it(5.7, 1, 8.5), budget)).toBe(true);
    expect(fitsHourBudget(it(5.7, 1, null), budget)).toBe(true);
    expect(fitsHourBudget(it(6.6, 1, 7.6), budget)).toBe(false);
  });

  test("a long wait still runs out of room", () => {
    expect(fitsHourBudget(it(5.7, 1, budget + 2.5), budget)).toBe(false);
  });
});

describe("an empty plan says why", () => {
  test("each reason reads as a sentence naming its cause", () => {
    expect(
      emptyPlanMessage({ kind: "over_budget", budget_hours: 7.4, nonstop_hours: 4.9 }, "SFO")
    ).toContain("4.9 hours nonstop");
    expect(emptyPlanMessage({ kind: "no_same_day", hubs: ["DEN", "IAH"] }, "SFO")).toContain(
      "reach DEN, IAH, but none flies on to SFO"
    );
    expect(emptyPlanMessage({ kind: "no_route", max_stops: 2 }, "SFO")).toContain("within 2 stops");
    expect(emptyPlanMessage({ kind: "no_route", max_stops: 0 }, "SFO")).toContain("No nonstop");
  });

  test("planRoute names a reason exactly when it offers nothing", () => {
    const sdb = makeSyntheticDb();
    try {
      const reader = createReaderFactory(sdb)("UA");
      const empty = planRoute(reader, "BIL", "ROC");
      expect(empty.itineraries).toEqual([]);
      expect(empty.empty?.kind).toBe("no_route");
    } finally {
      sdb.close();
    }
  });
});
