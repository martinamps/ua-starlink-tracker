/**
 * Class-9 pin: the united.com verdict matrix (tail match/mismatch/unknown ×
 * starlink/other/error/timeout) exercised offline through the real entry
 * points with injected checkers, against in-memory DBs. The load-bearing
 * invariant is the false-on-error class from the 2026-05 audits: an error
 * result must NEVER write a negative observation — pinned structurally,
 * including the adversarial cell where the checker returns an error AND a
 * populated hasStarlink/provider payload (the 1.7k-row class).
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  cascadeSubfleetDiscovery,
  logVerification,
  updateFleetVerificationResult,
  updateShipNumber,
} from "../src/database/database";
import { type VerifyPlaneDeps, verifyPlane } from "../src/scripts/fleet-discovery";
import { verifyPlaneStarlink } from "../src/scripts/starlink-verifier";
import type { StarlinkCheckResult } from "../src/scripts/united-starlink-checker";
import { type UnitedCheckCategory, classifyCheckResult } from "../src/scripts/united-verdict";
import type { FleetAircraft } from "../src/types";
import { addFleet, addPlane, makeSyntheticDb } from "./helpers";

const TAIL = "N100UA";
const SWAP_TAIL = "N200UA";
const NO_MAP: ReadonlyMap<string, string> = new Map();
const TIMEOUT = "timeout after 60000ms";

function checkResult(over: Partial<StarlinkCheckResult> = {}): StarlinkCheckResult {
  return {
    hasStarlink: null,
    tailNumber: null,
    shipNumber: null,
    aircraftType: "Boeing 737-900",
    wifiProvider: null,
    flightNumber: "100",
    date: "2026-06-05",
    origin: "SFO",
    destination: "EWR",
    ...over,
  };
}

const starlinkOn = (tail: string | null) =>
  checkResult({ hasStarlink: true, tailNumber: tail, wifiProvider: "Starlink" });
const viasatOn = (tail: string | null) =>
  checkResult({ hasStarlink: false, tailNumber: tail, wifiProvider: "Viasat" });
const errorOn = (tail: string | null, error = "Process exited with code 1") =>
  checkResult({ tailNumber: tail, error });
// The audit class: error set AND a populated negative payload.
const poisonedErrorOn = (tail: string | null) =>
  checkResult({ tailNumber: tail, error: TIMEOUT, hasStarlink: false, wifiProvider: "Viasat" });

/** Prior tail_confirmed united obs so the 30d consensus can settle. */
function addPriors(db: Database, tail: string, provider: string, n = 2): void {
  for (let i = 0; i < n; i++) {
    logVerification(db, {
      tail_number: tail,
      airline: "UA",
      source: "united",
      has_starlink: provider === "Starlink",
      wifi_provider: provider,
      aircraft_type: "Boeing 737-900",
      flight_number: "UA99",
      tail_confirmed: 1,
      error: null,
    });
  }
}

function logRows(db: Database, tail: string) {
  return db
    .query(
      `SELECT has_starlink, wifi_provider, tail_confirmed, error
       FROM starlink_verification_log WHERE tail_number = ? AND flight_number = 'UA100'
       ORDER BY id`
    )
    .all(tail) as Array<{
    has_starlink: number | null;
    wifi_provider: string | null;
    tail_confirmed: number | null;
    error: string | null;
  }>;
}

function planeWifi(db: Database, tail: string): string | null | undefined {
  const row = db
    .query("SELECT verified_wifi FROM starlink_planes WHERE TailNumber = ?")
    .get(tail) as { verified_wifi: string | null } | null;
  return row?.verified_wifi;
}

function fleetRow(db: Database, tail: string) {
  return db
    .query(
      `SELECT starlink_status, verified_wifi, verified_at, check_attempts, last_check_error, next_check_after
       FROM united_fleet WHERE tail_number = ?`
    )
    .get(tail) as {
    starlink_status: string;
    verified_wifi: string | null;
    verified_at: number | null;
    check_attempts: number;
    last_check_error: string | null;
    next_check_after: number;
  };
}

