/**
 * Integration tests — lock down public API contracts and MCP protocol.
 *
 * These tests run against a read-only copy of the production database at
 * /tmp/ua-test.sqlite. They assert on RESPONSE SHAPES, not specific values,
 * so they don't break as data changes.
 *
 * Critical contracts:
 *  - /api/check-flight: Chrome extension depends on { hasStarlink, flights[] }
 *  - /api/data: website depends on { totalCount, starlinkPlanes, fleetStats, flightsByTail }
 *  - MCP: JSON-RPC 2.0 protocol + tool schemas
 *
 * Run with: bun test tests/
 */

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { resolveTailVerdict } from "../src/api/flight-verdict";
import { handleMcpRequest } from "../src/api/mcp-server";
import {
  computeWifiConsensus,
  getFleetPageData,
  getFleetStats,
  getLastUpdated,
  getStarlinkPlanes,
  getTotalCount,
  getUpcomingFlights,
} from "../src/database/database";
import { computePrecision } from "../src/scripts/precision-backtest";
import { planItinerary, predictFlight, predictRoute } from "../src/scripts/starlink-predictor";
import { computeSurfaceContradictions } from "../src/scripts/surface-sweep";
import { type ScopedReader, createReaderFactory } from "../src/server/context";
import type { ApiResponse, Flight } from "../src/types";
import {
  buildFlightNumberVariants,
  ensureUAPrefix,
  inferFleet,
  normalizeFlightNumber,
} from "../src/utils/constants";

const TEST_DB = "/tmp/ua-test.sqlite";
let db: Database;
let reader: ScopedReader;

