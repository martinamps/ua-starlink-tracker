/**
 * Token extraction for citation verification — pure, offline, no network.
 *
 * The premise: a claim is only cited if the *distinguishing* parts of it are
 * physically present in the bytes the source returns. Prose paraphrases; "150
 * aircraft", "A321XLR", "ZK-OXE" and "Eutelsat OneWeb" do not. So we pull those
 * out of a fact and look for them, rather than trying to judge meaning.
 *
 * Every miss this produces is one of two things: a claim the source does not
 * make, or a surface variation the source spells differently. The second is
 * what SYNONYMS is for, and every entry in it is a place the check has been
 * deliberately weakened — keep it short and keep it reviewed.
 */

/** Severity of a missing token. FAIL blocks; WARN is reported and counted.
 *
 * The line: a number, a money amount, a registration or an aircraft designator
 * either appears in the source or the claim is not sourced — those are the five
 * date blockers and the ZIPAIR/ANA/LATAM/Virgin fabrications, and none of them
 * survives a literal search. A proper noun is softer: sources drop corporate
 * suffixes, use possessives, and say "OneWeb" where a fact says "Eutelsat
 * OneWeb", so a miss is a strong signal for a human but not a safe auto-block.
 * `--strict` (the weekly job) promotes every warning to a failure. */
export type Severity = "fail" | "warn";

export type TokenKind =
  | "number"
  | "money"
  | "year"
  | "month"
  | "aircraft"
  | "registration"
  | "properNoun";

export interface AssertableToken {
  kind: TokenKind;
  /** As written in the claim — what the report prints. */
  raw: string;
  /** Normalized alternatives; the token counts as present if ANY appears. */
  needles: string[];
  /** A weaker needle that downgrades a miss to a warning when it matches — the
   * aircraft family root ("787" for "787-8"), so "the source says 787 but not
   * 787-8" reads differently from "the source says neither". */
  fallback?: string;
  severity: Severity;
}

