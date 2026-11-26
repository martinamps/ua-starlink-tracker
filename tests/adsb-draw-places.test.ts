// Flight draws get their airports from the sweep's own ground sightings, and
// from nothing else: an end nobody saw on the ground stays empty.

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  ADSB_DRAW_PLACE_WINDOW_SEC,
  countPlacedAdsbFlightDraws,
  ensureAdsbFlightDrawsTable,
  getAdsbFlightDrawsOnPair,
  upsertAdsbFlightDraws,
} from "../src/database/adsb-flight-draws";
import { ROUTE_DEPARTURES_PLACED_BY_PAIR } from "../src/database/outlook";
import { createReaderFactory } from "../src/database/reader";
import { groundAirport, runAdsbSweepShadow } from "../src/scripts/adsb-sweep";
import { AIRPORT_COORDS, nearestAirport } from "../src/utils/airport-geo";
import { addFleet, makeSyntheticDb } from "./helpers";

const T0 = 1_790_000_000;
const MIN = 60;

type Ac = Record<string, unknown>;
const at = (code: string) => ({ lat: AIRPORT_COORDS[code][0], lon: AIRPORT_COORDS[code][1] });
const onGround = (tail: string, code: string, extra: Ac = {}): Ac => ({
  r: tail,
  alt_baro: "ground",
  gs: 12,
  ...at(code),
  ...extra,
});
const flying = (tail: string, callsign: string, extra: Ac = {}): Ac => ({
  r: tail,
  flight: callsign,
  alt_baro: 34000,
  gs: 440,
  lat: 39,
  lon: -98,
  ...extra,
});

/** One sweep at T0 + `minute`, with the aggregator answering `ac`. */
async function sweep(db: Database, minute: number, ac: Ac[]) {
  setSystemTime(new Date((T0 + minute * MIN) * 1000));
  const fetcher = (async () =>
    new Response(JSON.stringify({ ac }), { status: 200 })) as typeof fetch;
  const result = await runAdsbSweepShadow(db, fetcher);
  expect(result.outcome).toBe("success");
}

interface Row {
  flight_number: string;
  tail_number: string;
  origin: string | null;
  destination: string | null;
}
const draws = (db: Database) =>
  db
    .query(
      "SELECT flight_number, tail_number, origin, destination FROM adsb_flight_draws ORDER BY first_seen, flight_number"
    )
    .all() as Row[];

function fleetDb(...tails: string[]) {
  const db = makeSyntheticDb();
  for (const t of tails) addFleet(db, t, null);
  return db;
}

afterEach(() => setSystemTime());

describe("nearestAirport", () => {
  test("names the field a position is on, and nothing away from one", () => {
    // A taxiway position read from the live feed on 2026-11-25.
    expect(nearestAirport(40.7929, -111.987366, 4)).toBe("SLC");
    expect(nearestAirport(39, -98, 4)).toBeNull();
    expect(nearestAirport(Number.NaN, 0, 4)).toBeNull();
  });

  test("neighbouring fields each keep their own ramp", () => {
    expect(nearestAirport(...AIRPORT_COORDS.SEA, 4)).toBe("SEA");
    expect(nearestAirport(...AIRPORT_COORDS.BFI, 4)).toBe("BFI");
    expect(nearestAirport(...AIRPORT_COORDS.SAN, 4)).toBe("SAN");
    // One field under two codes answers with the same code every time.
    expect(nearestAirport(...AIRPORT_COORDS.PBI, 4)).toBe(nearestAirport(...AIRPORT_COORDS.DJT, 4));
  });
});

describe("groundAirport", () => {
  const slc = { ...at("SLC"), gs: 10 };
  test("needs the transponder's own ground report, a position and a taxi speed", () => {
    expect(groundAirport({ ...slc, onGround: true })).toBe("SLC");
    expect(groundAirport({ ...slc, onGround: true, gs: null })).toBe("SLC");
    expect(groundAirport({ ...slc, onGround: false })).toBeNull();
    expect(groundAirport({ ...slc })).toBeNull();
    expect(groundAirport({ ...slc, onGround: true, lat: null })).toBeNull();
    expect(groundAirport({ ...slc, onGround: true, gs: 430 })).toBeNull();
    expect(groundAirport({ onGround: true, gs: 5, lat: 39, lon: -98 })).toBeNull();
  });
});

