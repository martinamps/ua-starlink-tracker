/**
 * A flight-number band only implies the aircraft. Where our own data names the
 * aircraft on a flight, the band's fixed answer yields to it, and a type with a
 * line on the airline's chart gets that count in place of the band's blend.
 * Fixtures are built here; nothing reads the snapshot or the network.
 */

import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { AIRCRAFT_FAMILY_KEYS } from "../src/airlines/aircraft-families";
import { AIRLINES } from "../src/airlines/registry";
import { formatFactDate } from "../src/airlines/rollout-facts";
import {
  type FlightVerdict,
  resolveFlightVerdict,
  verdictSummary,
} from "../src/api/check-flight-core";
import { type FallbackSegment, setAssignmentFetcher } from "../src/api/flight-verdict";
import { usualAnswer } from "../src/components/check-flight/usual";
import { logFlightAssignments } from "../src/database/assignment-log";
import { utcDay } from "../src/database/chart-bounds";
import { createReaderFactory } from "../src/database/reader";
import { runAlaskaTrackerSync } from "../src/scripts/alaska-tracker";
import {
  type CarrierPrediction,
  carrierPrediction,
  describeCarrierPrediction,
} from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { communityWireFields } from "../src/server/community-wire";
import { bodyOf, jsonOf, makeFreshDb, mcpTool } from "./helpers";

const AS = AIRLINES.AS;
const AS_HOST = "alaskastarlinktracker.com";
const HUB_HOST = "airlinestarlinktracker.com";
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const DATE = utcDay((now + DAY) * 1000);
// Midday in Seattle and morning in Honolulu, so every fixture leg departs on DATE locally.
const DEPARTS = Math.floor(Date.parse(`${DATE}T21:00:00Z`) / 1000);
const CHART_DATE = utcDay((now - 30 * DAY) * 1000);

const TYPES = {
  e175: { type: "Embraer E175LR", airline: "AS", fleet: "horizon", n: 6, listed: 6 },
  b738: { type: "Boeing 737-800", airline: "AS", fleet: "mainline", n: 6, listed: 0 },
  max8: { type: "Boeing 737 MAX 8", airline: "AS", fleet: "mainline", n: 6, listed: 2 },
  b737: { type: "Boeing 737-700", airline: "AS", fleet: "mainline", n: 5, listed: 0 },
  b787: { type: "Boeing 787-9 Dreamliner", airline: "AS", fleet: "mainline", n: 5, listed: 0 },
  a330: { type: "Airbus A330-243", airline: "HA", fleet: "mainline", n: 4, listed: 4 },
} as const;
type TypeKey = keyof typeof TYPES;
const tail = (key: TypeKey, i: number) => `N${Object.keys(TYPES).indexOf(key)}${i}XA`;

const CHART: Array<[string, string, string]> = [
  ["Embraer 175", "6", "Update complete"],
  ["Boeing 737-800", "-", "6"],
  ["Boeing 737-8 MAX", "4", "2"],
  ["Airbus A330", "4", "Update complete"],
  ["Boeing 787 Dreamliner", "-", "5"],
];
const MONTHS = "Jan. Feb. March April May June July Aug. Sept. Oct. Nov. Dec.".split(" ");
const chartHtml = (iso: string) =>
  `<p>This chart was last updated on ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8))}, ${iso.slice(0, 4)}.</p>
<table aria-label="Starlink tracker"><thead><tr><th>Aircraft type</th><th>Connected</th><th>Pending update</th></tr></thead>
<tbody>${CHART.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

async function fleetDb(chartDate: string | null = CHART_DATE): Promise<Database> {
  const db = makeFreshDb();
  const fleet = db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
     VALUES (?, ?, 'test', ?, ?, ?, 'unknown', ?)`
  );
  const plane = db.query(
    `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, verified_wifi, airline)
     VALUES (?, 'Starlink', 'test', 'test', '2026-01-01', ?, 'test', ?, NULL, ?)`
  );
  for (const key of Object.keys(TYPES) as TypeKey[]) {
    const t = TYPES[key];
    for (let i = 0; i < t.n; i++) {
      fleet.run(tail(key, i), t.type, now, now, t.fleet, t.airline);
      if (i < t.listed) plane.run(t.type, tail(key, i), t.fleet, t.airline);
    }
  }
  if (chartDate) await runAlaskaTrackerSync(db, async () => chartHtml(chartDate));
  const routes = db.query(
    `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
     VALUES (?, ?, ?, 20000, ?, ?, 3)`
  );
  for (const [fn, o, d] of [
    ["AS121", "SEA", "HNL"],
    ["AS200", "SEA", "ANC"],
    ["AS812", "HNL", "SFO"],
    ["AS1138", "HNL", "OGG"],
  ]) {
    routes.run(fn, o, d, now, now);
  }
  return db;
}

