import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerTurn, flightAnswerKey } from "../src/components/check-flight/answer-key";
import type { AssignedDeparture, FlightFacts } from "../src/components/check-flight/types";
import { getSitemapFlights } from "../src/database/database";
import { recordFlightAnswers } from "../src/database/flight-answers";
import { createApp } from "../src/server/app";
import { TEST_DB, makeFreshDb } from "./helpers";

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

describe("whether a changed key turned the answer", () => {
  const base = flightAnswerKey(facts());
  const key = (over: Partial<FlightFacts>) => flightAnswerKey(facts(over));

  test("the next plane flipping between Starlink and not is the most telling", () => {
    const no = key({ nextAssigned: { ...assigned, hasStarlink: false, wifi: "non-Starlink" } });
    expect(answerTurn(base, no)).toBe(0);
    expect(answerTurn(no, base)).toBe(0);
  });

  test("then the firm lead's other turns, the usual band, and the quiet note alone", () => {
    const likely = key({ nextAssigned: { ...assigned, verified: false } });
    const band = key({
      prediction: { probability: 0.8, n_observations: 40, confidence: "medium" },
    });
    const quiet = key({ notObservedSince: 1_799_000_000 });
    expect(answerTurn(base, likely)).toBe(1);
    expect(answerTurn(base, band)).toBe(2);
    expect(answerTurn(base, quiet)).toBe(3);
    const ranks = [answerTurn(base, likely), answerTurn(base, band), answerTurn(base, quiet)];
    expect(ranks).toEqual([...ranks].sort());
  });

  test("a new leg or route alone, or the same key, turns nothing", () => {
    const leg = key({ nextAssigned: { ...assigned, origin: "DEN" } });
    const route = key({ routes: [{ ...facts().routes[0], departure_airport: "LAX" }] });
    expect(leg).not.toBe(base);
    expect(answerTurn(base, leg)).toBeNull();
    expect(answerTurn(base, route)).toBeNull();
    expect(answerTurn(base, base)).toBeNull();
  });

  test("a word that changes with the leg is rotation, not a turn", () => {
    const otherLeg = { ...assigned, origin: "DEN", destination: "SFO" };
    const likelyThere = key({ nextAssigned: { ...otherLeg, verified: false } });
    const noThere = key({
      nextAssigned: { ...otherLeg, hasStarlink: false, wifi: "non-Starlink" },
    });
    expect(answerTurn(base, likelyThere)).toBeNull();
    expect(answerTurn(likelyThere, base)).toBeNull();
    expect(answerTurn(base, noThere)).toBeNull();
    expect(answerTurn(noThere, base)).toBeNull();
  });

  test("a firm lead that appears or goes is no turn", () => {
    const none = key({ nextAssigned: null });
    const no = key({ nextAssigned: { ...assigned, hasStarlink: false, wifi: "non-Starlink" } });
    for (const firm of [base, no]) {
      expect(answerTurn(firm, none)).toBeNull();
      expect(answerTurn(none, firm)).toBeNull();
    }
  });

  test("the usual band and the quiet note still count when the leg or lead moves too", () => {
    const band: Partial<FlightFacts> = {
      prediction: { probability: 0.8, n_observations: 40, confidence: "medium" },
    };
    const quiet: Partial<FlightFacts> = { notObservedSince: 1_799_000_000 };
    const legBand = key({ ...band, nextAssigned: { ...assigned, origin: "DEN", verified: false } });
    expect(answerTurn(base, legBand)).toBe(2);
    expect(answerTurn(base, key({ ...band, nextAssigned: null }))).toBe(2);
    expect(answerTurn(base, key({ ...quiet, nextAssigned: null }))).toBe(3);
  });

  test("keys that are not keys never pass for news", () => {
    for (const [a, b] of [
      ["", base],
      [base, "not json"],
      ["null", base],
      ["1", "2"],
      ["{}", "{}"],
    ]) {
      expect(answerTurn(a, b)).toBeNull();
    }
  });
});

describe("recording which answers turned", () => {
  const db = makeFreshDb();
  afterAll(() => db.close());
  const yes = flightAnswerKey(facts());
  const no = flightAnswerKey(
    facts({ nextAssigned: { ...assigned, hasStarlink: false, wifi: "non-Starlink" } })
  );
  const quiet = flightAnswerKey(facts({ notObservedSince: 1_799_000_000 }));
  const leg = flightAnswerKey(facts({ nextAssigned: { ...assigned, origin: "DEN" } }));

  test("a first sighting, the same answer or a new leg is not handed on; a turn is, most telling first", () => {
    const first = recordFlightAnswers(
      db,
      "UA",
      [
        { flight_number: "UA1", answer: yes },
        { flight_number: "UA2", answer: yes },
        { flight_number: "UA3", answer: yes },
        { flight_number: "UA4", answer: yes },
      ],
      1_800_000_000,
      answerTurn
    );
    expect(first.turned).toEqual([]);
    const next = recordFlightAnswers(
      db,
      "UA",
      [
        { flight_number: "UA1", answer: quiet },
        { flight_number: "UA2", answer: no },
        { flight_number: "UA3", answer: yes },
        { flight_number: "UA4", answer: leg },
      ],
      1_800_003_600,
      answerTurn
    );
    expect(next.changed).toBe(3);
    expect(next.turned).toEqual(["UA2", "UA1"]);
  });

  test("without a rule for turns, nothing is handed on", () => {
    const r = recordFlightAnswers(db, "UA", [{ flight_number: "UA2", answer: yes }], 1_800_007_200);
    expect(r.changed).toBe(1);
    expect(r.turned).toEqual([]);
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
    for (const r of [...first, ...second]) expect(r.turned).toEqual([]);
    const after = getSitemapFlights(db, "UA").map((f) => [f.flight_number, f.changed_at]);
    expect(after).toEqual(before);
  });
});
