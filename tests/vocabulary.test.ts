/**
 * Class-4 vocabulary pinning: every per-airline vocabulary (subfleet keys,
 * aircraft families, tail patterns, type→wifi tables, verification sources,
 * social-image naming) must derive from the registry, and the snapshot's
 * real-world strings must resolve through it. Shapes over values — the test
 * is parameterized over whatever the snapshot contains, so data drift can't
 * break it; only vocabulary drift can.
 */

import { describe, expect, test } from "bun:test";
import { getContent } from "../src/airlines/content";
import { content as hubContent } from "../src/airlines/content/hub";
import {
  AIRLINES,
  HUB_BRAND,
  SUBFLEET_KEYS,
  SUBFLEET_KEY_LIST,
  VERIFICATION_SOURCES,
  enabledAirlines,
  verifierSourceTag,
} from "../src/airlines/registry";
import {
  computeWifiConsensus,
  logVerification,
  reconcileConsensus,
} from "../src/database/database";
import { normalizeAircraftType, normalizeFleet } from "../src/observability";
import { AIRCRAFT_SPECS } from "../src/utils/aircraft-specs";
import { makeSyntheticDb, openSnapshot } from "./helpers";

const airlineCodes = Object.keys(AIRLINES);

// ── snapshot vocabulary: every real aircraft_type resolves end-to-end ───────

const snap = openSnapshot();
const typeRows = snap
  .query(
    `SELECT DISTINCT airline, aircraft_type FROM united_fleet
     WHERE airline IN (${airlineCodes.map(() => "?").join(",")})
       AND aircraft_type IS NOT NULL AND TRIM(aircraft_type) <> ''
       AND LOWER(aircraft_type) <> 'unknown'`
  )
  .all(...airlineCodes) as Array<{ airline: string; aircraft_type: string }>;
snap.close();

describe("snapshot aircraft_type vocabulary", () => {
  test("snapshot has aircraft types to pin against", () => {
    expect(typeRows.length).toBeGreaterThan(0);
  });

  test.each(typeRows.map((r) => [r.airline, r.aircraft_type] as const))(
    "%s %s → known family with spec, registry subfleet",
    (airline, aircraftType) => {
      const family = normalizeAircraftType(aircraftType);
      expect(family).not.toBe("other");
      expect(family).not.toBe("unknown");
      expect(AIRCRAFT_SPECS[family]).toBeDefined();

      const fleet = AIRLINES[airline].classifyFleet?.(aircraftType) ?? "mainline";
      expect(SUBFLEET_KEYS.has(fleet)).toBe(true);
      expect(normalizeFleet(fleet)).toBe(fleet);
    }
  );
});

// ── subfleet keys ────────────────────────────────────────────────────────────

describe("subfleet keys", () => {
  // SubfleetKey (src/types.ts) derives from SUBFLEET_KEY_LIST; this equality
  // pins the literal list to the keys actually registered in AIRLINE_DEFS.
  test("SUBFLEET_KEY_LIST = registry-derived keys", () => {
    expect(new Set<string>(SUBFLEET_KEY_LIST)).toEqual(new Set(SUBFLEET_KEYS));
  });

  test.each([...SUBFLEET_KEYS])("normalizeFleet accepts registry key %s", (key) => {
    expect(normalizeFleet(key)).toBe(key);
  });

  test("normalizeFleet rejects junk", () => {
    expect(normalizeFleet("widebody")).toBe("unknown");
    expect(normalizeFleet("")).toBe("unknown");
    expect(normalizeFleet(null)).toBe("unknown");
    expect(normalizeFleet(undefined)).toBe("unknown");
  });
});

// ── carrier prefixes: no prefix claimed by two airlines ─────────────────────

describe("carrier prefixes", () => {
  test("pairwise disjoint across airlines", () => {
    const owner = new Map<string, string>();
    for (const a of Object.values(AIRLINES)) {
      for (const prefix of a.carrierPrefixes) {
        const prior = owner.get(prefix);
        expect(prior === undefined, `prefix ${prefix} claimed by ${prior} and ${a.code}`).toBe(
          true
        );
        owner.set(prefix, a.code);
      }
    }
  });
});

// ── tail patterns: scan regex and validation share one vocabulary ───────────

const TAIL_SAMPLES: Record<string, string> = {
  UA: "N127SY",
  HA: "N390HA",
  AS: "N967AK",
  QR: "A7-ALA",
};

describe("tail patterns", () => {
  test("a sample tail exists for every registered airline", () => {
    expect(new Set(Object.keys(TAIL_SAMPLES))).toEqual(new Set(airlineCodes));
  });

  test.each(airlineCodes)("%s: scan finds tails in prose; matches validate", (code) => {
    const cfg = AIRLINES[code];
    const tail = TAIL_SAMPLES[code];
    expect(cfg.tailPattern.test(tail)).toBe(true);

    const prose = `Spotted ${tail} at the gate today, antenna visible.`;
    const matches = prose.match(cfg.tailScanPattern) ?? [];
    expect(matches).toContain(tail);
    for (const m of matches) {
      expect(cfg.tailPattern.test(m)).toBe(true);
    }
  });
});