const UNLISTED = { b787: tail("b787", 0), b738: tail("b738", 0), max8: tail("max8", 5) };

function logged(
  db: Database,
  fn: string,
  tailNumber: string,
  daysBack: number,
  route: [string, string] = ["SEA", "HNL"]
): void {
  logFlightAssignments(
    db,
    "AS",
    tailNumber,
    [
      {
        flight_number: fn,
        departure_airport: route[0],
        arrival_airport: route[1],
        departure_time: DEPARTS - daysBack * DAY,
        arrival_time: DEPARTS - daysBack * DAY + 5 * 3600,
      },
    ],
    now
  );
}

const segment = (tailNumber: string, model: string, route = ["SEA", "HNL"]): FallbackSegment => ({
  tail_number: tailNumber,
  aircraft_model: model,
  origin: route[0],
  destination: route[1],
  departure_time: DEPARTS,
  arrival_time: DEPARTS + 5 * 3600,
  hasStarlink: null,
  confidence: "unknown",
});

type Answered = Extract<FlightVerdict, { kind: "no_model" }>;

async function typeAnswer(
  db: Database,
  fn: string,
  deps: Parameters<typeof resolveFlightVerdict>[4] = { lookupTail: null }
): Promise<Answered> {
  const v = await resolveFlightVerdict(AS, createReaderFactory(db)("AS"), fn, DATE, deps);
  if (v.kind !== "no_model") throw new Error(`${fn}: ${v.kind}`);
  return v;
}

const live = (tailNumber: string, model: string) => ({
  lookupTail: async () => [segment(tailNumber, model)],
});

const undated = (db: Database, fn: string) =>
  carrierPrediction(AS, createReaderFactory(db)("AS"), fn);

function penetration(answer: CarrierPrediction) {
  if (answer.kind !== "penetration") throw new Error(answer.kind);
  return answer;
}

