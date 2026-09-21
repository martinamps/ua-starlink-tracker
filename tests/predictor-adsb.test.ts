/**
 * ADS-B tail draws: the rollup (adsb_flight_draws), its scope gate, and what
 * the predictor does with them. Model assertions are relational — which side
 * of a threshold or of another number — never exact probabilities.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES } from "../src/airlines/registry";
import {
  type AdsbFlightDraw,
  getAdsbFlightDraws,
  upsertAdsbFlightDraws,
} from "../src/database/adsb-flight-draws";
import type { FleetRosterEntry, VerificationObservation } from "../src/database/database";
import { setMeta } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { backfillAdsbFlightDraws, flightSightingFromObservation } from "../src/scripts/adsb-sweep";
import {
  buildModel,
  labelAdsbDraws,
  loadFleetPriors,
  planItinerary,
  predictFlight,
} from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { addFlight, jsonOf, makeSyntheticDb } from "./helpers";

const CONFIG = {
  priorStrength: 3,
  expressSmoothingPrior: 0.768,
  mainlineSmoothingPrior: 0.2,
  expressColdPrior: 0.15,
  mainlineColdPrior: 0.2,
};
const NOW = 1_780_000_000;
const DAY = 86400;

const obs = (
  flight_number: string,
  tail_number: string,
  has_starlink: number,
  daysAgo = 0
): VerificationObservation => ({
  flight_number,
  tail_number,
  has_starlink,
  checked_at: NOW - daysAgo * DAY,
});

const draw = (flight_number: string, tail_number: string, daysAgo: number): AdsbFlightDraw => ({
  flight_number,
  tail_number,
  first_seen: NOW - daysAgo * DAY,
  last_seen: NOW - daysAgo * DAY + 3 * 3600,
});

// 200 MAX8s with no Starlink, 200 737-800s of which half have it.
function roster(): FleetRosterEntry[] {
  const out: FleetRosterEntry[] = [];
  for (let i = 0; i < 200; i++) {
    out.push({ tail_number: `NMAX${i}`, aircraft_type: "Boeing 737 MAX 8", verified_wifi: null });
    out.push({
      tail_number: `N738${i}`,
      aircraft_type: "Boeing 737-824",
      verified_wifi: i < 100 ? "Starlink" : null,
    });
  }
  return out;
}

describe("predictor with ADS-B draws", () => {
  const r = roster();
  // The verifier caught UA694 twice, both times on a Starlink 737-800; ADS-B
  // saw it ten times on MAX8s that have none.
  const log = [obs("UA694", "N7380", 1, 3), obs("UA694", "N7381", 1, 10)];
  const adsb = Array.from({ length: 10 }, (_, i) => draw("UA694", `NMAX${i}`, i));

  test("unbiased 0%-family draws outweigh two Starlink-biased log draws", () => {
    const logOnly = buildModel(log, CONFIG, r, null).predict("UA694");
    const withAdsb = buildModel(log, CONFIG, r, adsb).predict("UA694");
    expect(withAdsb.probability).toBeLessThan(0.3);
    expect(withAdsb.probability).toBeLessThan(logOnly.probability);
    expect(withAdsb.n_observations).toBeGreaterThan(logOnly.n_observations);
  });

  test("a flight seen only by ADS-B is still flight history, not a cold prior", () => {
    const p = buildModel(log, CONFIG, r, [draw("UA999", "NMAX5", 1)]).predict("UA999");
    expect(p.method).toBe("flight_history_smoothed");
    expect(p.n_observations).toBe(1);
    expect(p.n_recent_observations).toBe(1);
  });

  test("a tail outside the United roster is ignored (SKW/RPA also fly for DL/AA/AS)", () => {
    const p = buildModel(log, CONFIG, r, [draw("UA5123", "N123DL", 1)]).predict("UA5123");
    expect(p.method).toBe("fleet_prior_express");
    expect(p.n_observations).toBe(0);
  });

  test("an ADS-B draw of a departure the log already holds is not counted twice", () => {
    const logged = [obs("UA10", "N7380", 1, 2)];
    const same = draw("UA10", "N7380", 2);
    const p = buildModel(logged, CONFIG, r, [same]).predict("UA10");
    expect(p.n_observations).toBe(1);
  });

  test("n_recent_observations counts only draws inside the recent window", () => {
    const old = [obs("UA20", "N7380", 1, 100), obs("UA20", "N7381", 1, 2)];
    const p = buildModel(old, CONFIG, r, []).predict("UA20");
    expect(p.n_observations).toBe(2);
    expect(p.n_recent_observations).toBe(1);
  });

  test("a stale family no longer dominates the prior once newer draws exist", () => {
    // Six old 737-800 draws (a 50% family), then one fresh MAX8 departure
    // (0%). All on tails without Starlink, so only the family prior differs:
    // seen as a log row it joins a full-weight mix, seen by ADS-B the old
    // draws decay out of the mix.
    const old = Array.from({ length: 6 }, (_, i) => obs("UA30", `N738${150 + i}`, 0, 150 + i));
    const asLog = buildModel([...old, obs("UA30", "NMAX1", 0, 0)], CONFIG, r, null);
    const asAdsb = buildModel(old, CONFIG, r, [draw("UA30", "NMAX1", 0)]);
    expect(asAdsb.predict("UA30").probability).toBeLessThan(asLog.predict("UA30").probability);
  });

  test("a flight with no ADS-B draws predicts exactly as the log-only model", () => {
    const hist = [obs("UA40", "N7380", 1, 100), obs("UA40", "NMAX3", 0, 5)];
    const off = buildModel(hist, CONFIG, r, null).predict("UA40");
    const on = buildModel(hist, CONFIG, r, adsb).predict("UA40");
    expect(on.probability).toBe(off.probability);
    expect(on.confidence).toBe(off.confidence);
  });
});

describe("ADS-B test-set labels", () => {
  test("latest check at or before departure, else a check within 7 days after, else dropped", () => {
    const checks = [obs("UA1", "NA", 0, 20), obs("UA1", "NA", 1, 5), obs("UA1", "NB", 1, 0)];
    const { labeled, dropped } = labelAdsbDraws(
      [draw("UA1", "NA", 10), draw("UA1", "NB", 3), draw("UA1", "NB", 30), draw("UA1", "NC", 1)],
      checks
    );
    expect(labeled.map((l) => [l.draw.tail_number, l.actual])).toEqual([
      ["NA", 0],
      ["NB", 1],
    ]);
    expect(dropped).toBe(2);
  });
});

describe("adsb_flight_draws rollup", () => {
  test("sightings under 4h apart are one departure; a later one starts another", () => {
    const db = makeSyntheticDb();
    const s = (h: number) => ({
      flight_number: "UA1",
      tail_number: "N1",
      observed_at: NOW + h * 3600,
    });
    upsertAdsbFlightDraws(db, [s(0), s(1)]);
    upsertAdsbFlightDraws(db, [s(2)]);
    upsertAdsbFlightDraws(db, [s(10)]);
    const rows = getAdsbFlightDraws(db, 0);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.last_seen >= r.first_seen)).toBe(true);
    db.close();
  });

  test("sighting derivation reuses the sweep's callsign rules and excludes UCA", () => {
    const base = { observed_at: NOW, tail_number: "N1", airborne: 1, ground_speed: 400 };
    expect(flightSightingFromObservation({ ...base, callsign: "SKW5123" })?.flight_number).toBe(
      "UA5123"
    );
    expect(flightSightingFromObservation({ ...base, callsign: "UAL694" })?.flight_number).toBe(
      "UA694"
    );
    expect(flightSightingFromObservation({ ...base, callsign: "UCA4240" })).toBeNull();
    expect(flightSightingFromObservation({ ...base, callsign: "UAL8114" })).toBeNull();
    expect(flightSightingFromObservation({ ...base, callsign: "DAL123" })).toBeNull();
    expect(
      flightSightingFromObservation({ ...base, callsign: "UAL1", ground_speed: 60 })
    ).toBeNull();
    expect(flightSightingFromObservation({ ...base, callsign: "UAL1", airborne: 0 })).toBeNull();
  });

  test("backfill rolls up existing observations once, then never again", async () => {
    const db = makeSyntheticDb();
    const ins = db.query(
      `INSERT INTO adsb_observations (observed_at, tail_number, callsign, airborne, ground_speed, provider)
       VALUES (?, ?, ?, 1, 400, 'test')`
    );
    for (let i = 0; i < 30; i++) ins.run(NOW + i * 300, "N1", "UAL694");
    ins.run(NOW + DAY, "N1", "UAL694");
    expect(await backfillAdsbFlightDraws(db, { chunkRows: 7 })).toBe("done");
    expect(getAdsbFlightDraws(db, 0).length).toBe(2);
    expect(await backfillAdsbFlightDraws(db)).toBe("skipped");
    db.close();
  });

  test("only the UA reader sees draws", () => {
    const db = makeSyntheticDb();
    upsertAdsbFlightDraws(db, [{ flight_number: "UA1", tail_number: "N1", observed_at: NOW }]);
    const readers = createReaderFactory(db);
    expect(readers("UA").getAdsbFlightDraws(0).length).toBe(1);
    expect(readers("ALL").getAdsbFlightDraws(0)).toEqual([]);
    expect(readers("AS").getAdsbFlightDraws(0)).toEqual([]);
    db.close();
  });
});

describe("cold and positioning priors", () => {
  let db: ReturnType<typeof makeSyntheticDb>;
  beforeAll(() => {
    db = makeSyntheticDb();
    const plane = db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, DateFound, TailNumber, OperatedBy, fleet, airline)
       VALUES ('ERJ-175', 'StrLnk', '2026-01-01', ?, 'SkyWest', ?, 'UA')`
    );
    for (let i = 0; i < 7; i++) plane.run(`N${100 + i}SY`, "express");
    for (let i = 0; i < 3; i++) plane.run(`N${200 + i}UA`, "mainline");
    setMeta(db, "expressTotal", 10, "UA");
    setMeta(db, "mainlineTotal", 12, "UA");
    // A census-sized roster, so the type-aware model (and its cold path) runs.
    const fleet = db.query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, airline)
       VALUES (?, 'ERJ-145', 'test', 1, 1, 'UA')`
    );
    for (let i = 0; i < AIRLINES.UA.minFleetSanity; i++) fleet.run(`N${1000 + i}CE`);
  });
  afterAll(() => db.close());

  test("a never-seen express flight predicts below express fleet penetration", () => {
    const reader = createReaderFactory(db)("UA");
    const stats = reader.getFleetStats();
    if (!stats) throw new Error("UA scope must have fleet stats");
    const pred = predictFlight(reader, "UA4240");
    expect(pred.method).toBe("fleet_prior_express");
    expect(pred.probability).toBeLessThan(stats.express.starlink / stats.express.total);
  });

  // The hub resolves UA through the same census model, so its cold copy must
  // not attribute the low express prior to a fleet rollout rate.
  test("hub check-any-flight cold answer never cites the fleet rollout rate", async () => {
    const body = await jsonOf(
      createApp(db),
      "/api/check-any-flight?flight_number=UA4240&date=2024-01-15",
      "airlinestarlinktracker.com"
    );
    expect(body.hasStarlink).toBeNull();
    expect(typeof body.probability).toBe("number");
    expect(typeof body.reason).toBe("string");
    expect(body.reason).not.toMatch(/rollout rate/i);
    expect(body.reason).toContain("regional jets");
  });

  test("a partial itinerary's positioning leg is priced at the live mainline rate", () => {
    let n = 7000;
    const edge = (dep: string, arr: string) =>
      addFlight(db, `N${n}X`, `UA${n++}`, dep, 1, { arrivalAirport: arr });
    edge("LAX", "SFO");
    const reader = createReaderFactory(db)("UA");
    const mainline = loadFleetPriors(reader).mainline;
    const legs = planItinerary(reader, "OGG", "SFO", { maxItineraries: 10, minLegProbability: 0 })
      .flatMap((it) => it.legs)
      .filter((l) => l.flight_number === "(any)");
    expect(legs.length, "no positioning leg — premise gone").toBeGreaterThan(0);
    expect(mainline).not.toBe(0.02);
    for (const l of legs) expect(l.probability).toBe(mainline);
  });
});