/** Capture logger tags emitted while fn runs (logger writes JSON lines to console). */
async function captureLoggerTags(fn: () => Promise<unknown>): Promise<Set<string>> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(String(a[0]));
  console.error = (...a: unknown[]) => lines.push(String(a[0]));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const tags = new Set<string>();
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as { logger?: string };
      if (typeof record.logger === "string") tags.add(record.logger);
    } catch {
      // non-logger output
    }
  }
  return tags;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure classification matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyCheckResult matrix", () => {
  const MISMATCH_ERR = `Aircraft mismatch: flight has ${SWAP_TAIL}`;
  const UNATTRIBUTABLE_ERR = "Tail not extracted — cannot attribute non-Starlink result";
  const TRUSTED = new Set<UnitedCheckCategory>([
    "trusted_starlink",
    "trusted_other",
    "tail_unknown_positive",
  ]);

  // cell, result, category, observation, swap?
  test.each<
    [
      string,
      StarlinkCheckResult,
      UnitedCheckCategory,
      {
        has_starlink: boolean | null;
        wifi_provider: string | null;
        tail_confirmed: 0 | 1 | null;
        error: string | null;
      },
      boolean,
    ]
  >([
    [
      "match × starlink",
      starlinkOn(TAIL),
      "trusted_starlink",
      { has_starlink: true, wifi_provider: "Starlink", tail_confirmed: 1, error: null },
      false,
    ],
    [
      "match × other",
      viasatOn(TAIL),
      "trusted_other",
      { has_starlink: false, wifi_provider: "Viasat", tail_confirmed: 1, error: null },
      false,
    ],
    [
      "match × error",
      errorOn(TAIL),
      "error",
      {
        has_starlink: null,
        wifi_provider: null,
        tail_confirmed: 1,
        error: "Process exited with code 1",
      },
      false,
    ],
    [
      "match × timeout",
      errorOn(TAIL, TIMEOUT),
      "error",
      { has_starlink: null, wifi_provider: null, tail_confirmed: 1, error: TIMEOUT },
      false,
    ],
    [
      // The 1.7k-row audit class: error AND a populated negative payload —
      // the guard must be structural on result.error, not rely on the
      // checker nulling hasStarlink.
      "match × error-with-payload",
      poisonedErrorOn(TAIL),
      "error",
      { has_starlink: null, wifi_provider: "Viasat", tail_confirmed: 1, error: TIMEOUT },
      false,
    ],
    [
      "mismatch × starlink",
      starlinkOn(SWAP_TAIL),
      "mismatch",
      { has_starlink: null, wifi_provider: null, tail_confirmed: 0, error: MISMATCH_ERR },
      true,
    ],
    [
      "mismatch × other",
      viasatOn(SWAP_TAIL),
      "mismatch",
      { has_starlink: null, wifi_provider: null, tail_confirmed: 0, error: MISMATCH_ERR },
      true,
    ],
    [
      "mismatch × error",
      errorOn(SWAP_TAIL),
      "mismatch",
      { has_starlink: null, wifi_provider: null, tail_confirmed: 0, error: MISMATCH_ERR },
      false,
    ],
    [
      // Error guard applies to the swap side too: an errored scrape must not
      // become a tail_confirmed observation for the captured tail.
      "mismatch × error-with-payload",
      poisonedErrorOn(SWAP_TAIL),
      "mismatch",
      { has_starlink: null, wifi_provider: null, tail_confirmed: 0, error: MISMATCH_ERR },
      false,
    ],
    [
      "unknown × starlink",
      starlinkOn(null),
      "tail_unknown_positive",
      { has_starlink: true, wifi_provider: "Starlink", tail_confirmed: null, error: null },
      false,
    ],
    [
      "unknown × other",
      viasatOn(null),
      "unattributable",
      { has_starlink: null, wifi_provider: null, tail_confirmed: null, error: UNATTRIBUTABLE_ERR },
      false,
    ],
    [
      "unknown × error",
      errorOn(null),
      "error",
      {
        has_starlink: null,
        wifi_provider: null,
        tail_confirmed: null,
        error: "Process exited with code 1",
      },
      false,
    ],
    [
      // Empty-provider rows are untrusted; consensus additionally filters
      // wifi_provider <> '' so the passthrough negative below never settles.
      "match × empty provider",
      checkResult({ tailNumber: TAIL, hasStarlink: false, wifiProvider: "" }),
      "no_provider",
      { has_starlink: false, wifi_provider: "", tail_confirmed: 1, error: null },
      false,
    ],
    [
      "unknown × empty provider",
      checkResult({ hasStarlink: false, wifiProvider: "" }),
      "tail_unknown",
      { has_starlink: false, wifi_provider: "", tail_confirmed: null, error: null },
      false,
    ],
  ])("%s", (_cell, result, category, observation, hasSwap) => {
    const v = classifyCheckResult(result, TAIL, NO_MAP);
    expect(v.category).toBe(category);
    expect(v.trusted).toBe(TRUSTED.has(category));
    expect(v.observation).toEqual(observation);
    expect(v.swapCapture !== null).toBe(hasSwap);
    if (v.swapCapture) {
      expect(v.swapCapture.tail_number).toBe(SWAP_TAIL);
      expect(v.swapCapture.wifi_provider).toBe(result.wifiProvider);
    }
    // The false-on-error invariant, structurally: error ⇒ no observation
    // anywhere, regardless of what else the checker populated.
    if (result.error) {
      expect(v.observation.has_starlink).toBeNull();
      expect(v.trusted).toBe(false);
      expect(v.swapCapture).toBeNull();
    }
  });

  test("tail comparison is case-insensitive", () => {
    const v = classifyCheckResult(starlinkOn("n100ua"), TAIL, NO_MAP);
    expect(v.tailMismatch).toBe(false);
    expect(v.observation.tail_confirmed).toBe(1);
  });

  test("ship number resolves through the map", () => {
    const v = classifyCheckResult(
      checkResult({ shipNumber: "0100", hasStarlink: true, wifiProvider: "Starlink" }),
      TAIL,
      new Map([["0100", TAIL]])
    );
    expect(v.resolvedTail).toBe(TAIL);
    expect(v.observation.tail_confirmed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Verification mode (starlink-verifier): write paths only — classification
// outcomes per cell are owned by the matrix above.
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyPlaneStarlink write paths (injected checker)", () => {
  const FLIGHT = {
    tail_number: TAIL,
    flight_number: "UA100",
    departure_airport: "KSFO",
    arrival_airport: "KEWR",
    departure_time: Math.floor(Date.now() / 1000) + 6 * 3600,
    arrival_time: Math.floor(Date.now() / 1000) + 11 * 3600,
  };

  function setup(verifiedWifi: string | null = "Starlink"): Database {
    const db = makeSyntheticDb();
    addPlane(db, TAIL, verifiedWifi);
    addPlane(db, SWAP_TAIL, null);
    addFleet(db, TAIL, "unknown");
    return db;
  }

  const run = (db: Database, result: StarlinkCheckResult) =>
    verifyPlaneStarlink(db, TAIL, FLIGHT, true, undefined, { checker: async () => result });

  test("trusted settle: exactly one log row, verified_wifi settles", async () => {
    const db = setup(null);
    addPriors(db, TAIL, "Starlink");
    await run(db, starlinkOn(TAIL));
    expect(logRows(db, TAIL)).toHaveLength(1);
    expect(planeWifi(db, TAIL)).toBe("Starlink");
    db.close();
  });

  test("trusted negative settles", async () => {
    const db = setup("Starlink");
    addPriors(db, TAIL, "Viasat");
    await run(db, viasatOn(TAIL));
    expect(planeWifi(db, TAIL)).toBe("Viasat");
    db.close();
  });

  test("trusted but ambiguous consensus: verified_wifi cleared to NULL, not flipped", async () => {
    const db = setup("Starlink");
    await run(db, viasatOn(TAIL)); // single obs < minObs
    expect(planeWifi(db, TAIL)).toBeNull();
    db.close();
  });

  test("poisoned error payload writes NO negative: log row has NULL, wifi untouched", async () => {
    const db = setup("Starlink");
    await run(db, poisonedErrorOn(TAIL));
    const rows = logRows(db, TAIL);
    expect(rows).toHaveLength(1);
    expect(rows[0].has_starlink).toBeNull();
    expect(rows[0].error).toBe(TIMEOUT);
    expect(planeWifi(db, TAIL)).toBe("Starlink");
    db.close();
  });

  test("swap: one row per tail, swap tail settles, intended tail untouched", async () => {
    const db = setup("Starlink");
    addPriors(db, SWAP_TAIL, "Starlink");
    await run(db, starlinkOn(SWAP_TAIL));
    expect(logRows(db, TAIL)).toHaveLength(1);
    expect(logRows(db, SWAP_TAIL)).toHaveLength(1);
    expect(planeWifi(db, SWAP_TAIL)).toBe("Starlink");
    expect(planeWifi(db, TAIL)).toBe("Starlink"); // untouched
    db.close();
  });

  test("mismatch × error: no swap row, no writes", async () => {
    const db = setup("Starlink");
    await run(db, errorOn(SWAP_TAIL));
    expect(logRows(db, TAIL)).toHaveLength(1);
    expect(logRows(db, SWAP_TAIL)).toHaveLength(0);
    expect(planeWifi(db, TAIL)).toBe("Starlink");
    db.close();
  });

  test("unknown × starlink: positive-only trust settles with confirmed priors", async () => {
    const db = setup(null);
    addPriors(db, TAIL, "Starlink");
    await run(db, starlinkOn(null));
    expect(planeWifi(db, TAIL)).toBe("Starlink");
    db.close();
  });

  test("unknown × other: verified_wifi untouched", async () => {
    const db = setup("Starlink");
    addPriors(db, TAIL, "Viasat");
    await run(db, viasatOn(null));
    expect(planeWifi(db, TAIL)).toBe("Starlink");
    db.close();
  });

  test("checker throws: unified failure row (UA flight number), wifi untouched, returns null", async () => {
    const db = setup("Starlink");
    const result = await verifyPlaneStarlink(db, TAIL, FLIGHT, true, undefined, {
      checker: async () => {
        throw new Error("spawn ENOMEM");
      },
    });
    expect(result).toBeNull();
    const rows = logRows(db, TAIL); // filters flight_number = 'UA100'
    expect(rows).toHaveLength(1);
    expect(rows[0].has_starlink).toBeNull();
    expect(rows[0].error).toBe("spawn ENOMEM");
    expect(planeWifi(db, TAIL)).toBe("Starlink");
    db.close();
  });

  test("verification mode syncs united_fleet status when consensus settles", async () => {
    const db = setup(null);
    addPriors(db, TAIL, "Viasat");
    await run(db, viasatOn(TAIL));
    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("negative");
    expect(uf.verified_wifi).toBe("Viasat");
    expect(uf.next_check_after).toBe(0); // scheduling untouched — discovery owns that
    db.close();
  });

  test("verification mode leaves united_fleet alone when consensus is ambiguous", async () => {
    const db = setup("Starlink");
    await run(db, viasatOn(TAIL)); // single obs < minObs
    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("unknown");
    expect(uf.verified_at).toBe(1);
    db.close();
  });

  test("ship-number page resolves via united_fleet map", async () => {
    const db = setup(null);
    addPriors(db, TAIL, "Starlink");
    updateShipNumber(db, TAIL, "0100");
    await run(db, checkResult({ shipNumber: "0100", hasStarlink: true, wifiProvider: "Starlink" }));
    expect(logRows(db, TAIL)[0].tail_confirmed).toBe(1);
    db.close();
  });

  test("shared verdict-core log lines keep the starlink-verifier logger tag", async () => {
    const db = setup("Starlink");
    addPriors(db, SWAP_TAIL, "Starlink");
    // Mismatch + swap settle exercises the shared warn + info lines.
    const tags = await captureLoggerTags(() => run(db, starlinkOn(SWAP_TAIL)));
    expect(tags.has("starlink-verifier")).toBe(true);
    expect(tags.has("united-verdict")).toBe(false);
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Discovery mode (fleet-discovery): united_fleet settle, backoff, and the
// transactional pairing with the shared write path.
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyPlane (discovery) write paths (injected checker + flights)", () => {
  const NOW = Math.floor(Date.now() / 1000);

  function makePlane(over: Partial<FleetAircraft> = {}): FleetAircraft {
    return {
      tail_number: TAIL,
      aircraft_type: "Boeing 737-900",
      first_seen_source: "flightradar24",
      first_seen_at: 1,
      last_seen_at: 1,
      fleet: "mainline",
      operated_by: "United Airlines",
      starlink_status: "unknown",
      verified_wifi: null,
      verified_at: null,
      discovery_priority: 1,
      next_check_after: 0,
      check_attempts: 0,
      last_check_error: null,
      ...over,
    };
  }

  const stubFlights: NonNullable<VerifyPlaneDeps["getFlights"]> = async () => ({
    forVerification: { flightNumber: "100", date: "2026-06-05", origin: "SFO", destination: "EWR" },
    allFlights: [
      {
        flight_number: "UA100",
        departure_airport: "KSFO",
        arrival_airport: "KEWR",
        departure_time: NOW + 6 * 3600,
        arrival_time: NOW + 11 * 3600,
      },
    ],
  });

  const run = (db: Database, plane: FleetAircraft, result: StarlinkCheckResult) =>
    verifyPlane(db, plane, { checker: async () => result, getFlights: stubFlights });

  test("trusted starlink with priors: unknown → confirmed, plane added to starlink_planes", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown");
    addPriors(db, TAIL, "Starlink");
    await run(db, makePlane(), starlinkOn(TAIL));

    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("confirmed");
    expect(uf.verified_wifi).toBe("Starlink");
    expect(uf.check_attempts).toBe(0);
    expect(uf.last_check_error).toBeNull();
    expect(planeWifi(db, TAIL)).toBe("Starlink"); // discovered row created
    db.close();
  });

  test("trusted other with priors: unknown → negative, NOT added to starlink_planes", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown");
    addPriors(db, TAIL, "Viasat");
    await run(db, makePlane(), viasatOn(TAIL));

    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("negative");
    expect(uf.verified_wifi).toBe("Viasat");
    expect(planeWifi(db, TAIL)).toBeUndefined(); // no starlink_planes row
    db.close();
  });

  test("trusted but ambiguous: status unchanged, needsMoreObs reschedules ~36h", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown");
    await run(db, makePlane(), viasatOn(TAIL)); // single obs

    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("unknown");
    expect(uf.verified_wifi).toBeNull();
    expect(uf.next_check_after).toBeGreaterThan(NOW + 24 * 3600);
    expect(uf.next_check_after).toBeLessThan(NOW + 48 * 3600);
    db.close();
  });

  test("poisoned error payload: NO negative settle — backoff bookkeeping only", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "confirmed", { verifiedWifi: "Starlink", verifiedAt: 1 });
    addPlane(db, TAIL, "Starlink");
    await run(
      db,
      makePlane({ starlink_status: "confirmed", verified_wifi: "Starlink" }),
      poisonedErrorOn(TAIL)
    );

    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("confirmed");
    expect(uf.verified_wifi).toBe("Starlink");
    expect(uf.verified_at).toBe(1); // error path never stamps verification
    expect(uf.check_attempts).toBe(1);
    expect(uf.last_check_error).toBe(TIMEOUT);
    expect(planeWifi(db, TAIL)).toBe("Starlink");
    const rows = logRows(db, TAIL);
    expect(rows).toHaveLength(1);
    expect(rows[0].has_starlink).toBeNull();
    db.close();
  });

  test("aircraft swap: intended tail backs off, swap tail logged and settled", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown");
    addPlane(db, SWAP_TAIL, null);
    addPriors(db, SWAP_TAIL, "Starlink");
    await run(db, makePlane(), starlinkOn(SWAP_TAIL));

    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("unknown");
    expect(uf.check_attempts).toBe(1);
    expect(uf.last_check_error).toBe(`Aircraft mismatch: flight has ${SWAP_TAIL}`);
    expect(logRows(db, SWAP_TAIL)).toHaveLength(1);
    expect(planeWifi(db, SWAP_TAIL)).toBe("Starlink");
    db.close();
  });

  test("unknown tail × other: status untouched, error bookkeeping", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown");
    await run(db, makePlane(), viasatOn(null));

    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("unknown");
    expect(uf.check_attempts).toBe(1);
    expect(uf.last_check_error).toBe("Tail not extracted — cannot attribute non-Starlink result");
    db.close();
  });

  test("no upcoming flights: schedules retry without inventing an observation", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown");
    const result = await verifyPlane(db, makePlane(), {
      checker: async () => {
        throw new Error("checker must not run");
      },
      getFlights: async () => null,
    });

    expect(result).toBeNull();
    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("unknown");
    expect(uf.check_attempts).toBe(1);
    expect(uf.last_check_error).toBe("No upcoming flights");
    expect(logRows(db, TAIL)).toHaveLength(0);
    db.close();
  });

  test("checker throws: unified failure row (UA flight number), backoff, status untouched", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "confirmed", { verifiedWifi: "Starlink", verifiedAt: 1 });
    const result = await verifyPlane(
      db,
      makePlane({ starlink_status: "confirmed", verified_wifi: "Starlink" }),
      {
        checker: async () => {
          throw new Error("spawn ENOMEM");
        },
        getFlights: stubFlights,
      }
    );

    expect(result).toBeNull();
    const uf = fleetRow(db, TAIL);
    expect(uf.starlink_status).toBe("confirmed");
    expect(uf.verified_wifi).toBe("Starlink");
    expect(uf.check_attempts).toBe(1);
    expect(uf.last_check_error).toBe("spawn ENOMEM");
    const rows = logRows(db, TAIL); // filters flight_number = 'UA100'
    expect(rows).toHaveLength(1);
    expect(rows[0].has_starlink).toBeNull();
    db.close();
  });

  test("shared verdict-core log lines keep the fleet-discovery logger tag", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown");
    // Unattributable cell exercises the shared "couldn't confirm tail" warn.
    const tags = await captureLoggerTags(() => run(db, makePlane(), viasatOn(null)));
    expect(tags.has("fleet-discovery")).toBe(true);
    expect(tags.has("united-verdict")).toBe(false);
    db.close();
  });

  test("swap-captured tail's united_fleet status syncs from consensus", async () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "unknown");
    addFleet(db, SWAP_TAIL, "negative", { verifiedWifi: "Viasat" });
    addPlane(db, SWAP_TAIL, null);
    addPriors(db, SWAP_TAIL, "Starlink");
    await run(db, makePlane(), starlinkOn(SWAP_TAIL));
    expect(fleetRow(db, SWAP_TAIL).starlink_status).toBe("confirmed");
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Discovery scheduling: return-to-service grace + first-of-family cascade.
// ─────────────────────────────────────────────────────────────────────────────