beforeAll(() => {
  db = new Database(TEST_DB, { readonly: true });
  reader = createReaderFactory(db)("UA");
  // Sanity check: DB has data
  const count = db.query("SELECT COUNT(*) as n FROM starlink_planes").get() as { n: number };
  if (count.n < 10) {
    throw new Error(`Test DB has only ${count.n} planes — did you copy prod data?`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/check-flight contract — Chrome extension depends on this shape
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/check-flight contract", () => {
  // Reconstructs the handler's response shape using the same queries as server.ts.
  // If someone changes the server.ts handler, they need to update this OR extract
  // the handler to a testable module. Either way, the contract is documented here.
  function checkFlightResponse(flightNumber: string, date: string) {
    const dateObj = new Date(`${date}T00:00:00Z`);
    const startOfDay = Math.floor(dateObj.getTime() / 1000);
    const endOfDay = startOfDay + 86400;

    const normalized = ensureUAPrefix(flightNumber);
    const variants = buildFlightNumberVariants(normalized);
    const placeholders = variants.map(() => "?").join(", ");

    const rows = db
      .query(
        `SELECT uf.*, sp.Aircraft as aircraft_type, sp.WiFi, sp.DateFound, sp.OperatedBy, sp.fleet
         FROM upcoming_flights uf
         INNER JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
         WHERE uf.flight_number IN (${placeholders})
           AND uf.departure_time >= ? AND uf.departure_time < ?
           AND (sp.verified_wifi IS NULL OR sp.verified_wifi = 'Starlink')
         ORDER BY uf.departure_time ASC`
      )
      .all(...variants, startOfDay, endOfDay) as Array<
      Flight & {
        aircraft_type: string;
        WiFi: string;
        DateFound: string;
        OperatedBy: string;
        fleet: string;
      }
    >;

    if (rows.length === 0) {
      return { hasStarlink: false, flights: [] };
    }

    return {
      hasStarlink: true,
      flights: rows.map((f) => ({
        tail_number: f.tail_number,
        aircraft_type: f.aircraft_type,
        flight_number: f.flight_number,
        ua_flight_number: normalizeFlightNumber(f.flight_number),
        departure_airport: f.departure_airport,
        arrival_airport: f.arrival_airport,
        departure_time: f.departure_time,
        arrival_time: f.arrival_time,
        departure_time_formatted: new Date(f.departure_time * 1000).toISOString(),
        arrival_time_formatted: new Date(f.arrival_time * 1000).toISOString(),
        operated_by: f.OperatedBy,
        fleet_type: f.fleet,
      })),
    };
  }

  test("miss: returns { hasStarlink: false, flights: [] }", () => {
    const resp = checkFlightResponse("UA99999", "2099-01-01");
    expect(resp.hasStarlink).toBe(false);
    expect(Array.isArray(resp.flights)).toBe(true);
    expect(resp.flights.length).toBe(0);
  });

  test("hit: returns { hasStarlink: true, flights: [...] } with full field shape", () => {
    // Find ANY real flight in the DB so this test is stable across data refreshes
    const sample = db
      .query(
        `SELECT uf.flight_number, date(uf.departure_time, 'unixepoch') as d
         FROM upcoming_flights uf
         JOIN starlink_planes sp ON uf.tail_number = sp.TailNumber
         WHERE uf.airline = 'UA'
           AND (sp.verified_wifi IS NULL OR sp.verified_wifi = 'Starlink')
         LIMIT 1`
      )
      .get() as { flight_number: string; d: string } | null;

    expect(sample).not.toBeNull();
    const resp = checkFlightResponse(normalizeFlightNumber(sample!.flight_number), sample!.d);

    expect(resp.hasStarlink).toBe(true);
    expect(resp.flights.length).toBeGreaterThan(0);

    const f = resp.flights[0];
    // These fields are the Chrome extension contract — do not break
    expect(typeof f.tail_number).toBe("string");
    expect(typeof f.aircraft_type).toBe("string");
    expect(typeof f.flight_number).toBe("string");
    expect(typeof f.ua_flight_number).toBe("string");
    expect(f.ua_flight_number).toMatch(/^UA\d+$/);
    expect(typeof f.departure_airport).toBe("string");
    expect(typeof f.arrival_airport).toBe("string");
    expect(typeof f.departure_time).toBe("number");
    expect(typeof f.arrival_time).toBe("number");
    expect(typeof f.departure_time_formatted).toBe("string");
    expect(typeof f.arrival_time_formatted).toBe("string");
    expect(typeof f.operated_by).toBe("string");
    expect(typeof f.fleet_type).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/data contract — website depends on this shape
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/data contract", () => {
  test("returns ApiResponse shape", () => {
    const resp: ApiResponse = {
      totalCount: getTotalCount(db, "UA"),
      starlinkPlanes: getStarlinkPlanes(db, "UA"),
      lastUpdated: getLastUpdated(db, "UA"),
      fleetStats: getFleetStats(db, "UA"),
      flightsByTail: {},
    };

    // Group flights (same as server.ts)
    for (const f of getUpcomingFlights(db, undefined, "UA")) {
      if (!resp.flightsByTail[f.tail_number]) resp.flightsByTail[f.tail_number] = [];
      resp.flightsByTail[f.tail_number].push(f);
    }

    expect(typeof resp.totalCount).toBe("number");
    expect(resp.totalCount).toBeGreaterThan(0);
    expect(Array.isArray(resp.starlinkPlanes)).toBe(true);
    expect(resp.starlinkPlanes.length).toBeGreaterThan(0);
    expect(typeof resp.lastUpdated).toBe("string");

    // fleetStats shape
    expect(typeof resp.fleetStats.express.total).toBe("number");
    expect(typeof resp.fleetStats.express.starlink).toBe("number");
    expect(typeof resp.fleetStats.express.percentage).toBe("number");
    expect(typeof resp.fleetStats.mainline.total).toBe("number");
    expect(typeof resp.fleetStats.mainline.starlink).toBe("number");
    expect(typeof resp.fleetStats.mainline.percentage).toBe("number");

    // Aircraft shape
    const plane = resp.starlinkPlanes[0];
    expect(typeof plane.Aircraft).toBe("string");
    expect(typeof plane.TailNumber).toBe("string");
    expect(typeof plane.OperatedBy).toBe("string");
    expect(["express", "mainline"]).toContain(plane.fleet);

    // flightsByTail shape — skip if snapshot's upcoming_flights is stale/empty
    const tails = Object.keys(resp.flightsByTail);
    if (tails.length > 0) {
      const f = resp.flightsByTail[tails[0]][0];
      expect(typeof f.tail_number).toBe("string");
      expect(typeof f.flight_number).toBe("string");
      expect(typeof f.departure_airport).toBe("string");
      expect(typeof f.arrival_airport).toBe("string");
      expect(typeof f.departure_time).toBe("number");
      expect(typeof f.arrival_time).toBe("number");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP protocol — JSON-RPC 2.0 envelope + tool schemas
// ─────────────────────────────────────────────────────────────────────────────

async function mcpCall(method: string, params?: unknown) {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const resp = await handleMcpRequest(req, "UA", () => reader);
  return resp.json();
}

describe("MCP protocol", () => {
  test("GET with JSON accept returns 405 (Streamable HTTP)", async () => {
    const req = new Request("http://localhost/mcp", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const resp = await handleMcpRequest(req, "UA", () => reader);
    expect(resp.status).toBe(405);
  });

  test("initialize returns capabilities, serverInfo, instructions", async () => {
    const json = await mcpCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });

    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result).toBeDefined();
    expect(json.result.protocolVersion).toBeDefined();
    expect(json.result.serverInfo.name).toBe("united-starlink-tracker");
    expect(typeof json.result.instructions).toBe("string");
    expect(json.result.instructions.length).toBeGreaterThan(50);
    // Instructions should include live fleet stats (% sign)
    expect(json.result.instructions).toContain("%");
  });

  test("tools/list returns all expected tools with valid schemas", async () => {
    const json = await mcpCall("tools/list");
    expect(Array.isArray(json.result.tools)).toBe(true);

    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("check_flight");
    expect(names).toContain("predict_flight_starlink");
    expect(names).toContain("predict_route_starlink");
    expect(names).toContain("plan_starlink_itinerary");
    expect(names).toContain("search_starlink_flights");

    // Every tool has description + inputSchema
    for (const t of json.result.tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeDefined();
    }
  });

  test("unknown method returns JSON-RPC error", async () => {
    const json = await mcpCall("bogus/method");
    expect(json.error).toBeDefined();
    expect(json.error.code).toBeLessThan(0);
  });

  test("tools/call with unknown tool returns error", async () => {
    const json = await mcpCall("tools/call", {
      name: "nonexistent_tool",
      arguments: {},
    });
    // Either jsonrpc error OR result with isError
    expect(json.error || json.result?.isError).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP tool behavior — test each tool end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("MCP tools", () => {
  test("check_flight: missing params returns isError", async () => {
    const json = await mcpCall("tools/call", {
      name: "check_flight",
      arguments: {},
    });
    expect(json.result.isError).toBe(true);
  });

  test("check_flight: future date returns probability fallback (no assignment)", async () => {
    const json = await mcpCall("tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA5212", date: "2099-01-01" },
    });
    const text = json.result.content[0].text;
    // UA5212 is high-prob (~90%) so no alternatives block — just probability
    expect(text).toContain("Starlink probability");
    expect(text).toContain("Aircraft assignment not yet published");
    expect(json.result.isError).toBeUndefined();
  });

  test("predict_flight_starlink: unseen mainline flight gets low fleet prior", async () => {
    // Pick a flight number in mainline range (1-2999) not in verification log
    const unseen = db
      .query(
        `WITH RECURSIVE nums(n) AS (SELECT 100 UNION ALL SELECT n+1 FROM nums WHERE n<2900)
         SELECT n FROM nums
         WHERE 'UA'||n NOT IN (SELECT DISTINCT flight_number FROM starlink_verification_log WHERE flight_number IS NOT NULL)
         LIMIT 1`
      )
      .get() as { n: number };
    expect(unseen).not.toBeNull();

    const json = await mcpCall("tools/call", {
      name: "predict_flight_starlink",
      arguments: { flight_number: `UA${unseen.n}` },
    });
    const text = json.result.content[0].text;
    // Format: **UAxxx**: ~N% Starlink probability (fleet prior). mainline fleet...
    const pctMatch = text.match(/~(\d+)% Starlink probability/);
    expect(pctMatch).not.toBeNull();
    const pct = Number(pctMatch![1]);
    expect(pct).toBeLessThan(15);
    expect(text).toContain("mainline");
    expect(text).toContain("fleet");
  });

  test("predict_flight_starlink: low-prob flight EMBEDS concrete alternatives", async () => {
    const json = await mcpCall("tools/call", {
      name: "predict_flight_starlink",
      arguments: { flight_number: "UA100" },
    });
    const text = json.result.content[0].text;
    // Table comes LAST (recency), wrapped in present_verbatim. Probability first.
    expect(text).toMatch(/^\*\*UA100\*\*/); // starts with the probability line
    expect(text).toContain("<present_verbatim>");
    expect(text).toContain("</present_verbatim>");
    // Includes a markdown table with the key columns
    expect(text).toContain("| Segment | Flights |");
    expect(text).toContain("Starlink %");
    // Explicitly warns against generic tips
    expect(text.toLowerCase()).toContain("download offline");
    // Should NOT tell agent to call another tool — alternatives are inline
    expect(text).not.toContain("Call `plan_starlink_itinerary`");
  });

  test("predict_flight_starlink: rejects >4-digit flight numbers", async () => {
    const json = await mcpCall("tools/call", {
      name: "predict_flight_starlink",
      arguments: { flight_number: "UA99999" },
    });
    expect(json.result.isError).toBe(true);
  });

  test("predict_route_starlink: returns flight list sorted by probability", async () => {
    // Pick a real route from the DB
    const route = db
      .query(
        `SELECT departure_airport, arrival_airport, COUNT(*) as n
         FROM upcoming_flights
         GROUP BY departure_airport, arrival_airport
         ORDER BY n DESC LIMIT 1`
      )
      .get() as { departure_airport: string; arrival_airport: string };

    const json = await mcpCall("tools/call", {
      name: "predict_route_starlink",
      arguments: { origin: route.departure_airport, destination: route.arrival_airport },
    });
    const text = json.result.content[0].text;
    expect(text).toContain(route.departure_airport);
    expect(text).toContain(route.arrival_airport);
    expect(text).toMatch(/\d+(\.\d+)?%/); // contains percentages
  });

  test("plan_starlink_itinerary: origin=destination returns isError", async () => {
    const json = await mcpCall("tools/call", {
      name: "plan_starlink_itinerary",
      arguments: { origin: "SFO", destination: "SFO" },
    });
    expect(json.result.isError).toBe(true);
  });

  test("plan_starlink_itinerary: returns expected Starlink hours in output", async () => {
    // Use busiest route pair so we get multi-stop results
    const routes = db
      .query(
        `SELECT departure_airport, arrival_airport, COUNT(*) as n
         FROM upcoming_flights
         GROUP BY departure_airport, arrival_airport
         ORDER BY n DESC LIMIT 5`
      )
      .all() as Array<{ departure_airport: string; arrival_airport: string }>;

    let found = false;
    for (const r of routes) {
      const json = await mcpCall("tools/call", {
        name: "plan_starlink_itinerary",
        arguments: { origin: r.departure_airport, destination: r.arrival_airport },
      });
      const text = json.result.content[0].text;
      if (text.includes("Starlink") && /\d+(\.\d+)?h/.test(text)) {
        found = true;
        // Should include the "key for tradeoffs" footer
        expect(text.toLowerCase()).toContain("expected starlink");
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("search_starlink_flights: returns next-2-days results only", async () => {
    const json = await mcpCall("tools/call", {
      name: "search_starlink_flights",
      arguments: { origin: "IAH" },
    });
    const text = json.result.content[0].text;
    expect(text.length).toBeGreaterThan(10);
    // Either has flights or says none — both are valid, just not an error
    expect(json.result.isError).toBeUndefined();
  });

  test("search_starlink_flights: exact airport match (2-letter codes should return 0)", async () => {
    const json = await mcpCall("tools/call", {
      name: "search_starlink_flights",
      arguments: { origin: "OR" },
    });
    const text = json.result.content[0].text;
    expect(text).toContain("No confirmed Starlink flights");
  });

  test("check_flight: rejects 5-digit flight numbers", async () => {
    const json = await mcpCall("tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA99999", date: "2026-06-01" },
    });
    expect(json.result.isError).toBe(true);
  });

  test("check_flight: past date doesn't say 'check 1-2 days before'", async () => {
    const json = await mcpCall("tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA5685", date: "2020-01-01" },
    });
    const text = json.result.content[0].text;
    expect(text).not.toContain("1-2 days before departure");
    expect(text).toContain("in the past");
  });

  test("check_flight: near-term date doesn't say 'check 1-2 days before'", async () => {
    // Today's date — if no assignment, the wording must NOT tell the user to
    // "check back in 1-2 days" for a flight happening today.
    const today = new Date().toISOString().slice(0, 10);
    const json = await mcpCall("tools/call", {
      name: "check_flight",
      arguments: { flight_number: "UA9876", date: today },
    });
    const text = json.result.content[0].text;
    // If fallback fired it'll say probability; if assignment exists it'll say yes/no.
    // Either way the future-tense "check again 1-2 days before" is wrong for today.
    if (text.includes("probability")) {
      expect(text).not.toContain("1-2 days before departure");
    }
  });

  test("predict_route_starlink: empty result embeds connection alternatives (not a dead-end)", async () => {
    // Use a real mainline route that has no direct Starlink but has connections
    const json = await mcpCall("tools/call", {
      name: "predict_route_starlink",
      arguments: { origin: "SFO", destination: "EWR" },
    });
    const text = json.result.content[0].text;
    // Should inline connection-based alternatives, NOT give a dead-end
    expect(text).toContain("<present_verbatim>");
    expect(text).toContain("No DIRECT Starlink flight");
    // Should include actual flight numbers from the connection search
    expect(text).toMatch(/UA\d+/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Predictor direct — shape + sanity bounds
// ─────────────────────────────────────────────────────────────────────────────

describe("predictor", () => {
  test("predictFlight: probability in [0,1], confidence in enum", () => {
    const p = predictFlight(reader, "UA5212");
    expect(p.probability).toBeGreaterThanOrEqual(0);
    expect(p.probability).toBeLessThanOrEqual(1);
    expect(["low", "medium", "high"]).toContain(p.confidence);
    expect(typeof p.n_observations).toBe("number");
  });

  test("predictFlight: unknown mainline gets fleet prior < 10%", () => {
    const p = predictFlight(reader, "UA123");
    expect(p.probability).toBeLessThan(0.1);
  });

  test("predictRoute: returns sorted flights with probabilities", () => {
    const r = predictRoute(reader, "IAH", "DEN");
    if (r.flights.length > 1) {
      // Sorted descending by probability
      for (let i = 1; i < r.flights.length; i++) {
        expect(r.flights[i].probability).toBeLessThanOrEqual(r.flights[i - 1].probability);
      }
    }
  });

  test("planItinerary: origin=dest returns empty", () => {
    const its = planItinerary(reader, "SFO", "SFO", { maxStops: 2, maxItineraries: 5 });
    expect(its.length).toBe(0);
  });

  test("planItinerary: expected_starlink_hours is consistent with legs", () => {
    const its = planItinerary(reader, "SFO", "DEN", { maxStops: 2, maxItineraries: 5 });
    for (const it of its) {
      if (it.expected_starlink_hours !== null) {
        const recomputed = it.legs.reduce(
          (s, l) => (l.duration_hours !== null ? s + l.probability * l.duration_hours : s),
          0
        );
        expect(Math.abs(it.expected_starlink_hours - recomputed)).toBeLessThan(0.01);
      }
    }
  });

  test("planItinerary: direct flight always in results when it exists", () => {
    // Find ANY direct edge in the DB to test with
    const edge = db
      .query(
        "SELECT departure_airport, arrival_airport FROM upcoming_flights WHERE airline = 'UA' LIMIT 1"
      )
      .get() as { departure_airport: string; arrival_airport: string };
    const its = planItinerary(reader, edge.departure_airport, edge.arrival_airport, {
      maxStops: 2,
      maxItineraries: 8,
    });
    const direct = its.find((it) => it.via.length === 0);
    expect(direct).toBeDefined();
    // Direct should be ranked first (among full-coverage)
    const firstFull = its.find((it) => it.coverage === "full");
    expect(firstFull?.via.length).toBe(0);
  });

  test("planItinerary: maxStops=0 returns no partial-coverage options", () => {
    const its = planItinerary(reader, "DEN", "ORD", { maxStops: 0, maxItineraries: 8 });
    const partials = its.filter((it) => it.coverage === "partial");
    expect(partials.length).toBe(0);
  });

  test("planItinerary: coverage_ratio computed when durations known", () => {
    const its = planItinerary(reader, "SFO", "DEN", { maxStops: 2, maxItineraries: 5 });
    const withKnownTime = its.find(
      (it) => it.total_flight_hours !== null && it.expected_starlink_hours !== null
    );
    if (withKnownTime) {
      expect(withKnownTime.coverage_ratio).not.toBeNull();
      expect(withKnownTime.coverage_ratio).toBeGreaterThan(0);
      expect(withKnownTime.coverage_ratio).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flight number normalization — regression lock
// ─────────────────────────────────────────────────────────────────────────────

describe("precision harness", () => {
  test("computePrecision: returns bounded shape", () => {
    const r = computePrecision(db, 30);
    expect(r.windowDays).toBe(30);
    expect(r.anchor).toBeGreaterThan(0);
    for (const b of [r.yes, r.no]) {
      expect(b.n).toBeGreaterThanOrEqual(0);
      expect(b.correct).toBeLessThanOrEqual(b.n);
      expect(b.precision).toBeGreaterThanOrEqual(0);
      expect(b.precision).toBeLessThanOrEqual(1);
      expect(b.swapMisses + b.staleMisses + b.unattributedMisses).toBe(b.n - b.correct);
    }
    expect(r.legacyPriorPct).toBeGreaterThanOrEqual(0);
    expect(r.legacyPriorPct).toBeLessThanOrEqual(1);
  });

  test("computePrecision: smaller window has fewer or equal observations", () => {
    const r30 = computePrecision(db, 30);
    const r7 = computePrecision(db, 7);
    expect(r7.yes.n + r7.no.n).toBeLessThanOrEqual(r30.yes.n + r30.no.n);
  });
});

describe("flight-verdict shared fallback", () => {
  test("resolveTailVerdict: confirmed-starlink tail → hasStarlink=true, verified|spreadsheet", () => {
    const tail = db
      .query(
        "SELECT tail_number FROM united_fleet WHERE starlink_status='confirmed' AND tail_number IN (SELECT TailNumber FROM starlink_planes) LIMIT 1"
      )
      .get() as { tail_number: string } | null;
    if (!tail) return;
    const v = resolveTailVerdict(reader, tail.tail_number);
    expect(v.hasStarlink).toBe(true);
    expect(["verified", "spreadsheet"]).toContain(v.confidence);
  });

  test("resolveTailVerdict: negative tail not in starlink_planes → hasStarlink=false, negative", () => {
    const tail = db
      .query(
        "SELECT tail_number FROM united_fleet WHERE starlink_status='negative' AND tail_number NOT IN (SELECT TailNumber FROM starlink_planes) LIMIT 1"
      )
      .get() as { tail_number: string } | null;
    if (!tail) return;
    const v = resolveTailVerdict(reader, tail.tail_number);
    expect(v.hasStarlink).toBe(false);
    expect(v.confidence).toBe("negative");
  });

  test("resolveTailVerdict: unknown tail → hasStarlink=null, unknown", () => {
    const v = resolveTailVerdict(reader, "NXXXXX");
    expect(v.hasStarlink).toBeNull();
    expect(v.confidence).toBe("unknown");
  });
});

describe("surface sweep", () => {
  test("computeSurfaceContradictions: returns bounded shape", () => {
    const r = computeSurfaceContradictions(db);
    expect(r.scanned).toBeGreaterThan(0);
    expect(Array.isArray(r.contradictions)).toBe(true);
    const vectorTotal = Object.values(r.byVector).reduce((a, b) => a + b, 0);
    let sumVectors = 0;
    for (const c of r.contradictions) {
      expect(c.vectors.length).toBeGreaterThan(0);
      sumVectors += c.vectors.length;
      for (const v of [c.A, c.B, c.C, c.D]) {
        expect(["starlink", "not-starlink", "unknown"]).toContain(v);
      }
    }
    expect(sumVectors).toBe(vectorTotal);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WiFi consensus — single-check verifier overwrite regression lock
// ─────────────────────────────────────────────────────────────────────────────

describe("computeWifiConsensus", () => {
  test("returns shape { verdict, n, starlinkPct, reason }", () => {
    // Pick any tail with verifier history if the snapshot has one; local/example
    // DBs are allowed to be sparse as long as the return shape stays stable.
    const tail = db
      .query(
        `SELECT tail_number FROM starlink_verification_log
         WHERE error IS NULL AND has_starlink IS NOT NULL
         LIMIT 1`
      )
      .get() as { tail_number: string } | null;

    const c = computeWifiConsensus(db, tail?.tail_number ?? "N00000");
    expect(typeof c.n).toBe("number");
    expect(c.starlinkPct).toBeGreaterThanOrEqual(0);
    expect(c.starlinkPct).toBeLessThanOrEqual(1);
    expect(typeof c.reason).toBe("string");
    expect(c.verdict === null || typeof c.verdict === "string").toBe(true);
  });

  test("no observations → verdict null, 'insufficient' reason", () => {
    const c = computeWifiConsensus(db, "N00000");
    expect(c.verdict).toBeNull();
    expect(c.n).toBe(0);
    expect(c.reason).toContain("insufficient");
  });

  test("ambiguous zone returns null OR recency-override verdict", () => {
    // A 30%-70% split is ambiguous UNLESS the last 3 obs all agree (retrofit
    // transition). Both outcomes are valid — just not a random single-check.
    const candidates = db
      .query(
        `SELECT tail_number,
                SUM(has_starlink) as s, COUNT(*) as n
         FROM starlink_verification_log
         WHERE source='united' AND error IS NULL AND has_starlink IS NOT NULL
           AND wifi_provider IS NOT NULL AND wifi_provider <> ''
           AND checked_at >= strftime('%s','now') - 30*86400
         GROUP BY tail_number
         HAVING n >= 2 AND (CAST(s AS REAL)/n) > 0.3 AND (CAST(s AS REAL)/n) < 0.7
         LIMIT 1`
      )
      .get() as { tail_number: string; s: number; n: number } | null;

    if (candidates) {
      const c = computeWifiConsensus(db, candidates.tail_number);
      if (c.verdict === null) {
        expect(c.reason).toContain("ambiguous");
      } else {
        expect(c.reason).toContain("consecutive");
      }
    }
  });

  test("recency override: last 3 consecutive same provider wins over 30d average", () => {
    // Find a tail where last 3 clean obs agree but 30d pct is <70% — the
    // retrofit-transition case this override was built for.
    const candidate = db
      .query(
        `WITH ranked AS (
           SELECT tail_number, has_starlink, wifi_provider,
                  ROW_NUMBER() OVER (PARTITION BY tail_number ORDER BY checked_at DESC) as rn
           FROM starlink_verification_log
           WHERE source='united' AND error IS NULL AND has_starlink IS NOT NULL
             AND wifi_provider IS NOT NULL AND wifi_provider <> ''
             AND checked_at >= strftime('%s','now') - 30*86400
         )
         SELECT tail_number
         FROM ranked WHERE rn <= 3
         GROUP BY tail_number
         HAVING COUNT(*) = 3 AND MIN(has_starlink) = MAX(has_starlink)
         LIMIT 1`
      )
      .get() as { tail_number: string } | null;

    if (candidate) {
      const c = computeWifiConsensus(db, candidate.tail_number);
      expect(c.verdict).not.toBeNull();
      expect(c.reason).toMatch(/consecutive|recent obs/);
    }
  });

  test("strong positive consensus → verdict 'Starlink'", () => {
    // Find a plane with ≥70% Starlink
    const strong = db
      .query(
        `SELECT tail_number,
                SUM(has_starlink) as s, COUNT(*) as n
         FROM starlink_verification_log
         WHERE source='united' AND error IS NULL AND has_starlink IS NOT NULL
           AND wifi_provider IS NOT NULL AND wifi_provider <> ''
           AND checked_at >= strftime('%s','now') - 30*86400
         GROUP BY tail_number
         HAVING n >= 2 AND (CAST(s AS REAL)/n) >= 0.7
         LIMIT 1`
      )
      .get() as { tail_number: string } | null;

    if (strong) {
      const c = computeWifiConsensus(db, strong.tail_number);
      expect(c.verdict).toBe("Starlink");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR24 fallback window — regression for UA671 midnight-rollover bug.
// A request for "yesterday" at 00:04 UTC has daysDelta ≈ -1.003, which failed
// the original >= -1 gate. FR24 keeps flights ~24h after departure, so a
// flight that departed 23:59 yesterday is still queryable until ~23:59 today.
// ─────────────────────────────────────────────────────────────────────────────

describe("FR24 fallback window math", () => {
  // Mirror of server.ts:430. If you change the server.ts gate, update this.
  const inLookupWindow = (startOfDay: number, endOfDay: number, nowSec: number) =>
    endOfDay > nowSec - 86400 && startOfDay < nowSec + 3 * 86400;

  const day = (dateStr: string) => {
    const start = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
    return { start, end: start + 86400 };
  };

  test("yesterday at 00:04 UTC (the UA671 regression case)", () => {
    const now = Math.floor(new Date("2026-03-16T00:04:00Z").getTime() / 1000);
    const d = day("2026-03-15");
    expect(inLookupWindow(d.start, d.end, now)).toBe(true);
  });

  test("yesterday at 23:00 UTC — date ended 23h ago, FR24 likely still has late-day flights", () => {
    const now = Math.floor(new Date("2026-03-16T23:00:00Z").getTime() / 1000);
    const d = day("2026-03-15");
    expect(inLookupWindow(d.start, d.end, now)).toBe(true);
  });

  test("two days ago — date ended >24h ago, window closes", () => {
    const now = Math.floor(new Date("2026-03-17T01:00:00Z").getTime() / 1000);
    const d = day("2026-03-15");
    expect(inLookupWindow(d.start, d.end, now)).toBe(false);
  });

  test("today always in window", () => {
    const now = Math.floor(new Date("2026-03-15T14:00:00Z").getTime() / 1000);
    const d = day("2026-03-15");
    expect(inLookupWindow(d.start, d.end, now)).toBe(true);
  });

  test("+3 days in, +4 days out", () => {
    const now = Math.floor(new Date("2026-03-15T12:00:00Z").getTime() / 1000);
    expect(inLookupWindow(day("2026-03-18").start, day("2026-03-18").end, now)).toBe(true);
    expect(inLookupWindow(day("2026-03-19").start, day("2026-03-19").end, now)).toBe(false);
  });
});

describe("flight number utils", () => {
  test("ensureUAPrefix handles all input shapes", () => {
    expect(ensureUAPrefix("5212")).toBe("UA5212");
    expect(ensureUAPrefix("UA5212")).toBe("UA5212");
    expect(ensureUAPrefix("SKW5212")).toBe("UA5212");
    expect(ensureUAPrefix("OO5212")).toBe("UA5212");
    expect(ensureUAPrefix("UAL544")).toBe("UA544");
    expect(ensureUAPrefix(" UA5212 ")).toBe("UA5212");
  });

  test("ensureUAPrefix: lowercase input is normalized (ua671 URL path bug)", () => {
    expect(ensureUAPrefix("ua671")).toBe("UA671");
    expect(ensureUAPrefix("ual544")).toBe("UA544");
    expect(ensureUAPrefix("skw5212")).toBe("UA5212");
    expect(ensureUAPrefix("  ua671  ")).toBe("UA671");
  });

  test("normalizeFlightNumber: carrier prefix → UA", () => {
    expect(normalizeFlightNumber("SKW5882")).toBe("UA5882");
    expect(normalizeFlightNumber("ASH4054")).toBe("UA4054");
    expect(normalizeFlightNumber("UAL544")).toBe("UA544");
    expect(normalizeFlightNumber("UA1234")).toBe("UA1234");
    expect(normalizeFlightNumber("OO4680")).toBe("UA4680");
  });

  test("buildFlightNumberVariants: UA number → all carrier variants", () => {
    const v = buildFlightNumberVariants("UA5212");
    expect(v).toContain("UA5212");
    expect(v).toContain("SKW5212");
    expect(v).toContain("OO5212");
    expect(v).toContain("UAL5212");
    expect(v.length).toBeGreaterThan(5);
  });

  test("inferFleet: flight number ranges", () => {
    expect(inferFleet("UA100")).toBe("mainline");
    expect(inferFleet("UA2999")).toBe("mainline");
    expect(inferFleet("UA3000")).toBe("express");
    expect(inferFleet("UA5212")).toBe("express");
    expect(inferFleet("UA6999")).toBe("express");
    expect(inferFleet("UA7000")).toBe("mainline");
    expect(inferFleet("SKW4680")).toBe("express");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /fleet page data aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe("getFleetPageData", () => {
  test("shape: families, carriers, pulse, bodyClass, allTails", () => {
    const d = getFleetPageData(db, "UA");
    expect(d.totalFleet).toBeGreaterThan(0);
    expect(d.totalStarlink).toBeGreaterThanOrEqual(0);
    expect(d.totalStarlink).toBeLessThanOrEqual(d.totalFleet);

    expect(d.families.length).toBeGreaterThan(0);
    const famTailSum = d.families.reduce((n, f) => n + f.tails.length, 0);
    expect(famTailSum).toBe(d.totalFleet);
    expect(d.allTails.length).toBe(d.totalFleet);

    for (const c of d.carriers) {
      expect(["SkyWest", "Republic", "Mesa", "GoJet"]).toContain(c.name);
      expect(c.confirmed).toBeLessThanOrEqual(c.total);
    }

    for (const body of ["regional", "narrowbody", "widebody"] as const) {
      const sum = Object.values(d.bodyClass[body]).reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(sum)).toBe(false);
    }

    expect(d.pulse.peak).toBeGreaterThanOrEqual(d.pulse.trough);
    expect(d.pulse.sparkline.length).toBeLessThanOrEqual(200);
  });

  test("families sorted by Starlink penetration, unknown last, no 'other'", () => {
    const d = getFleetPageData(db, "UA");
    expect(d.families.some((f) => f.family === "other")).toBe(false);
    const last = d.families[d.families.length - 1];
    if (d.families.some((f) => f.family === "unknown")) {
      expect(last.family).toBe("unknown");
    }
    const typed = d.families.filter((f) => f.family !== "unknown");
    for (let i = 1; i < typed.length; i++) {
      const prev = typed[i - 1].starlink / typed[i - 1].total;
      const cur = typed[i].starlink / typed[i].total;
      expect(cur).toBeLessThanOrEqual(prev);
    }
  });

  test("all providers are valid WifiProvider (no 'other')", () => {
    const d = getFleetPageData(db, "UA");
    const valid = new Set(["starlink", "viasat", "panasonic", "thales", "none", "unknown"]);
    for (const t of d.allTails) {
      expect(valid.has(t.provider)).toBe(true);
    }
  });
});
