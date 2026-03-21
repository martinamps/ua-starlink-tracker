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
    fun_fact:
      "Same body Boeing turns into private jets for billionaires — just with 120 more seats.",
  },
  "B737-800": {
    seats: 166,
    wingspan_ft: 117.4,
    length_ft: 129.5,
    range_mi: 3380,
    cruise_mph: 530,
    first_flight: 1997,
    engines: "2× CFM56-7B",
    fun_fact: "Over 5,000 built — the most-produced jet airliner variant in history.",
  },
  "B737-900": {
    seats: "167–179",
    wingspan_ft: 117.4,
    length_ft: 138.2,
    range_mi: 3235,
    cruise_mph: 530,
    first_flight: 2000,
    engines: "2× CFM56-7B",
    fun_fact: "Longest 737 for its time but carried no extra people — ran out of emergency exits.",
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
      "Grounded worldwide for 20 months after two crashes — longest ban on a U.S. jet ever.",
  },
  "B737-MAX9": {
    seats: 179,
    wingspan_ft: 117.8,
    length_ft: 138.3,
    range_mi: 4085,
    cruise_mph: 530,
    first_flight: 2017,
    engines: "2× CFM LEAP-1B",
    fun_fact: "Yes, this is the one whose door panel blew off mid-flight on Alaska in 2024.",
  },
  "B737-MAX10": {
    seats: 191,
    wingspan_ft: 117.8,
    length_ft: 143.7,
    range_mi: 3800,
    cruise_mph: 530,
    first_flight: 2021,
    engines: "2× CFM LEAP-1B",
    fun_fact: "So long its landing gear has to telescope taller at takeoff or the tail would drag.",
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
      "Pilots love it — absurdly overpowered, climbs like a rocket, out of production since 2004.",
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
    fun_fact:
      "First wide-body designed for just two pilots — put an entire profession out of work.",
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
      "Each engine is wider than the entire body of a 737 — the most powerful jet engines ever.",
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
      "Higher cabin humidity and pressure than other jets — passengers actually feel less wrecked.",
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
    fun_fact: "The smallest plane United flies that can still cross the Atlantic nonstop.",
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
      "First airliner flown by joystick instead of a steering wheel — scandalized pilots in 1987.",
  },
  A321: {
    seats: 200,
    wingspan_ft: 117.4,
    length_ft: 146.0,
    range_mi: 4600,
    cruise_mph: 518,
    first_flight: 2016,
    engines: "2× PW1133G-JM",
    fun_fact: "First plane where United let you pair your AirPods to the seatback screen.",
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
      "Over half the plane is carbon fiber — the wings bend upward 13 feet in flight. United has none yet.",
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
      "Sized to the exact 76-seat limit that pilot unions negotiated — any bigger and it's illegal to fly.",
  },
  "ERJ-145": {
    seats: 50,
    wingspan_ft: 65.8,
    length_ft: 98.0,
    range_mi: 1780,
    cruise_mph: 515,
    first_flight: 1995,
    engines: "2× RR AE 3007",
    fun_fact: "Only one seat on the left side — half the plane gets a private window seat.",
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
      "It's a stretched private jet. Windows are at knee height, ceiling brushes your hair. Comically cramped.",
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
    fun_fact: "The first small jet where your carry-on might actually fit in the overhead bin.",
  },
};