describe("discovery scheduling", () => {
  const NOW = Math.floor(Date.now() / 1000);

  function nextCheckHours(db: Database, tail: string): number {
    return (fleetRow(db, tail).next_check_after - NOW) / 3600;
  }

  test("return-to-service: long error streak → 24h grace, persists across checks, error clears it", () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "negative");
    db.query("UPDATE united_fleet SET check_attempts = 12 WHERE tail_number = ?").run(TAIL);

    updateFleetVerificationResult(db, TAIL, { starlinkStatus: "negative", verifiedWifi: "Viasat" });
    expect(nextCheckHours(db, TAIL)).toBeLessThan(30);
    expect(fleetRow(db, TAIL).check_attempts).toBe(0);

    updateFleetVerificationResult(db, TAIL, { starlinkStatus: "negative", verifiedWifi: "Viasat" });
    expect(nextCheckHours(db, TAIL)).toBeLessThan(30);

    updateFleetVerificationResult(db, TAIL, {
      starlinkStatus: "negative",
      verifiedWifi: null,
      error: "No upcoming flights",
    });
    updateFleetVerificationResult(db, TAIL, { starlinkStatus: "negative", verifiedWifi: "Viasat" });
    expect(nextCheckHours(db, TAIL)).toBeGreaterThan(11 * 24);
    db.close();
  });

  test("short error streak does not arm grace", () => {
    const db = makeSyntheticDb();
    addFleet(db, TAIL, "negative");
    db.query("UPDATE united_fleet SET check_attempts = 3 WHERE tail_number = ?").run(TAIL);
    updateFleetVerificationResult(db, TAIL, { starlinkStatus: "negative", verifiedWifi: "Viasat" });
    expect(nextCheckHours(db, TAIL)).toBeGreaterThan(11 * 24);
    db.close();
  });

  test("cascade: first-of-family bumps negative siblings, second confirm is a no-op", () => {
    const db = makeSyntheticDb();
    addFleet(db, "N777A", "confirmed", { aircraftType: "Boeing 777-224(ER)" });
    addFleet(db, "N777B", "negative", { aircraftType: "Boeing 777-222" });
    addFleet(db, "N777C", "negative", { aircraftType: "Boeing 777-322(ER)" });
    addFleet(db, "N777D", "unknown", { aircraftType: "Boeing 777-222" });
    addFleet(db, "N321A", "negative", { aircraftType: "Airbus A321-271NX" });
    db.query("UPDATE united_fleet SET next_check_after = ?").run(NOW + 14 * 86400);

    expect(cascadeSubfleetDiscovery(db, "N777A", "Boeing 777-224(ER)", "UA")).toBe(2);
    expect(fleetRow(db, "N777B").next_check_after).toBeLessThanOrEqual(NOW);
    expect(fleetRow(db, "N777C").next_check_after).toBeLessThanOrEqual(NOW);
    expect(fleetRow(db, "N777D").next_check_after).toBeGreaterThan(NOW); // unknown left alone
    expect(fleetRow(db, "N321A").next_check_after).toBeGreaterThan(NOW); // other family left alone

    db.query("UPDATE united_fleet SET starlink_status='confirmed' WHERE tail_number='N777B'").run();
    expect(cascadeSubfleetDiscovery(db, "N777C", "Boeing 777-322(ER)", "UA")).toBe(0);
    db.close();
  });
});