describe("draws placed by the sweep", () => {
  test("ground before and ground after put a departure on its pair", async () => {
    const db = fleetDb("N1", "N2");
    await sweep(db, 0, [onGround("N1", "DEN"), onGround("N2", "ORD")]);
    await sweep(db, 10, [flying("N1", "UAL500"), flying("N2", "SKW5123")]);
    await sweep(db, 120, [flying("N1", "UAL500"), flying("N2", "SKW5123")]);
    await sweep(db, 130, [onGround("N1", "SFO"), flying("N2", "SKW5123")]);
    expect(draws(db)).toEqual([
      { flight_number: "UA500", tail_number: "N1", origin: "DEN", destination: "SFO" },
      { flight_number: "UA5123", tail_number: "N2", origin: "ORD", destination: null },
    ]);
    expect(getAdsbFlightDrawsOnPair(db, "DEN", "SFO", 0).map((d) => d.tail_number)).toEqual(["N1"]);
    expect(getAdsbFlightDrawsOnPair(db, "SFO", "DEN", 0)).toEqual([]);
    db.close();
  });

  test("an end nobody saw on the ground stays empty", async () => {
    const db = fleetDb("N1");
    // First seen already in the air; lands where no receiver hears the ramp.
    await sweep(db, 0, [flying("N1", "UAL500")]);
    await sweep(db, 60, [flying("N1", "UAL500")]);
    expect(draws(db)).toEqual([
      { flight_number: "UA500", tail_number: "N1", origin: null, destination: null },
    ]);
    db.close();
  });

  test("a ground sighting outside the window places nothing", async () => {
    const db = fleetDb("N1");
    const late = ADSB_DRAW_PLACE_WINDOW_SEC / MIN + 5;
    await sweep(db, 0, [onGround("N1", "DEN")]);
    await sweep(db, late, [flying("N1", "UAL500")]);
    await sweep(db, late + 60, [flying("N1", "UAL500")]);
    await sweep(db, late + 60 + late, [onGround("N1", "SFO")]);
    expect(draws(db)[0]).toMatchObject({ origin: null, destination: null });
    db.close();
  });

  test("the ground state of a target with no altitude is not a ground sighting", async () => {
    const db = fleetDb("N1");
    await sweep(db, 0, [{ r: "N1", gs: 8, ...at("DEN") }]);
    await sweep(db, 10, [flying("N1", "UAL500")]);
    expect(draws(db)[0].origin).toBeNull();
    expect(
      db.query("SELECT COUNT(*) AS n FROM adsb_observations WHERE ground_airport IS NOT NULL").get()
    ).toEqual({ n: 0 });
    db.close();
  });

  test("a landing closes the tail's latest draw only, and only once", async () => {
    const db = fleetDb("N1");
    await sweep(db, 0, [onGround("N1", "DEN")]);
    await sweep(db, 10, [flying("N1", "UAL500")]);
    await sweep(db, 100, [flying("N1", "UAL500")]);
    await sweep(db, 110, [onGround("N1", "SFO")]);
    // Still at the gate, then out again under another number.
    await sweep(db, 115, [onGround("N1", "SFO")]);
    await sweep(db, 160, [onGround("N1", "SFO")]);
    await sweep(db, 170, [flying("N1", "UAL700")]);
    await sweep(db, 250, [flying("N1", "UAL700")]);
    await sweep(db, 260, [onGround("N1", "LAX")]);
    expect(draws(db)).toEqual([
      { flight_number: "UA500", tail_number: "N1", origin: "DEN", destination: "SFO" },
      { flight_number: "UA700", tail_number: "N1", origin: "SFO", destination: "LAX" },
    ]);
    db.close();
  });

  test("a through flight's merged row keeps its first leg's pair", async () => {
    const db = fleetDb("N1");
    await sweep(db, 0, [onGround("N1", "DEN")]);
    await sweep(db, 10, [flying("N1", "UAL500")]);
    await sweep(db, 100, [flying("N1", "UAL500")]);
    await sweep(db, 110, [onGround("N1", "SFO")]);
    await sweep(db, 160, [onGround("N1", "SFO")]);
    // Same number, same tail, on to the next city: one row, as before.
    await sweep(db, 170, [flying("N1", "UAL500")]);
    await sweep(db, 260, [onGround("N1", "HNL")]);
    expect(draws(db)).toEqual([
      { flight_number: "UA500", tail_number: "N1", origin: "DEN", destination: "SFO" },
    ]);
    db.close();
  });

  test("airborne again minutes after a 'landing' drops the destination", async () => {
    const db = fleetDb("N1");
    await sweep(db, 0, [flying("N1", "UAL500")]);
    await sweep(db, 5, [onGround("N1", "DEN", { flight: "UAL500" })]);
    expect(draws(db)[0].destination).toBe("DEN");
    await sweep(db, 10, [flying("N1", "UAL500")]);
    expect(draws(db)).toEqual([
      { flight_number: "UA500", tail_number: "N1", origin: null, destination: null },
    ]);
    db.close();
  });

  test("rows written before the columns existed stay unplaced", () => {
    const db = makeSyntheticDb();
    db.exec("DROP TABLE adsb_flight_draws");
    db.exec(`CREATE TABLE adsb_flight_draws (
      flight_number TEXT NOT NULL, tail_number TEXT NOT NULL,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      PRIMARY KEY (flight_number, tail_number, first_seen))`);
    db.exec(`INSERT INTO adsb_flight_draws VALUES ('UA1', 'N1', ${T0}, ${T0 + 3600})`);
    ensureAdsbFlightDrawsTable(db);
    ensureAdsbFlightDrawsTable(db);
    expect(draws(db)).toEqual([
      { flight_number: "UA1", tail_number: "N1", origin: null, destination: null },
    ]);
    // The old row still merges a late sighting, and still has no pair.
    upsertAdsbFlightDraws(db, [
      { flight_number: "UA1", tail_number: "N1", observed_at: T0 + 7200 },
    ]);
    expect(draws(db).length).toBe(1);
    expect(countPlacedAdsbFlightDraws(db, 0, T0 + 1)).toEqual({
      both: 0,
      origin_only: 0,
      destination_only: 0,
      neither: 1,
    });
    db.close();
  });

  test("the route section stays off with placed draws in the table", async () => {
    const db = fleetDb("N1");
    await sweep(db, 0, [onGround("N1", "DEN")]);
    await sweep(db, 10, [flying("N1", "UAL500")]);
    await sweep(db, 130, [flying("N1", "UAL500")]);
    await sweep(db, 135, [onGround("N1", "SFO")]);
    expect(getAdsbFlightDrawsOnPair(db, "DEN", "SFO", 0).length).toBe(1);
    expect(ROUTE_DEPARTURES_PLACED_BY_PAIR).toBe(false);
    expect(createReaderFactory(db)("UA").getRouteOutlook("DEN", "SFO")).toBeNull();
    db.close();
  });
});
