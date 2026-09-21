import { describe, expect, test } from "bun:test";
import {
  marketedRowFlightNumber,
  normalizeAirlineFlightNumber,
} from "../src/airlines/flight-number";
import { AIRLINES } from "../src/airlines/registry";

describe("marketedRowFlightNumber", () => {
  test("maps a shared operator's number to the row airline's marketed number", () => {
    expect(marketedRowFlightNumber(AIRLINES.AS, "SKW3015")).toBe("AS3015");
    expect(marketedRowFlightNumber(AIRLINES.AS, "OO3343")).toBe("AS3343");
  });

  test("agrees with normalizeAirlineFlightNumber wherever that already maps", () => {
    for (const fn of ["UAL1377", "SKW5352", "UA100"]) {
      expect(marketedRowFlightNumber(AIRLINES.UA, fn)).toBe(
        normalizeAirlineFlightNumber(AIRLINES.UA, fn)
      );
    }
  });

  test("user-input normalization still leaves shared operators alone", () => {
    expect(normalizeAirlineFlightNumber(AIRLINES.AS, "SKW3015")).toBe("SKW3015");
  });
});
