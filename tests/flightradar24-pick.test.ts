import { describe, expect, test } from "bun:test";
import { parseUpcomingFlights, pickFlightNumber } from "../src/api/flightradar24-api";

const leg = (callsign: string | null, def: string, alt: string | null = null) => ({
  identification: { id: null, row: 1, number: { default: def, alternative: alt }, callsign },
  airport: {
    origin: { code: { iata: "CDG", icao: "LFPG" } },
    destination: { code: { iata: "DUS", icao: "EDDL" } },
  },
  time: {
    scheduled: { departure: 2_000_000_000, arrival: 2_000_003_600 },
    estimated: { departure: null, arrival: null },
    real: { departure: null, arrival: null },
  },
});

type Leg = Parameters<typeof parseUpcomingFlights>[0][number];

describe("pickFlightNumber", () => {
  test("callsign mode keeps today's precedence", () => {
    expect(pickFlightNumber(leg("SKW4783", "UA4783"), "callsign")).toBe("SKW4783");
    expect(pickFlightNumber(leg(null, "UA4783", "OO4783"), "callsign")).toBe("OO4783");
    expect(pickFlightNumber(leg(null, "UA4783"), "callsign")).toBe("UA4783");
  });

  test("marketing mode reads the marketed number, or drops the leg", () => {
    expect(pickFlightNumber(leg("AFR32UN", "AF1006", "A51006"), "marketing")).toBe("AF1006");
    expect(pickFlightNumber(leg("AFR32UN", ""), "marketing")).toBeNull();
    const rows = parseUpcomingFlights(
      [leg("AFR32UN", "AF1006"), leg("AFR99XX", "")] as unknown as Leg[],
      1_900_000_000,
      25,
      { flightNumberSource: "marketing" }
    );
    expect(rows.map((r) => r.flight_number)).toEqual(["AF1006"]);
  });
});
