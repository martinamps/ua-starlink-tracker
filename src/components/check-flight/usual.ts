import {
  bandLabel,
  capitalize,
  flightShare,
  fmt,
  longDate,
  probLabel,
  probTier,
  shareLabel,
  sharePhrase,
} from "../ui/format";
import { PROB_TIER_TONE, type Tone } from "../ui/tone-classes";
import type { FlightFacts } from "./types";

/** The undated answer in the page's sentence, and the same answer as a figure
 * for the share picture. One branch each, so the two cannot disagree. */
export interface UsualAnswer {
  sentence: string;
  /** "12%", "Yes", "3 of 14", "No history yet". */
  figure: string;
  /** What the figure counts. */
  caption: string;
  tone: Tone;
}

const QUESTION = "Does this flight have Starlink?";

/** How often this flight gets Starlink, number first. Prefers the model's
 * number (the one the API and MCP quote) over the raw check tally. */
export function usualAnswer(flight: FlightFacts): UsualAnswer {
  const fn = flight.flightNumber;
  const pred = flight.prediction;
  if (pred && pred.n_observations > 0) {
    return {
      sentence: `${capitalize(flightShare(pred.probability, fn))}.`,
      figure: probLabel(pred.probability),
      caption: "Starlink odds, from recent flights",
      tone: PROB_TIER_TONE[probTier(pred.probability)],
    };
  }
  const rule = flight.typeRule;
  if (rule?.aircraft) return aircraftAnswer(flight.airlineName, rule.aircraft, rule);
  if (rule && rule.probability !== null) {
    const band = bandLabel(rule.label);
    if (rule.probability >= 1) {
      return {
        sentence: `Yes: ${fn} flies ${band} aircraft, and every one has Starlink.`,
        figure: "Yes",
        caption: QUESTION,
        tone: "success",
      };
    }
    if (rule.probability <= 0) {
      return {
        sentence: `No: ${fn} flies ${band} aircraft, which don't have Starlink.`,
        figure: "No",
        caption: QUESTION,
        tone: "neutral",
      };
    }
    return {
      sentence: `${capitalize(sharePhrase(rule.probability))} of the ${band} aircraft that fly ${fn} have Starlink.`,
      figure: shareLabel(rule.probability),
      caption: "Of the aircraft that fly it have Starlink",
      tone: PROB_TIER_TONE[probTier(rule.probability)],
    };
  }
  const { observedStarlink: s, observedTotal: n } = flight;
  if (n > 0) {
    return {
      sentence: `Aircraft on ${fn} had Starlink in ${fmt(s)} of ${fmt(n)} recent checks.`,
      figure: `${fmt(s)} of ${fmt(n)}`,
      caption: "Recent aircraft checks that found Starlink",
      tone: "neutral",
    };
  }
  return {
    sentence: `No Starlink history for ${fn} yet.`,
    figure: "No history yet",
    caption: QUESTION,
    tone: "neutral",
  };
}

/** The answer the aircraft on this number decided: the airline's own count
 * for its type as the figure, never a yes or no the count can't carry. */
function aircraftAnswer(
  airlineName: string,
  sentence: string,
  { probability, count }: NonNullable<FlightFacts["typeRule"]>
): UsualAnswer {
  if (count) {
    return {
      sentence: count.connected <= 0 ? `Not yet: ${lowerFirst(sentence)}` : sentence,
      figure: `${fmt(count.connected)} of ${fmt(count.total)}`,
      caption: `Connected, as counted by ${airlineName} on ${longDate(count.asOf)}`,
      tone: "neutral",
    };
  }
  if (probability === null) {
    return {
      sentence,
      figure: "Depends",
      caption: "On the aircraft that flies it",
      tone: "neutral",
    };
  }
  return {
    sentence,
    figure: shareLabel(probability),
    caption: "Of the aircraft that fly it have Starlink",
    tone: PROB_TIER_TONE[probTier(probability)],
  };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export const usualSummary = (flight: FlightFacts): string => usualAnswer(flight).sentence;
