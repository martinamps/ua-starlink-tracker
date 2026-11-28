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
