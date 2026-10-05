/**
 * Wording and tones for the "every flight on this route" board, shared by the
 * server-rendered route page and the planner's browser bundle so the two
 * never phrase a row differently. No JSX: browser bundles import it.
 */
import type { RouteFlightBoard, RouteFlightRow } from "../api/route-flights";
import { fmt, probTier } from "./ui/format";
import { PROB_TIER_TONE, type Tone } from "./ui/tone-classes";

const WEEKDAY_NAME: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

/** The big cell: the assigned plane's answer, else the forecast. */
export function oddsCell(row: RouteFlightRow): string {
  const a = row.assignment;
  if (a) return a.starlink === "none" ? "No Starlink" : "Starlink";
  return row.odds_label;
}

export function oddsTone(row: RouteFlightRow): Tone {
  const a = row.assignment;
  if (a) return a.starlink === "none" ? "neutral" : "success";
  return row.enough_history && row.probability !== null
    ? PROB_TIER_TONE[probTier(row.probability)]
    : "neutral";
}

/** "53 flights, weighted to recent": the plain count, and that it isn't an even average. */
export function recentFlights(r: Pick<RouteFlightRow, "n_observations">): string {
  const n = r.n_observations ?? 0;
  return `${fmt(n)} flight${n === 1 ? "" : "s"}, weighted to recent`;
}

/** What the forecast rests on, under the big cell. */
export function oddsBasis(row: RouteFlightRow): string {
  return row.basis === "aircraft_type" ? "by type" : recentFlights(row);
}

/** A row's one marker, when it has one. */
export function rowMarker(row: RouteFlightRow, board: RouteFlightBoard): string | null {
  if (!row.established) return "seen once";
  if (row.operates_on_date === false && board.weekday) return `not seen ${board.weekday}`;
  return null;
}

/** One mark on a verified assignment, explained once in the legend. */
export const VERIFIED_MARK = "✓";
export const VERIFIED_LEGEND = `${VERIFIED_MARK} Starlink confirmed on that plane.`;

export function assignmentPill(row: RouteFlightRow): string | null {
  const a = row.assignment;
  if (!a) return null;
  return a.starlink === "verified" ? `${a.label} ${VERIFIED_MARK}` : a.label;
}

export function hasVerifiedRow(board: RouteFlightBoard): boolean {
  return board.flights.some((f) => f.assignment?.starlink === "verified");
}

/** The board's empty state, or null when it has rows. */
export function emptyBoardMessage(board: RouteFlightBoard): string | null {
  return board.flights.length > 0 ? null : "No nonstop seen this week.";
}

export function boardDek(board: RouteFlightBoard): string {
  const n = board.flights.length;
  const head = `${fmt(n)} ${board.airline} nonstop${n === 1 ? "" : "s"} seen on this route in the past week, best Starlink odds first. Times local to ${board.origin}.`;
  const day = board.weekday ? WEEKDAY_NAME[board.weekday] : null;
  return day ? `${head} Flights not seen on a ${day} are listed last.` : head;
}
