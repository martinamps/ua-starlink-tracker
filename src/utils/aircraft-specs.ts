/**
 * Static aircraft specs keyed by normalized family name
 * (see normalizeAircraftType in airlines/aircraft-families.ts).
 * Seat counts reflect the operating carrier's configuration (United for the
 * shared families, Hawaiian for A330/B717, Qatar for A380).
 */

import { normalizeAircraftType } from "../airlines/aircraft-families";

export interface AircraftSpec {
  seats: number | string;
  wingspan_ft: number | string;
  length_ft: number | string;
  range_mi: number;
  cruise_mph: number;
  first_flight: number;
  engines: string;
  fun_fact: string;
}

export const AIRCRAFT_SPECS: Record<string, AircraftSpec> = {
  // Boeing narrowbody
  "B737-700": {
    seats: 126,
    wingspan_ft: 117.4,
    length_ft: 110.3,
    range_mi: 3440,
    cruise_mph: 530,
    first_flight: 1997,
    engines: "2× CFM56-7B",
    fun_fact: "The Boeing Business Jet is the same airframe, minus about 100 seats.",
  },
  "B737-800": {
    seats: 166,
    wingspan_ft: 117.4,
    length_ft: 129.5,
    range_mi: 3380,
    cruise_mph: 530,
    first_flight: 1997,
    engines: "2× CFM56-7B",
    fun_fact: "Nearly 5,000 built, the most-produced jet airliner variant ever.",
  },
  "B737-900": {
    seats: "167–179",
    wingspan_ft: 117.4,
    length_ft: 138.2,
    range_mi: 3235,
    cruise_mph: 530,
    first_flight: 2000,
    engines: "2× CFM56-7B",
    fun_fact:
      "The original -900 was longer than the -800 but couldn't seat more people. Not enough exits.",
  },
  "B737-MAX8": {
    seats: 166,
    wingspan_ft: 117.8,
    length_ft: 129.7,
    range_mi: 4085,
    cruise_mph: 530,
    first_flight: 2016,
    engines: "2× CFM LEAP-1B",
    fun_fact:
      "Grounded worldwide for 20 months after two crashes, the longest grounding of a U.S. airliner.",
  },
  "B737-MAX9": {
    seats: 179,
    wingspan_ft: 117.8,
    length_ft: 138.3,
    range_mi: 4085,
    cruise_mph: 530,
    first_flight: 2017,
    engines: "2× CFM LEAP-1B",
    fun_fact: "Yes, this is the type that lost a door plug mid-flight in January 2024.",
  },
  "B737-MAX10": {
    seats: 191,
    wingspan_ft: 117.8,
    length_ft: 143.7,
    range_mi: 3800,
    cruise_mph: 530,
    first_flight: 2021,
    engines: "2× CFM LEAP-1B",
    fun_fact:
      "So long its landing gear stretches taller for takeoff, or the tail would hit the runway.",
  },
  B757: {
    seats: "169–234",
    wingspan_ft: 124.8,
    length_ft: "155.3–178.6",
    range_mi: 4490,
    cruise_mph: 530,
    first_flight: 1982,
    engines: "2× PW2000 or RR RB211",
    fun_fact: "Pilots love how overpowered it is. Boeing stopped building it in 2004.",
  },
  B717: {
    seats: 128,
    wingspan_ft: 93.3,
    length_ft: 124.0,
    range_mi: 2060,
    cruise_mph: 504,
    first_flight: 1998,
    engines: "2× RR BR715",
    fun_fact:
      "Really a McDonnell Douglas MD-95. Boeing inherited it in the 1997 merger and renamed it.",
  },
  // Boeing widebody
  B747: {
    seats: "364–467",
    wingspan_ft: 224.4,
    length_ft: 250.2,
    range_mi: 8920,
    cruise_mph: 570,
    first_flight: 1969,
    engines: "4× GEnx-2B67",
    fun_fact: "The original jumbo. Boeing built the world's largest building by volume to make it.",
  },
  B747F: {
    seats: "—",
    wingspan_ft: 224.4,
    length_ft: 250.2,
    range_mi: 5050,
    cruise_mph: 570,
    first_flight: 2010,
    engines: "4× GEnx-2B67",
    fun_fact:
      "The nose swings up so cargo loads straight through the front. That's why the cockpit sits in the hump.",
  },
  B767: {
    seats: "167–240",
    wingspan_ft: "156.1–170.3",
    length_ft: "180.3–201.3",
    range_mi: 6880,
    cruise_mph: 530,
    first_flight: 1981,
    engines: "2× GE CF6-80C2 or PW4000",
    fun_fact:
      "One of the first widebodies flown by just two pilots. Flight engineers were not fans.",
  },
  B777: {
    seats: "276–350",
    wingspan_ft: "199.9–212.6",
    length_ft: "209.1–242.3",
    range_mi: 8480,
    cruise_mph: 560,
    first_flight: 1994,
    engines: "2× PW4000 or GE90-115B",
    fun_fact:
      "The 777-300ER's GE90-115B is the most powerful jet engine in airline service, with a fan nearly as wide as a 737's cabin.",
  },
  B777F: {
    seats: "—",
    wingspan_ft: 212.6,
    length_ft: 209.1,
    range_mi: 5720,
    cruise_mph: 560,
    first_flight: 2008,
    engines: "2× GE90-110B1",
    fun_fact:
      "Hauls 102 tonnes of freight on two engines, which made four-engine freighters a hard sell.",
  },
  B787: {
    seats: "243–318",
    wingspan_ft: 197.3,
    length_ft: "186.1–224.0",
    range_mi: 8705,
    cruise_mph: 567,
    first_flight: 2009,
    engines: "2× GEnx-1B",
    fun_fact:
      "Higher cabin humidity and a lower cabin altitude than older jets, so you land a little less wrecked.",
  },
  // Airbus
  A220: {
    seats: "120–160",
    wingspan_ft: 115.1,
    length_ft: 127.0,
    range_mi: 3900,
    cruise_mph: 515,
    first_flight: 2015,
    engines: "2× PW1500G",
    fun_fact: "Designed by Bombardier as the CSeries. Airbus took it over in 2018 and renamed it.",
  },
  A318: {
    seats: "107–132",
    wingspan_ft: 111.9,
    length_ft: 103.2,
    range_mi: 3570,
    cruise_mph: 515,
    first_flight: 2002,
    engines: "2× CFM56-5B or PW6000",
    fun_fact: "The smallest A320-family jet. Only 80 were built.",
  },
  A319: {
    seats: 126,
    wingspan_ft: 111.9,
    length_ft: 111.0,
    range_mi: 4300,
    cruise_mph: 515,
    first_flight: 1995,
    engines: "2× IAE V2524-A5",
    fun_fact: "Shorter than the A320 but with more range: the same fuel, fewer people.",
  },
  A320: {
    seats: 150,
    wingspan_ft: 111.9,
    length_ft: 123.3,
    range_mi: 3800,
    cruise_mph: 515,
    first_flight: 1987,
    engines: "2× IAE V2527-A5",
    fun_fact:
      "First airliner flown with a sidestick instead of a control yoke, which scandalized pilots in 1987.",
  },
  A321: {
    seats: 200,
    wingspan_ft: 117.4,
    length_ft: 146.0,
    range_mi: 4600,
    cruise_mph: 518,
    first_flight: 2016,
    engines: "2× PW1133G-JM",
    fun_fact: "Airbus's best-seller today, flying routes that once needed a widebody.",
  },
  A330: {
    seats: 278,
    wingspan_ft: 197.8,
    length_ft: 193.0,
    range_mi: 8390,
    cruise_mph: 541,
    first_flight: 1992,
    engines: "2× PW4000 or RR Trent 700",
    fun_fact:
      "Same fuselage width as the 1972 A300. Airbus has been stretching that tube for 50 years.",
  },
  A350: {
    seats: "—",
    wingspan_ft: 212.4,
    length_ft: 219.2,
    range_mi: 9700,
    cruise_mph: 561,
    first_flight: 2013,
    engines: "2× RR Trent XWB-84",
    fun_fact: "Over half the airframe is carbon fiber, which doesn't corrode like aluminum.",
  },
  A380: {
    seats: 517,
    wingspan_ft: 261.6,
    length_ft: 238.5,
    range_mi: 9200,
    cruise_mph: 561,
    first_flight: 2005,
    engines: "4× RR Trent 900 or EA GP7200",
    fun_fact: "So big that airports rebuilt gates and taxiways for it. Airbus stopped after 251.",
  },
  // Regional jets
  E175: {
    seats: 76,
    wingspan_ft: 93.9,
    length_ft: 103.9,
    range_mi: 2530,
    cruise_mph: 515,
    first_flight: 2003,
    engines: "2× GE CF34-8E",
    fun_fact:
      "Sized to the 76-seat cap in US pilot scope clauses. One more seat and mainline pilots would have to fly it.",
  },
  E170: {
    seats: "70–78",
    wingspan_ft: 85.3,
    length_ft: 98.1,
    range_mi: 2450,
    cruise_mph: 500,
    first_flight: 2002,
    engines: "2× GE CF34-8E",
    fun_fact: "The original E-Jet. The E175 and E190 are stretches of it.",
  },
  E190: {
    seats: "96–114",
    wingspan_ft: 94.3,
    length_ft: 118.9,
    range_mi: 2800,
    cruise_mph: 515,
    first_flight: 2004,
    engines: "2× GE CF34-10E",
    fun_fact: "Seated 2-2 throughout, so there is no middle seat anywhere on board.",
  },
  "ERJ-145": {
    seats: 50,
    wingspan_ft: 65.8,
    length_ft: 98.0,
    range_mi: 1780,
    cruise_mph: 515,
    first_flight: 1995,
    engines: "2× RR AE 3007",
    fun_fact: "Seated 1-2, so a third of the cabin gets a window and an aisle to itself.",
  },
  "CRJ-200": {
    seats: 50,
    wingspan_ft: 69.6,
    length_ft: 87.8,
    range_mi: 1955,
    cruise_mph: 488,
    first_flight: 1991,
    engines: "2× GE CF34-3B1",
    fun_fact: "A stretched Challenger business jet, which is why the windows sit so low.",
  },
  "CRJ-550": {
    seats: 50,
    wingspan_ft: 76.3,
    length_ft: 106.1,
    range_mi: 1960,
    cruise_mph: 515,
    first_flight: 2019,
    engines: "2× GE CF34-8C5",
    fun_fact:
      "United yanked 20 seats out of a 70-seater so they could add first class and a snack bar.",
  },
  "CRJ-700": {
    seats: 70,
    wingspan_ft: 76.3,
    length_ft: 106.1,
    range_mi: 1840,
    cruise_mph: 515,
    first_flight: 1999,
    engines: "2× GE CF34-8C",
    fun_fact: "Bigger overhead bins than the CRJ200, so your carry-on might actually fit.",
  },
};

