/**
 * IATA → IANA timezone lookup for departure-date math. Flight dates on
 * boarding passes are LOCAL dates; departure_time columns are UTC epochs, so
 * date matching must convert through the departure airport's zone. Coverage:
 * every airport observed in the snapshot data plus Qatar-network majors.
 * Unknown airports return undefined/null — callers fall back to a UTC window,
 * never a guessed zone.
 */

import { debug } from "./logger";

const AIRPORT_TZ: Record<string, string> = {
  // Hawaii (no DST)
  HNL: "Pacific/Honolulu",
  OGG: "Pacific/Honolulu",
  KOA: "Pacific/Honolulu",
  LIH: "Pacific/Honolulu",
  ITO: "Pacific/Honolulu",
  // Alaska
  ANC: "America/Anchorage",
  FAI: "America/Anchorage",
  JNU: "America/Anchorage",
  KTN: "America/Anchorage",
  SIT: "America/Anchorage",
  // US Pacific
  ACV: "America/Los_Angeles",
  BFL: "America/Los_Angeles",
  BUR: "America/Los_Angeles",
  CLD: "America/Los_Angeles",
  EUG: "America/Los_Angeles",
  FAT: "America/Los_Angeles",
  GEG: "America/Los_Angeles",
  LAS: "America/Los_Angeles",
  LAX: "America/Los_Angeles",
  MFR: "America/Los_Angeles",
  MRY: "America/Los_Angeles",
  OAK: "America/Los_Angeles",
  ONT: "America/Los_Angeles",
  OTH: "America/Los_Angeles",
  PDX: "America/Los_Angeles",
  PSC: "America/Los_Angeles",
  PSP: "America/Los_Angeles",
  RDD: "America/Los_Angeles",
  RDM: "America/Los_Angeles",
  RNO: "America/Los_Angeles",
  SAN: "America/Los_Angeles",
  SBA: "America/Los_Angeles",
  SBP: "America/Los_Angeles",
  SEA: "America/Los_Angeles",
  SFO: "America/Los_Angeles",
  SJC: "America/Los_Angeles",
  SMF: "America/Los_Angeles",
  SNA: "America/Los_Angeles",
  // US Mountain
  ABQ: "America/Denver",
  BIL: "America/Denver",
  BZN: "America/Denver",
  COS: "America/Denver",
  CPR: "America/Denver",
  DEN: "America/Denver",
  DRO: "America/Denver",
  EGE: "America/Denver",
  ELP: "America/Denver",
  FCA: "America/Denver",
  GJT: "America/Denver",
  GUC: "America/Denver",
  HLN: "America/Denver",
  JAC: "America/Denver",
  MSO: "America/Denver",
  MTJ: "America/Denver",
  RAP: "America/Denver",
  SAF: "America/Denver",
  SLC: "America/Denver",
  BOI: "America/Boise",
  IDA: "America/Boise",
  SUN: "America/Boise",
  // Arizona (no DST)
  PHX: "America/Phoenix",
  TUS: "America/Phoenix",
  // US Central
  AMA: "America/Chicago",
  ATW: "America/Chicago",
  AUS: "America/Chicago",
  BHM: "America/Chicago",
  BIS: "America/Chicago",
  BNA: "America/Chicago",
  BTR: "America/Chicago",
  CID: "America/Chicago",
  COU: "America/Chicago",
  CRP: "America/Chicago",
  DFW: "America/Chicago",
  DLH: "America/Chicago",
  DSM: "America/Chicago",
  ECP: "America/Chicago",
  FAR: "America/Chicago",
  FSD: "America/Chicago",
  GRB: "America/Chicago",
  HSV: "America/Chicago",
  IAH: "America/Chicago",
  ICT: "America/Chicago",
  LBB: "America/Chicago",
  LFT: "America/Chicago",
  LIT: "America/Chicago",
  LNK: "America/Chicago",
  MAF: "America/Chicago",
  MCI: "America/Chicago",
  MEM: "America/Chicago",
  MFE: "America/Chicago",
  MKE: "America/Chicago",
  MLI: "America/Chicago",
  MOT: "America/Chicago",
  MSN: "America/Chicago",
  MSP: "America/Chicago",
  MSY: "America/Chicago",
  OKC: "America/Chicago",
  OMA: "America/Chicago",
  ORD: "America/Chicago",
  PAH: "America/Chicago",
  PIA: "America/Chicago",
  PNS: "America/Chicago",
  SAT: "America/Chicago",
  SGF: "America/Chicago",
  SHV: "America/Chicago",
  STL: "America/Chicago",
  TUL: "America/Chicago",
  VCT: "America/Chicago",
  XNA: "America/Chicago",
  XWA: "America/Chicago",
  // US Eastern
  ABE: "America/New_York",
  ALB: "America/New_York",
  ATL: "America/New_York",
  AVL: "America/New_York",
  AVP: "America/New_York",
  BDL: "America/New_York",
  BGR: "America/New_York",
  BOS: "America/New_York",
  BTV: "America/New_York",
  BUF: "America/New_York",
  BWI: "America/New_York",
  CAE: "America/New_York",
  CAK: "America/New_York",
  CHA: "America/New_York",
  CHO: "America/New_York",
  CHS: "America/New_York",
  CLE: "America/New_York",
  CLT: "America/New_York",
  CMH: "America/New_York",
  CRW: "America/New_York",
  CVG: "America/New_York",
  DAY: "America/New_York",
  DCA: "America/New_York",
  EWR: "America/New_York",
  EYW: "America/New_York",
  FLL: "America/New_York",
  GSO: "America/New_York",
  GSP: "America/New_York",
  HHH: "America/New_York",
  IAD: "America/New_York",
  ILM: "America/New_York",
  JAX: "America/New_York",
  JFK: "America/New_York",
  LEX: "America/New_York",
  LGA: "America/New_York",
  MCO: "America/New_York",
  MDT: "America/New_York",
  MIA: "America/New_York",
  MYR: "America/New_York",
  ORF: "America/New_York",
  PHL: "America/New_York",
  PIT: "America/New_York",
  PVD: "America/New_York",
  PWM: "America/New_York",
  RDU: "America/New_York",
  RIC: "America/New_York",
  ROA: "America/New_York",
  ROC: "America/New_York",
  RSW: "America/New_York",
  SAV: "America/New_York",
  SCE: "America/New_York",
  SRQ: "America/New_York",
  SYR: "America/New_York",
  TPA: "America/New_York",
  TYS: "America/New_York",
  DTW: "America/Detroit",
  FNT: "America/Detroit",
  GRR: "America/Detroit",
  TVC: "America/Detroit",
  FWA: "America/Indiana/Indianapolis",
  IND: "America/Indiana/Indianapolis",
  SBN: "America/Indiana/Indianapolis",
  SDF: "America/Kentucky/Louisville",
  // Canada
  YEG: "America/Edmonton",
  YYC: "America/Edmonton",
  YHZ: "America/Halifax",
  YOW: "America/Toronto",
  YQB: "America/Toronto",
  YUL: "America/Toronto",
  YYZ: "America/Toronto",
  YVR: "America/Vancouver",
  YWG: "America/Winnipeg",
  // Mexico / Caribbean / Central America
  AGU: "America/Mexico_City",
  BJX: "America/Mexico_City",
  GDL: "America/Mexico_City",
  MEX: "America/Mexico_City",
  MLM: "America/Mexico_City",
  OAX: "America/Mexico_City",
  PVR: "America/Mexico_City",
  PXM: "America/Mexico_City",
  SLP: "America/Mexico_City",
  ZIH: "America/Mexico_City",
  MTY: "America/Monterrey",
  TAM: "America/Monterrey",
  SJD: "America/Mazatlan",
  CUN: "America/Cancun",
  CZM: "America/Cancun",
  TQO: "America/Cancun",
  GCM: "America/Cayman",
  SDQ: "America/Santo_Domingo",
  SJO: "America/Costa_Rica",
  // South America
  BOG: "America/Bogota",
  EZE: "America/Argentina/Buenos_Aires",
  GIG: "America/Sao_Paulo",
  GRU: "America/Sao_Paulo",
  LIM: "America/Lima",
  SCL: "America/Santiago",
  // Europe
  AMS: "Europe/Amsterdam",
  ARN: "Europe/Stockholm",
  ATH: "Europe/Athens",
  BCN: "Europe/Madrid",
  BER: "Europe/Berlin",
  BRU: "Europe/Brussels",
  CDG: "Europe/Paris",
  CPH: "Europe/Copenhagen",
  DUB: "Europe/Dublin",
  EDI: "Europe/London",
  FCO: "Europe/Rome",
  FRA: "Europe/Berlin",
  GVA: "Europe/Zurich",
  HEL: "Europe/Helsinki",
  IST: "Europe/Istanbul",
  LGW: "Europe/London",
  LHR: "Europe/London",
  LIS: "Europe/Lisbon",
  MAD: "Europe/Madrid",
  MAN: "Europe/London",
  MUC: "Europe/Berlin",
  MXP: "Europe/Rome",
  OSL: "Europe/Oslo",
  VCE: "Europe/Rome",
  VIE: "Europe/Vienna",
  ZRH: "Europe/Zurich",
  // Middle East / Africa (Qatar network)
  DOH: "Asia/Qatar",
  AMM: "Asia/Amman",
  AUH: "Asia/Dubai",
  BAH: "Asia/Bahrain",
  BEY: "Asia/Beirut",
  DMM: "Asia/Riyadh",
  DXB: "Asia/Dubai",
  JED: "Asia/Riyadh",
  KWI: "Asia/Kuwait",
  MCT: "Asia/Muscat",
  MED: "Asia/Riyadh",
  RUH: "Asia/Riyadh",
  ADD: "Africa/Addis_Ababa",
  CAI: "Africa/Cairo",
  CMN: "Africa/Casablanca",
  CPT: "Africa/Johannesburg",
  DUR: "Africa/Johannesburg",
  JNB: "Africa/Johannesburg",
  LOS: "Africa/Lagos",
  NBO: "Africa/Nairobi",
  TUN: "Africa/Tunis",
  // South / Southeast / East Asia (Qatar network)
  AMD: "Asia/Kolkata",
  BLR: "Asia/Kolkata",
  BOM: "Asia/Kolkata",
  CCU: "Asia/Kolkata",
  COK: "Asia/Kolkata",
  DEL: "Asia/Kolkata",
  HYD: "Asia/Kolkata",
  MAA: "Asia/Kolkata",
  CMB: "Asia/Colombo",
  DAC: "Asia/Dhaka",
  ISB: "Asia/Karachi",
  KHI: "Asia/Karachi",
  KTM: "Asia/Kathmandu",
  LHE: "Asia/Karachi",
  BKK: "Asia/Bangkok",
  CGK: "Asia/Jakarta",
  DPS: "Asia/Makassar",
  HAN: "Asia/Ho_Chi_Minh",
  HKG: "Asia/Hong_Kong",
  ICN: "Asia/Seoul",
  KUL: "Asia/Kuala_Lumpur",
  MNL: "Asia/Manila",
  SGN: "Asia/Ho_Chi_Minh",
  SIN: "Asia/Singapore",
  CAN: "Asia/Shanghai",
  PEK: "Asia/Shanghai",
  PVG: "Asia/Shanghai",
  HND: "Asia/Tokyo",
  KIX: "Asia/Tokyo",
  NRT: "Asia/Tokyo",
  // Oceania
  ADL: "Australia/Adelaide",
  AKL: "Pacific/Auckland",
  BNE: "Australia/Brisbane",
  MEL: "Australia/Melbourne",
  PER: "Australia/Perth",
  SYD: "Australia/Sydney",
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = fmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    fmtCache.set(timeZone, fmt);
  }
  return fmt;
}

