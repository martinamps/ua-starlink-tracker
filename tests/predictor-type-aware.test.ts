/**
 * The aircraft-type-aware predictor (buildModel with a census roster).
 * Tests the pure model directly — predictFlight's module-level cache is keyed
 * by scope, so going through a reader here would collide with the snapshot-
 * backed suites. Asserts the causal structure, not exact probabilities.
 */
import { describe, expect, test } from "bun:test";
import type { FleetRosterEntry, VerificationObservation } from "../src/database/database";
import { buildModel } from "../src/scripts/starlink-predictor";

const CONFIG = {
  priorStrength: 3,
  expressSmoothingPrior: 0.768,
  mainlineSmoothingPrior: 0.02,
  expressColdPrior: 0.39,
  mainlineColdPrior: 0.02,
};

const NOW = 1_780_000_000;
const obs = (
  flight_number: string,
  tail_number: string,
  has_starlink: number,
  daysAgo = 0
): VerificationObservation => ({
  flight_number,
  tail_number,
  has_starlink,
  checked_at: NOW - daysAgo * 86400,
});

// A census-shaped roster: 400 unretrofittable 787s, 400 737-824s of which 100
// carry Starlink, 100 fully-retrofitted express E175s. Raw type strings are
// deliberate: the model must normalize them to families itself.
function makeRoster(): FleetRosterEntry[] {
  const roster: FleetRosterEntry[] = [];
  for (let i = 0; i < 400; i++)
    roster.push({
      tail_number: `N787-${i}`,
      aircraft_type: "Boeing 787-9",
      verified_wifi: null,
    });
  for (let i = 0; i < 400; i++)
    roster.push({
      tail_number: `N738-${i}`,
      aircraft_type: "Boeing 737-824",
      verified_wifi: i < 100 ? "Starlink" : null,
    });
  for (let i = 0; i < 100; i++)
    roster.push({
      tail_number: `N175-${i}`,
      aircraft_type: "ERJ-175",
      verified_wifi: "Starlink",
    });
  return roster;
}

