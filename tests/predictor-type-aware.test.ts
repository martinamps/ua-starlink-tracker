/**
 * The aircraft-type-aware predictor (buildModel with a census roster).
 * Tests the pure model directly — predictFlight's module-level cache is keyed
 * by scope, so going through a reader here would collide with the snapshot-
 * backed suites. Asserts the causal structure, not exact probabilities.
 */
import { describe, expect, test } from "bun:test";
import type {
  FleetRosterEntry,
  FlightTypeDraw,
  VerificationObservation,
} from "../src/database/database";
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

const draw = (
  flight_number: string,
  tail_number: string,
  aircraft_type: string,
  daysAgo = 0
): FlightTypeDraw => ({
  flight_number,
  tail_number,
  aircraft_type,
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
  // The never-equipped end of United Express: 60 CRJ-200s, none retrofitted,
  // alongside a fully-equipped E175 pool that lifts the express average.
  const crjRoster: FleetRosterEntry[] = [
    ...roster,
    ...Array.from({ length: 60 }, (_, i) => ({
      tail_number: `NCRJ-${i}`,
      aircraft_type: "Bombardier CRJ-200",
      verified_wifi: null,
    })),
  ];

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

  test("a flight known only by the airframes it draws is priced off that family", () => {
    // UA5000 has no clean observation — its checks parse no wifi provider, the
    // way a regional jet with no wifi product at all never does. What the log
    // DOES record is which airframe flew it. Without that the express cold
    // prior answers for a family that will never be equipped.
    const draws = Array.from({ length: 6 }, (_, i) => draw("UA5000", `NCRJ-${i}`, "CRJ-200", i));
    const withTypes = buildModel([], CONFIG, crjRoster, draws).predict("UA5000");
    const blind = buildModel([], CONFIG, crjRoster).predict("UA5000");

    expect(withTypes.method).toBe("type_mix_prior");
    expect(withTypes.n_observations).toBe(0);
    // No outcome behind it — the number is a prior, and says so.
    expect(withTypes.confidence).toBe("low");
    expect(withTypes.probability).toBeLessThan(blind.probability);
    expect(blind.method).toBe("fleet_prior_express");
  });

  test("airframes the roster misses still count toward their family's rate", () => {
    // United Express is flown by partner carriers whose tails the fleet pull
    // doesn't return, so ERJ-145 has no rostered airframe at all. The log has
    // both their family and their status, which is everything a penetration
    // figure needs — and without it the express average answers instead.
    const offRoster = Array.from({ length: 8 }, (_, i) => `NPTNR-${i}`);
    const history = offRoster.map((tail, i) => obs(`UA61${i}`, tail, 0, i));
    const draws = [
      ...offRoster.map((tail, i) => draw(`UA61${i}`, tail, "ERJ-145", i)),
      ...offRoster.map((tail, i) => draw("UA5001", tail, "ERJ-145", i)),
    ];
    const p = buildModel(history, CONFIG, roster, draws).predict("UA5001");
    expect(p.method).toBe("type_mix_prior");
    expect(p.probability).toBeLessThan(CONFIG.expressColdPrior / 2);
  });

  test("a family with no airframe of known status leaves the prior alone", () => {
    // An unknown type must not read as 0% installed: UA5002 draws a family the
    // roster has never seen and no observation has ever settled, so the honest
    // answer is still the subfleet cold start.
    const p = buildModel([], CONFIG, roster, [draw("UA5002", "NNEW-1", "Airbus A321neo")]).predict(
      "UA5002"
    );
    expect(p.method).toBe("fleet_prior_express");
    expect(p.probability).toBe(CONFIG.expressColdPrior);
  });

  test("an off-roster airframe with no clean observation neither counts nor blocks", () => {
    // The conjunction 462d886 named as its root cause: a tail missing from the
    // fleet roster AND never seen in a clean observation. Production has no
    // airframe in that state today — every off-roster tail in the draw log
    // carries one, and never-equipped jets report wifi_provider 'None', which
    // is a clean negative — but the model must handle it in the safe direction:
    // the unknown body is not counted as unequipped, and it does not stop the
    // family's KNOWN bodies from pricing the flight either.
    const p = buildModel([], CONFIG, crjRoster, [draw("UA5530", "NGHOST-1", "CRJ-200")]).predict(
      "UA5530"
    );
    expect(p.method).toBe("type_mix_prior");
    expect(p.probability).toBeLessThan(CONFIG.expressColdPrior / 4);
  });

  test("type evidence informs the prior; it never overrules the flight's own record", () => {
    // A 25%-penetration family still has flight numbers that draw an equipped
    // tail every single day. Clamping those at the family rate costs Brier
    // 0.1630 -> 0.1727 on the production snapshot — see mixPrior's note.
    const history = Array.from({ length: 12 }, (_, i) => obs("UA800", "N738-0", 1, i / 4));
    const draws = Array.from({ length: 12 }, (_, i) =>
      draw("UA800", "N738-0", "Boeing 737-824", i / 4)
    );
    const p = buildModel(history, CONFIG, roster, draws).predict("UA800");
    expect(p.method).toBe("flight_history_smoothed");
    expect(p.probability).toBeGreaterThan(0.7);
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
    // Same answer, not the same float: the decayed weights are summed in row
    // order, so bit-equality would be asserting IEEE addition is commutative.
    expect(reversed).toBeCloseTo(forward, 12);
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

  test("a large stale sample is hedged, never labeled low next to its own n", () => {
    // The shipped bug: confidence scored off the decayed weight while
    // n_observations reported the raw count, so a flight could publish
    // "17 observations (low confidence)" — which the Chrome extension read as
    // a reason to suppress the badge at the point of booking.
    const staleSeventeen = buildModel(
      [
        obs("UA999", "N175-0", 1, 0),
        ...Array.from({ length: 17 }, () => obs("UA5501", "N175-1", 1, 120)),
      ],
      CONFIG,
      roster
    ).predict("UA5501");
    expect(staleSeventeen.n_observations).toBe(17);
    expect(staleSeventeen.confidence).not.toBe("low");
  });

  test("neighbouring draw counts of the same age are never labeled differently", () => {
    // The reported symptom: two legs at the same probability, one draw apart,
    // carrying opposite labels. Pinning a single age proves nothing — any rule
    // scored on count x decay straddles SOMEWHERE, so sweep the ages instead.
    // Only confidenceFor's own count boundaries (1|2 and 4|5) may separate two
    // counts, and this sweep stays inside one of its bands.
    const label = (n: number, ageDays: number) =>
      buildModel(
        [
          obs("UA999", "N175-0", 1, 0),
          ...Array.from({ length: n }, () => obs("UA5510", "N175-1", 1, ageDays)),
        ],
        CONFIG,
        roster
      ).predict("UA5510").confidence;

    const straddles: string[] = [];
    for (let ageDays = 1; ageDays <= 365; ageDays++) {
      for (let n = 5; n <= 39; n++) {
        if (label(n, ageDays) !== label(n + 1, ageDays)) {
          straddles.push(`${n} vs ${n + 1} at ${ageDays}d`);
        }
      }
    }
    expect(straddles).toEqual([]);
  });

  test("staleness costs at most one tier, so decay still outranks a fresh sample", () => {
    // The floor must not erase the decay signal: 16 fresh draws should still
    // outrank 17 stale ones. Same method, so the ordering is the label's job.
    const build = (n: number, ageDays: number, fn: string) =>
      buildModel(
        [
          obs("UA999", "N175-0", 1, 0),
          ...Array.from({ length: n }, () => obs(fn, "N175-1", 1, ageDays)),
        ],
        CONFIG,
        roster
      ).predict(fn);

    const stale = build(17, 120, "UA5501");
    const fresh = build(16, 30, "UA5502");
    const rank = { low: 0, medium: 1, high: 2 } as const;

    expect(stale.method).toBe(fresh.method);
    expect(rank[fresh.confidence]).toBeGreaterThan(rank[stale.confidence]);
    expect(fresh.confidence).toBe("high");
  });

  test("the raw floor never invents confidence a thin sample hasn't earned", () => {
    // One fresh observation is genuinely weak; flooring must not promote it.
    const single = buildModel([obs("UA5503", "N175-1", 1, 0)], CONFIG, roster).predict("UA5503");
    expect(single.n_observations).toBe(1);
    expect(single.confidence).toBe("low");
  });

  test("the floor covers small samples too, not just the 5+ band", () => {
    // The first floor only lifted a sample one tier below its raw count, which
    // left 2-4 draws — confidenceFor's own "medium" band — still publishing
    // "3 historical observations (low confidence)". Every count the tiering
    // rates above low must clear the same bar.
    for (const n of [2, 3, 4]) {
      const p = buildModel(
        [
          obs("UA999", "N175-0", 1, 0),
          ...Array.from({ length: n }, () => obs(`UA560${n}`, "N175-1", 1, 90)),
        ],
        CONFIG,
        roster
      ).predict(`UA560${n}`);
      expect(p.n_observations, `n=${n}`).toBe(n);
      expect(p.confidence, `n=${n}`).not.toBe("low");
    }
  });

  test("evidence decayed past the prior falls to low however large the raw count", () => {
    // The floor must not make "low" unreachable forever: at a year and two
    // years out, 17 draws are worth a fraction of one observation against the
    // smoothing prior, so the number IS the prior and the label must say so.
    const build = (ageDays: number, fn: string) =>
      buildModel(
        [
          obs("UA999", "N175-0", 1, 0),
          ...Array.from({ length: 17 }, () => obs(fn, "N175-1", 1, ageDays)),
        ],
        CONFIG,
        roster
      ).predict(fn);

    for (const [age, fn] of [
      [365, "UA5504"],
      [730, "UA5505"],
    ] as const) {
      const dead = build(age, fn);
      expect(dead.n_observations, `${age}d`).toBe(17);
      expect(dead.confidence, `${age}d`).toBe("low");
    }
    // ...and the cliff is the decay, not the count: the same 17 draws still
    // rate above low while the evidence is live.
    expect(build(120, "UA5506").confidence).not.toBe("low");
  });

  test("a type-mix answer is never stated as a certainty", () => {
    // Zero observations behind it, so it must not outrank a verified answer:
    // an all-equipped family can't publish 100% and a thin family can't
    // publish 0% off a couple of airframes.
    const allEquipped: FleetRosterEntry[] = Array.from({ length: 40 }, (_, i) => ({
      tail_number: `NE${i}`,
      aircraft_type: "ERJ-175",
      verified_wifi: "Starlink",
    }));
    const thin: FleetRosterEntry[] = [
      { tail_number: "NTHIN-1", aircraft_type: "Bombardier CRJ-700", verified_wifi: null },
    ];
    const { predict } = buildModel(
      [],
      CONFIG,
      [...crjRoster, ...allEquipped, ...thin],
      [
        draw("UA5520", "NE0", "ERJ-175"),
        draw("UA5521", "NTHIN-1", "CRJ-700"),
        draw("UA5522", "NCRJ-0", "CRJ-200"),
      ]
    );

    const sure = predict("UA5520");
    const sparse = predict("UA5521");
    const censused = predict("UA5522");
    expect(sure.method).toBe("type_mix_prior");
    expect(sure.probability).toBeLessThan(1);
    expect(sparse.method).toBe("type_mix_prior");
    expect(sparse.probability).toBeGreaterThan(0);
    // A one-airframe family is barely evidence; sixty airframes at the same
    // rate is. The thin one must stay nearer the fleet-wide rate.
    expect(sparse.probability).toBeGreaterThan(censused.probability);
  });

  test("a large never-equipped family still prices far under the subfleet prior", () => {
    // Smoothing must hedge the extremes without giving back the fix: 60
    // CRJ-200s with no Starlink is real evidence, not a coin flip.
    const draws = Array.from({ length: 6 }, (_, i) => draw("UA5000", `NCRJ-${i}`, "CRJ-200", i));
    const p = buildModel([], CONFIG, crjRoster, draws).predict("UA5000");
    expect(p.method).toBe("type_mix_prior");
    expect(p.probability).toBeLessThan(CONFIG.expressColdPrior / 4);
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
