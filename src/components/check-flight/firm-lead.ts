/**
 * The undated flight page's opening when the next departure's aircraft is
 * already assigned and its Wi-Fi settled. Assistants and crawlers quote this
 * sentence with nothing around it, so it carries everything that keeps it
 * true alone: the flight, the departure's date and airports, the tail, and
 * the time the assignment was last seen.
 */
import { aircraftName } from "../../airlines/aircraft-families";
import { article } from "../../utils/grammar";
import { monthDay, utcDateTime, utcDayTime, zonedLongDate, zonedShortDate } from "../ui/format";
import type { AssignedDeparture, FlightFacts } from "./types";

function aircraftPhrase(a: AssignedDeparture): string {
  const name = a.aircraft ? aircraftName(a.aircraft) : "aircraft";
  const plane = `${article(name)} ${name}`;
  if (a.hasStarlink) {
    return a.verified
      ? `${plane} with Starlink Wi-Fi`
      : `${plane} listed with Starlink Wi-Fi that we have not verified yet`;
  }
  if (a.wifi === "no") return `${plane} with no Wi-Fi`;
  if (!a.wifi || a.wifi === "non-Starlink") return `${plane} without Starlink Wi-Fi`;
  return `${plane} with ${a.wifi} Wi-Fi, not Starlink`;
}

const firmAnswer = (a: AssignedDeparture) =>
  a.hasStarlink ? (a.verified ? "Yes" : "Likely yes") : "No";

export function firmLead(flight: FlightFacts, a: AssignedDeparture): string {
  const answer = firmAnswer(a);
  return `${answer}: as of ${utcDateTime(a.seenAt)}, ${flight.airlineName} flight ${flight.flightNumber} from ${a.origin} to ${a.destination} on ${zonedLongDate(a.departure, a.departureZone)} is assigned ${a.tail}, ${aircraftPhrase(a)}.`;
}

/** Said once, right under the lead: the one thing that can make it wrong. */
export const SWAP_CAVEAT =
  "Aircraft can be swapped before departure, so check your date again on the day you fly.";

const SWAP_NOTE = "Aircraft can be swapped before departure.";

/**
 * The same answer for the search description of a page that opens with
 * firmLead: the answer word, the tail and the aircraft phrase are firmLead's
 * own, so the snippet and the page cannot disagree. A search engine keeps a
 * snippet for days, so it stays dated twice (when the assignment was seen, and
 * the departure's day) and is true however late it is read. Dates are short
 * to fit `max`, and the swap note is added only when the whole of it fits.
 */
export function firmDescription(flight: FlightFacts, a: AssignedDeparture, max: number): string {
  const said = (seen: string) =>
    `${firmAnswer(a)}: as of ${seen}, ${flight.flightNumber} ${a.origin}–${a.destination} on ${zonedShortDate(a.departure, a.departureZone)} is assigned ${a.tail}, ${aircraftPhrase(a)}.`;
  const full = said(utcDayTime(a.seenAt));
  if (`${full} ${SWAP_NOTE}`.length <= max) return `${full} ${SWAP_NOTE}`;
  // A long aircraft name gives up the hour before it gives up its last words.
  return full.length <= max ? full : said(monthDay(a.seenAt));
}
