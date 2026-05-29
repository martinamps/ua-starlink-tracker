/**
 * Airport-local time helpers. Flight searches (Google Flights, airline sites)
 * are keyed on the departure airport's LOCAL date, while the DB stores UTC
 * epochs — a US evening departure belongs to the previous UTC calendar day.
 */

const Z = {
  honolulu: "Pacific/Honolulu",
  anchorage: "America/Anchorage",
  pacific: "America/Los_Angeles",
  arizona: "America/Phoenix",
  mountain: "America/Denver",
  central: "America/Chicago",
  eastern: "America/New_York",
} as const;

// Covers ~97% of departures across the tracked airlines plus United's
// widebody international stations. Unmapped airports fall back to UTC dates.
const AIRPORT_TZ: Record<string, string> = {
  // Hawaii
  ...mapTo(Z.honolulu, "HNL OGG KOA LIH ITO"),
  // Alaska
  ...mapTo(Z.anchorage, "ANC FAI JNU KTN SIT ADQ BET"),
  // Pacific
  ...mapTo(
    Z.pacific,
    "SEA PDX SFO LAX SAN SJC OAK SNA ONT BUR LGB LAS RNO SMF FAT SBA PSP ACV RDD GEG MRY SBP CLD BFL EUG MFR RDM STS"
  ),
  // Arizona (no DST)
  ...mapTo(Z.arizona, "PHX TUS YUM"),
  // Mountain
  ...mapTo(
    Z.mountain,
    "DEN SLC ASE COS GJT MTJ EGE HDN JAC GUC BOI SUN TWF IDA BIL BZN MSO FCA GTF HLN RAP ABQ SAF ROW DRO FMN ELP"
  ),
  // Central
  ...mapTo(
    Z.central,
    "ORD MDW IAH HOU DFW DAL AUS SAT MAF LBB AMA CRP BRO MFE HRL MSY BTR SHV LFT MSP MCI STL MKE MSN DSM OKC TUL XNA LIT ICT FAR FSD OMA LNK GRB ATW BNA MEM SGF PIA MLI CID COU MOT BIS PAH ECP HSV BHM XWA GCK"
  ),
  // Eastern
  ...mapTo(
    Z.eastern,
    "EWR JFK LGA IAD DCA BOS PHL PIT CLE CMH CVG DTW IND SDF RIC ORF RDU CLT GSO GSP CHS CAE SAV JAX MCO TPA FLL MIA PBI RSW ATL ROA CHO AVL TYS CHA LEX BUF ROC ALB SYR PWM BTV BGR BDL PVD MDT ABE AVP SCE ERI MYR ILM GRR TVC AZO LAN FNT MBS DAY HHH"
  ),
  // Canada
  ...mapTo("America/Toronto", "YYZ YOW YUL YQB"),
  ...mapTo("America/Halifax", "YHZ"),
  ...mapTo("America/Vancouver", "YVR"),
  ...mapTo("America/Winnipeg", "YWG"),
  ...mapTo("America/Edmonton", "YYC YEG"),
  // Mexico, Caribbean, Central & South America
  ...mapTo("America/Monterrey", "MTY"),
  ...mapTo("America/Mexico_City", "MEX GDL"),
  ...mapTo("America/Mazatlan", "SJD PVR"),
  ...mapTo("America/Cancun", "CUN CZM"),
  ...mapTo("America/Puerto_Rico", "SJU STT STX"),
  ...mapTo("America/Panama", "PTY"),
  ...mapTo("America/Bogota", "BOG"),
  ...mapTo("America/Lima", "LIM"),
  ...mapTo("America/Santiago", "SCL"),
  ...mapTo("America/Sao_Paulo", "GRU GIG"),
  ...mapTo("America/Argentina/Buenos_Aires", "EZE"),
  // Europe
  ...mapTo("Europe/London", "LHR LGW EDI"),
  ...mapTo("Europe/Dublin", "DUB"),
  ...mapTo("Europe/Paris", "CDG NCE"),
  ...mapTo("Europe/Berlin", "FRA MUC BER"),
  ...mapTo("Europe/Amsterdam", "AMS"),
  ...mapTo("Europe/Brussels", "BRU"),
  ...mapTo("Europe/Zurich", "ZRH GVA"),
  ...mapTo("Europe/Madrid", "MAD BCN"),
  ...mapTo("Europe/Lisbon", "LIS"),
  ...mapTo("Europe/Rome", "FCO MXP"),
  ...mapTo("Europe/Athens", "ATH"),
  ...mapTo("Atlantic/Reykjavik", "KEF"),
  // Middle East, Asia, Pacific
  ...mapTo("Asia/Jerusalem", "TLV"),
  ...mapTo("Asia/Dubai", "DXB AUH"),
  ...mapTo("Asia/Qatar", "DOH"),
  ...mapTo("Asia/Tokyo", "NRT HND KIX"),
  ...mapTo("Asia/Seoul", "ICN"),
  ...mapTo("Asia/Shanghai", "PVG PEK"),
  ...mapTo("Asia/Hong_Kong", "HKG"),
  ...mapTo("Asia/Taipei", "TPE"),
  ...mapTo("Asia/Singapore", "SIN"),
  ...mapTo("Asia/Bangkok", "BKK"),
  ...mapTo("Asia/Manila", "MNL"),
  ...mapTo("Asia/Kolkata", "DEL BOM"),
  ...mapTo("Australia/Sydney", "SYD"),
  ...mapTo("Australia/Melbourne", "MEL"),
  ...mapTo("Pacific/Auckland", "AKL"),
  ...mapTo("Pacific/Guam", "GUM"),
  ...mapTo("Pacific/Tahiti", "PPT"),
  ...mapTo("Pacific/Majuro", "MAJ"),
  ...mapTo("Pacific/Palau", "ROR"),
  ...mapTo("Pacific/Chuuk", "TKK"),
  ...mapTo("Pacific/Kosrae", "KSA"),
  ...mapTo("Pacific/Pohnpei", "PNI"),
};

function mapTo(tz: string, codes: string): Record<string, string> {
  return Object.fromEntries(codes.split(" ").map((c) => [c, tz]));
}

export function airportTimezone(iata: string): string | null {
  return AIRPORT_TZ[iata.toUpperCase()] ?? null;
}

export function localDateISO(epochSec: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochSec * 1000));
}

/**
 * UTC query window guaranteed to contain every departure whose airport-local
 * date is `dateISO`, for any timezone an airline serves (UTC-11 .. UTC+13).
 * Callers narrow the result with departsOnLocalDate / filterToLocalDate.
 */
export function localDateWindow(dateISO: string): { startSec: number; endSec: number } {
  const utcMidnight = Math.floor(new Date(`${dateISO}T00:00:00Z`).getTime() / 1000);
  return { startSec: utcMidnight - 13 * 3600, endSec: utcMidnight + 86400 + 11 * 3600 };
}

export function filterToLocalDate<T extends { departure_time: number; departure_airport: string }>(
  rows: T[],
  dateISO: string
): T[] {
  return rows.filter((r) => departsOnLocalDate(r.departure_time, r.departure_airport, dateISO));
}

/**
 * Does this departure fall on `dateISO` in the departure airport's local time?
 * Unknown airports fall back to the UTC calendar date (the previous behavior).
 */
export function departsOnLocalDate(
  departureEpochSec: number,
  departureAirportIata: string,
  dateISO: string
): boolean {
  const tz = airportTimezone(departureAirportIata);
  if (!tz) return new Date(departureEpochSec * 1000).toISOString().slice(0, 10) === dateISO;
  return localDateISO(departureEpochSec, tz) === dateISO;
}
