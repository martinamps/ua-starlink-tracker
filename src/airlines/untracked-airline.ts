/**
 * What a flight lookup may say about an airline this site doesn't answer by
 * flight: the newest current rollout fact it holds, with its date and source,
 * and the airline's own way to check a flight where one is on file. Never a
 * yes, a no or odds of ours: nothing held names the aircraft on such a flight.
 * An airline with no Starlink programme gets its dated fact too, worded as the
 * airline's choice (or as nothing found), not as a check of the flight.
 */

import { canonicalFlightInput } from "./flight-input";
import { SITES } from "./registry";
import {
  AIRLINE_FACTS,
  type AirlineFactsEntry,
  type RolloutFact,
  type RolloutFactsStatus,
  factStamp,
  formatFactDate,
} from "./rollout-facts";

interface OwnCheck {
  /** Only what the page at `source.url` says, in this site's words; quoted
   * words are the page's own. */
  text: string;
  source: { label: string; url: string };
  /** The day the page was opened and read: these pages carry no date. */
  checked: string;
}

/**
 * How the airline itself tells a traveller whether a flight has its Wi-Fi,
 * keyed by IATA code. Held to the rollout-facts rule: an entry says only what
 * its page says, and exists only for a page that opened when read.
 */
const OWN_CHECKS: Readonly<Record<string, OwnCheck>> = {
  WN: {
    text: 'Southwest says a trip viewed in the Southwest app shows "WiFi Powered by Starlink", and that all flights are subject to last-minute aircraft changes.',
    source: {
      label: "Southwest help centre",
      url: "https://support.southwest.com/helpcenter/s/article/starlink-wifi",
    },
    checked: "2026-11-25",
  },
  WS: {
    text: "WestJet says to check Wi-Fi availability for a flight in its Flight Guide within 72 hours of departure. Its help page calls the service WestJet Wi-Fi, presented by TELUS, and does not name Starlink.",
    source: {
      label: "WestJet help: WestJet Wi-Fi",
      url: "https://www.westjet.com/en-ca/help/westjet-wifi",
    },
    checked: "2026-11-25",
  },
  AC: {
    text: "Air Canada's Wi-Fi page has a tool that shows whether Wi-Fi is available on a flight in the next five days. The page does not say the tool tells Starlink from Air Canada's other Wi-Fi.",
    source: {
      label: "Air Canada: Wi-Fi onboard",
      url: "https://www.aircanada.com/ca/en/aco/home/fly/onboard/wi-fi.html",
    },
    checked: "2026-11-25",
  },
};

const byIata = new Map<string, AirlineFactsEntry>(
  AIRLINE_FACTS.filter((e) => !e.trackedCode).map((e) => [e.iata, e])
);

export interface UntrackedAirlineInfo {
  /** The name a headline uses. A group entry (IAG, Lufthansa Group) answers
   * under the brand whose code it carries. */
  airline: string;
  iata: string;
  /** "installing" | "complete" | "trial" | "announced" | "not_starlink". */
  status: RolloutFactsStatus;
  status_label: string;
  /** False when nothing flies with Starlink: announced and not yet flying, or
   * no Starlink programme at all. */
  flying: boolean;
  /** The words that open the fact: a dated "not yet" when Starlink is
   * announced and nothing flies, the airline's other choice when it has made
   * one, and "no announcement found" when it has said nothing. */
  lead: string;
  /** "As of Oct 8, 2026", or "Checked Nov 17, 2026" for an undated page. */
  dated: string;
  fact: string;
  /** Exactly one of these: `as_of` is the source's own date, `checked` the day
   * an undated page was read. YYYY-MM-DD, or YYYY-MM. */
  as_of?: string;
  checked?: string;
  source: { label: string; url: string; second_hand?: true };
  /** Why this is no answer for the flight asked about. */
  caveat: string;
  /** This airline's page on the hub. */
  page: string;
  how_to_check?: { text: string; checked: string; source: { label: string; url: string } };
  /** The whole of the above as one paragraph, for a surface that prints text. */
  summary: string;
}

/** The current fact with the latest date, a source-dated one before a merely
 * checked one of the same day. */
function newestCurrentFact(entry: AirlineFactsEntry): RolloutFact | null {
  const current = entry.facts.filter((f) => !f.superseded);
  const rank = (f: RolloutFact) => `${factStamp(f).date}${f.asOf ? "1" : "0"}`;
  return current.sort((a, b) => rank(b).localeCompare(rank(a)))[0] ?? null;
}