const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;|&#160;/g, " "],
  [/&amp;|&#38;/g, "&"],
  [/&quot;|&#34;|&#8220;|&#8221;|[“”]/g, '"'],
  // The numeric references belong here for the same reason &#8211; and &#8212;
  // are on the dash row: a publisher that writes an apostrophe as &#8216; is
  // writing an apostrophe. PaxEx.Aero serves "Viasat</a>&#8216;s GX satellites",
  // which without this reads as a page that does not contain "Viasat's GX" —
  // a token miss invented entirely by the extractor.
  [/&#39;|&apos;|&rsquo;|&lsquo;|&#8216;|&#8217;|[‘’]/g, "'"],
  [/&mdash;|&ndash;|&#8211;|&#8212;|[–—]/g, "-"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
];

/**
 * One spelling for both sides of every comparison. Case-folded, entities
 * decoded, thousands separators dropped ("1,000" and "1000" are the same
 * number), Wi-Fi's four spellings unified, and every dash flattened — a source
 * that writes "A321 XLR" or "A321‑XLR" is saying what "A321XLR" says.
 */
export function normalize(input: string): string {
  let s = input;
  for (const [re, to] of ENTITIES) s = s.replace(re, to);
  s = s.toLowerCase();
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  s = s.replace(/wi[\s\-‑]?fi/g, "wifi");
  // Possessives are inflection, not a different name: a source writing
  // "United Q2" supports a claim writing "United's Q2". Applied to BOTH sides
  // so the two can never disagree about which form to look for.
  s = s.replace(/['’]s\b/g, "");
  s = s.replace(/[‐-―]/g, "-");
  return s.replace(/\s+/g, " ").trim();
}

/** HTML → the text a reader would see. Scripts, styles and inline JSON-LD are
 * stripped BEFORE the tag strip: a page that merely mentions "787" inside an
 * ad-tech blob is not a page that says it. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return normalize(stripped);
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Small-number words: a source writing "eight aircraft" is making the claim a
 * fact writes as "(eight aircraft)" or "8 aircraft". Only 1-20 — beyond that,
 * publications use digits. */
const SPELLED: Record<string, string> = {
  "1": "one",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
  "10": "ten",
  "11": "eleven",
  "12": "twelve",
  "13": "thirteen",
  "14": "fourteen",
  "15": "fifteen",
  "16": "sixteen",
  "17": "seventeen",
  "18": "eighteen",
  "19": "nineteen",
  "20": "twenty",
};

/**
 * Legitimate surface variation, NOT synonymy. Each entry says "these strings
 * are the same string" — never "this claim implies that one". Adding one is a
 * deliberate weakening of the check, so each needs a reason a reviewer can
 * check in the source's own text.
 */
const SYNONYMS: Record<string, string[]> = {
  // Registrations are printed with and without the hyphen, sometimes spaced.
  "zk-oxe": ["zk oxe", "zkoxe"],
  // Airbus and Boeing marketing names vs the type designator.
  a380: ["airbus a380", "a-380"],
  a350: ["airbus a350"],
  "787": ["dreamliner", "boeing 787"],
  "777": ["boeing 777", "triple seven"],
  // "US$25 million" is also written "$25 million" and "25 million dollars".
  us$: ["$", "usd "],
};

const PROPER_NOUN_STOP = new Set([
  // Sentence and clause openers that happen to be capitalized.
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "by",
  "for",
  "of",
  "to",
  "with",
  "from",
  "since",
  "its",
  "it",
  "this",
  "that",
  "these",
  "those",
  "no",
  "not",
  "all",
  "both",
  "only",
  "free",
  "new",
  // Domain words that appear in almost every fact and prove nothing.
  "starlink",
  "wifi",
  "internet",
  "connectivity",
  "aircraft",
  "fleet",
  "airline",
  "airlines",
  "air",
  "class",
  "business",
  "economy",
  "first",
  "gate",
  "spacex",
  ...MONTHS,
]);

// Designators as airlines and press releases actually print them: with the
// manufacturer letter attached ("B767-300ER"), pluralized ("A330s"), and with
// the marketing suffix spaced off ("737 MAX 9"). Missing any of those spellings
// does not make the check softer — it makes the type silently fall through to
// the bare-number rule and lose its family-root fallback.
const AIRCRAFT_RE =
  /\b[AB]?(?:7[0-9]7|A3[0-9]{2}|A2[0-9]{2}|E1[0-9]{2}|ATR ?[0-9]{2})(?:-?[0-9A-Z]+)*(?: (?:MAX|NEO|XLR|ULR|LR)\s?[0-9]*)?s?\b/g;
// Tail numbers, filtered to the prefixes real registries use. An unfiltered
// pattern eats every uppercase acronym in the sentence. The separator may be a
// space: Air New Zealand's own release styles ZK-OXE as "ZK OXE".
const REGISTRATION_RE =
  /\b(?:N\d{1,5}[A-Z]{0,2}|(?:G|D|F|HP|ZK|A7|C|VH|9V|PH|EI|OH|SE|LN)[ -][A-Z]{2,5})\b/g;
const MONEY_RE = /(?:US\$|\$|USD ?|EUR ?|€)\s?\d[\d,]*(?:\.\d+)?(?: ?(?:million|billion))?/gi;
const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?%?\b/g;

function needlesFor(normalized: string): string[] {
  const out = [normalized];
  for (const [key, alts] of Object.entries(SYNONYMS)) {
    if (normalized === key || normalized.includes(key)) {
      for (const alt of alts) out.push(normalized.replace(key, alt));
    }
  }
  // Hyphenated designators are printed spaced and closed up.
  if (normalized.includes("-")) {
    out.push(normalized.replace(/-/g, " "), normalized.replace(/-/g, ""));
  }
  return [...new Set(out)];
}

/**
 * The claim's distinguishing tokens. Order of extraction matters: aircraft
 * designators and registrations are pulled first and masked out, so "787-9"
 * never also arrives as the bare numbers 787 and 9.
 */
export function assertableTokens(claim: string, subjectName = ""): AssertableToken[] {
  const tokens: AssertableToken[] = [];
  const seen = new Set<string>();
  const push = (t: AssertableToken) => {
    const key = `${t.kind}:${t.raw.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push(t);
  };

  let masked = claim;
  const mask = (re: RegExp, make: (raw: string) => AssertableToken) => {
    masked = masked.replace(re, (raw) => {
      push(make(raw));
      return " ".repeat(raw.length);
    });
  };

  mask(new RegExp(AIRCRAFT_RE.source, "g"), (raw) => {
    // A plural is inflection, not a sub-type: a fact saying "A330s" is
    // supported by a source saying "A330". Only the DESIGNATOR distinguishes,
    // which is why the trailing s is dropped before the needle is built.
    const norm = normalize(raw).replace(/s$/, "");
    // "787-8" fails softer when the page says "787": the sub-type may simply
    // be absent from the source, which is a different finding from the whole
    // type being absent.
    const root = norm.match(/(7[0-9]7|a3[0-9]{2}|a2[0-9]{2}|e1[0-9]{2}|atr ?[0-9]{2})/)?.[1];
    return {
      kind: "aircraft",
      raw,
      needles: needlesFor(norm),
      fallback: root && root !== norm ? root : undefined,
      severity: "fail",
    };
  });
  mask(new RegExp(REGISTRATION_RE.source, "g"), (raw) => ({
    kind: "registration",
    raw,
    needles: needlesFor(normalize(raw)),
    severity: "fail",
  }));
  mask(new RegExp(MONEY_RE.source, "gi"), (raw) => {
    const norm = normalize(raw);
    return {
      kind: "money",
      // The bare amount is the assertable part; currency sigils vary wildly.
      needles: [...new Set([...needlesFor(norm), norm.replace(/^[^\d]+/, "")])],
      raw,
      severity: "fail",
    };
  });

  for (const m of masked.matchAll(NUMBER_RE)) {
    const raw = m[0];
    const norm = normalize(raw);
    const bare = norm.replace("%", "");
    const needles = [norm, bare];
    // "about 90%" is supported by a source that writes "90 percent".
    if (norm.endsWith("%")) needles.push(`${bare} percent`, `${bare} per cent`);
    if (SPELLED[bare]) needles.push(SPELLED[bare]);
    push({
      kind: /^(19|20)\d{2}$/.test(bare) ? "year" : "number",
      raw,
      needles: [...new Set(needles)],
      severity: "fail",
    });
  }

  for (const month of MONTHS) {
    if (new RegExp(`\\b${month}\\b`, "i").test(claim)) {
      push({
        kind: "month",
        raw: month,
        needles: [month, month.slice(0, 3)],
        // A source dated in its own byline often never names the month in prose.
        severity: "warn",
      });
    }
  }

  const subjectWords = new Set(normalize(subjectName).split(" ").filter(Boolean));
  for (const run of properNounRuns(masked)) {
    const norm = normalize(run);
    if (norm.split(" ").every((w) => subjectWords.has(w))) continue;
    push({ kind: "properNoun", raw: run, needles: needlesFor(norm), severity: "warn" });
  }
  return tokens;
}

/** Capitalized runs of 2+ words, minus the stop-list.
 *
 * Two rules keep this from inventing phrases. The first word of each sentence
 * is skipped — "Since January…" is not a proper noun, it is a sentence that
 * starts with a capital letter. And punctuation ENDS a run: "Alaska, Hawaiian,
 * and Horizon" is a list of three names, not the two-word name "Alaska
 * Hawaiian", and a source is under no obligation to print the list in that
 * order. */
function properNounRuns(text: string): string[] {
  const runs: string[] = [];
  for (const sentence of text.split(/(?<=[.;:])\s+/)) {
    const words = sentence.trim().split(/\s+/);
    let current: string[] = [];
    const flush = () => {
      if (current.length >= 2) runs.push(current.join(" "));
      current = [];
    };
    for (const [i, word] of words.entries()) {
      const bare = word.replace(/^[("'“]+|[)"'”,.;:—–]+$/g, "");
      // A bracket or a comma opens a new phrase: "Amazon Leo (LEO satellites)"
      // names one thing, not a thing called "Leo LEO".
      const opensPhrase = /^[("“]/.test(word);
      const closesPhrase = /[,;:.—–)]$/.test(word);
      // "Jazz-operated", "Viasat/Hughes-powered" are compound ADJECTIVES built
      // from proper nouns, not names. Requiring a source to reproduce the
      // compound verbatim tests the writer's phrasing, not the claim.
      const compound = /[\/]|.[-].+/.test(bare) && !/^[A-Z]+-[0-9]/.test(bare);
      if (opensPhrase) flush();
      // Stop-list lookup goes through normalize(), so "Wi-Fi" matches the
      // "wifi" entry — the four spellings are one word.
      if (i === 0 || !/^[A-Z]/.test(bare) || PROPER_NOUN_STOP.has(normalize(bare)) || compound) {
        flush();
        continue;
      }
      current.push(bare);
      if (closesPhrase) flush();
    }
    flush();
  }
  return runs;
}

export interface TokenResult {
  token: AssertableToken;
  found: boolean;
  /** True when only the weaker fallback matched (aircraft family root). */
  viaFallback: boolean;
}

/** Look every token up in already-normalized text. */
export function checkTokens(tokens: AssertableToken[], normalizedText: string): TokenResult[] {
  return tokens.map((token) => {
    if (token.needles.some((n) => normalizedText.includes(n))) {
      return { token, found: true, viaFallback: false };
    }
    if (token.fallback && normalizedText.includes(token.fallback)) {
      return { token, found: true, viaFallback: true };
    }
    return { token, found: false, viaFallback: false };
  });
}

/** Effective severity of a result — a fallback-only aircraft match is a warning
 * however the token was declared. */
export function severityOf(result: TokenResult): Severity | null {
  if (result.found && !result.viaFallback) return null;
  if (result.viaFallback) return "warn";
  return result.token.severity;
}
