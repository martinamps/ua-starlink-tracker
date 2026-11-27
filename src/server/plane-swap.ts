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

/** Distinct departure airports the day's flight flies: one per leg. */
function legsFlown(
  history: readonly AssignmentLogRow[],
  listedDeps: readonly (string | null | undefined)[]
): number {
  const deps = new Set<string>();
  for (const dep of [...history.map((h) => h.departure_airport), ...listedDeps]) {
    if (dep) deps.add(toIata(dep));
  }
  return deps.size;
}

function legOf(row: AssignmentLogRow): { dep: string; arr: string | null } {
  return {
    dep: toIata(row.departure_airport),
    arr: row.arrival_airport ? toIata(row.arrival_airport) : null,
  };
}

export function planeSwapFor(
  reader: Pick<ScopedReader, "getTailStarlinkFlag">,
  verdict: VerdictWithWindow,
  history: readonly AssignmentLogRow[],
  /** Departure airports the answer lists for the day, beside the log's. */
  listedDeps: readonly (string | null | undefined)[] = []
): PlaneSwap | null {
  if (history.length < 2) return null;
  const { verdict: seen, leg } = watchVerdictFrom(verdict, history);
  if (seen.state !== "yes" && seen.state !== "no") return null;
  const tail = seen.tail;
  if (!tail || !isSwap(history, seen, leg.dep)) return null;
  const legRows = leg.dep ? history.filter((h) => h.departure_airport === leg.dep) : history;
  const current = legRows.find((r) => r.tail_number === tail);
  if (!current) return null;
  // The first tail logged, as the feed's isSwap reads it: the plane a traveller
  // who checked earliest saw, and the one the Starlink change is measured from.
  const ordered = [...legRows].sort(
    (a, b) => a.first_seen - b.first_seen || a.tail_number.localeCompare(b.tail_number)
  );
  const first = ordered[0];
  if (!first || first.tail_number === tail) return null;
  const between = [
    ...new Set(
      ordered
        .filter(
          (r) =>
            r.tail_number !== first.tail_number &&
            r.tail_number !== tail &&
            r.first_seen <= current.first_seen
        )
        .map((r) => r.tail_number)
    ),
  ];
  const flag = reader.getTailStarlinkFlag(first.tail_number, first.airline);
  const fromStarlink = flag === null ? null : flag === 1;
  const toStarlink = seen.state === "yes";
  return {
    from: first.tail_number,
    between,
    to: tail,
    seenAt: current.first_seen,
    zone: airportTimezone(toIata(current.departure_airport)) ?? null,
    toStarlink,
    fromStarlink,
    change: changeOf(fromStarlink, toStarlink),
    leg: legsFlown(history, listedDeps) > 1 ? legOf(current) : null,
  };
}
