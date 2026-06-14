// Pins the BTS FGK aggregation (UA-marketed filter, cancelled handling, quoted
// fields), the month-replace storage, and the sync's noop/ingest decisions.

import { describe, expect, test } from "bun:test";
import { getBtsIngestedMonths, replaceBtsMonth } from "../src/database/database";
import {
  aggregateBtsCsv,
  candidateMonths,
  computeFleetDeltas,
  monthKey,
  runBtsSync,
} from "../src/scripts/bts-sync";
import { addFleet, makeSyntheticDb } from "./helpers";

const HEADER =
  '"FlightDate","Marketing_Airline_Network","Flight_Number_Marketing_Airline","Operating_Airline ","Flight_Number_Operating_Airline","Tail_Number","Origin","OriginCityName","Dest","DestCityName","Cancelled","Diverted"';

const CSV_LINES = [
  HEADER,
  '"2026-04-01","UA","1326","UA","1326","N73275","AUS","Austin, TX","IAH","Houston, TX","0.00","0.00"',
  '"2026-04-01","UA","1326","UA","1326","N73275","IAH","Houston, TX","DEN","Denver, CO","0.00","0.00"',
  '"2026-04-02","UA","5753","OO","5753","N106SY","SFO","San Francisco, CA","SLC","Salt Lake City, UT","0.00","0.00"',
  '"2026-04-02","UA","5754","OO","5754","N106SY","SLC","Salt Lake City, UT","SFO","San Francisco, CA","1.00","0.00"',
  '"2026-04-02","UA","4520","G7","4520","N520GJ","ORD","Chicago, IL","CMH","Columbus, OH","0.00","0.00"',
  '"2026-04-03","UA","999","UA","999","","EWR","Newark, NJ","LAX","Los Angeles, CA","0.00","0.00"',
  '"2026-04-03","UA","2120","UA","2120","N37502","DEN","Denver, CO","ORD","Chicago, IL","0.00","1.00"',
  '"2026-04-03","DL","1000","DL","1000","N301DN","ATL","Atlanta, GA","LAX","Los Angeles, CA","0.00","0.00"',
];

describe("aggregateBtsCsv", () => {
  test("filters to UA-marketed rows and aggregates operators, tails, and routes", async () => {
    const agg = await aggregateBtsCsv(CSV_LINES);
    expect(agg.rows).toBe(7); // DL row excluded

    const ua = agg.operators.find((o) => o.op_carrier === "UA");
    const oo = agg.operators.find((o) => o.op_carrier === "OO");
    expect(ua).toMatchObject({ flights: 4, performed: 4, distinct_tails: 2 });
    expect(oo).toMatchObject({ flights: 2, performed: 1, distinct_tails: 1 });

    // Cancelled flights don't count as departures; blank tails are dropped.
    expect(agg.tails.find((t) => t.tail_number === "N73275")?.departures).toBe(2);
    expect(agg.tails.find((t) => t.tail_number === "N106SY")?.departures).toBe(1);
    expect(agg.tails.length).toBe(4);

    expect(agg.routes.find((r) => r.origin === "AUS" && r.dest === "IAH")?.performed).toBe(1);
    // The cancelled SLC-SFO leg is not a performed departure.
    expect(agg.routes.some((r) => r.origin === "SLC" && r.dest === "SFO")).toBe(false);
    // The diverted DEN-ORD leg departed but didn't complete the scheduled route.
    expect(agg.routes.some((r) => r.origin === "DEN" && r.dest === "ORD")).toBe(false);
    expect(agg.tails.find((t) => t.tail_number === "N37502")?.departures).toBe(1);
  });
});

describe("storage and fleet deltas", () => {
  test("replaceBtsMonth is idempotent per month and getBtsIngestedMonths reports it", async () => {
    const db = makeSyntheticDb();
    const agg = await aggregateBtsCsv(CSV_LINES);
    replaceBtsMonth(db, "2026-04", agg);
    replaceBtsMonth(db, "2026-04", agg);
    expect(getBtsIngestedMonths(db)).toEqual(["2026-04"]);
    expect(
      db.query("SELECT COUNT(*) AS n FROM bts_monthly_tails WHERE month = '2026-04'").get()
    ).toEqual({ n: 4 });
  });

  test("computeFleetDeltas separates missing-from-fleet and inactive narrowbodies", async () => {
    const db = makeSyntheticDb();
    addFleet(db, "N73275", "confirmed", { aircraftType: "Boeing 737-824" });
    addFleet(db, "N106SY", "confirmed", { aircraftType: "E175" });
    addFleet(db, "N12345", "unknown", { aircraftType: "Boeing 737-900" }); // not in BTS month
    addFleet(db, "N2645U", "unknown", { aircraftType: "Boeing 777-200" }); // widebody — excluded
    const agg = await aggregateBtsCsv(CSV_LINES);
    const deltas = computeFleetDeltas(db, agg);
    expect(deltas.missingFromFleet).toEqual(["N37502", "N520GJ"]);
    expect(deltas.inactiveInFleet).toEqual(["N12345"]);
  });
});

describe("runBtsSync", () => {
  test("ingests the newest published month, then noops on the next run", async () => {
    const db = makeSyntheticDb();
    addFleet(db, "N73275", "confirmed", { aircraftType: "Boeing 737-824" });
    let calls = 0;
    const loadMonth = async (_year: number, _month: number) => {
      calls++;
      return calls === 1 ? CSV_LINES : null;
    };

    const first = await runBtsSync(db, { loadMonth });
    expect(first.outcome).toBe("ingested");
    expect(first.rows).toBe(7);
    expect(getBtsIngestedMonths(db).length).toBe(1);

    const second = await runBtsSync(db, { loadMonth });
    expect(second.outcome).toBe("noop");
  });

  test("nooping months that aren't published yet without erroring", async () => {
    const db = makeSyntheticDb();
    const result = await runBtsSync(db, { loadMonth: async () => null });
    expect(result.outcome).toBe("noop");
    expect(getBtsIngestedMonths(db)).toEqual([]);
  });

  test("a failing newer month doesn't block backfilling an older one", async () => {
    const db = makeSyntheticDb();
    let calls = 0;
    const loadMonth = async () => {
      calls++;
      if (calls === 1) throw new Error("BTS served a 503");
      return CSV_LINES;
    };
    const result = await runBtsSync(db, { loadMonth });
    expect(result.outcome).toBe("ingested");
    expect(getBtsIngestedMonths(db).length).toBe(1);
  });

  test("reports error, not noop, when every candidate month fails", async () => {
    const db = makeSyntheticDb();
    const loadMonth = async () => {
      throw new Error("BTS outage");
    };
    const result = await runBtsSync(db, { loadMonth });
    expect(result.outcome).toBe("error");
    expect(getBtsIngestedMonths(db)).toEqual([]);
  });

  test("monthKey and candidateMonths respect the publication lag", () => {
    expect(monthKey(2026, 4)).toBe("2026-04");
    const months = candidateMonths(new Date("2026-06-14T12:00:00Z"));
    expect(months[0]).toEqual({ year: 2026, month: 4 });
    expect(months.at(-1)).toEqual({ year: 2026, month: 2 });
  });
});
