/**
 * The undated flight page's opening when the next departure's aircraft is
 * already assigned and its Wi-Fi settled. Assistants and crawlers quote this
 * sentence with nothing around it, so it carries everything that keeps it
 * true alone: the flight, the departure's date and airports, the tail, and
 * the time the assignment was last seen.
 */
import { aircraftName } from "../../airlines/aircraft-families";
import { article } from "../../utils/grammar";
import { utcDateTime, zonedLongDate } from "../ui/format";
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

export function firmLead(flight: FlightFacts, a: AssignedDeparture): string {
  const answer = a.hasStarlink ? (a.verified ? "Yes" : "Likely yes") : "No";
  return `${answer}: as of ${utcDateTime(a.seenAt)}, ${flight.airlineName} flight ${flight.flightNumber} from ${a.origin} to ${a.destination} on ${zonedLongDate(a.departure, a.departureZone)} is assigned ${a.tail}, ${aircraftPhrase(a)}.`;
}

/** Said once, right under the lead: the one thing that can make it wrong. */
export const SWAP_CAVEAT =
  "Aircraft can be swapped before departure, so check your date again on the day you fly.";