function iataPrefix(flightNumber: string): string | null {
  return canonicalFlightInput(flightNumber).match(/^([A-Z][A-Z0-9]|\d[A-Z])\d{1,4}$/)?.[1] ?? null;
}

const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** "As of Oct 8, 2026" for a source-dated fact, "Checked Nov 17, 2026" for an
 * undated page. */
function stampWords(stamp: ReturnType<typeof factStamp>): string {
  return `${stamp.label === "as of" ? "As of" : "Checked"} ${formatFactDate(stamp.date)}`;
}

/** The words that open the fact: a dated "not yet" where nothing flies. An
 * airline we found no announcement from is never called a no: silence is an
 * absence of evidence (rollout-facts.ts, `negative`). */
function leadWords(entry: AirlineFactsEntry, airline: string): string {
  if (entry.status === "not_starlink") {
    return entry.negative === "chose"
      ? `${airline} has no Starlink programme: it chose another system`
      : `We have found no Starlink announcement from ${airline}`;
  }
  return entry.status === "announced"
    ? `Not yet: Starlink is announced for ${airline}, and we hold no report of an aircraft flying with it`
    : `What we know about ${airline}`;
}

const SCOPE_NOTE =
  "This is the airline-wide picture, not an answer for this flight: nothing we hold names the aircraft on it.";
const PLAN_NOTE = "This is the airline's plan, not a check of this flight.";
const CHOICE_NOTE = "This is the airline's own choice of system, not a check of this flight.";
const SILENCE_NOTE =
  "Finding no announcement is not proof there is none, and this is not a check of this flight.";

function caveatFor(entry: AirlineFactsEntry): string {
  if (entry.status === "not_starlink") {
    return entry.negative === "chose" ? CHOICE_NOTE : SILENCE_NOTE;
  }
  return entry.status === "announced" ? PLAN_NOTE : SCOPE_NOTE;
}

function summaryOf(info: Omit<UntrackedAirlineInfo, "summary">): string {
  const how = info.how_to_check
    ? ` To check for yourself: ${sentence(info.how_to_check.text)} (Source: ${info.how_to_check.source.label}, ${info.how_to_check.source.url}, read ${formatFactDate(info.how_to_check.checked)}.)`
    : "";
  return `${info.lead}. ${info.dated}: ${sentence(info.fact)} (Source: ${info.source.label}, ${info.source.url}.) ${info.caveat}${how} More: ${info.page}`;
}

/**
 * The dated fact for the airline a flight number names, or null: a number
 * that isn't code-plus-digits, an airline with no entry, or one answered by
 * flight elsewhere on this site.
 */
export function untrackedAirlineInfo(flightNumber: string): UntrackedAirlineInfo | null {
  const iata = iataPrefix(flightNumber);
  const entry = iata ? byIata.get(iata) : undefined;
  const fact = entry ? newestCurrentFact(entry) : null;
  if (!entry || !fact) return null;
  const stamp = factStamp(fact);
  const own = OWN_CHECKS[entry.iata];
  const airline = entry.titleName ?? entry.shortName;
  const flying = entry.status !== "announced" && entry.status !== "not_starlink";
  const info: Omit<UntrackedAirlineInfo, "summary"> = {
    airline,
    iata: entry.iata,
    status: entry.status,
    status_label: entry.statusLabel,
    flying,
    lead: leadWords(entry, airline),
    dated: stampWords(stamp),
    fact: fact.fact,
    ...(stamp.label === "as of" ? { as_of: stamp.date } : { checked: stamp.date }),
    source: {
      label: fact.source.label,
      url: fact.source.url,
      ...(fact.source.secondHand ? { second_hand: true as const } : {}),
    },
    caveat: caveatFor(entry),
    page: `https://${SITES.airline.canonicalHost}/airlines/${entry.slug}`,
    ...(own ? { how_to_check: { text: own.text, checked: own.checked, source: own.source } } : {}),
  };
  return { ...info, summary: summaryOf(info) };
}

/**
 * Hawaiian's own HA code no longer sells a flight: its flights carry Alaska's
 * AS code, and the registry answers them in the AS800-1299 blocks. A traveller
 * holding an old HA number is told which number to use.
 */
export const RETIRED_CODE_NOTES: Readonly<Record<string, string>> = {
  HA: "Hawaiian's flights now carry Alaska's AS code: the HA code was retired on April 22, 2026. Look this flight up by the AS number on the booking.",
};

export function retiredCodeNote(flightNumber: string): string | null {
  const iata = iataPrefix(flightNumber);
  return iata ? (RETIRED_CODE_NOTES[iata] ?? null) : null;
}
