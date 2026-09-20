/**
 * IATA → IANA timezone lookup for departure-date math. Flight dates on
 * boarding passes are LOCAL dates; departure_time columns are UTC epochs, so
 * date matching must convert through the departure airport's zone. Coverage:
 * every airport observed in the snapshot data plus Qatar-network majors
 * (tests/airport-tz-coverage.test.ts holds the line). Unknown airports return
 * undefined/null — callers fall back to a UTC window, never a guessed zone.
 * every airport observed in the snapshot data plus Qatar- and Air France-network
 * majors.
 * Unknown airports return undefined/null — callers fall back to a UTC window,
 * never a guessed zone.
 */

import { debug } from "./logger";

export const AIRPORT_TZ: Record<string, string> = {
  // Hawaii (no DST)
  HNL: "Pacific/Honolulu",
  OGG: "Pacific/Honolulu",
  KOA: "Pacific/Honolulu",
  LIH: "Pacific/Honolulu",
  ITO: "Pacific/Honolulu",
  // US Pacific territories / Micronesia (United Guam hub + island hopper)
  GUM: "Pacific/Guam",
  SPN: "Pacific/Guam",
  MAJ: "Pacific/Majuro",
  KWA: "Pacific/Kwajalein",
  KSA: "Pacific/Kosrae",
  PNI: "Pacific/Pohnpei",
  TKK: "Pacific/Chuuk",
  ROR: "Pacific/Palau",
  YAP: "Pacific/Chuuk",
  PPG: "Pacific/Pago_Pago",
  // Alaska
  ANC: "America/Anchorage",
  FAI: "America/Anchorage",
  JNU: "America/Anchorage",
  KTN: "America/Anchorage",
  SIT: "America/Anchorage",
  ADK: "America/Adak",
  ADQ: "America/Anchorage",
  AKN: "America/Anchorage",
  BET: "America/Anchorage",
  BRW: "America/Anchorage",
  DLG: "America/Anchorage",
  OME: "America/Nome",
  OTZ: "America/Nome",
  PSG: "America/Sitka",
  SCC: "America/Anchorage",
  WRG: "America/Sitka",
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
  ALW: "America/Los_Angeles",
  BFI: "America/Los_Angeles",
  BIH: "America/Los_Angeles",
  BLI: "America/Los_Angeles",
  EAT: "America/Los_Angeles",
  LGB: "America/Los_Angeles",
  NZY: "America/Los_Angeles",
  PAE: "America/Los_Angeles",
  PUW: "America/Los_Angeles",
  STS: "America/Los_Angeles",
  VCV: "America/Los_Angeles",
  YKM: "America/Los_Angeles",
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
  ASE: "America/Denver",
  BFF: "America/Denver",
  BTM: "America/Denver",
  COD: "America/Denver",
  CYS: "America/Denver",
  GCC: "America/Denver",
  GTF: "America/Denver",
  HDN: "America/Denver",
  HOB: "America/Denver",
  LAR: "America/Denver",
  RIW: "America/Denver",
  ROW: "America/Denver",
  SGU: "America/Denver",
  SHR: "America/Denver",
  WYS: "America/Denver",
  // Arizona (no DST)
  PHX: "America/Phoenix",
  TUS: "America/Phoenix",
  PRC: "America/Phoenix",
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
  AEX: "America/Chicago",
  BFM: "America/Chicago",
  BRO: "America/Chicago",
  DAL: "America/Chicago",
  EAR: "America/Chicago",
  FTW: "America/Chicago",
  HRL: "America/Chicago",
  IAB: "America/Chicago",
  JLN: "America/Chicago",
  LBF: "America/Chicago",
  LCH: "America/Chicago",
  MDW: "America/Chicago",
  MEI: "America/Chicago",
  MGM: "America/Chicago",
  MKC: "America/Chicago",
  PIB: "America/Chicago",
  RFD: "America/Chicago",
  SLN: "America/Chicago",
  SUX: "America/Chicago",
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
  ACK: "America/New_York",
  DJT: "America/New_York",
  GGE: "America/New_York",
  GNV: "America/New_York",
  INT: "America/New_York",
  IPT: "America/New_York",
  ITH: "America/New_York",
  JST: "America/New_York",
  LCQ: "America/New_York",
  MCN: "America/New_York",
  MHT: "America/New_York",
  MLB: "America/New_York",
  PBI: "America/New_York",
  CMX: "America/Detroit",
  MBS: "America/Detroit",
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
  YLW: "America/Vancouver",
  YYJ: "America/Vancouver",
  YQG: "America/Toronto",
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
  PUJ: "America/Santo_Domingo",
  STI: "America/Santo_Domingo",
  SJO: "America/Costa_Rica",
  LIR: "America/Costa_Rica",
  GUA: "America/Guatemala",
  SAL: "America/El_Salvador",
  BZE: "America/Belize",
  SAP: "America/Tegucigalpa",
  RTB: "America/Tegucigalpa",
  PTY: "America/Panama",
  SJU: "America/Puerto_Rico",
  STT: "America/Puerto_Rico",
  STX: "America/Puerto_Rico",
  SXM: "America/Lower_Princes",
  AUA: "America/Aruba",
  CUR: "America/Curacao",
  MBJ: "America/Jamaica",
  KIN: "America/Jamaica",
  NAS: "America/Nassau",
  ACA: "America/Mexico_City",
  QRO: "America/Mexico_City",
  VER: "America/Mexico_City",
  ZLO: "America/Mexico_City",
  MID: "America/Merida",
  LAP: "America/Mazatlan",
  LTO: "America/Mazatlan",
  MZT: "America/Mazatlan",
  TPQ: "America/Mazatlan",
  BQN: "America/Puerto_Rico",
  BDA: "Atlantic/Bermuda",
  BGI: "America/Barbados",
  BON: "America/Kralendijk",
  PLS: "America/Grand_Turk",
  POS: "America/Port_of_Spain",
  UVF: "America/St_Lucia",
  MGA: "America/Managua",
  XPL: "America/Tegucigalpa",
  // South America
  BOG: "America/Bogota",
  EZE: "America/Argentina/Buenos_Aires",
  GIG: "America/Sao_Paulo",
  GRU: "America/Sao_Paulo",
  LIM: "America/Lima",
  SCL: "America/Santiago",
  // Europe
  AMS: "Europe/Amsterdam",
  KEF: "Atlantic/Reykjavik",
  NCE: "Europe/Paris",
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
  AGP: "Europe/Madrid",
  TEV: "Europe/Madrid",
  BHX: "Europe/London",
  FAB: "Europe/London",
  STN: "Europe/London",
  BUD: "Europe/Budapest",
  OPO: "Europe/Lisbon",
  SMA: "Atlantic/Azores",
  SNN: "Europe/Dublin",
  SVO: "Europe/Moscow",
  TLS: "Europe/Paris",
  WAW: "Europe/Warsaw",
  XFW: "Europe/Berlin",
  ESB: "Europe/Istanbul",
  LCA: "Asia/Nicosia",
  // Middle East / Africa (Qatar network)
  DOH: "Asia/Qatar",
  TLV: "Asia/Jerusalem",
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
  BGW: "Asia/Baghdad",
  BSR: "Asia/Baghdad",
  DAM: "Asia/Damascus",
  ABJ: "Africa/Abidjan",
  ACC: "Africa/Accra",
  ALG: "Africa/Algiers",
  DAR: "Africa/Dar_es_Salaam",
  MPM: "Africa/Maputo",
  PZU: "Africa/Khartoum",
  RAK: "Africa/Casablanca",
  SEZ: "Indian/Mahe",
  MLE: "Indian/Maldives",
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
  PKX: "Asia/Shanghai",
  HND: "Asia/Tokyo",
  KIX: "Asia/Tokyo",
  NRT: "Asia/Tokyo",
  TPE: "Asia/Taipei",
  CRK: "Asia/Manila",
  HKT: "Asia/Bangkok",
  KTI: "Asia/Phnom_Penh",
  CKG: "Asia/Shanghai",
  HGH: "Asia/Shanghai",
  // Air France / HOP network (France, overseas departments, Africa, Europe)
  ABV: "Africa/Lagos",
  AJA: "Europe/Paris",
  BEG: "Europe/Belgrade",
  BEL: "America/Belem",
  BES: "Europe/Paris",
  BGF: "Africa/Bangui",
  BIA: "Europe/Paris",
  BIO: "Europe/Madrid",
  BIQ: "Europe/Paris",
  BKO: "Africa/Bamako",
  BLL: "Europe/Copenhagen",
  BLQ: "Europe/Rome",
  BOD: "Europe/Paris",
  BRI: "Europe/Rome",
  BSL: "Europe/Paris",
  BZV: "Africa/Brazzaville",
  CAG: "Europe/Rome",
  CAY: "America/Cayenne",
  CFE: "Europe/Paris",
  CFR: "Europe/Paris",
  CKY: "Africa/Conakry",
  CLY: "Europe/Paris",
  CMF: "Europe/Paris",
  COO: "Africa/Porto-Novo",
  CTA: "Europe/Rome",
  CTG: "America/Bogota",
  DBV: "Europe/Zagreb",
  DLA: "Africa/Douala",
  DSS: "Africa/Dakar",
  DUS: "Europe/Berlin",
  EVN: "Asia/Yerevan",
  FAO: "Europe/Lisbon",
  FDF: "America/Martinique",
  FIH: "Africa/Kinshasa",
  FLR: "Europe/Rome",
  FOR: "America/Fortaleza",
  FSC: "Europe/Paris",
  GOA: "Europe/Rome",
  GOT: "Europe/Stockholm",
  HAJ: "Europe/Berlin",
  HAM: "Europe/Berlin",
  HAV: "America/Havana",
  HER: "Europe/Athens",
  IBZ: "Europe/Madrid",
  JMK: "Europe/Athens",
  JTR: "Europe/Athens",
  KIV: "Europe/Chisinau",
  KRK: "Europe/Warsaw",
  LBV: "Africa/Libreville",
  LDE: "Europe/Paris",
  LFW: "Africa/Lome",
  LIL: "Europe/Paris",
  LIN: "Europe/Rome",
  LJU: "Europe/Ljubljana",
  LRH: "Europe/Paris",
  LUX: "Europe/Luxembourg",
  LYS: "Europe/Paris",
  MLA: "Europe/Malta",
  MLH: "Europe/Paris",
  MPL: "Europe/Paris",
  MRS: "Europe/Paris",
  MRU: "Indian/Mauritius",
  MVD: "America/Montevideo",
  NAP: "Europe/Rome",
  NBJ: "Africa/Luanda",
  NDJ: "Africa/Ndjamena",
  NIM: "Africa/Niamey",
  NKC: "Africa/Nouakchott",
  NSI: "Africa/Douala",
  NTE: "Europe/Paris",
  NUE: "Europe/Berlin",
  OLB: "Europe/Rome",
  ORN: "Africa/Algiers",
  ORY: "Europe/Paris",
  OTP: "Europe/Bucharest",
  OUA: "Africa/Ouagadougou",
  PAP: "America/Port-au-Prince",
  PGF: "Europe/Paris",
  PMI: "Europe/Madrid",
  PMO: "Europe/Rome",
  PNR: "Africa/Brazzaville",
  POP: "America/Santo_Domingo",
  PRG: "Europe/Prague",
  PTP: "America/Guadeloupe",
  PUF: "Europe/Paris",
  RAI: "Atlantic/Cape_Verde",
  RBA: "Africa/Casablanca",
  REC: "America/Recife",
  RIX: "Europe/Riga",
  RNS: "Europe/Paris",
  RUN: "Indian/Reunion",
  SID: "Atlantic/Cape_Verde",
  SKG: "Europe/Athens",
  SOF: "Europe/Sofia",
  SPU: "Europe/Zagreb",
  SSA: "America/Bahia",
  SSG: "Africa/Malabo",
  STR: "Europe/Berlin",
  SVQ: "Europe/Madrid",
  SXB: "Europe/Paris",
  TBS: "Asia/Tbilisi",
  TIA: "Europe/Tirane",
  TLL: "Europe/Tallinn",
  TLN: "Europe/Paris",
  TNR: "Indian/Antananarivo",
  TRN: "Europe/Rome",
  UIO: "America/Guayaquil",
  VLC: "Europe/Madrid",
  VNO: "Europe/Vilnius",
  ZAG: "Europe/Zagreb",
  ZNZ: "Africa/Dar_es_Salaam",
  // Oceania
  ADL: "Australia/Adelaide",
  AKL: "Pacific/Auckland",
  PPT: "Pacific/Tahiti",
  BNE: "Australia/Brisbane",
  MEL: "Australia/Melbourne",
  PER: "Australia/Perth",
  SYD: "Australia/Sydney",
  RAR: "Pacific/Rarotonga",
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

/** ICAO → IATA for US/Canada codes (KEWR → EWR, CYVR → YVR); others pass through. */
export function icaoToIata(icao: string): string {
  if (icao.length === 4 && (icao.startsWith("K") || icao.startsWith("C"))) {
    return icao.substring(1);
  }
  return icao;
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

export interface FlightDateWindow {
  /** Strict UTC bounds of the calendar date — kept for FR24 fallback + days_out math. */
  start: number;
  end: number;
  /** Noon UTC of the date — anchor for FR24/route lookups and planner seeding. */
  mid: number;
  /** Widened SQL bounds: every UTC instant whose local date can equal the queried date. */
  queryStart: number;
  queryEnd: number;
  daysOut: number;
}

/** Strict YYYY-MM-DD that names a real calendar day — Date.parse rolls 2026-02-30 over to March 2. */
export function isRealIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date;
}

export function flightDateWindow(
  date: string,
  nowSec = Math.floor(Date.now() / 1000)
): FlightDateWindow | null {
  if (!isRealIsoDate(date)) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  const start = Math.floor(t / 1000);
  const end = start + 86400;
  return {
    start,
    end,
    mid: start + 43200,
    queryStart: start - 14 * 3600, // UTC+14: local date starts up to 14h before the UTC date
    queryEnd: end + 12 * 3600, // UTC-12: local date ends up to 12h after
    daysOut: Math.floor(start / 86400) - Math.floor(nowSec / 86400),
  };
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

/** First UTC instant after `date` ends locally at the airport; unmapped
 * airports get the latest end any zone can have (UTC-12). */
export function localDayEndSec(iata: string, date: string): number {
  const dayStart = Date.parse(`${date}T00:00:00Z`) / 1000;
  const latest = dayStart + 86400 + 12 * 3600;
  if (!airportTimezone(iata)) return latest;
  // Every zone offset is a multiple of 15 minutes.
  for (let t = dayStart - 14 * 3600; t < latest; t += 900) {
    const local = airportLocalDate(iata, t);
    if (local !== null && local > date) return t;
  }
  return latest;
}

function lastSundayISO(year: number, monthIndex: number): string {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  last.setUTCDate(last.getUTCDate() - last.getUTCDay());
  return last.toISOString().slice(0, 10);
}

/**
 * IATA schedule season for a calendar date: "S26" from the last Sunday of
 * March 2026, "W26" from the last Sunday of October 2026 until the next S.
 * Airlines re-plan equipment per season, so equipment history only transfers
 * within one. Null for a malformed date.
 */
export function iataSeasonKey(dateISO: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || Number.isNaN(Date.parse(dateISO))) return null;
  const year = Number(dateISO.slice(0, 4));
  const yy = (y: number) => String(y % 100).padStart(2, "0");
  if (dateISO < lastSundayISO(year, 2)) return `W${yy(year - 1)}`;
  if (dateISO < lastSundayISO(year, 9)) return `S${yy(year)}`;
  return `W${yy(year)}`;
}

/** First day of a season key ("W26" → "2026-10-25"), or null. */
export function iataSeasonStart(key: string): string | null {
  const m = key.match(/^([SW])(\d{2})$/);
  if (!m) return null;
  return lastSundayISO(2000 + Number(m[2]), m[1] === "S" ? 2 : 9);
}

/** Ordinal of a season key, so seasons can be subtracted (S26 → W26 is 1). */
export function iataSeasonIndex(key: string): number {
  const m = key.match(/^([SW])(\d{2})$/);
  if (!m) return Number.NaN;
  return (2000 + Number(m[2])) * 2 + (m[1] === "W" ? 1 : 0);
}
