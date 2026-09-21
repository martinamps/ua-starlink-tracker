/**
 * Time windows the readers share. Every function takes `now` (unix seconds) so
 * a snapshot read or a test pins the clock; nothing here calls Date.now()
 * except unixNow's default.
 */

export const DAY_SEC = 86400;

export function unixNow(ms = Date.now()): number {
  return Math.floor(ms / 1000);
}

/** Forward schedule the "next 48 hours" surfaces count over. */
export const DEPARTURE_WINDOW_HOURS = 48;
export const DEPARTURE_WINDOW_SEC = DEPARTURE_WINDOW_HOURS * 3600;

/** departure_log keeps this much history; recent-install surfaces count over the same span. */
export const TRAILING_WINDOW_DAYS = 30;
export const TRAILING_WINDOW_SEC = TRAILING_WINDOW_DAYS * DAY_SEC;

/** `YYYY-MM-DD` (UTC) `days` before `now` — the SQL date('now', '-N day') twin with an injected clock. */
export function isoDateDaysAgo(days: number, now = unixNow()): string {
  return new Date((now - days * DAY_SEC) * 1000).toISOString().slice(0, 10);
}

/** FR24 publishes assignments about two days out and keeps them about a day
 * after departure; outside these bounds a tail lookup cannot answer. */
const LOOKUP_PAST_SEC = DAY_SEC;
const LOOKUP_AHEAD_SEC = 3 * DAY_SEC;

/** Where a flight day's [start, end) window sits against the FR24 lookup span. */
export function lookupWindowPosition(
  start: number,
  end: number,
  now = unixNow()
): "past" | "inside" | "future" {
  if (end <= now - LOOKUP_PAST_SEC) return "past";
  if (start >= now + LOOKUP_AHEAD_SEC) return "future";
  return "inside";
}

export function inLookupWindow(start: number, end: number, now = unixNow()): boolean {
  return lookupWindowPosition(start, end, now) === "inside";
}
