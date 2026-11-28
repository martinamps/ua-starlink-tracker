import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flightAnswerKey } from "../src/components/check-flight/answer-key";
import type { AssignedDeparture, FlightFacts } from "../src/components/check-flight/types";
import { getSitemapFlights } from "../src/database/database";
import { createApp } from "../src/server/app";
import { TEST_DB } from "./helpers";

const assigned: AssignedDeparture = {
  hasStarlink: true,
  verified: true,
  tail: "N12345",
  aircraft: "Boeing 737-900",
  wifi: null,
  origin: "SFO",
  destination: "EWR",
  departure: 1_800_000_000,
  departureZone: "America/Los_Angeles",
  seenAt: 1_799_990_000,
};

function facts(over: Partial<FlightFacts> = {}): FlightFacts {
  return {
    flightNumber: "UA1",
    airlineName: "United",
    observedTotal: 40,
    observedStarlink: 5,
    prediction: { probability: 0.12, n_observations: 40, confidence: "medium" },
    aircraftTypes: ["Boeing 737-900"],
    lastStarlink: null,
    routes: [
      {
        departure_airport: "SFO",
        arrival_airport: "EWR",
        times: 40,
        dur_sec: 19800,
        last_seen_at: 1_799_990_000,
        linkable: true,
      },
    ],
    upcoming: [],
    nextAssigned: assigned,
    siblings: [],
    notObservedSince: null,
    ...over,
  };
}

describe("a flight page's answer key", () => {
  const base = flightAnswerKey(facts());

  test("another plane with the same answer, a later day or a fresh refresh is no change", () => {
    const next = {
      ...assigned,
      tail: "N54321",
      aircraft: "Boeing 737 MAX 9",
      departure: assigned.departure + 86400,
      seenAt: assigned.seenAt + 86400,
    };
    expect(flightAnswerKey(facts({ nextAssigned: next }))).toBe(base);
  });

  test("odds that drift inside their band, and a longer check tally, are no change", () => {
    expect(
      flightAnswerKey(
        facts({
          prediction: { probability: 0.14, n_observations: 41, confidence: "medium" },
          observedTotal: 41,
          observedStarlink: 6,
        })
      )
    ).toBe(base);
  });

  test("a different answer, Wi-Fi, leg, odds band or quiet note is a change", () => {
    const changed = [
      facts({ nextAssigned: { ...assigned, hasStarlink: false, wifi: "non-Starlink" } }),
      facts({ nextAssigned: { ...assigned, verified: false } }),
      facts({ nextAssigned: null }),
      facts({ nextAssigned: { ...assigned, origin: "DEN" } }),
      facts({ prediction: { probability: 0.8, n_observations: 40, confidence: "medium" } }),
      facts({ routes: [{ ...facts().routes[0], departure_airport: "LAX" }] }),
      facts({ notObservedSince: 1_799_000_000 }),
    ];
    for (const f of changed) expect(flightAnswerKey(f)).not.toBe(base);
  });
});

describe("recording answers on a copy of the snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "flight-answers-"));
  const path = join(dir, "db.sqlite");
  copyFileSync(TEST_DB, path);
  const db = new Database(path);
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a second pass over unchanged data changes no date", async () => {
    const app = createApp(db);
    const before = getSitemapFlights(db, "UA").map((f) => [f.flight_number, f.changed_at]);
    const first = await app.recordFlightAnswers();
    const ua = first.find((r) => r.airline === "UA");
    expect(ua?.seen).toBe(before.length);
    // Every key is new, and a first sighting claims no change.
    expect(ua?.changed).toBe(0);
    const second = await app.recordFlightAnswers();
    expect(second.find((r) => r.airline === "UA")?.changed).toBe(0);
    const after = getSitemapFlights(db, "UA").map((f) => [f.flight_number, f.changed_at]);
    expect(after).toEqual(before);
  });
});
