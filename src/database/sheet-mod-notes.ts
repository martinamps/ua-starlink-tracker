/**
 * The mainline sheet's Starlink hangar notes, stored per tail, and the
 * sub-fleet install order as a check-order hint.
 *
 * Neither counts a tail. A note that holds keeps an unobserved listing out of
 * the count (sql/equipped.ts, evidence 4); install order only moves a tail up
 * the verifier's existing queue.
 */

import type { Database } from "bun:sqlite";
import type { SheetModNote } from "../types";
import { type ParsedModNote, modHoldsUntil, modNoteHolds, utcToday } from "../utils/sheet-mod-note";
import { type SheetOrderRow, subfleetOrderScores } from "../utils/subfleet-order";
import { tailEquippedSql } from "./sql/equipped";
import { unixNow } from "./sql/windows";

export type TailModNote = ParsedModNote & { tail: string };

/** Replace an airline's notes with this read's: a jet the sheet no longer
 * marks loses its note the same hour. Runs inside the roster replace. */
export function replaceSheetModNotes(
  db: Database,
  airline: string,
  notes: TailModNote[],
  nowSec = unixNow()
): void {
  db.query("DELETE FROM sheet_mod_notes WHERE airline = ?").run(airline);
  const insert = db.query(
    `INSERT OR IGNORE INTO sheet_mod_notes
       (airline, tail_number, station, started, due_back, unsure, holds_until, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const n of notes) {
    insert.run(
      airline,
      n.tail,
      n.station,
      n.started,
      n.due_back,
      n.unsure ? 1 : 0,
      modHoldsUntil(n),
      nowSec
    );
  }
}

/** Notes that still speak for their tail on `today` (UTC, YYYY-MM-DD). */
export function getSheetModNotes(
  db: Database,
  airline: string,
  today = utcToday()
): SheetModNote[] {
  return (
    db
      .query(
        `SELECT airline, tail_number AS tail, station, started, due_back, unsure, holds_until, read_at
         FROM sheet_mod_notes WHERE airline = ? AND holds_until >= ? ORDER BY tail_number`
      )
      .all(airline, today) as Array<Omit<SheetModNote, "unsure"> & { unsure: number }>
  ).map((r) => ({ ...r, unsure: r.unsure === 1 }));
}

export function getSheetModNote(
  db: Database,
  airline: string,
  tail: string,
  today = utcToday()
): SheetModNote | null {
  return getSheetModNotes(db, airline, today).find((n) => n.tail === tail) ?? null;
}

/** Above every priority calculateDiscoveryPriority can return (max 1.0), so a
 * hinted tail leads its own status group and nothing else moves. */
const ORDER_PRIORITY_BASE = 1;

/**
 * Move sheet-listed tails we don't count up the verifier's queue when their
 * neighbours in the sub-fleet's numbering already have Starlink.
 *
 * It writes discovery_priority only. next_check_after is untouched, so no
 * tail becomes due sooner and the queue drains at the rate it always did; the
 * hint only decides which due tail goes first. Other writers reset the column
 * to its base value, so this runs after every sheet read.
 */
export function applySubfleetOrder(db: Database, airline: string, rows: SheetOrderRow[]): number {
  const counted = new Set(
    (
      db
        .query(
          `SELECT tail_number FROM united_fleet uf
           WHERE uf.airline = ? AND ${tailEquippedSql("uf.tail_number", "uf.airline")}`
        )
        .all(airline) as Array<{ tail_number: string }>
    ).map((r) => r.tail_number)
  );
  // A jet in the hangar can't be read on a flight: the note outranks order.
  const inHangar = new Set(
    getSheetModNotes(db, airline)
      .filter((n) => modNoteHolds(n))
      .map((n) => n.tail)
  );
  const scores = subfleetOrderScores(rows, counted, inHangar);
  db.transaction(() => {
    db.query(
      "UPDATE united_fleet SET discovery_priority = ? WHERE airline = ? AND discovery_priority > ?"
    ).run(ORDER_PRIORITY_BASE, airline, ORDER_PRIORITY_BASE);
    const raise = db.query(
      "UPDATE united_fleet SET discovery_priority = ? WHERE tail_number = ? AND airline = ?"
    );
    for (const [tail, score] of scores) raise.run(ORDER_PRIORITY_BASE + score, tail, airline);
  })();
  return scores.size;
}