/**
 * Live TV on the seatback (United + DISH, Sept 2026) needs a Starlink jet AND
 * a seatback screen, and we hold no per-tail screen data. So this is a
 * type-level hedge, never a promise: the newer mainline types are built around
 * seatback screens, some older 737-800/-900 cabins lack them, and United
 * Express regional jets have none. Unlisted mainline types stay "possible"
 * rather than "no" — absence of data is not a verified negative.
 */
export type SeatbackLiveTv = "likely" | "possible" | "no";

export const SEATBACK_LIVE_TV_LIKELY_FAMILIES: readonly string[] = [
  "A321",
  "B737-MAX8",
  "B737-MAX9",
  "B737-MAX10",
  "B777",
  "B787",
];

export function seatbackLiveTv(
  fleet: string | null | undefined,
  aircraftType: string | null | undefined
): SeatbackLiveTv {
  if (fleet !== "mainline") return "no";
  return SEATBACK_LIVE_TV_LIKELY_FAMILIES.includes(normalizeAircraftType(aircraftType))
    ? "likely"
    : "possible";
}

export const SEATBACK_LIVE_TV_COPY: Record<SeatbackLiveTv, string> = {
  likely: "Live TV: likely (this type has seatback screens).",
  possible: "Live TV: possible (some older cabins of this type have no seatback screen).",
  no: "Live TV: no seatback screens on United Express; stream on your own device.",
};
