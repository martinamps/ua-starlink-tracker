/**
 * Alaska Airlines tests — E175 type→Starlink mapper and the AS-tenant
 * /api/check-flight + /api/fleet-summary surfaces.
 *
 * Type-map tests are deterministic and DB-free. Integration tests run against
 * the read-only snapshot at /tmp/ua-test.sqlite (see scripts/test-setup.sh).
 * The hermetic AS fixture seeds two confirmed Horizon E175s (N654QX, N658QX)
 * plus the canary 737 (N644AS); the prod snapshot post-seed has ~90 E175s.
 * Tests assert shape + a snapshot-relative lower bound, not absolute counts.
 */

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { alaskaTypeToStarlink } from "../src/api/alaska-status";
import { createApp } from "../src/server/app";

const TEST_DB = "/tmp/ua-test.sqlite";
const AS_HOST = "alaskastarlinktracker.com";
// Hermetic E175 row from scripts/test-setup.sh; also exists on a prod snapshot.
const HORIZON_E175_FLIGHT = { flight: "QX2304", date: "2026-03-22" };

let app: ReturnType<typeof createApp>;
let db: Database;

beforeAll(() => {
  db = new Database(TEST_DB, { readonly: true });
  app = createApp(db);
});

function asReq(path: string) {
  return new Request(`http://x${path}`, { headers: { Host: AS_HOST } });
}

// ─────────────────────────────────────────────────────────────────────────────
// alaskaTypeToStarlink — Q1 2026 earnings call: full regional E175 fleet equipped
// ─────────────────────────────────────────────────────────────────────────────

describe("alaskaTypeToStarlink", () => {
  test.each<[string, "Starlink" | null]>([
    ["Embraer E175LR", "Starlink"],
    ["E175", "Starlink"],
    ["ERJ-175LR", "Starlink"],
    ["ERJ175", "Starlink"],
    ["E75", "Starlink"], // FR24 short type code
    ["e175", "Starlink"], // case-insensitive
    ["Boeing 737-990ER", null],
    ["Boeing 737 MAX 9", null],
    ["Boeing 737-890", null],
    ["Boeing 787-9 Dreamliner", null],
    ["A321neo", null],
  ])("%s → %p", (type, want) => {
    expect(alaskaTypeToStarlink(type)).toBe(want);
  });

  test("null/undefined/empty → null (no oracle for mainline)", () => {
    expect(alaskaTypeToStarlink(null)).toBeNull();
    expect(alaskaTypeToStarlink(undefined)).toBeNull();
    expect(alaskaTypeToStarlink("")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/check-flight — Horizon E175 (regional, fully equipped)
// ─────────────────────────────────────────────────────────────────────────────

describe("AS /api/check-flight", () => {
  test("Horizon E175 flight → hasStarlink: true", async () => {
    const r = await app.dispatch(
      asReq(
        `/api/check-flight?flight_number=${HORIZON_E175_FLIGHT.flight}&date=${HORIZON_E175_FLIGHT.date}`
      )
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { hasStarlink: boolean; flights: unknown[] };
    expect(body.hasStarlink).toBe(true);
    expect(Array.isArray(body.flights)).toBe(true);
    expect(body.flights.length).toBeGreaterThan(0);
  });
  // Note: do NOT assert AS mainline 737 → hasStarlink:false here. The snapshot
  // canary N644AS is a fake 737 marked Starlink for isolation tests; a flight
  // that resolves to it would flake. See ALASKA_TRACKING.md known limitations.
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/fleet-summary — AS hub card
// ─────────────────────────────────────────────────────────────────────────────

describe("AS /api/fleet-summary", () => {
  test("AS entry has installed > 0 and a sane shape", async () => {
    const r = await app.dispatch(asReq("/api/fleet-summary"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      airlines: { code: string; installed: number; total: number; percentage: number }[];
    };
    const as = body.airlines.find((a) => a.code === "AS");
    expect(as).toBeDefined();
    if (!as) return;

    // installed should match the AS rows the handler actually returns —
    // getStarlinkPlanes() filters on (verified_wifi IS NULL OR verified_wifi = 'Starlink').
    // Catches a regression to 0 (E175 seed disappearing) and a handler that
    // stops scoping by airline.
    const dbCount = (
      db
        .query(
          "SELECT COUNT(*) as n FROM starlink_planes WHERE airline = 'AS' AND (verified_wifi IS NULL OR verified_wifi = 'Starlink')"
        )
        .get() as { n: number }
    ).n;
    expect(as.installed).toBeGreaterThan(0);
    expect(as.installed).toBe(dbCount);
    expect(as.installed).toBeLessThanOrEqual(as.total);
    expect(as.percentage).toBeGreaterThanOrEqual(0);
    expect(as.percentage).toBeLessThanOrEqual(100);
  });
});
