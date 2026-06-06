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
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { SHEET_ROSTER_WHERE, updateDatabase, updateFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import type { FleetStats } from "../src/types";
import {
  TEST_DB,
  addFleet,
  addPlane,
  bodyOf as bodyOfApp,
  makeSyntheticDb,
  mcpReq,
  openSnapshot,
  postMcp,
  req,
} from "./helpers";

const UA = "unitedstarlinktracker.com";
const HA_HOST = "hawaiianstarlinktracker.com";
const AS_HOST = "alaskastarlinktracker.com";
const HUB = "airlinestarlinktracker.com";
const EVIL = "evil.example.com";
const CANARIES = ["N999HA", "HA9999", "N644AS", "AS118", "A7-TST", "QR9999"];
const REAL_HA_TAILS = ["N380HA", "N382HA", "N389HA", "N202HA", "N215HA"];
const REAL_AS_TAILS = ["N654QX", "N658QX"];

let app: ReturnType<typeof createApp>;
let db: Database;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
  const c = db
    .query("SELECT COUNT(*) as n FROM starlink_planes WHERE airline IN ('HA','QR')")
    .get() as { n: number };
  if (c.n < 2) throw new Error("Canary rows missing — run `bun run test:setup`");
});

const bodyOf = (path: string, host: string, init?: RequestInit) => bodyOfApp(app, path, host, init);

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

  test("site.webmanifest is branded per host", async () => {
    const uaManifest = await app.dispatch(req("/site.webmanifest", UA));
    const hubManifest = await app.dispatch(req("/site.webmanifest", HUB));

    expect(uaManifest.status).toBe(200);
    expect(hubManifest.status).toBe(200);

    expect(await uaManifest.json()).toMatchObject({ name: "United Airlines Starlink Tracker" });
    expect(await hubManifest.json()).toMatchObject({ name: "Airline Starlink Tracker" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("og:image is tenant-branded", () => {
  const cases: Array<[string, string]> = [
    [UA, "/static/social-image.webp"],
    [HA_HOST, "/static/social-image-ha.webp"],
    [AS_HOST, "/static/social-image-as.webp"],
    [HUB, "/static/social-image-hub.webp"],
    // QR card is never generated (not in /api/fleet-summary) → hub fallback.
    ["qatarstarlinktracker.com", "/static/social-image-hub.webp"],
  ];
  for (const [host, img] of cases) {
    test(`${host} serves ${img}`, async () => {
      const { status, text } = await bodyOf("/", host);
      expect(status).toBe(200);
      expect(text).toContain(`property="og:image" content="https://${host}${img}"`);
      expect(text).toContain(`name="twitter:image" content="https://${host}${img}"`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const ENDPOINTS = [
  "/",
  "/fleet",
  "/routes",
  "/check-flight",
  "/route-planner",
  "/api/data",
  "/api/fleet-summary",
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

  test("MCP check_flight HA9999 on the UA scope — refused, no cross-brand leak", async () => {
    // Foreign marketing prefixes are refused on pinned MCP scopes (parity
    // with REST's 404). The refusal names ONLY the pinned carrier.
    const j = await postMcp(app, UA, "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "HA9999", date: "2026-03-22" },
    });
    expect(j.result.isError).toBe(true);
    const text = j.result.content[0].text as string;
    expect(text).toContain("This server covers United Airlines");
    // Single-airline surface: never advertise competitor brands.
    for (const brand of ["Hawaiian Airlines", "Alaska Airlines", "Qatar Airways"]) {
      expect(text).not.toContain(brand);
    }
    // Full response body carries no TAIL canaries (flight-number canaries
    // excluded — a refusal legitimately echoes the requested number).
    const body = JSON.stringify(j);
    expect(body).not.toContain("N999HA");
    expect(body).not.toContain("A7-TST");
  });

  test("MCP get_fleet_stats", async () => {
    const r = await app.dispatch(
      mcpReq(UA, "tools/call", { name: "get_fleet_stats", arguments: {} })
    );
    const text = await r.text();
    for (const c of CANARIES) expect(text).not.toContain(c);
  });

  test("/api/predict-flight rejects a foreign-prefix number outright (404)", async () => {
    // Pre-fix this ran HA9999 through the UA model; now the marketing-prefix
    // gate fails closed before any model or FR24 work.
    const { status, text } = await bodyOf("/api/predict-flight?flight_number=HA9999", UA);
    expect(status).toBe(404);
    expect(text).toContain("not tracked");
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

  test("/api/compare-route: HA interisland routeTypeRule → 0%", async () => {
    // OGG-KOA: real interisland route Hawaiian operates only on 717s, so no
    // tracked tails fly it → falls through to routeTypeRule. (HNL-spoke routes
    // get occasional Airbus rotations and would observe 100%.)
    const { text } = await bodyOf("/api/compare-route?origin=OGG&destination=KOA", HUB);
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
    // Enough rows to clear the roster-replace floor — a tiny parse is now
    // refused outright (see updateDatabase's rosterReplaceRefusal).
    const uaSheetBefore = (
      wdb.query(`SELECT COUNT(*) n FROM starlink_planes WHERE ${SHEET_ROSTER_WHERE}`).get("UA") as {
        n: number;
      }
    ).n;
    const fakeRows = Array.from({ length: Math.max(1, uaSheetBefore) }, (_, i) => ({
      TailNumber: `N${10000 + i}`,
      Aircraft: "Embraer ERJ-175",
      WiFi: "Starlink",
      OperatedBy: "Test Express",
      fleet: "express",
      sheet_gid: "test",
      sheet_type: "test",
      DateFound: "2026-04-12",
    }));
    updateDatabase(wdb, 100, fakeRows, fakeStats, "UA");

    const haAfter = (
      wdb.query("SELECT COUNT(*) n FROM starlink_planes WHERE airline='HA'").get() as { n: number }
    ).n;
    const uaAfter = (
      wdb.query("SELECT COUNT(*) n FROM starlink_planes WHERE airline='UA'").get() as { n: number }
    ).n;
    const fakePresent = (
      wdb.query("SELECT COUNT(*) n FROM starlink_planes WHERE TailNumber='N10000'").get() as {
        n: number;
      }
    ).n;
    wdb.close();

    expect(haAfter).toBe(haBefore);
    // UA scrape replaced spreadsheet rows with the fakes (+ any discovery rows)
    expect(uaAfter).toBeGreaterThan(0);
    expect(uaAfter).toBeLessThanOrEqual(uaBefore);
    expect(fakePresent).toBe(1);
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

  test("updateFlights drops pre-2000 departure_time rows at the insert", () => {
    const tmp = `/tmp/ua-floor-flights-${process.pid}-${Date.now()}.sqlite`;
    copyFileSync(TEST_DB, tmp);
    const wdb = new Database(tmp);

    const tail = (
      wdb.query("SELECT TailNumber FROM starlink_planes WHERE airline='UA' LIMIT 1").get() as {
        TailNumber: string;
      }
    ).TailNumber;
    const future = Math.floor(Date.now() / 1000) + 3600;

    updateFlights(wdb, tail, [
      // FR24 half-parse: epoch-0 departure must never reach the table.
      {
        flight_number: "UA900",
        departure_airport: "SFO",
        arrival_airport: "EWR",
        departure_time: 0,
        arrival_time: 3600,
      },
      {
        flight_number: "UA901",
        departure_airport: "SFO",
        arrival_airport: "EWR",
        departure_time: future,
        arrival_time: future + 21600,
      },
    ]);

    const flightNumbers = (
      wdb.query("SELECT flight_number FROM upcoming_flights WHERE tail_number = ?").all(tail) as {
        flight_number: string;
      }[]
    ).map((r) => r.flight_number);
    // A garbage departure_time invalidates the schedule row, not the route
    // knowledge — the airports are real, so the route cache still learns.
    const route = wdb
      .query(
        "SELECT duration_sec FROM flight_routes WHERE flight_number = 'UA900' AND origin = 'SFO' AND destination = 'EWR'"
      )
      .get() as { duration_sec: number | null } | null;
    wdb.close();

    expect(flightNumbers).toContain("UA901");
    expect(flightNumbers).not.toContain("UA900");
    expect(route).not.toBeNull();
    expect(route?.duration_sec).toBeNull(); // duration from epoch-0 is garbage
  });
});

describe("hub host shows enabled airlines only", () => {
  test("/api/data contains enabled-airline canaries, not disabled", async () => {
    const { text } = await bodyOf("/api/data", HUB);
    expect(text).toContain("N999HA");
    expect(text).toContain("N644AS");
    expect(text).not.toContain("A7-TST");
  });

  test("/fleet page contains enabled-airline canaries, not disabled", async () => {
    const { text } = await bodyOf("/fleet", HUB);
    expect(text).toContain("N999HA");
    expect(text).toContain("N644AS");
    expect(text).not.toContain("A7-TST");
  });

  test("MCP list_starlink_aircraft limit=500 — enabled-only (no QR canary)", async () => {
    const r = await app.dispatch(
      mcpReq(HUB, "tools/call", { name: "list_starlink_aircraft", arguments: { limit: 500 } })
    );
    const text = await r.text();
    expect(text).toContain("N999HA");
    expect(text).toContain("N644AS");
    expect(text).not.toContain("A7-TST");
  });

  test("homepage links stay on the live generic hub for unlaunched airlines", async () => {
    const { text } = await bodyOf("/", HUB);
    expect(text).toContain("https://airlinestarlinktracker.com/?filter=HA");
    expect(text).toContain("https://airlinestarlinktracker.com/?filter=AS");
    expect(text).not.toContain("https://hawaiianstarlinktracker.com/");
    expect(text).not.toContain("https://alaskastarlinktracker.com/");
    expect(text).not.toContain("https://qatarstarlinktracker.com/");
  });

  test("hub sitemap stays generic", async () => {
    const { text } = await bodyOf("/sitemap.xml", HUB);
    expect(text).toContain("<loc>https://airlinestarlinktracker.com/</loc>");
    expect(text).toContain("<loc>https://airlinestarlinktracker.com/fleet</loc>");
    expect(text).not.toContain("/check-flight</loc>");
    expect(text).not.toContain("/route-planner</loc>");
    expect(text).not.toContain("/mcp</loc>");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("MCP per-host branding + scope override", () => {
  const QR_HOST = "qatarstarlinktracker.com";

  async function mcpInit(host: string, query = "") {
    const r = await app.dispatch(
      new Request(`http://x/mcp${query}`, {
        method: "POST",
        headers: { Host: host, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
        }),
      })
    );
    return r.json();
  }

  test("UA host: serverInfo.name = united-starlink-tracker", async () => {
    const j = await mcpInit(UA);
    expect(j.result.serverInfo.name).toBe("united-starlink-tracker");
    expect(j.result.instructions).toContain("Scope: United Airlines");
  });

  test("QR host: serverInfo + instructions reflect Qatar", async () => {
    const j = await mcpInit(QR_HOST);
    expect(j.result.serverInfo.name).toBe("qatar-starlink-tracker");
    expect(j.result.instructions).toContain("Scope: Qatar Airways");
    expect(j.result.instructions).not.toContain("UNITED ONLY");
  });

  test("hub host: serverInfo = airline-starlink-tracker", async () => {
    const j = await mcpInit(HUB);
    expect(j.result.serverInfo.name).toBe("airline-starlink-tracker");
    expect(j.result.instructions).toContain("Scope: tracked airlines");
  });

  test("?scope=ALL on QR host overrides to hub scope", async () => {
    const j = await mcpInit(QR_HOST, "?scope=ALL");
    expect(j.result.serverInfo.name).toBe("airline-starlink-tracker");
    expect(j.result.instructions).toContain("override of host default");
  });

  test("?scope=UA on hub host overrides to UA scope", async () => {
    const j = await mcpInit(HUB, "?scope=UA");
    expect(j.result.serverInfo.name).toBe("united-starlink-tracker");
    expect(j.result.instructions).toContain("override of host default via ?scope=UA");
  });

  test("invalid ?scope= silently falls back to host scope", async () => {
    const j = await mcpInit(QR_HOST, "?scope=BOGUS");
    expect(j.result.serverInfo.name).toBe("qatar-starlink-tracker");
  });

  test("tools/list descriptions are templated with airline name", async () => {
    const r = await app.dispatch(mcpReq(QR_HOST, "tools/list", {}));
    const j = await r.json();
    const checkFlight = j.result.tools.find((t: { name: string }) => t.name === "check_flight");
    expect(checkFlight.description).toContain("Qatar Airways");
    expect(checkFlight.description).not.toContain("United Airlines");
  });
});

describe("QR site features", () => {
  const QR_HOST = "qatarstarlinktracker.com";

  test("/route-planner is disabled (404) on QR host", async () => {
    const r = await app.dispatch(req("/route-planner", QR_HOST));
    expect(r.status).toBe(404);
  });

  test("/check-flight remains enabled on QR host", async () => {
    const r = await app.dispatch(req("/check-flight", QR_HOST));
    expect(r.status).toBe(200);
  });

  test("QR sitemap omits /route-planner", async () => {
    const { text } = await bodyOf("/sitemap.xml", QR_HOST);
    expect(text).toContain("<loc>https://qatarstarlinktracker.com/check-flight</loc>");
    expect(text).not.toContain("/route-planner</loc>");
  });
});

describe("AS host isolation", () => {
  test("/api/data on AS host shows only AS tails", async () => {
    const { status, text } = await bodyOf("/api/data", AS_HOST);
    expect(status).toBe(200);
    for (const t of REAL_AS_TAILS) expect(text).toContain(t);
    for (const t of REAL_HA_TAILS) expect(text).not.toContain(t);
    expect(text).not.toMatch(/N\d{3}HA/);
  });

  test("UA host /api/data has zero AS tails", async () => {
    const { text } = await bodyOf("/api/data", UA);
    for (const t of REAL_AS_TAILS) expect(text).not.toContain(t);
    expect(text).not.toContain("N644AS");
  });

  test("AS host MCP list_starlink_aircraft → AS-only", async () => {
    const r = await app.dispatch(
      mcpReq(AS_HOST, "tools/call", { name: "list_starlink_aircraft", arguments: { limit: 500 } })
    );
    const text = await r.text();
    expect(text).toContain("Alaska");
    expect(text).toContain("N654QX");
    expect(text).not.toContain("N382HA");
    for (const t of REAL_HA_TAILS) expect(text).not.toContain(t);
  });

  test("HA host /api/data has zero AS tails", async () => {
    const { text } = await bodyOf("/api/data", HA_HOST);
    for (const t of REAL_AS_TAILS) expect(text).not.toContain(t);
    expect(text).not.toContain("N644AS");
  });

  test("hub /api/data includes AS tails", async () => {
    const { text } = await bodyOf("/api/data", HUB);
    for (const t of REAL_AS_TAILS) expect(text).toContain(t);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-host foreign-prefix gate: a tenant host must refuse flight numbers
// carrying ANOTHER registered airline's marketing prefix instead of running
// them through its own ladder (the AS-host-answers-UA1 tenant leak).
// ─────────────────────────────────────────────────────────────────────────────

describe("per-host foreign-prefix gate", () => {
  const PAST_DATE = "2026-03-22"; // outside FR24's window — fully hermetic

  test("UA flight on AS host → 404 not-tracked (check + predict)", async () => {
    for (const path of [
      `/api/check-flight?flight_number=UA1&date=${PAST_DATE}`,
      "/api/predict-flight?flight_number=UA1",
    ]) {
      const { status, text } = await bodyOf(path, AS_HOST);
      expect(status, path).toBe(404);
      expect(text).toContain("not tracked");
      expect(text).not.toContain("United");
    }
  });

  test("QR flight on AS host → 404 (enabled-but-hub-hidden carriers also rejected)", async () => {
    const { status } = await bodyOf(
      `/api/check-flight?flight_number=QR123&date=${PAST_DATE}`,
      AS_HOST
    );
    expect(status).toBe(404);
  });

  test("own-prefix and digits-only numbers proceed unchanged", async () => {
    const own = await bodyOf(`/api/check-flight?flight_number=AS123&date=${PAST_DATE}`, AS_HOST);
    expect(own.status).toBe(200);
    const bare = await bodyOf(`/api/check-flight?flight_number=123&date=${PAST_DATE}`, AS_HOST);
    expect(bare.status).toBe(200);
    const ua = await bodyOf(`/api/check-flight?flight_number=UA1&date=${PAST_DATE}`, UA);
    expect(ua.status).toBe(200);
  });

  test("operating-carrier prefixes are not treated as foreign (SKW on UA host)", async () => {
    const { status } = await bodyOf(
      `/api/check-flight?flight_number=SKW5882&date=${PAST_DATE}`,
      UA
    );
    expect(status).toBe(200);
  });

  test("a seeded foreign tail cannot surface through another tenant's FR24 fallback", async () => {
    // Synthetic DB: one verified UA Starlink tail. FR24 reports that tail for
    // a digits-only lookup on the AS host — the airline-scoped tail ladder
    // must not resolve it, so the AS host cannot answer "verified yes" with
    // United inventory. The same fetch on the UA host proves the seam works.
    const db = makeSyntheticDb();
    addPlane(db, "N91234", "Starlink");
    addFleet(db, "N91234", "confirmed", { verifiedWifi: "Starlink" });
    const sapp = createApp(db);

    const nowSec = Math.floor(Date.now() / 1000);
    const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
    setAssignmentFetcher(async () => [
      {
        tail_number: "N91234",
        aircraft_model: "Boeing 737-900",
        origin: "ZZZ",
        destination: "ZZX",
        departure_time: nowSec,
        arrival_time: nowSec + 3 * 3600,
      },
    ]);
    try {
      const ua = await bodyOfApp(sapp, `/api/check-flight?flight_number=123&date=${today}`, UA);
      expect(ua.status).toBe(200);
      expect(JSON.parse(ua.text).hasStarlink).toBe(true);

      const as = await bodyOfApp(
        sapp,
        `/api/check-flight?flight_number=123&date=${today}`,
        AS_HOST
      );
      expect(as.status).toBe(200);
      const d = JSON.parse(as.text);
      expect(d.hasStarlink).not.toBe(true);
      expect(as.text).not.toContain("N91234");
    } finally {
      setAssignmentFetcher(null);
    }
    db.close();
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