describe("the bands declare the aircraft they speak for", () => {
  test("every declared family is one the type normalizer returns, in one band per airline", () => {
    for (const cfg of Object.values(AIRLINES)) {
      const declared = cfg.subfleets.flatMap((s) => s.families ?? []);
      for (const family of declared) expect(AIRCRAFT_FAMILY_KEYS).toContain(family);
      expect(new Set(declared).size).toBe(declared.length);
    }
  });

  test("a band with a fixed answer names its aircraft, so it can yield", () => {
    const fixed = AS.subfleets.filter((s) => s.penetrationOverride != null);
    expect(fixed.length).toBeGreaterThan(0);
    for (const s of fixed) expect(s.families?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("a fixed band yields to a known aircraft of another type", () => {
  test.each([
    ["a 787 on a Hawaiian-block number", "AS812", UNLISTED.b787, "Boeing 787-9", /787/],
    ["a 737 on a Hawaiian-block number", "AS814", UNLISTED.b738, "Boeing 737-890", /737-800/],
  ])("%s is not a flat yes", async (_name, fn, tailNumber, model, names) => {
    const db = await fleetDb();
    const blockOnly = penetration(undated(db, fn));
    expect(blockOnly.pen.pct).toBe(1);
    expect(blockOnly.aircraft).toBeUndefined();

    const v = await typeAnswer(db, fn, live(tailNumber, model));
    const answer = penetration(v.answer);
    expect(answer.sf.key).toBe("mainline");
    expect(answer.aircraft?.basis).toBe("scheduled");
    expect(answer.aircraft?.tail).toBe(tailNumber);
    const summary = verdictSummary(v);
    expect(summary.hasStarlink).toBeNull();
    expect(summary.probability).toBeLessThan(1);
    const said = describeCarrierPrediction(AS, v.answer, { date: DATE });
    expect(said).toContain(tailNumber);
    expect(said).toMatch(names);
    expect(said).not.toMatch(/every .* has Starlink/i);
    expect(communityWireFields(v.answer)).toEqual({
      assignment: { tail_number: tailNumber, aircraft_type: expect.any(String) },
    });
    db.close();
  });

  test("a 737 on an interisland number is answered as a 737, not as a 717", async () => {
    const db = await fleetDb();
    const blockOnly = penetration(undated(db, "AS1138"));
    expect(blockOnly.sf.key).toBe("hawaiian_interisland");

    const v = await typeAnswer(db, "AS1138", live(UNLISTED.b738, "Boeing 737-890"));
    const answer = penetration(v.answer);
    expect(answer.sf.key).toBe("mainline");
    expect(answer.aircraft?.count?.family).toBe("B737-800");
    const said = describeCarrierPrediction(AS, v.answer, { date: DATE });
    expect(said).toContain(UNLISTED.b738);
    expect(said).toMatch(/737-800/);
    expect(said).not.toMatch(/717 aircraft \(AS1000-1299\) don't have Starlink/);
    db.close();
  });

  test("an aircraft of the band's own type leaves the band's answer alone", async () => {
    const db = await fleetDb();
    const before = undated(db, "AS812");
    // An unlisted A330 the lookup names: no yes is granted beyond the band's own.
    const v = await typeAnswer(db, "AS812", live("N999ZZ", "Airbus A330-243"));
    expect(v.answer).toEqual(before);
    db.close();
  });

  test("without a chart the band still yields, to a count made tail by tail", async () => {
    const db = await fleetDb(null);
    const v = await typeAnswer(db, "AS812", live(UNLISTED.b787, "Boeing 787-9"));
    const answer = penetration(v.answer);
    expect(answer.aircraft?.count).toBeNull();
    expect(answer.pen.synthetic).toBe(false);
    expect(verdictSummary(v).probability).toBeLessThan(1);
    expect(describeCarrierPrediction(AS, v.answer)).toContain(UNLISTED.b787);
    db.close();
  });

  test("a type string the normalizer can't place decides nothing", async () => {
    const db = await fleetDb();
    const v = await typeAnswer(db, "AS812", live("N777ZZ", "X99"));
    expect(v.answer).toEqual(undated(db, "AS812"));
    db.close();
  });

  test("another fixed band's aircraft on an interisland number is not called a 717", async () => {
    const db = await fleetDb();
    const v = await typeAnswer(db, "AS1138", live("N999ZZ", "Airbus A330-243"));
    expect(v.answer.kind).toBe("no_model");
    expect(verdictSummary(v).probability).toBeNull();
    const said = describeCarrierPrediction(AS, v.answer);
    expect(said).toMatch(/A330/);
    expect(said).not.toMatch(/717 aircraft \(AS1000-1299\) don't have Starlink/);
    db.close();
  });

  test("a type with no home band withdraws the yes and gives no number", async () => {
    const db = await fleetDb();
    const v = await typeAnswer(db, "AS812", live("N777ZZ", "Airbus A220-300"));
    expect(v.answer.kind).toBe("no_model");
    expect(verdictSummary(v).probability).toBeNull();
    expect(describeCarrierPrediction(AS, v.answer)).toContain("N777ZZ");
    db.close();
  });
});

describe("a known type gets the airline's own dated count", () => {
  test("a 787 on a mainline number quotes the chart's 787 line, with its date and owner", async () => {
    const db = await fleetDb();
    const blend = penetration(undated(db, "AS121"));
    expect(blend.aircraft).toBeUndefined();

    const v = await typeAnswer(db, "AS121", live(UNLISTED.b787, "Boeing 787-9"));
    const answer = penetration(v.answer);
    const line = CHART.find((r) => r[0].includes("787"));
    expect(answer.aircraft?.count).toMatchObject({
      family: "B787",
      connected: 0,
      total: Number(line?.[2]),
      asOf: CHART_DATE,
    });
    expect(verdictSummary(v).probability).toBe(0);
    expect(verdictSummary(v).hasStarlink).toBeNull();
    const said = describeCarrierPrediction(AS, v.answer, { date: DATE });
    expect(said).toContain(`${AS.shortName}'s own chart`);
    expect(said).toContain(formatFactDate(CHART_DATE));
    expect(said).toContain(UNLISTED.b787);
    expect(said).not.toContain("mainline");
    db.close();
  });

  test("an unlisted tail's odds leave out the aircraft we already name", async () => {
    const db = await fleetDb();
    const v = await typeAnswer(db, "AS414", live(UNLISTED.max8, "Boeing 737 MAX 8"));
    const count = penetration(v.answer).aircraft?.count;
    if (!count) throw new Error("no count");
    expect(count.named).toBe(TYPES.max8.listed);
    expect(count.connected).toBeGreaterThan(count.named);
    expect(verdictSummary(v).probability).toBeCloseTo(
      (count.connected - count.named) / (count.total - count.named)
    );
    expect(verdictSummary(v).probability).toBeLessThan(count.connected / count.total);
    expect(describeCarrierPrediction(AS, v.answer)).toContain(UNLISTED.max8);
    db.close();
  });

  test("a type the chart has no line for keeps the band's answer", async () => {
    const db = await fleetDb();
    const before = undated(db, "AS418");
    const v = await typeAnswer(db, "AS418", live(tail("b737", 0), "Boeing 737-790"));
    expect(v.answer).toEqual(before);
    expect(communityWireFields(v.answer)).toEqual({});
    db.close();
  });

  test("a chart past its age bound is not quoted", async () => {
    const db = await fleetDb(utcDay((now - 200 * DAY) * 1000));
    const before = undated(db, "AS121");
    const v = await typeAnswer(db, "AS121", live(UNLISTED.b787, "Boeing 787-9"));
    expect(v.answer).toEqual(before);
    db.close();
  });
});

describe("where the aircraft comes from", () => {
  test("no known aircraft: every band answers as it did", async () => {
    const db = await fleetDb();
    for (const fn of ["AS121", "AS200", "AS812", "AS1138", "AS2100", "AS9100"]) {
      const v = await typeAnswer(db, fn, { lookupTail: async () => [] });
      expect(v.answer).toEqual(undated(db, fn));
      expect(penetrationOrNull(v.answer)?.aircraft).toBeUndefined();
      expect(communityWireFields(v.answer)).toEqual({});
    }
    db.close();
  });

  test("the log answers the same without a live lookup (the hub's path)", async () => {
    const db = await fleetDb();
    logged(db, "AS812", UNLISTED.b787, 0, ["HNL", "SFO"]);
    const v = await typeAnswer(db, "AS812");
    expect(penetration(v.answer).aircraft?.tail).toBe(UNLISTED.b787);
    expect(verdictSummary(v).probability).toBeLessThan(1);
    db.close();
  });

  test("a leg the logged aircraft does not fly is not answered from it", async () => {
    const db = await fleetDb();
    logged(db, "AS812", UNLISTED.b787, 0, ["HNL", "SFO"]);
    const other = await typeAnswer(db, "AS812", { lookupTail: null, leg: { origin: "OGG" } });
    expect(penetrationOrNull(other.answer)?.aircraft?.basis).not.toBe("scheduled");
    const same = await typeAnswer(db, "AS812", { lookupTail: null, leg: { origin: "HNL" } });
    expect(penetration(same.answer).aircraft?.tail).toBe(UNLISTED.b787);
    db.close();
  });

  test("the aircraft on the asked date outranks what flew the number on other days", async () => {
    const db = await fleetDb();
    logged(db, "AS121", UNLISTED.b787, 1);
    logged(db, "AS121", tail("b787", 1), 2);
    expect(penetration(undated(db, "AS121")).aircraft?.basis).toBe("logged");
    const v = await typeAnswer(db, "AS121", live(tail("b737", 0), "Boeing 737-790"));
    expect(penetration(v.answer).aircraft).toBeUndefined();
    db.close();
  });

  test("a listed tail left in the log by a swap decides nothing", async () => {
    const db = await fleetDb();
    logged(db, "AS414", tail("max8", 0), 0, ["SEA", "LAX"]);
    const v = await typeAnswer(db, "AS414");
    expect(penetration(v.answer).aircraft).toBeUndefined();
    db.close();
  });

  test("undated, a mainline number narrows only on two or more untracked departures of one type", async () => {
    const db = await fleetDb();
    logged(db, "AS121", UNLISTED.b787, 1);
    expect(penetration(undated(db, "AS121")).aircraft).toBeUndefined();
    logged(db, "AS121", tail("b787", 1), 2);
    const narrowed = penetration(undated(db, "AS121"));
    expect(narrowed.aircraft?.basis).toBe("logged");
    expect(narrowed.aircraft?.tail).toBeNull();
    expect(narrowed.aircraft?.count?.family).toBe("B787");
    expect(narrowed.pen.pct).toBe(0);

    for (const back of [1, 2, 3]) logged(db, "AS414", tail("max8", 0), back, ["SEA", "LAX"]);
    expect(penetration(undated(db, "AS414")).aircraft).toBeUndefined();

    logged(db, "AS416", UNLISTED.b738, 1, ["SEA", "SFO"]);
    logged(db, "AS416", UNLISTED.max8, 2, ["SEA", "SFO"]);
    expect(penetration(undated(db, "AS416")).aircraft).toBeUndefined();
    db.close();
  });

  test("undated, one stray departure on a fixed band withdraws the flat answer", async () => {
    const db = await fleetDb();
    for (const back of [1, 2, 3]) logged(db, "AS816", tail("a330", 0), back, ["HNL", "LAX"]);
    expect(penetration(undated(db, "AS816")).pen.pct).toBe(1);
    logged(db, "AS816", UNLISTED.b787, 4, ["HNL", "LAX"]);
    const mixed = undated(db, "AS816");
    if (mixed.kind !== "no_model") throw new Error(mixed.kind);
    expect(mixed.aircraft?.basis).toBe("logged");
    expect(mixed.reason).toMatch(/A330/);
    expect(mixed.reason).toMatch(/787/);

    logged(db, "AS1138", UNLISTED.b738, 1, ["HNL", "OGG"]);
    expect(penetration(undated(db, "AS1138")).sf.key).toBe("mainline");
    db.close();
  });

  test("a swap leaves two tails on a departure; the later sighting is the aircraft", async () => {
    const db = await fleetDb();
    logFlightAssignments(
      db,
      "AS",
      tail("a330", 3),
      [
        {
          flight_number: "AS812",
          departure_airport: "HNL",
          arrival_airport: "SFO",
          departure_time: DEPARTS,
          arrival_time: DEPARTS + 5 * 3600,
        },
      ],
      now - 3600
    );
    logged(db, "AS812", UNLISTED.b787, 0, ["HNL", "SFO"]);
    const rows = createReaderFactory(db)("AS").getLoggedAircraft(["AS812"], DATE);
    expect(rows.map((r) => r.tail_number)).toEqual([UNLISTED.b787]);
    db.close();
  });
});

function penetrationOrNull(answer: CarrierPrediction) {
  return answer.kind === "penetration" ? answer : null;
}

describe("the page, the API and the MCP say the same", () => {
  afterAll(() => setAssignmentFetcher(null));

  test("a 787 on a Hawaiian-block number, through the app", async () => {
    const db = await fleetDb();
    const app = createApp(db);
    setAssignmentFetcher(async (fn) =>
      fn === "AS812"
        ? [
            {
              tail_number: UNLISTED.b787,
              aircraft_model: "Boeing 787-9",
              origin: "HNL",
              destination: "SFO",
              departure_time: DEPARTS,
              arrival_time: DEPARTS + 5 * 3600,
            },
          ]
        : []
    );
    const path = (fn: string) => `/api/check-flight?flight_number=${fn}&date=${DATE}`;

    const untouched = await jsonOf(app, path("AS200"), AS_HOST);
    expect(Object.keys(untouched).sort()).toEqual(
      ["confidence", "flights", "hasStarlink", "message", "prediction"].sort()
    );

    const body = await jsonOf(app, path("AS812"), AS_HOST);
    expect(Object.keys(body).sort()).toEqual([...Object.keys(untouched), "assignment"].sort());
    expect(body.hasStarlink).toBeNull();
    expect(body.confidence).toBe("type");
    expect(body.prediction.probability).toBeLessThan(1);
    expect(body.assignment.tail_number).toBe(UNLISTED.b787);
    expect(body.message).toContain(UNLISTED.b787);

    const hub = await jsonOf(
      app,
      `/api/check-any-flight?flight_number=AS812&date=${DATE}`,
      HUB_HOST
    );
    expect(hub.hasStarlink).toBeNull();
    expect(hub.probability).toBe(body.prediction.probability);
    expect(hub.reason).toBe(body.message);

    const mcp = await mcpTool(app, AS_HOST, "check_flight", { flight_number: "AS812", date: DATE });
    expect(mcp.isError).toBe(false);
    expect(mcp.text).toContain(body.message);
    expect(mcp.text).not.toContain("no assignment data");

    const predict = await jsonOf(app, "/api/predict-flight?flight_number=AS812", AS_HOST);
    expect(predict.probability).toBeLessThan(1);
    expect(predict.message).toMatch(/787/);

    const page = await bodyOf(app, "/check-flight/AS812", AS_HOST);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/787-9/);
    expect(page.text).not.toContain("and every one has Starlink");
    const dated = await bodyOf(app, `/check-flight/AS812/${DATE}`, AS_HOST);
    expect(dated.text).toContain(UNLISTED.b787);
    expect(dated.text).not.toContain("every aircraft that flies AS812 has Starlink");
    expect(dated.text).not.toMatch(/We don(&#x27;|')t have the aircraft assignment yet/);
    db.close();
  });

  test("the page's figure is the airline's count, never a yes or no it can't carry", () => {
    const facts = {
      flightNumber: "AS121",
      airlineName: AS.name,
      observedTotal: 0,
      observedStarlink: 0,
      aircraftTypes: [],
      lastStarlink: null,
      routes: [],
      upcoming: [],
      siblings: [],
    };
    const counted = usualAnswer({
      ...facts,
      typeRule: {
        probability: 0,
        label: "Mainline (737/787)",
        aircraft: "The 3 departures were all flown by the 787-9.",
        count: { connected: 0, total: 5, asOf: CHART_DATE },
      },
    });
    expect(counted.figure).toBe("0 of 5");
    expect(counted.caption).toContain(AS.name);
    expect(counted.sentence).not.toMatch(/^No:/);

    const depends = usualAnswer({
      ...facts,
      typeRule: { probability: null, label: "", aircraft: "AS816 flew on two types." },
    });
    expect(depends.figure).not.toMatch(/^(Yes|No|\d)/);
    expect(depends.sentence).toBe("AS816 flew on two types.");

    const band = usualAnswer({
      ...facts,
      typeRule: { probability: 1, label: "Hawaiian-operated (A330/A321neo)" },
    });
    expect(band.figure).toBe("Yes");
  });
});
