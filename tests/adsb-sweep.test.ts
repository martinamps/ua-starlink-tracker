// Pins the callsign↔assignment matching rules and the shadow sweep's write path.
// Shadow only: nothing here may touch the serving tables.

import { describe, expect, test } from "bun:test";
import {
  callsignMatchesAssignment,
  classifyObservation,
  deriveCallsignFlight,
  runAdsbSweepShadow,
} from "../src/scripts/adsb-sweep";
import { addFleet, addFlight, makeSyntheticDb } from "./helpers";

describe("callsign matching", () => {
  test.each([
    ["UAL1710", "UA1710", true],
    ["UAL1710", "UAL1710", true],
    ["SKW5753", "SKW5753", true],
    ["SKW5753", "OO5753", true],
    ["GJS4520", "G74520", true],
    ["RPA3640", "YX3640", true],
    ["UAL1710", "UA1711", false],
    ["SKW5753", "UA5753", false],
    ["DAL123", "UA123", false],
  ])("%s vs assigned %s -> %p", (callsign, assigned, expected) => {
    expect(callsignMatchesAssignment(callsign, assigned)).toBe(expected);
  });

  test("deriveCallsignFlight ignores non-UA-network callsigns", () => {
    expect(deriveCallsignFlight("DAL123")).toBeNull();
    expect(deriveCallsignFlight(null)).toBeNull();
    expect(deriveCallsignFlight("UAL204")).toEqual({ prefix: "UAL", num: 204 });
  });
});

describe("classifyObservation", () => {
  const aircraft = (callsign: string | null) => ({
    tail: "N73275",
    hex: "a98d0c",
    callsign,
    airborne: true,
    gs: 450,
    lat: 40,
    lon: -100,
    aircraftType: "B738",
  });

  test("classifies match, mismatch, no_assignment, no_callsign, non_revenue, low_speed", () => {
    expect(classifyObservation(aircraft("UAL1326"), ["UAL1326"]).result).toBe("match");
    expect(classifyObservation(aircraft("UAL1326"), ["UAL2436"]).result).toBe("mismatch");
    expect(classifyObservation(aircraft("UAL1326"), []).result).toBe("no_assignment");
    expect(classifyObservation(aircraft(null), ["UAL1326"]).result).toBe("no_callsign");
    expect(classifyObservation(aircraft("UAL8114"), ["UAL2436"]).result).toBe("non_revenue");
    expect(classifyObservation(aircraft("SKW9001"), []).result).toBe("non_revenue");
    expect(classifyObservation({ ...aircraft("UAL1326"), gs: 80 }, ["UAL1326"]).result).toBe(
      "low_speed"
    );
  });
});

describe("runAdsbSweepShadow", () => {
  function seedDb() {
    const db = makeSyntheticDb();
    const now = Math.floor(Date.now() / 1000);
    // Sweep reads united_fleet (full fleet, not just Starlink tails).
    addFleet(db, "N73275", "confirmed", { aircraftType: "Boeing 737-824" });
    addFleet(db, "N106SY", "confirmed", { aircraftType: "E175" });
    // One in-progress sector and one about to depart.
    addFlight(db, "N73275", "UAL1326", "AUS", now - 5 * 3600, { arrivalAirport: "IAH" });
    db.query("UPDATE upcoming_flights SET arrival_time = ? WHERE tail_number = 'N73275'").run(
      now + 3600
    );
    addFlight(db, "N106SY", "SKW6027", "SFO", now + 900, { arrivalAirport: "SLC" });
    return db;
  }

  const providerResponse = JSON.stringify({
    ac: [
      {
        r: "N73275",
        hex: "a98d0c",
        flight: "UAL1326 ",
        alt_baro: 35000,
        gs: 450,
        lat: 30,
        lon: -97,
        t: "B738",
      },
      {
        r: "N106SY",
        hex: "abc123",
        flight: "SKW5425",
        alt_baro: 20000,
        gs: 380,
        lat: 37,
        lon: -121,
        t: "E75L",
      },
    ],
  });

  test("records observations, classifies against assignments, and prunes nothing fresh", async () => {
    const db = seedDb();
    const fetcher = (async () => new Response(providerResponse, { status: 200 })) as typeof fetch;
    const result = await runAdsbSweepShadow(db, fetcher);
    expect(result.outcome).toBe("success");
    expect(result.airborne).toBe(2);
    expect(result.counts.match).toBe(1);
    expect(result.counts.mismatch).toBe(1);

    const sweeps = db.query("SELECT * FROM adsb_sweeps").all() as Array<Record<string, unknown>>;
    expect(sweeps.length).toBe(1);
    expect(sweeps[0].matched).toBe(1);
    expect(sweeps[0].mismatched).toBe(1);

    const obs = db
      .query(
        "SELECT tail_number, shadow_result, assigned_flight FROM adsb_observations ORDER BY tail_number"
      )
      .all() as Array<{ tail_number: string; shadow_result: string; assigned_flight: string }>;
    expect(obs.length).toBe(2);
    expect(obs.find((o) => o.tail_number === "N73275")?.shadow_result).toBe("match");
    expect(obs.find((o) => o.tail_number === "N106SY")?.shadow_result).toBe("mismatch");
    expect(obs.find((o) => o.tail_number === "N106SY")?.assigned_flight).toBe("SKW6027");
  });

  test("reports error without writing when every provider fails", async () => {
    const db = seedDb();
    const fetcher = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const result = await runAdsbSweepShadow(db, fetcher);
    expect(result.outcome).toBe("error");
    expect(db.query("SELECT COUNT(*) AS n FROM adsb_sweeps").get()).toEqual({ n: 0 });
  });
});
