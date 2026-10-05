/**
 * Wording and tones for the "every flight on this route" board, shared by the
 * server-rendered route page and the planner's browser bundle so the two
 * never phrase a row differently. No JSX: browser bundles import it.
 */
import type { RouteFlightBoard, RouteFlightRow } from "../api/route-flights";
import { fmt, probTier } from "./ui/format";
import { PROB_TIER_TONE, type Tone } from "./ui/tone-classes";

export function oddsTone(row: RouteFlightRow): Tone {
  return row.enough_history && row.probability !== null
    ? PROB_TIER_TONE[probTier(row.probability)]
    : "neutral";
}

/** The line under the percentage: what the number rests on. */
export function oddsDetail(row: RouteFlightRow): string {
  if (row.basis === "aircraft_type") return "by aircraft type";
  const n = row.n_observations ?? 0;
  const flights = `${fmt(n)} flight${n === 1 ? "" : "s"}`;
  return row.enough_history ? `from ${flights}` : `only ${flights}`;
}

export function assignmentTone(row: RouteFlightRow): Tone {
  return row.assignment && row.assignment.starlink !== "none" ? "success" : "neutral";
}

export const ASSIGNMENT_CAVEAT = "can still be swapped";

/** The board's empty state, or null when it has rows. */
export function emptyBoardMessage(board: RouteFlightBoard): string | null {
  if (board.flights.length > 0) return null;
  const pair = `${board.origin} to ${board.destination}`;
  if (!board.nonstop) {
    return `No ${board.airline} nonstop from ${pair} has been seen in the past week. Connections can still have Starlink.`;
  }
  return `None of the ${pair} nonstops we track was seen flying on a ${board.weekday ?? "that day"}.`;
}

export function boardDek(board: RouteFlightBoard): string {
  const day = board.date && board.weekday ? ` Showing flights seen on ${board.weekday}s.` : "";
  return `Every nonstop seen recently, best Starlink odds first. Times are local to ${board.origin}.${day}`;
}
