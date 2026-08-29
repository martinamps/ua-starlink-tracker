/**
 * MCP structuredContent + outputSchema shape tests. Structured output is
 * additive alongside the prose text blocks: provenance (source + evidence
 * class), freshness stamps, and per-tail evidence URLs (/tail/{registration}).
 * Shape-not-values — must survive snapshot drift.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/server/app";
import {
  addFlight,
  addPlane,
  addQatarRow,
  makeSyntheticDb,
  openSnapshot,
  postMcp,
  utc,
} from "./helpers";

const UA = "unitedstarlinktracker.com";
const AS = "alaskastarlinktracker.com";
const HUB = "airlinestarlinktracker.com";
const QR = "qatarstarlinktracker.com";

const EVIDENCE_CLASSES = ["observed", "fleet_data", "type_derived", "predicted", "none"];

let db: Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

async function callTool(host: string, name: string, args: Record<string, unknown>) {
  const j = await postMcp(app, host, "tools/call", { name, arguments: args });
  return j.result as {
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

function expectProvenance(sc: Record<string, unknown> | undefined) {
  expect(sc).toBeDefined();
  const p = (sc as Record<string, unknown>).provenance as Record<string, unknown>;
  expect(p).toBeDefined();
  expect(typeof p.source).toBe("string");
  expect(EVIDENCE_CLASSES).toContain(p.evidence);
  expect(typeof p.retrieved_at).toBe("string");
  expect(Number.isNaN(Date.parse(p.retrieved_at as string))).toBe(false);
  if (p.data_updated_at !== null) {
    expect(Number.isNaN(Date.parse(p.data_updated_at as string))).toBe(false);
  }
  return p;
}

describe("tools/list outputSchema", () => {
  test("every tool declares an outputSchema with required provenance", async () => {
    const j = await postMcp(app, UA, "tools/list", {});
    const tools = j.result.tools as Array<{
      name: string;
      outputSchema?: Record<string, unknown>;
    }>;
    expect(tools.length).toBe(7);
    for (const t of tools) {
      expect(t.outputSchema, `${t.name} missing outputSchema`).toBeDefined();
      const schema = t.outputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      const props = schema.properties as Record<string, unknown>;
      expect(props.provenance, `${t.name} outputSchema lacks provenance`).toBeDefined();
      expect(schema.required as string[]).toContain("provenance");
      // Anthropic API rejects these at the top level — same rule as inputSchema.
      for (const k of ["oneOf", "allOf", "anyOf", "not", "$ref", "if", "then", "else"]) {
        expect(schema).not.toHaveProperty(k);
      }
    }
  });
});

describe("check_flight structuredContent", () => {
  test("prediction branch: verdict unknown, predicted evidence, probability in range", async () => {
    // UA5212's express prior is ≥20%, so the alternatives block (live FR24
    // route lookup) never fires — no network.
    const r = await callTool(UA, "check_flight", {
      flight_number: "UA5212",
      date: "2099-01-01",
    });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as Record<string, unknown>;
    const p = expectProvenance(sc);
    expect(p.evidence).toBe("predicted");
    expect(sc.flight_number).toBe("UA5212");
    expect(sc.date).toBe("2099-01-01");
    expect(sc.verdict).toBe("unknown");
    expect(sc.probability as number).toBeGreaterThanOrEqual(0);
    expect(sc.probability as number).toBeLessThanOrEqual(1);
    expect(typeof sc.n_observations).toBe("number");
  });

  test("scheduled branch: verdict yes, observed evidence, per-tail evidence URL", async () => {
    const sdb = makeSyntheticDb();
    addPlane(sdb, "N1001", "Starlink");
    // Far-future date keeps FR24 out of its lookup window — no network.
    addFlight(sdb, "N1001", "UA111", "SFO", utc("2027-06-10T05:35:00Z"));
    const sapp = createApp(sdb);
    const j = await postMcp(sapp, UA, "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA111", date: "2027-06-09" },
    });
    const sc = j.result.structuredContent as Record<string, unknown>;
    const p = expectProvenance(sc);
    expect(p.evidence).toBe("observed");
    expect(sc.verdict).toBe("yes");
    expect(sc.confidence).toBe("verified");
    const flights = sc.flights as Array<Record<string, unknown>>;
    expect(flights.length).toBe(1);
    const tail = flights[0].tail as Record<string, unknown>;
    expect(tail.registration).toBe("N1001");
    expect(tail.evidence_url).toBe("https://unitedstarlinktracker.com/tail/N1001");
    sdb.close();
  });

  test("qatar branch: type_derived evidence, tri-state verdict word", async () => {
    const sdb = makeSyntheticDb();
    // Midday UTC keeps DOH's local calendar date equal to the UTC date.
    addQatarRow(sdb, "QR1", utc("2027-03-10T09:00:00Z"), "Starlink");
    const sapp = createApp(sdb);
    const j = await postMcp(sapp, QR, "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "QR1", date: "2027-03-10" },
    });
    const sc = j.result.structuredContent as Record<string, unknown>;
    const p = expectProvenance(sc);
    expect(p.evidence).toBe("type_derived");
    expect(sc.verdict).toBe("yes");
    sdb.close();
  });

  test("error result carries no structuredContent (spec: errors are exempt)", async () => {
    const r = await callTool(UA, "check_flight", {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });
});

describe("fleet + aircraft structuredContent", () => {
  test("get_fleet_stats (airline scope): counts, subfleets, provenance", async () => {
    const r = await callTool(UA, "get_fleet_stats", {});
    const sc = r.structuredContent as Record<string, unknown>;
    expectProvenance(sc);
    expect(sc.airline).toBe("UA");
    expect(sc.starlink_count as number).toBeGreaterThan(0);
    expect(sc.total_count as number).toBeGreaterThan(0);
    expect(sc.percentage as number).toBeGreaterThan(0);
    expect(sc.percentage as number).toBeLessThanOrEqual(100);
    const sub = sc.subfleets as Record<string, Record<string, number>>;
    expect(typeof sub.express.total).toBe("number");
    expect(typeof sub.mainline.total).toBe("number");
  });

  test("get_fleet_stats (hub scope): per-airline breakdown, airline null", async () => {
    const r = await callTool(HUB, "get_fleet_stats", {});
    const sc = r.structuredContent as Record<string, unknown>;
    expectProvenance(sc);
    expect(sc.airline).toBeNull();
    const airlines = sc.airlines as Array<Record<string, unknown>>;
    expect(airlines.length).toBeGreaterThan(0);
    for (const a of airlines) {
      expect(typeof a.airline).toBe("string");
      expect(typeof a.starlink_count).toBe("number");
      expect(typeof a.total_count).toBe("number");
    }
  });

  test("list_starlink_aircraft: per-tail evidence URLs on an airline scope", async () => {
    const r = await callTool(UA, "list_starlink_aircraft", { limit: 5 });
    const sc = r.structuredContent as Record<string, unknown>;
    expectProvenance(sc);
    expect(sc.total as number).toBeGreaterThan(0);
    const aircraft = sc.aircraft as Array<Record<string, unknown>>;
    expect(aircraft.length).toBeGreaterThan(0);
    expect(aircraft.length).toBeLessThanOrEqual(5);
    for (const a of aircraft) {
      expect(typeof a.registration).toBe("string");
      expect(a.evidence_url).toMatch(
        new RegExp(`^https://unitedstarlinktracker\\.com/tail/${a.registration}$`)
      );
    }
  });

  test("list_starlink_aircraft: hub rows carry no guessed evidence host", async () => {
    const r = await callTool(HUB, "list_starlink_aircraft", { limit: 3 });
    const sc = r.structuredContent as Record<string, unknown>;
    expectProvenance(sc);
    for (const a of sc.aircraft as Array<Record<string, unknown>>) {
      // Hub aircraft rows have no airline attribution — null beats a wrong host.
      expect(a.evidence_url).toBeNull();
    }
  });
});

describe("prediction tools structuredContent", () => {
  test("predict_flight_starlink (UA model): probability + method + provenance", async () => {
    // Express-band prior ≥20% — the alternatives block (live FR24) never fires.
    const r = await callTool(UA, "predict_flight_starlink", { flight_number: "UA5212" });
    const sc = r.structuredContent as Record<string, unknown>;
    const p = expectProvenance(sc);
    expect(p.evidence).toBe("predicted");
    expect(sc.flight_number).toBe("UA5212");
    expect(sc.probability as number).toBeGreaterThanOrEqual(0);
    expect(sc.probability as number).toBeLessThanOrEqual(1);
    expect(typeof sc.method).toBe("string");
  });

  test("predict_flight_starlink (model-less carrier): type_derived provenance", async () => {
    const r = await callTool(AS, "predict_flight_starlink", { flight_number: "1" });
    const sc = r.structuredContent as Record<string, unknown>;
    const p = expectProvenance(sc);
    expect(p.evidence).toBe("type_derived");
    expect(sc.confidence).toBe("type");
  });

  test("predict_route_starlink: per-flight predictions ride in structure", async () => {
    const route = db
      .query(
        `SELECT departure_airport, arrival_airport, COUNT(*) as n
         FROM upcoming_flights WHERE airline = 'UA'
         GROUP BY departure_airport, arrival_airport
         ORDER BY n DESC LIMIT 1`
      )
      .get() as { departure_airport: string; arrival_airport: string };
    const r = await callTool(UA, "predict_route_starlink", {
      origin: route.departure_airport,
      destination: route.arrival_airport,
    });
    const sc = r.structuredContent as Record<string, unknown>;
    expectProvenance(sc);
    const flights = sc.flights as Array<Record<string, unknown>>;
    expect(Array.isArray(flights)).toBe(true);
    for (const f of flights) {
      expect(typeof f.flight_number).toBe("string");
      expect(f.probability as number).toBeGreaterThanOrEqual(0);
      expect(f.probability as number).toBeLessThanOrEqual(1);
      expect(typeof f.n_observations).toBe("number");
    }
  });

  test("plan_starlink_itinerary: itineraries with legs in structure", async () => {
    const routes = db
      .query(
        `SELECT departure_airport, arrival_airport, COUNT(*) as n
         FROM upcoming_flights WHERE airline = 'UA'
         GROUP BY departure_airport, arrival_airport
         ORDER BY n DESC LIMIT 5`
      )
      .all() as Array<{ departure_airport: string; arrival_airport: string }>;
    for (const route of routes) {
      const r = await callTool(UA, "plan_starlink_itinerary", {
        origin: route.departure_airport,
        destination: route.arrival_airport,
      });
      const sc = r.structuredContent as Record<string, unknown>;
      expectProvenance(sc);
      expect(sc.origin).toBe(route.departure_airport);
      const its = sc.itineraries as Array<Record<string, unknown>>;
      expect(Array.isArray(its)).toBe(true);
      if (its.length === 0) continue;
      const legs = its[0].legs as Array<Record<string, unknown>>;
      expect(legs.length).toBeGreaterThan(0);
      expect(typeof legs[0].flight_number).toBe("string");
      expect(typeof legs[0].probability).toBe("number");
      return; // one populated result is enough
    }
  });

  test("hub route tools: per-airline comparison in structure", async () => {
    const r = await callTool(HUB, "plan_starlink_itinerary", {
      origin: "SEA",
      destination: "LAX",
    });
    const sc = r.structuredContent as Record<string, unknown>;
    expectProvenance(sc);
    const airlines = sc.airlines as Array<Record<string, unknown>>;
    expect(Array.isArray(airlines)).toBe(true);
    for (const a of airlines) {
      expect(typeof a.airline).toBe("string");
      expect(typeof a.kind).toBe("string");
    }
  });
});

describe("search_starlink_flights structuredContent", () => {
  test("confirmed flights carry tails + data horizon", async () => {
    const r = await callTool(UA, "search_starlink_flights", { origin: "IAH" });
    const sc = r.structuredContent as Record<string, unknown>;
    expectProvenance(sc);
    expect(typeof sc.total).toBe("number");
    expect(typeof sc.shown).toBe("number");
    expect(typeof sc.data_horizon).toBe("string");
    const flights = sc.flights as Array<Record<string, unknown>>;
    expect(Array.isArray(flights)).toBe(true);
    for (const f of flights) {
      expect(typeof f.flight_number).toBe("string");
      const tail = f.tail as Record<string, unknown>;
      expect(typeof tail.registration).toBe("string");
    }
  });
});