// ── homepage content: exhaustive over registry codes ────────────────────────

describe("airline content", () => {
  test.each(airlineCodes)("%s has its own homepage content (not hub fallback)", (code) => {
    const content = getContent(AIRLINES[code]);
    expect(content).toBeDefined();
    expect(content).not.toBe(hubContent);
  });

  test("hub tenant gets hub content", () => {
    expect(getContent("ALL")).toBe(hubContent);
  });
});

// ── social image naming: pinned to the og-images.yml glob ───────────────────

describe("socialImagePath convention", () => {
  // SITES brands are reference-identical to these (AIRLINES.X.brand / HUB_BRAND),
  // so airline + hub rows cover every site.
  const brands = [
    ...Object.values(AIRLINES).map((a) => [a.code, a.brand.socialImagePath] as const),
    ["HUB", HUB_BRAND.socialImagePath] as const,
  ];

  // og-images.yml commits `static/social-image*.webp` — a basename outside
  // that glob would render but silently never be committed.
  test.each(brands)("%s socialImagePath matches static/social-image*.webp", (_key, p) => {
    expect(p).toMatch(/^\/static\/social-image[A-Za-z0-9-]*\.webp$/);
  });
});

// ── consensus: accepted sources derive from the registry ────────────────────

describe("verification sources", () => {
  test("every enabled verifier's written source is accepted by consensus", () => {
    const verifying = enabledAirlines().filter((a) => a.verifierBackend);
    expect(verifying.length).toBeGreaterThan(0);
    for (const a of verifying) {
      expect(VERIFICATION_SOURCES).toContain(verifierSourceTag(a));
    }
    expect(new Set(VERIFICATION_SOURCES).size).toBe(VERIFICATION_SOURCES.length);
  });

  function logRows(
    db: ReturnType<typeof makeSyntheticDb>,
    tail: string,
    source: "united" | "alaska" | "spreadsheet",
    airline: string,
    hasStarlink: boolean,
    n: number
  ) {
    for (let i = 0; i < n; i++) {
      logVerification(db, {
        tail_number: tail,
        source,
        has_starlink: hasStarlink,
        wifi_provider: hasStarlink ? "Starlink" : "Viasat",
        aircraft_type: "Boeing 737-890",
        flight_number: `${airline}123`,
        error: null,
        tail_confirmed: 1,
        airline,
      });
    }
  }

  test("AS verification rows settle consensus for an AS tail (display read)", () => {
    const db = makeSyntheticDb();
    logRows(db, "N967AK", "alaska", "AS", true, 2);
    const c = computeWifiConsensus(db, "N967AK");
    expect(c.verdict).toBe("Starlink");
    expect(c.n).toBe(2);
    db.close();
  });

  function addPlaneRow(db: ReturnType<typeof makeSyntheticDb>, tail: string, airline: string) {
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber, OperatedBy, fleet, airline)
       VALUES ('Boeing 737-890', 'StrLnk', 'discovery', 'discovery', '2026-01-01', ?, 'x', 'mainline', ?)`
    ).run(tail, airline);
  }

  test("type-derived alaska rows have no verified_wifi write authority", () => {
    const db = makeSyntheticDb();
    addPlaneRow(db, "N967AK", "AS");
    logRows(db, "N967AK", "alaska", "AS", true, 2);
    expect(reconcileConsensus(db)).toBe(0);
    const row = db
      .query("SELECT verified_wifi FROM starlink_planes WHERE TailNumber = 'N967AK'")
      .get() as { verified_wifi: string | null };
    expect(row.verified_wifi).toBeNull();
    db.close();
  });

  test("observed united rows still flip verified_wifi via reconcileConsensus", () => {
    const db = makeSyntheticDb();
    addPlaneRow(db, "N37502", "UA");
    logRows(db, "N37502", "united", "UA", true, 2);
    expect(reconcileConsensus(db)).toBe(1);
    const row = db
      .query("SELECT verified_wifi FROM starlink_planes WHERE TailNumber = 'N37502'")
      .get() as { verified_wifi: string | null };
    expect(row.verified_wifi).toBe("Starlink");
    db.close();
  });

  test("united rows keep settling UA tails (semantics pin)", () => {
    const db = makeSyntheticDb();
    logRows(db, "N37502", "united", "UA", false, 2);
    const c = computeWifiConsensus(db, "N37502");
    expect(c.verdict).toBe("Viasat");
    expect(c.n).toBe(2);
    db.close();
  });

  test("non-verifier sources stay invisible to consensus", () => {
    const db = makeSyntheticDb();
    logRows(db, "N11111", "spreadsheet", "UA", true, 3);
    const c = computeWifiConsensus(db, "N11111");
    expect(c.verdict).toBeNull();
    expect(c.n).toBe(0);
    db.close();
  });
});
