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
  if (row.basis === "aircraft_type") return "by type";
  const n = row.n_observations ?? 0;
  return `${fmt(n)} flight${n === 1 ? "" : "s"}`;
}

export function assignmentTone(row: RouteFlightRow): Tone {
  return row.assignment && row.assignment.starlink !== "none" ? "success" : "neutral";
}

/** One mark on a verified assignment, explained once in the legend. */
export const VERIFIED_MARK = "✓";
export const VERIFIED_LEGEND = `${VERIFIED_MARK} Starlink confirmed on that plane.`;

export function hasVerifiedRow(board: RouteFlightBoard): boolean {
  return board.flights.some((f) => f.assignment?.starlink === "verified");
}

/** The board's empty state, or null when it has rows. */
export function emptyBoardMessage(board: RouteFlightBoard): string | null {
  if (board.flights.length > 0) return null;
  if (!board.nonstop) return "No nonstop seen this week.";
  return `No nonstop seen on a ${board.weekday ?? "that day"}.`;
}

export function boardDek(board: RouteFlightBoard): string {
  const day = board.date && board.weekday ? ` ${board.weekday}s only.` : "";
  return `Best odds first. Times local to ${board.origin}.${day}`;
}
