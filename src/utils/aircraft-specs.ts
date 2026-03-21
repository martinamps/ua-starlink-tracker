/**
 * Static aircraft specs keyed by normalized family name
 * (see normalizeAircraftType in observability/metrics.ts).
 * Seat counts reflect United/United Express configurations.
 */

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
    fun_fact: "First of the Next-Gen 737s; the airframe Boeing stretched into the BBJ bizjet.",
  },
  "B737-800": {
    seats: 166,
    wingspan_ft: 117.4,
    length_ft: 129.5,
    range_mi: 3380,
    cruise_mph: 530,
    first_flight: 1997,
    engines: "2× CFM56-7B",
    fun_fact: "Best-selling 737 variant ever — over 5,000 built before the MAX arrived.",
  },
  "B737-900": {
    seats: "167–179",
    wingspan_ft: 117.4,
    length_ft: 138.2,
    range_mi: 3235,
    cruise_mph: 530,
    first_flight: 2000,
    engines: "2× CFM56-7B",
    fun_fact: "Original -900 was capped at 189 pax because it kept the -800's exit doors.",
  },
  "B737-MAX8": {
    seats: 166,
    wingspan_ft: 117.8,
    length_ft: 129.7,
    range_mi: 4085,
    cruise_mph: 530,
    first_flight: 2016,
    engines: "2× CFM LEAP-1B",
    fun_fact: "Grounded worldwide for 20 months — the longest grounding of any U.S. airliner.",
  },
  "B737-MAX9": {
    seats: 179,
    wingspan_ft: 117.8,
    length_ft: 138.3,
    range_mi: 4085,
    cruise_mph: 530,
    first_flight: 2017,
    engines: "2× CFM LEAP-1B",
    fun_fact: "The Alaska 1282 door-plug blowout ship — yes, that was a MAX 9.",
  },
  "B737-MAX10": {
    seats: 191,
    wingspan_ft: 117.8,
    length_ft: 143.7,
    range_mi: 3800,
    cruise_mph: 530,
    first_flight: 2021,
    engines: "2× CFM LEAP-1B",
    fun_fact: "Telescoping levered landing gear lets it rotate without scraping its tail.",
  },
  B757: {
    seats: "169–234",
    wingspan_ft: 124.8,
    length_ft: "155.3–178.6",
    range_mi: 4490,
    cruise_mph: 530,
    first_flight: 1982,
    engines: "2× PW2000 or RR RB211",
    fun_fact:
      "Pilots call it the 'Atari Ferrari' — glass cockpit + hilariously overpowered engines.",
  },
  // Boeing widebody
  B767: {
    seats: "167–240",
    wingspan_ft: "156.1–170.3",
    length_ft: "180.3–201.3",
    range_mi: 6880,
    cruise_mph: 530,
    first_flight: 1981,
    engines: "2× GE CF6-80C2 or PW4000",
    fun_fact: "First widebody with a two-pilot cockpit — it killed the flight engineer job.",
  },
  B777: {
    seats: "276–350",
    wingspan_ft: "199.9–212.6",
    length_ft: "209.1–242.3",
    range_mi: 8480,
    cruise_mph: 560,
    first_flight: 1994,
    engines: "2× PW4000 or GE90-115B",
    fun_fact: "The GE90 on the -300ER has a fan diameter wider than a 737 fuselage.",
  },
  B787: {
    seats: "243–318",
    wingspan_ft: 197.3,
    length_ft: "186.1–224.0",
    range_mi: 8705,
    cruise_mph: 567,
    first_flight: 2009,
    engines: "2× GEnx-1B",
    fun_fact: "Cabin pressurized to 6,000 ft instead of 8,000 — measurably reduces jet lag.",
  },
  // Airbus
  A319: {
    seats: 126,
    wingspan_ft: 111.9,
    length_ft: 111.0,
    range_mi: 4300,
    cruise_mph: 515,
    first_flight: 1995,
    engines: "2× IAE V2524-A5",
    fun_fact: "Shortest Airbus United flies, yet has the longest range of any A320ceo variant.",
  },
  A320: {
    seats: 150,
    wingspan_ft: 111.9,
    length_ft: 123.3,
    range_mi: 3800,
    cruise_mph: 515,
    first_flight: 1987,
    engines: "2× IAE V2527-A5",
    fun_fact: "First airliner with digital fly-by-wire and a sidestick instead of a yoke.",
  },
  A321: {
    seats: 200,
    wingspan_ft: 117.4,
    length_ft: 146.0,
    range_mi: 4600,
    cruise_mph: 518,
    first_flight: 2016,
    engines: "2× PW1133G-JM",
    fun_fact: "United's A321neo debuted seatback screens with Bluetooth audio.",
  },
  A350: {
    seats: "—",
    wingspan_ft: 212.4,
    length_ft: 219.2,
    range_mi: 9700,
    cruise_mph: 561,
    first_flight: 2013,
    engines: "2× RR Trent XWB-84",
    fun_fact:
      "53% carbon-fiber; wingtips flex upward over 13 feet in flight. United has 45 on order.",
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
    fun_fact: "Scope-clause king — the 76-seat/86k-lb cap was practically written around it.",
  },
  "ERJ-145": {
    seats: 50,
    wingspan_ft: 65.8,
    length_ft: 98.0,
    range_mi: 1780,
    cruise_mph: 515,
    first_flight: 1995,
    engines: "2× RR AE 3007",
    fun_fact: "1+2 seating means half the cabin gets a solo window seat — no neighbor.",
  },
  "CRJ-200": {
    seats: 50,
    wingspan_ft: 69.6,
    length_ft: 87.8,
    range_mi: 1955,
    cruise_mph: 488,
    first_flight: 1991,
    engines: "2× GE CF34-3B1",
    fun_fact:
      "Stretched Challenger bizjet; avgeeks call it the 'Devil's Chariot' for knee-level windows.",
  },
  "CRJ-550": {
    seats: 50,
    wingspan_ft: 76.3,
    length_ft: 106.1,
    range_mi: 1960,
    cruise_mph: 515,
    first_flight: 2019,
    engines: "2× GE CF34-8C5",
    fun_fact: "World's first 50-seater with true first class and a walk-up self-serve snack bar.",
  },
  "CRJ-700": {
    seats: 70,
    wingspan_ft: 76.3,
    length_ft: 106.1,
    range_mi: 1840,
    cruise_mph: 515,
    first_flight: 1999,
    engines: "2× GE CF34-8C",
    fun_fact: "First CRJ with leading-edge slats — 12 more feet of wing and actual overhead bins.",
  },
};
