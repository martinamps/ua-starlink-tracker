/**
 * normalizeAircraftType's rule list as it stood before the E170 split and the
 * alaskaair.com / "Airbus 320" coverage rules. The normalizer-diff test runs
 * both over every raw type string in the snapshot, so a later rule edit that
 * moves any other string between families fails loudly instead of drifting.
 */
const BASE_RULES: ReadonlyArray<[RegExp, string]> = [
  [/737[-\s]?(MAX[-\s]?10|10[-\s]?MAX)/i, "B737-MAX10"],
  [/737[-\s]?(MAX[-\s]?8|8[-\s]?MAX)/i, "B737-MAX8"],
  [/737[-\s]?(MAX[-\s]?9|9[-\s]?MAX)/i, "B737-MAX9"],
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

export function baseNormalizeAircraftType(raw: string | null | undefined): string {
  if (!raw || /^unknown$/i.test(raw.trim())) return "unknown";
  for (const [pattern, family] of BASE_RULES) {
    if (pattern.test(raw)) return family;
  }
  return "other";
}
