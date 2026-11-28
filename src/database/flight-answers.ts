/**
 * When each flight page's answer to a traveller last changed, for its
 * sitemap <lastmod>.
 *
 * No other table records this: flight_assignment_log gains a row for every
 * departure and tail, so its newest first_seen moves for nearly every flight
 * every day whether or not the page now says anything different, and a date
 * that always says "today" is one a crawler learns to ignore. A watcher
 * (createApp's recordFlightAnswers) builds each page's answer key with the
 * page's own reads and stores it here; changed_at moves only when the key
 * differs from the one stored.
 *
 * A flight seen for the first time has no known change: changed_at stays
 * NULL, and the sitemap falls back to an older true date or none, never the
 * time we happened to look.
 */
import type { Database } from "bun:sqlite";
import type { AirlineCode } from "../airlines/registry";

export const FLIGHT_ANSWERS_DDL = `
  CREATE TABLE IF NOT EXISTS flight_page_answers (
    airline TEXT NOT NULL,
    flight_number TEXT NOT NULL,
    answer TEXT NOT NULL,
    changed_at INTEGER,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (airline, flight_number)
  );
`;

/**
 * Stores each flight's current answer key; returns how many keys differed
 * from the stored one (a first sighting is not a change), and the flights
 * whose answer itself turned by `turnOf` (answerTurn: null for no turn,
 * lower for more telling), most telling first: what IndexNow may be told. One transaction, so a run cut short leaves either all of a
 * batch or none of it.
 */
export function recordFlightAnswers(
  db: Database,
  airline: AirlineCode,
  answers: Array<{ flight_number: string; answer: string }>,
  nowSec: number,
  turnOf: (before: string, after: string) => number | null = () => null
): { seen: number; changed: number; turned: string[] } {
  const stored = new Map(
    (
      db
        .query("SELECT flight_number, answer FROM flight_page_answers WHERE airline = ?")
        .all(airline) as Array<{ flight_number: string; answer: string }>
    ).map((r) => [r.flight_number, r.answer])
  );
  const insert = db.query(
    `INSERT INTO flight_page_answers (airline, flight_number, answer, changed_at, seen_at)
     VALUES (?, ?, ?, NULL, ?)`
  );
  const changed = db.query(
    `UPDATE flight_page_answers SET answer = ?, changed_at = ?, seen_at = ?
     WHERE airline = ? AND flight_number = ?`
  );
  const same = db.query(
    "UPDATE flight_page_answers SET seen_at = ? WHERE airline = ? AND flight_number = ?"
  );
  let n = 0;
  const turns: Array<{ flight_number: string; turn: number }> = [];
  db.transaction(() => {
    for (const { flight_number, answer } of answers) {
      const before = stored.get(flight_number);
      if (before === undefined) insert.run(airline, flight_number, answer, nowSec);
      else if (before !== answer) {
        changed.run(answer, nowSec, nowSec, airline, flight_number);
        n++;
        const turn = turnOf(before, answer);
        if (turn !== null) turns.push({ flight_number, turn });
      } else same.run(nowSec, airline, flight_number);
    }
  })();
  // Within a rank, an order that changes every hour: a fixed one (by flight
  // number) would put the same flights first under every capped send.
  const hour = Math.floor(nowSec / 3600);
  const spin = (fn: string) => {
    let h = 2166136261 ^ hour;
    for (let i = 0; i < fn.length; i++) h = Math.imul(h ^ fn.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  turns.sort((a, b) => a.turn - b.turn || spin(a.flight_number) - spin(b.flight_number));
  return { seen: answers.length, changed: n, turned: turns.map((t) => t.flight_number) };
}

/** Last recorded answer change per flight number (unix sec); flights with
 * none recorded are absent. */
export function flightAnswerChanges(db: Database, airline: AirlineCode): Map<string, number> {
  const rows = db
    .query(
      `SELECT flight_number, changed_at FROM flight_page_answers
       WHERE airline = ? AND changed_at IS NOT NULL`
    )
    .all(airline) as Array<{ flight_number: string; changed_at: number }>;
  return new Map(rows.map((r) => [r.flight_number, r.changed_at]));
}