describe("type-aware predictor", () => {
  const roster = makeRoster();

  test("a flight that only ever draws an unretrofittable type predicts ~0", () => {
    // UA100 has flown ten 787s. 0/400 787s have Starlink → the answer is no,
    // no matter what the express/mainline average says.
    const history = Array.from({ length: 10 }, (_, i) => obs("UA100", `N787-${i}`, 0, i));
    const { predict } = buildModel(history, CONFIG, roster);
    const p = predict("UA100");
    expect(p.probability).toBeLessThan(0.05);
    expect(p.method).toBe("flight_history_smoothed");
    expect(p.confidence).toBe("high");
  });

  test("stale pre-retrofit zeros are relabeled by the tail's CURRENT status", () => {
    // Every UA200 observation predates its tail's retrofit (has_starlink=0).
    // The verifier has since re-seen each tail WITH Starlink — on some other
    // flight. UA200's own record is 0/10, but the tails it draws all carry
    // Starlink now, so the honest answer flips. The legacy model can't see it.
    const history = [
      ...Array.from({ length: 10 }, (_, i) => obs("UA200", `N738-${i}`, 0, 5 + i)),
      ...Array.from({ length: 10 }, (_, i) => obs(`UA90${i}`, `N738-${i}`, 1, i / 10)),
    ];
    const withRoster = buildModel(history, CONFIG, roster).predict("UA200");
    const legacy = buildModel(history, CONFIG, []).predict("UA200");
    expect(legacy.probability).toBeLessThan(0.1);
    expect(withRoster.probability).toBeGreaterThan(0.7);
  });

  test("the prior is the flight's TYPE mix, not a fleet-wide average", () => {
    // Two cold-ish mainline flights, one observation each, on tails that are
    // not themselves Starlink. Only their aircraft type differs — and so must
    // the prediction: the 737-824 pool is 25% retrofitted, the 787 pool 0%.
    const history = [obs("UA300", "N738-399", 0), obs("UA301", "N787-399", 0)];
    const { predict } = buildModel(history, CONFIG, roster);
    const on737 = predict("UA300").probability;
    const on787 = predict("UA301").probability;
    expect(on737).toBeGreaterThan(on787 + 0.1);
    expect(on787).toBeLessThan(0.05);
  });

  test("a flight that has never drawn a rostered tail gets the subfleet cold prior", () => {
    const { predict } = buildModel([], CONFIG, roster);
    const express = predict("UA5000");
    expect(express.probability).toBe(CONFIG.expressColdPrior);
    expect(express.method).toBe("fleet_prior_express");
    expect(express.n_observations).toBe(0);
    expect(predict("UA300").method).toBe("fleet_prior_mainline");
  });

  test("cosmetic type-name variants share one penetration bucket", () => {
    // "Boeing 737-800" and "Boeing 737-824" are the same airframe under two
    // labels. A flight that only ever drew "737-800"-labelled tails must be
    // priced by the merged B737-800 family, not a private 737-800 bucket.
    const split: FleetRosterEntry[] = [
      ...Array.from({ length: 20 }, (_, i) => ({
        tail_number: `NA${i}`,
        aircraft_type: "Boeing 737-800",
        verified_wifi: "Starlink",
      })),
      ...Array.from({ length: 80 }, (_, i) => ({
        tail_number: `NB${i}`,
        aircraft_type: "Boeing 737-824",
        verified_wifi: null,
      })),
    ];
    const p = buildModel([obs("UA700", "NA0", 1)], CONFIG, split).predict("UA700");
    // Merged family rate is 20/100; an unmerged "737-800" bucket would be 20/20.
    expect(p.probability).toBeLessThan(0.6);
  });

  test("a recent observation of the tail itself outranks the roster's settled state", () => {
    // N738-399 has verified_wifi=null in the roster but the log has since
    // seen it WITH Starlink — the point-in-time observation wins.
    const history = Array.from({ length: 6 }, (_, i) => obs("UA400", "N738-399", 1, i));
    expect(buildModel(history, CONFIG, roster).predict("UA400").probability).toBeGreaterThan(0.7);
  });

  test("a tail's current status is its NEWEST observation, not the last row iterated", () => {
    // getVerificationObservations has no ORDER BY, so the model must key on
    // checked_at itself. Same history, reversed row order → same answer.
    const history = [
      ...Array.from({ length: 10 }, (_, i) => obs("UA200", `N738-${i}`, 0, 5 + i)),
      ...Array.from({ length: 10 }, (_, i) => obs(`UA90${i}`, `N738-${i}`, 1, i / 10)),
    ];
    const forward = buildModel(history, CONFIG, roster).predict("UA200").probability;
    const reversed = buildModel([...history].reverse(), CONFIG, roster).predict(
      "UA200"
    ).probability;
    expect(reversed).toBe(forward);
    expect(reversed).toBeGreaterThan(0.7);
  });

  test("an observation on an unrostered tail still counts toward the flight's history", () => {
    // NZZZ is not in united_fleet (retired / missed by fleet-sync). Its
    // observations must not silently vanish and regress UA600 to a cold prior.
    const history = Array.from({ length: 8 }, (_, i) => obs("UA600", "NZZZ", 1, i));
    const p = buildModel(history, CONFIG, roster).predict("UA600");
    expect(p.n_observations).toBe(8);
    expect(p.method).toBe("flight_history_smoothed");
    expect(p.probability).toBeGreaterThan(0.7);
  });

  test("confidence reflects the decayed evidence weight, not the raw count", () => {
    // Six draws from ~3 months before the newest observation carry almost no
    // weight — the probability is nearly all prior, so the label must not
    // claim "high" the way a raw count of 6 would.
    const stale = buildModel(
      [
        obs("UA999", "N175-0", 1, 0), // anchors "now"
        ...Array.from({ length: 6 }, (_, i) => obs("UA800", `N738-${200 + i}`, 0, 90 + i)),
      ],
      CONFIG,
      roster
    ).predict("UA800");
    expect(stale.n_observations).toBe(6);
    expect(stale.confidence).not.toBe("high");
  });

  test("no roster → the legacy subfleet-prior model, method labels intact", () => {
    const legacy = buildModel([obs("UA500", "N1", 1), obs("UA500", "N1", 1)], CONFIG, []);
    const seen = legacy.predict("UA500");
    expect(seen.method).toBe("flight_history_smoothed");
    expect(seen.n_observations).toBe(2);
    const cold = legacy.predict("UA501");
    expect(cold.method).toBe("fleet_prior_mainline");
    expect(cold.probability).toBe(CONFIG.mainlineColdPrior);
  });
});