export function airportTimezone(iata: string): string | undefined {
  return AIRPORT_TZ[iata.toUpperCase()];
}

/** YYYY-MM-DD in the given zone (en-CA locale formats ISO-style). */
export function localDateISO(epochSec: number, timeZone: string): string {
  return formatterFor(timeZone).format(new Date(epochSec * 1000));
}

/** Local calendar date at the airport, or null when the airport is unmapped. */
export function airportLocalDate(iata: string, unixSec: number): string | null {
  const tz = airportTimezone(iata);
  return tz ? localDateISO(unixSec, tz) : null;
}

/**
 * Does a UTC departure fall on the queried local date at its departure
 * airport? Unmapped airports fall back to the strict UTC day window, which is
 * the pre-timezone behavior — never worse than before.
 */
// One log per airport per process — surfaces map rot without spamming.
const loggedUnmapped = new Set<string>();

export function matchesLocalDate(
  date: string,
  departureAirport: string,
  departureTimeSec: number,
  fallbackStart: number,
  fallbackEnd: number
): boolean {
  const local = airportLocalDate(departureAirport, departureTimeSec);
  if (local !== null) return local === date;
  const iata = departureAirport.toUpperCase();
  if (iata && !loggedUnmapped.has(iata)) {
    loggedUnmapped.add(iata);
    debug(`no timezone mapping for airport ${iata} — using strict UTC day window`);
  }
  return departureTimeSec >= fallbackStart && departureTimeSec < fallbackEnd;
}
