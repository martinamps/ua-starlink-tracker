/**
 * Every hand-placed airport's country, held against two things the hand
 * placing did not write.
 *
 * AIRPORT_COUNTRY lists foreign airports only, and a hand-placed code with no
 * line there is US. So a foreign airport placed with a point and a zone but
 * no country line was silently domestic: on 2026-11-27 eleven were (Stansted,
 * Farnborough, Nagoya, Bermuda, Moscow Sheremetyevo, Ankara, Cebu, Kaohsiung,
 * Siem Reap, Tuxtla Gutiérrez, Comayagua). The planner then gated a trip from
 * a US airport to one of them as US-domestic and dropped every connection
 * through a foreign hub (Newark to Stansted by way of Heathrow), and let
 * Bermuda connect San Francisco to Newark.
 *
 * Two checks, since neither covers every code:
 *  - the bundled register's country, for each code the register holds;
 *  - the code's own zone in AIRPORT_TZ, for every code: US exactly when the
 *    zone is one the register gives a US airport. This is the one that caught
 *    Farnborough, which the register lacks.
 * A code the register lacks is also pinned by name below, so placing another
 * such code means writing its country down here.
 */

import { describe, expect, test } from "bun:test";
import { AIRPORT_COORDS, airportCountry, hubAllowedForTrip } from "../src/utils/airport-geo";
import { AIRPORT_REGISTER } from "../src/utils/airport-register-data";
import { AIRPORT_TZ } from "../src/utils/airport-tz";

const HAND = Object.keys(AIRPORT_COORDS);
const REGISTER_COUNTRY = 4;
const REGISTER_ZONE = 5;

// Puerto Rico, the US Virgin Islands, Guam, the Northern Marianas and
// American Samoa are US here on purpose, though ISO gives each its own code
// (PR, VI, GU, MP, AS). The country exists to answer one question, "does this
// trip or this connection cross a US border control?", and a flight between
// the mainland and a territory is a domestic one: no passport for a US
// citizen, and United sells Honolulu to Guam and Newark to San Juan as
// domestic. The register folds the same five into US when it is built
// (scripts/build-airport-register.ts), so the comparison below holds them
// with no exception; this list keeps the choice from being undone unseen.
const TERRITORY_AIRPORTS = ["SJU", "BQN", "STT", "STX", "GUM", "SPN", "PPG"];

// Hand-placed codes the register has no row for, each with the country a
// person checked. Farnborough sat here as US until the zone check below.
const NOT_IN_REGISTER: Record<string, string> = {
  BAH: "BH",
  BFM: "US",
  FAB: "GB",
  FMN: "US",
  GGE: "US",
  IAB: "US",
  INT: "US",
  KIV: "MD",
  LCQ: "US",
  MDH: "US",
  MKC: "US",
  MLH: "FR",
  NKC: "MR",
  NZY: "US",
  PBI: "US",
  PPG: "US",
  PSG: "US",
  TEV: "ES",
  VCV: "US",
  WRG: "US",
  XFW: "DE",
  XWA: "US",
};

describe("a hand-placed airport's country", () => {
  test("is the register's, for every code the register holds", () => {
    const wrong: string[] = [];
    for (const code of HAND) {
      if (!Object.hasOwn(AIRPORT_REGISTER, code)) continue;
      const register = AIRPORT_REGISTER[code][REGISTER_COUNTRY];
      if (airportCountry(code) !== register) {
        wrong.push(`${code}: ours ${airportCountry(code)}, register ${register}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("is written down here for every code the register lacks", () => {
    const lacking = HAND.filter((code) => !Object.hasOwn(AIRPORT_REGISTER, code)).sort();
    expect(lacking).toEqual(Object.keys(NOT_IN_REGISTER).sort());
    for (const [code, country] of Object.entries(NOT_IN_REGISTER)) {
      expect(airportCountry(code), code).toBe(country);
    }
  });

  test("is US exactly when the airport's own zone is a US zone", () => {
    const usZones = new Set(
      Object.values(AIRPORT_REGISTER)
        .filter((row) => row[REGISTER_COUNTRY] === "US")
        .map((row) => row[REGISTER_ZONE])
    );
    const wrong: string[] = [];
    for (const code of HAND) {
      const zone = AIRPORT_TZ[code];
      if ((airportCountry(code) === "US") !== usZones.has(zone)) {
        wrong.push(`${code}: ${airportCountry(code)} in ${zone}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("stays US for the territories", () => {
    for (const code of TERRITORY_AIRPORTS) {
      expect(Object.hasOwn(AIRPORT_COORDS, code), code).toBe(true);
      expect(airportCountry(code), code).toBe("US");
    }
  });

  test("names the eleven that read as US", () => {
    const eleven: Record<string, string> = {
      BDA: "BM",
      CEB: "PH",
      ESB: "TR",
      FAB: "GB",
      KHH: "TW",
      KTI: "KH",
      NGO: "JP",
      STN: "GB",
      SVO: "RU",
      TGZ: "MX",
      XPL: "HN",
    };
    for (const [code, country] of Object.entries(eleven)) {
      expect(airportCountry(code), code).toBe(country);
    }
  });
});

describe("the planner's hub gate, for those airports", () => {
  test("a trip to or from one is no longer US-domestic, so a foreign hub may connect it", () => {
    expect(hubAllowedForTrip("NGO", "ORD", "NRT")).toBe(true);
    expect(hubAllowedForTrip("EWR", "STN", "LHR")).toBe(true);
    expect(hubAllowedForTrip("IAH", "TGZ", "MEX")).toBe(true);
  });

  test("none of them may connect a US-domestic trip", () => {
    expect(hubAllowedForTrip("SFO", "EWR", "BDA")).toBe(false);
    expect(hubAllowedForTrip("LAX", "JFK", "STN")).toBe(false);
  });

  test("a territory still connects a domestic trip, and a trip to one is still gated", () => {
    expect(hubAllowedForTrip("HNL", "SPN", "GUM")).toBe(true);
    expect(hubAllowedForTrip("EWR", "SJU", "YYZ")).toBe(false);
  });
});
