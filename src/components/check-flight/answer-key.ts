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
 * 0 the next plane on the same leg flips between Starlink and not (yes or
 *   likely ↔ no);
 * 1 the firm lead on the same leg otherwise changes its word or Wi-Fi
 *   (verified ↔ likely);
 * 2 the usual answer or its band;
 * 3 the quiet note alone.
 * The firm lead counts only when both keys have one for the same leg. On a
 * number that flies two legs a day the page opens on the other one every few
 * hours, and the two legs' planes often differ, so a word that changes with
 * the leg is rotation, not news; it still moves the sitemap date (the title
 * names the leg). A lead that appears or goes is whether the schedule reaches
 * the next departure, not the flight's answer: a swap onto a non-Starlink
 * plane shows as a firm "no", never as a missing lead. The usual answer and
 * the quiet note belong to the number, not the leg, so they count either way.
 * Keys that don't parse are null: never news by accident.
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
  const firm = (k: AnswerKeyShape) => (Array.isArray(k.firm) ? k.firm : null);
  const [f, g] = [firm(was), firm(is)];
  if (f && g && typeof f[2] === "string" && f[2] === g[2] && f[3] === g[3]) {
    const side = (word: unknown) =>
      word === "yes" || word === "likely" ? "starlink" : word === "no" ? "not" : null;
    const [a, b] = [side(f[0]), side(g[0])];
    if (a && b && a !== b) return 0;
    if (f[0] !== g[0] || f[1] !== g[1]) return 1;
  }
  if (JSON.stringify(was.usual ?? null) !== JSON.stringify(is.usual ?? null)) return 2;
  if (Boolean(was.quiet) !== Boolean(is.quiet)) return 3;
  return null;
}

/**
 * The turns IndexNow is told about: the next plane on the same leg flipping
 * between Starlink and not (answerTurn's 0). Engines take one or two URLs of
 * a submission and leave the rest, and each URL counts against the site's
 * crawl, so only the flip a traveller acts on is sent; the other turns still
 * move the sitemap date.
 */
export function starlinkFlip(before: string, after: string): 0 | null {
  return answerTurn(before, after) === 0 ? 0 : null;
}

interface AnswerKeyShape {
  firm?: unknown[] | null;
  usual?: unknown;
  quiet?: unknown;
}
