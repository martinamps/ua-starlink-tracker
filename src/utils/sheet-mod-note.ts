/**
 * The mainline fleet sheet's hangar notes ("MIA Mod SL 11/2/26 ERS 12/17"):
 * station, "Mod", what is being fitted, the day it went in, and the sheet's
 * estimated return to service.
 *
 * The cells are typed by hand by people we don't know, so this reads one
 * grammar and nothing else. A cell that strays from it ("11/1626", a trailing
 * "RTS", a word we don't know) yields null: no label beats a guessed one.
 * Nothing of the cell's own text is kept, only a three-letter station, two
 * dates and a flag.
 */

import type { SheetModNote } from "../types";

/** What a mod can fit. Only SL (Starlink) makes a note; NEXT is the interior. */
const KNOWN_WORK = new Set(["NEXT", "SL", "STC"]);

const NOTE_RE =
  /^([A-Z]{3}) MOD ([A-Z]+\?*(?:\/[A-Z]+\?*)*) ?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}))?(?: ERS(?: (\d{1,2})\/(\d{1,2}))?)?$/;

const DAY_MS = 86_400_000;

/** A start further from today than this is a typo, not a hangar visit. */
const START_PAST_DAYS = 200;
const START_AHEAD_DAYS = 31;
/** The longest hangar visit the sheet's own return date may describe. */
const MAX_VISIT_DAYS = 200;
/** Past its return date a note still holds this long: the sheet trails the jet. */
export const MOD_GRACE_DAYS = 3;
/** A note with no return date holds this long from its start, then lapses. */
export const MOD_UNDATED_DAYS = 90;

function isoDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
    ? d.toISOString().slice(0, 10)
    : null;
}

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** The start as typed, or with the year the sheet left off: the one nearest today. */
function startDate(
  month: number,
  day: number,
  yy: string | undefined,
  today: string
): string | null {
  const thisYear = Number(today.slice(0, 4));
  const candidates = (yy ? [2000 + Number(yy)] : [thisYear - 1, thisYear, thisYear + 1])
    .map((y) => isoDate(y, month, day))
    .filter((d): d is string => d !== null)
    .sort(
      (a, b) =>
        Math.abs(dayNumber(a) - dayNumber(today)) - Math.abs(dayNumber(b) - dayNumber(today))
    );
  const start = candidates[0];
  if (!start) return null;
  const offset = dayNumber(start) - dayNumber(today);
  return offset >= -START_PAST_DAYS && offset <= START_AHEAD_DAYS ? start : null;
}

/** The sheet's month/day return, as the first such day on or after the start. */
function returnDate(month: number, day: number, start: string): string | null {
  const year = Number(start.slice(0, 4));
  for (const y of [year, year + 1]) {
    const d = isoDate(y, month, day);
    if (d && d >= start) return dayNumber(d) - dayNumber(start) <= MAX_VISIT_DAYS ? d : null;
  }
  return null;
}

export type ParsedModNote = Pick<SheetModNote, "station" | "started" | "due_back" | "unsure">;

/**
 * A Starlink hangar note, or null for anything else: another kind of mod, a
 * stored jet, an empty cell, or a cell this grammar doesn't cover.
 *
 * `unsure` is the sheet's own doubt, kept as doubt: "SL?" with its question
 * mark, or the 757's "STC", which is a Starlink fit only on the word of the
 * row's "To Rcv Starlink" cell.
 */
export function parseModNote(
  cell: { note: string | null | undefined; toReceiveStarlink?: string | null },
  today: string
): ParsedModNote | null {
  const text = (cell.note ?? "")
    .replace(/[\s ]+/g, " ")
    .trim()
    .toUpperCase();
  if (text.length === 0 || text.length > 60) return null;
  const m = NOTE_RE.exec(text);
  if (!m) return null;
  const [, station, work, sm, sd, syy, rm, rd] = m;

  const items = work.split("/");
  if (!items.every((w) => KNOWN_WORK.has(w.replace(/\?+$/, "")))) return null;
  const starlinkSure = items.includes("SL");
  const starlinkDoubted = items.some((w) => /^SL\?+$/.test(w));
  const certifying =
    items.some((w) => w.replace(/\?+$/, "") === "STC") &&
    /^yes$/i.test((cell.toReceiveStarlink ?? "").trim());
  if (!starlinkSure && !starlinkDoubted && !certifying) return null;

  const started = startDate(Number(sm), Number(sd), syy, today);
  if (!started) return null;
  // A return date that doesn't read as one drops the date, never the note.
  const due_back = rm ? returnDate(Number(rm), Number(rd), started) : null;
  return { station, started, due_back, unsure: !starlinkSure };
}

/** The last day a note speaks for its tail. */
export function modHoldsUntil(n: Pick<SheetModNote, "started" | "due_back">): string {
  return n.due_back ? addDays(n.due_back, MOD_GRACE_DAYS) : addDays(n.started, MOD_UNDATED_DAYS);
}

/** YYYY-MM-DD in UTC, the clock SQL's date('now') reads. */
export const utcToday = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** JS twin of sql/equipped.ts's modHoldSql. */
export function modNoteHolds(
  n: Pick<SheetModNote, "unsure" | "holds_until"> | null | undefined,
  today = utcToday()
): boolean {
  return !!n && !n.unsure && n.holds_until >= today;
}
