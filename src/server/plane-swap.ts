/**
 * The plane swap a dated answer page names: the log holds two tails for the
 * departure the answer is about, and the aircraft the answer names now is not
 * the first one we saw. Built from stored rows only, on the calendar feed's
 * swap rule (isSwap), so the page and the feed never disagree on whether one
 * happened.
 */

import type { PlaneSwap, SwapStarlinkChange } from "../components/check-flight/types";
import type { AssignmentLogRow } from "../database/assignment-log";
import { toIata } from "../utils/airport-code";
import { airportTimezone } from "../utils/airport-tz";
import { isSwap } from "../utils/ics";
import type { ScopedReader } from "./context";
import { type VerdictWithWindow, watchVerdictFrom } from "./watch";

function changeOf(from: boolean | null, to: boolean): SwapStarlinkChange {
  if (from === null) return "unknown";
  if (from === to) return "same";
  return to ? "gained" : "lost";
}

export function planeSwapFor(
  reader: Pick<ScopedReader, "getTailStarlinkFlag">,
  verdict: VerdictWithWindow,
  history: readonly AssignmentLogRow[]
): PlaneSwap | null {
  if (history.length < 2) return null;
  const { verdict: seen, leg } = watchVerdictFrom(verdict, history);
  if (seen.state !== "yes" && seen.state !== "no") return null;
  const tail = seen.tail;
  if (!tail || !isSwap(history, seen, leg.dep)) return null;
  const legRows = leg.dep ? history.filter((h) => h.departure_airport === leg.dep) : history;
  const current = legRows.find((r) => r.tail_number === tail);
  if (!current) return null;
  // The tail last seen before this one took over: with three tails, the middle one.
  const previous = legRows
    .filter((r) => r.tail_number !== tail && r.first_seen <= current.first_seen)
    .sort((a, b) => b.last_seen - a.last_seen || b.first_seen - a.first_seen)[0];
  if (!previous) return null;
  const flag = reader.getTailStarlinkFlag(previous.tail_number, previous.airline);
  const fromStarlink = flag === null ? null : flag === 1;
  const toStarlink = seen.state === "yes";
  return {
    from: previous.tail_number,
    to: tail,
    seenAt: current.first_seen,
    zone: airportTimezone(toIata(current.departure_airport)) ?? null,
    toStarlink,
    fromStarlink,
    change: changeOf(fromStarlink, toStarlink),
  };
}
