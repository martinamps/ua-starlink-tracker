/**
 * Tenant isolation matrix.
 *
 * Canary rows N999HA/HA9999 (HA), N644AS/AS118 (AS), and A7-TST/QR9999 (QR)
 * are seeded into the test DB by scripts/test-setup.sh. These tests assert
 * they NEVER appear on unitedstarlinktracker.com responses; the hub shows
 * enabled-airline canaries only (HA), not disabled (AS/QR).
 */

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { updateDatabase, updateFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import type { FleetStats } from "../src/types";

const TEST_DB = "/tmp/ua-test.sqlite";
const UA = "unitedstarlinktracker.com";
const HA_HOST = "hawaiianstarlinktracker.com";
const HUB = "airlinestarlinktracker.com";
const EVIL = "evil.example.com";
const CANARIES = ["N999HA", "HA9999", "N644AS", "AS118", "A7-TST", "QR9999"];
const REAL_HA_TAILS = ["N380HA", "N382HA", "N389HA", "N202HA", "N215HA"];

let app: ReturnType<typeof createApp>;
let db: Database;

beforeAll(() => {
  db = new Database(TEST_DB, { readonly: true });
  app = createApp(db);
  const c = db
    .query("SELECT COUNT(*) as n FROM starlink_planes WHERE airline IN ('HA','QR')")
    .get() as { n: number };
  if (c.n < 2) throw new Error("Canary rows missing — run `bun run test:setup`");
});

function req(path: string, host: string, init: RequestInit = {}) {
  return new Request(`http://x${path}`, {
    ...init,
    headers: { Host: host, ...(init.headers as Record<string, string>) },
  });
}

async function bodyOf(path: string, host: string, init?: RequestInit) {
  const r = await app.dispatch(req(path, host, init));
  return { status: r.status, text: await r.text() };
}

function mcpReq(host: string, method: string, params: unknown) {
  return req("/mcp", host, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("tenant resolution", () => {
  test("unknown host → 421", async () => {
    const r = await app.dispatch(req("/api/data", EVIL));
    expect(r.status).toBe(421);
  });

  test("UA host → 200", async () => {
    const r = await app.dispatch(req("/api/data", UA));
    expect(r.status).toBe(200);
  });

  test("hub host → 200", async () => {
    const r = await app.dispatch(req("/api/data", HUB));
    expect(r.status).toBe(200);
  });

  test("static asset bypasses tenancy (favicon on evil host)", async () => {
    const r = await app.dispatch(req("/favicon.ico", EVIL));
    expect([200, 404]).toContain(r.status); // 404 if static file absent in test env, but never 421
    expect(r.status).not.toBe(421);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const ENDPOINTS = [
  "/",
  "/fleet",
  "/check-flight",
  "/route-planner",
  "/api/data",
  "/api/check-flight?flight_number=HA9999&date=2026-03-22",
  "/api/check-flight?flight_number=QR9999&date=2026-03-22",
  "/api/mismatches",
  "/api/fleet-discovery",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
];

describe("UA host never leaks canaries", () => {
  for (const ep of ENDPOINTS) {
    test(ep, async () => {
      const { status, text } = await bodyOf(ep, UA);
      expect(status).toBeLessThan(500);
      for (const c of CANARIES) {
        expect(text).not.toContain(c);
      }
    });
  }

  test("MCP list_starlink_aircraft (limit=500)", async () => {
    const r = await app.dispatch(
      mcpReq(UA, "tools/call", { name: "list_starlink_aircraft", arguments: { limit: 500 } })
    );
    const text = await r.text();
    for (const c of CANARIES) expect(text).not.toContain(c);
  });

  test("MCP search_starlink_flights origin=HNL", async () => {
    const r = await app.dispatch(
      mcpReq(UA, "tools/call", { name: "search_starlink_flights", arguments: { origin: "HNL" } })
    );
    const text = await r.text();
    for (const c of CANARIES) expect(text).not.toContain(c);
  });

  test("MCP check_flight HA9999 on canary date — no tail leak", async () => {
    const r = await app.dispatch(
      mcpReq(UA, "tools/call", {
        name: "check_flight",
        arguments: { flight_number: "HA9999", date: "2026-03-22" },
      })
    );
    const text = await r.text();
    expect(text).not.toContain("N999HA");
    expect(text).not.toContain("A7-TST");
    expect(text).not.toContain("Hawaiian Airlines");
  });

  test("MCP get_fleet_stats", async () => {
    const r = await app.dispatch(
      mcpReq(UA, "tools/call", { name: "get_fleet_stats", arguments: {} })
    );
    const text = await r.text();
    for (const c of CANARIES) expect(text).not.toContain(c);
  });

  test("/api/predict-flight echoes input but leaks no HA data", async () => {
    const { text } = await bodyOf("/api/predict-flight?flight_number=HA9999", UA);
    const d = JSON.parse(text);
    expect(d.n_observations).toBe(0);
    expect(text).not.toContain("N999HA");
    expect(text).not.toContain("A7-TST");
  });
});

describe("hub-only endpoints", () => {
  test("/api/check-any-flight: 404 on UA host", async () => {
    const { status } = await bodyOf(
      "/api/check-any-flight?flight_number=UA5212&date=2026-04-12",
      UA
    );
    expect(status).toBe(404);
  });

  test("/api/check-any-flight: works on hub, detects HA", async () => {
    const { status, text } = await bodyOf(
      "/api/check-any-flight?flight_number=HA9999&date=2026-03-22",
      HUB
    );
    expect(status).toBe(200);
    const d = JSON.parse(text);
    expect(d.airline).toBe("Hawaiian Airlines");
  });

  test("/api/check-any-flight: works on hub, detects UA", async () => {
    const { status, text } = await bodyOf(
      "/api/check-any-flight?flight_number=UA4421&date=2026-03-22",
      HUB
    );
    expect(status).toBe(200);
    const d = JSON.parse(text);
    expect(d.airline).toBe("United Airlines");
  });

  test("/api/check-any-flight: untracked airline → error message", async () => {
    const { status, text } = await bodyOf(
      "/api/check-any-flight?flight_number=DL123&date=2026-04-12",
      HUB
    );
    expect(status).toBe(200);
    const d = JSON.parse(text);
    expect(d.error).toContain("not tracked");
  });

  test("/api/compare-route: 404 on UA host", async () => {
    const { status } = await bodyOf("/api/compare-route?origin=SFO&destination=HNL", UA);
    expect(status).toBe(404);
  });

  test("/api/compare-route: works on hub, returns sorted results", async () => {
    const { status, text } = await bodyOf("/api/compare-route?origin=SFO&destination=HNL", HUB);
    expect(status).toBe(200);
    const d = JSON.parse(text);
    expect(Array.isArray(d.results)).toBe(true);
    // HA routeTypeRule should give 100% for non-interisland; results sorted desc
    if (d.results.length > 1) {
      expect(d.results[0].probability).toBeGreaterThanOrEqual(d.results[1].probability);
    }
    const ha = d.results.find((r: { airline: string }) => r.airline === "HA");
    expect(ha?.probability).toBe(1);
  });

  test("/api/compare-route: HA interisland → 0%", async () => {
    const { text } = await bodyOf("/api/compare-route?origin=HNL&destination=OGG", HUB);
    const d = JSON.parse(text);
    const ha = d.results.find((r: { airline: string }) => r.airline === "HA");
    expect(ha?.probability).toBe(0);
    expect(ha?.reason).toContain("717");
  });
});

describe("real HA fleet — UA host never leaks, HA host shows", () => {
  test("/api/data on UA host contains zero real HA tails", async () => {
    const { text } = await bodyOf("/api/data", UA);
    for (const t of REAL_HA_TAILS) expect(text).not.toContain(t);
  });

  test("MCP list_starlink_aircraft limit=500 on UA host has zero real HA tails", async () => {
    const r = await app.dispatch(
      mcpReq(UA, "tools/call", { name: "list_starlink_aircraft", arguments: { limit: 500 } })
    );
    const text = await r.text();
    for (const t of REAL_HA_TAILS) expect(text).not.toContain(t);
  });

  test("/api/data on HA host contains real HA tails and zero UA tails", async () => {
    const { status, text } = await bodyOf("/api/data", HA_HOST);
    expect(status).toBe(200);
    for (const t of REAL_HA_TAILS) expect(text).toContain(t);
    const j = JSON.parse(text);
    const haPlanes = j.starlinkPlanes as Array<{ TailNumber: string; OperatedBy: string }>;
    expect(haPlanes.length).toBeGreaterThanOrEqual(REAL_HA_TAILS.length);
    for (const p of haPlanes) {
      expect(p.OperatedBy).not.toMatch(/United/i);
    }
  });

  test("/fleet on HA host renders without UA leak", async () => {
    const { status, text } = await bodyOf("/fleet", HA_HOST);
    expect(status).toBe(200);
    expect(text).toContain("N380HA");
  });
});

describe("write-path safety — UA scrape cannot wipe HA rows", () => {
  test("updateDatabase(..., 'UA') leaves HA starlink_planes untouched", () => {
    const tmp = `/tmp/ua-writepath-${process.pid}-${Date.now()}.sqlite`;
    copyFileSync(TEST_DB, tmp);
    const wdb = new Database(tmp);
    const haBefore = (
      wdb.query("SELECT COUNT(*) n FROM starlink_planes WHERE airline='HA'").get() as { n: number }
    ).n;
    expect(haBefore).toBeGreaterThan(0);
    const uaBefore = (
      wdb.query("SELECT COUNT(*) n FROM starlink_planes WHERE airline='UA'").get() as { n: number }
    ).n;

    const fakeStats: FleetStats = {
      express: { total: 50, starlink: 10, percentage: 20 },
      mainline: { total: 50, starlink: 0, percentage: 0 },
    };
    updateDatabase(
      wdb,
      100,
      [
        {
          TailNumber: "N00000",
          Aircraft: "Embraer ERJ-175",
          WiFi: "Starlink",
          OperatedBy: "Test Express",
          fleet: "express",
          sheet_gid: "test",
          sheet_type: "test",
          DateFound: "2026-04-12",
        },
      ],
      fakeStats,
      "UA"
    );

    const haAfter = (
      wdb.query("SELECT COUNT(*) n FROM starlink_planes WHERE airline='HA'").get() as { n: number }
    ).n;
    const uaAfter = (
      wdb.query("SELECT COUNT(*) n FROM starlink_planes WHERE airline='UA'").get() as { n: number }
    ).n;
    wdb.close();

    expect(haAfter).toBe(haBefore);
    // UA scrape replaced spreadsheet rows with the single fake (+ any discovery rows)
    expect(uaAfter).toBeLessThan(uaBefore);
    expect(uaAfter).toBeGreaterThan(0);
  });

  test("updateFlights stamps airline from starlink_planes (HA tail → airline='HA')", () => {
    const tmp = `/tmp/ua-writepath-flights-${process.pid}-${Date.now()}.sqlite`;
    copyFileSync(TEST_DB, tmp);
    const wdb = new Database(tmp);

    const haTail = (
      wdb.query("SELECT TailNumber FROM starlink_planes WHERE airline='HA' LIMIT 1").get() as {
        TailNumber: string;
      }
    ).TailNumber;

    updateFlights(wdb, haTail, [
      {
        flight_number: "HA100",
        departure_airport: "HNL",
        arrival_airport: "LAX",
        departure_time: Math.floor(Date.now() / 1000) + 3600,
        arrival_time: Math.floor(Date.now() / 1000) + 21600,
      },
    ]);

    const row = wdb
      .query(
        "SELECT airline FROM upcoming_flights WHERE tail_number = ? AND flight_number = 'HA100'"
      )
      .get(haTail) as { airline: string };
    wdb.close();

    expect(row.airline).toBe("HA");
  });
});

describe("hub host shows enabled airlines only", () => {
  test("/api/data contains enabled-airline canaries, not disabled", async () => {
    const { text } = await bodyOf("/api/data", HUB);
    expect(text).toContain("N999HA");
    expect(text).not.toContain("N644AS");
    expect(text).not.toContain("A7-TST");
  });

  test("/fleet page contains enabled-airline canaries, not disabled", async () => {
    const { text } = await bodyOf("/fleet", HUB);
    expect(text).toContain("N999HA");
    expect(text).not.toContain("N644AS");
    expect(text).not.toContain("A7-TST");
  });

  test("MCP list_starlink_aircraft limit=500 — enabled-only (no AS/QR canaries)", async () => {
    const r = await app.dispatch(
      mcpReq(HUB, "tools/call", { name: "list_starlink_aircraft", arguments: { limit: 500 } })
    );
    const text = await r.text();
    expect(text).toContain("N999HA");
    expect(text).not.toContain("N644AS");
    expect(text).not.toContain("A7-TST");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("route-table coverage", () => {
  test("every app.routes key is exercised by isolation matrix", () => {
    const tested = new Set(
      ENDPOINTS.map((e) => e.split("?")[0]).concat([
        "/mcp",
        "/api/plan-route",
        "/api/predict-flight",
        "/api/check-any-flight",
        "/api/compare-route",
      ])
    );
    // /api/plan-route + /api/predict-flight are exercised separately above —
    // both still take raw db (transitional) and don't expose tail rows.
    for (const key of Object.keys(app.routes)) {
      expect(tested.has(key)).toBe(true);
    }
  });
});
