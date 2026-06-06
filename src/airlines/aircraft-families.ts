/**
 * THE free-text aircraft-type normalizer. FR24 type names, alaskaair.com
 * equipment strings, and IATA short codes all collapse to one bounded family
 * vocabulary, consumed by metrics tags, fleet-page grouping, aircraft specs,
 * and the registry's type→wifi phase tables — one matcher, many consumers.
 *
 * Freighters are distinct families (B777F/B747F) because program status
 * diverges from the passenger fleet (QR: every passenger 777 has Starlink,
 * the freighters never will).
 *
 * Input examples (44 distinct in prod):
 *   "Boeing 737-924(ER)", "Boeing 737-924", "Boeing 737-932(ER)" → all B737-900
 *   "ERJ-175", "E175SC", "Embraer E-175", "Embraer E175LR", "E75L" → all E175
 *   "Mitsubishi CRJ-701ER", "CRJ-700"                            → all CRJ-700
 *
 * Ordered from most-specific to least-specific pattern — first match wins.
 * Leaf module: no imports, safe for both registry and observability.
 */
const AIRCRAFT_FAMILIES: Array<[RegExp, string]> = [
  // MAX variants render both ways in the wild ("737 MAX 9", "737-9 MAX").
  [/737[-\s]?(MAX[-\s]?10|10[-\s]?MAX)/i, "B737-MAX10"],
  [/737[-\s]?(MAX[-\s]?8|8[-\s]?MAX)/i, "B737-MAX8"],
  [/737[-\s]?(MAX[-\s]?9|9[-\s]?MAX)/i, "B737-MAX9"],
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
  [/A319/i, "A319"],
  [/A320/i, "A320"],
  [/A321|^(A21N|32Q)\b/i, "A321"],
  [/A330|^A33[23]\b/i, "A330"],
  [/A350/i, "A350"],
  [/A380/i, "A380"],
  [/E-?17[05]|ERJ.?17[05]|EMB.?17[05]|^E75[A-Z]?\b/i, "E175"],
  [/ERJ.?145/i, "ERJ-145"],
  [/CRJ.?2/i, "CRJ-200"],
  [/CRJ.?550/i, "CRJ-550"],
  [/CRJ.?7/i, "CRJ-700"],
];

export function normalizeAircraftType(raw: string | null | undefined): string {
  if (!raw || /^unknown$/i.test(raw.trim())) return "unknown";
  for (const [pattern, family] of AIRCRAFT_FAMILIES) {
    if (pattern.test(raw)) return family;
  }
  return "other";
}
