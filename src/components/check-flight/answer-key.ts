/**
 * What the undated flight page tells a traveller, reduced to the parts that
 * make it a different answer: the firm lead's word (yes, likely yes, no) and
 * the Wi-Fi it names, the leg it is for, the usual answer's kind and band,
 * and whether the page says the flight has gone quiet. The sitemap dates a
 * flight page by when this last changed.
 *
 * Left out on purpose, because they move on every refresh while the answer
 * stays the same: the tail and aircraft type assigned, the departure's date,
 * the "as of" time, and the exact odds figure and check tally (a percent that
 * drifts 12 → 13 is the same "unlikely"). A page whose next plane is another
 * Starlink jet tomorrow still says yes, and is not news to a crawler.
 */
import { probTier } from "../ui/format";
import type { FlightFacts } from "./types";
import { usualAnswer } from "./usual";

/** Figures that are themselves the answer; any other figure is a count or a
 * percent, whose band the tone already carries. */
const ANSWER_FIGURES = new Set(["Yes", "No", "Depends", "No history yet"]);

export function flightAnswerKey(facts: FlightFacts): string {
  const a = facts.nextAssigned;
  const firm = a
    ? [
        a.hasStarlink ? (a.verified ? "yes" : "likely") : "no",
        a.wifi ?? "",
        a.origin,
        a.destination,
      ]
    : null;
  const usual = usualAnswer(facts);
  const pred = facts.prediction;
  const band = pred && pred.n_observations > 0 ? probTier(pred.probability) : null;
  const route = facts.routes[0];
  return JSON.stringify({
    firm,
    usual: [
      usual.caption,
      usual.tone,
      band ?? (ANSWER_FIGURES.has(usual.figure) ? usual.figure : ""),
    ],
    route: route ? `${route.departure_airport}-${route.arrival_airport}` : null,
    quiet: !!facts.notObservedSince,
  });
}

/**
 * How much a key change matters to someone deciding on the flight, lower for
 * more, or null when it doesn't change the answer at all:
 * 0 the next plane flips between Starlink and not (yes or likely ↔ no);
 * 1 the firm lead otherwise changes its word or Wi-Fi (verified ↔ likely, a
 *   lead that appears or goes);
 * 2 the usual answer or its band;
 * 3 the quiet note alone.
 * A change of leg or route alone is null: on a number that flies two legs a
 * day the page opens on the other one every few hours, which moves the
 * sitemap date (the title names the leg) but tells nobody anything new about
 * Starlink. Keys that don't parse are null: never news by accident.
 */
export function answerTurn(before: string, after: string): 0 | 1 | 2 | 3 | null {
  let was: AnswerKeyShape;
  let is: AnswerKeyShape;
  try {
    was = JSON.parse(before);
    is = JSON.parse(after);
  } catch {
    return null;
  }
  if (!was || !is || typeof was !== "object" || typeof is !== "object") return null;
  const lead = (k: AnswerKeyShape) => (Array.isArray(k.firm) ? k.firm.slice(0, 2) : null);
  const side = (k: AnswerKeyShape) => {
    const word = lead(k)?.[0];
    return word === "yes" || word === "likely" ? "starlink" : word === "no" ? "not" : null;
  };
  const [a, b] = [side(was), side(is)];
  if (a && b && a !== b) return 0;
  if (JSON.stringify(lead(was)) !== JSON.stringify(lead(is))) return 1;
  if (JSON.stringify(was.usual ?? null) !== JSON.stringify(is.usual ?? null)) return 2;
  if (Boolean(was.quiet) !== Boolean(is.quiet)) return 3;
  return null;
}

interface AnswerKeyShape {
  firm?: unknown[] | null;
  usual?: unknown;
  quiet?: unknown;
}
