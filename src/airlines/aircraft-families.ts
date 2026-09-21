/**
 * THE free-text aircraft-type normalizer. FR24 type names, alaskaair.com
 * equipment strings, and IATA short codes all collapse to one bounded family
 * vocabulary, consumed by metrics tags, fleet-page grouping, aircraft specs,
 * and the registry's type→wifi phase tables — one matcher, many consumers.
 *
 * Freighters are distinct families (B777F/B747F/B737F) because program status
 * diverges from the passenger fleet (QR: every passenger 777 has Starlink,
 * the freighters never will), and because they are not in any passenger
 * denominator — see isFreighterFamily.
 *
 * Input examples (44 distinct in prod):
 *   "Boeing 737-924(ER)", "Boeing 737-924", "Boeing 737-932(ER)" → all B737-900
 *   "ERJ-175", "E175SC", "Embraer E-175", "Embraer E175LR", "E75L" → all E175
 *   "Embraer E170SE", "Embraer E-170"                            → E170
 *   "Mitsubishi CRJ-701ER", "CRJ-700"                            → all CRJ-700
 *
 * Ordered from most-specific to least-specific pattern — first match wins.
 * Leaf module: no imports, safe for both registry and observability.
 */
const AIRCRAFT_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  // MAX variants render both ways in the wild ("737 MAX 9", "737-9 MAX").
  [/737[-\s]?(MAX[-\s]?10|10[-\s]?MAX)/i, "B737-MAX10"],
  [/737[-\s]?(MAX[-\s]?8|8[-\s]?MAX)/i, "B737-MAX8"],
  [/737[-\s]?(MAX[-\s]?9|9[-\s]?MAX)/i, "B737-MAX9"],
  // alaskaair.com's equipment codes ("737-M8E", "737-M9E").
  [/737-?M8/i, "B737-MAX8"],
  [/737-?M9/i, "B737-MAX9"],
  // Converted freighters ("737-804(BCF)", "737-790(BDSF)") must win over the
  // passenger -700/-800 patterns below.
  [/737[\w-]*\((?:BCF|BDSF|SF|PCF|F)\)/i, "B737F"],
  [/737-?7/i, "B737-700"],
  [/737-?8/i, "B737-800"],
  [/737-?9/i, "B737-900"],
  [/717|^B712\b/i, "B717"],
  [/747[\w-]*F\b/i, "B747F"],
  [/747/i, "B747"],
  [/757/i, "B757"],
  [/767/i, "B767"],
  [/777-?F/i, "B777F"],
  [/777/i, "B777"],
  [/787|^B78[89]\b/i, "B787"],
  [/A220|^BCS[13]\b|CS[13]00/i, "A220"],
  [/A318/i, "A318"],
  [/A319/i, "A319"],
  [/A320/i, "A320"],
  [/Airbus\s+320\b/i, "A320"],
  [/A321|^(A21N|32Q)\b/i, "A321"],
  [/A330|^A33[23]\b/i, "A330"],
  [/A350/i, "A350"],
  [/A380/i, "A380"],
  // Distinct from the E175: Air France's E190s are mid-install while its
  // E170s have no WiFi at all. "ERJ 170-200" is the E175's type-certificate
  // name, so a 170 followed by -200 is an E175.
  [/(?:E-?|ERJ.?|EMB.?|Embraer\s*)170(?![-\s]?200)|^E70\b/i, "E170"],
  [/E-?190|ERJ.?190|EMB.?190|Embraer\s*190|^E90\b/i, "E190"],
  [
    /E-?175|ERJ.?175|EMB.?175|Embraer\s*175|(?:ERJ|EMB|E|Embraer\s*)[-\s]?170[-\s]?200|^E75[A-Z]?\b/i,
    "E175",
  ],
  [/ERJ.?145/i, "ERJ-145"],
  [/CRJ.?2/i, "CRJ-200"],
  [/CRJ.?550/i, "CRJ-550"],
  [/CRJ.?7/i, "CRJ-700"],
];

/** Every family normalizeAircraftType can return besides "other"/"unknown". */
export const AIRCRAFT_FAMILY_KEYS: readonly string[] = [
  ...new Set(AIRCRAFT_FAMILIES.map(([, family]) => family)),
];

/** Freighter families: kept in united_fleet, excluded from passenger counts. */
export const isFreighterFamily = (family: string): boolean => /F$/.test(family);

export function normalizeAircraftType(raw: string | null | undefined): string {
  if (!raw || /^unknown$/i.test(raw.trim())) return "unknown";
  for (const [pattern, family] of AIRCRAFT_FAMILIES) {
    if (pattern.test(raw)) return family;
  }
  return "other";
}

const FAMILY_DISPLAY: Record<string, string> = {
  "B737-MAX8": "737 MAX 8",
  "B737-MAX9": "737 MAX 9",
  "B737-MAX10": "737 MAX 10",
  "B737-700": "737-700",
  "B737-800": "737-800",
  "B737-900": "737-900",
  B737F: "737 Freighter",
  B717: "717",
  B747: "747",
  B747F: "747 Freighter",
  B757: "757",
  B767: "767",
  B777: "777",
  B777F: "777 Freighter",
  B787: "787",
  "CRJ-200": "CRJ200",
  "CRJ-550": "CRJ550",
  "CRJ-700": "CRJ700",
  "ERJ-145": "ERJ-145",
};

/** "A321-271NX", "A321-271N", "A21N", "A321neo": the re-engined A321. */
const A321NEO = /neo|A21N|\d{3}N[XY]?\b/i;

/**
 * Short display name for any aircraft-type string — FR24 names, sheet headers
 * ("B737-MAX9", "E175SC") and family keys alike — via the one normalizer, so a
 * page never shows "E175" and "ERJ-175" for the same aircraft. The 787's
 * sub-variant and the A321neo survive when the raw string names them, because
 * programmes split on them. Display only: grouping keys on normalizeAircraftType.
 */
export function aircraftName(raw: string | null | undefined): string {
  const family = normalizeAircraftType(raw);
  if (family === "other" || family === "unknown") return raw?.trim() || "Unknown";
  if (family === "B787") {
    const variant = raw?.match(/787-?(8|9|10)\b/);
    if (variant) return `787-${variant[1]}`;
  }
  if (family === "A321" && raw && A321NEO.test(raw)) return "A321neo";
  return FAMILY_DISPLAY[family] ?? family;
}

/** The matcher as data, for inline page scripts that must classify a type
 * string exactly as the server does (a hand-written second copy drifts). */
export function aircraftFamilyPatterns(): Array<[source: string, flags: string, family: string]> {
  return AIRCRAFT_FAMILIES.map(([re, family]) => [re.source, re.flags, family]);
}
