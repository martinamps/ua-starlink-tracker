/**
 * Number, date and duration formatting for every page and client bundle.
 * Dates are pinned to UTC (or to a named airport zone): a formatter without a
 * timeZone renders in whatever zone the server runs in, which belongs to
 * neither the traveller nor the data. Dependency-free, so browser bundles
 * import it too.
 */

/** Thousands-separated integer or decimal, the one number format pages use. */
export function fmt(n: number, maximumFractionDigits = 0): string {
  return n.toLocaleString("en-US", { maximumFractionDigits });
}

/**
 * The one rule that turns a count into a percent, on every page, feed, JSON
 * field and tool answer: the whole number below the share, so no surface says
 * a share before it is reached. 100 only when every aircraft has it.
 * Multiplied before dividing: (29 / 100) * 100 is 28.999… in floating point.
 */
export function pctWhole(n: number, total: number): number {
  if (total <= 0 || n <= 0) return 0;
  if (n >= total) return 100;
  return Math.floor((n * 100) / total);
}

/** pctWhole as "35%" for people, with ">99%" and "<1%" at the edges where the
 * bare number would read as all or none. */
export function pct(n: number, total: number): string {
  const whole = pctWhole(n, total);
  if (whole === 99 && n * 100 > total * 99) return ">99%";
  if (whole === 0 && n > 0 && total > 0) return "<1%";
  return `${whole}%`;
}

/** pctWhole for a share that arrives as a ratio with no counts beside it (a
 * subfleet's share inside a flight answer, a rule-set band). The nudge undoes
 * the division: 29 / 100 * 100 is 28.999…, and no real share sits that close
 * under a whole number. */
export function shareWhole(p: number): number {
  if (!(p > 0)) return 0;
  if (p >= 1) return 100;
  return Math.floor(p * 100 + 1e-9);
}

/** pct() for a share given as a ratio: the same number and the same edges, so
 * a flight answered by its subfleet's share prints the fleet page's percent. */
export function shareLabel(p: number): string {
  if (p >= 1) return "100%";
  if (!(p > 0)) return "0%";
  const whole = shareWhole(p);
  if (whole >= 99 && p * 100 - 99 > 1e-9) return ">99%";
  if (whole === 0) return "<1%";
  return `${whole}%`;
}

const inWords = (label: string, exact: boolean) =>
  label.startsWith(">")
    ? `over ${label.slice(1)}`
    : label.startsWith("<")
      ? `under ${label.slice(1)}`
      : exact
        ? label
        : `about ${label}`;

/** shareLabel in words, for prose: "about 32%", "over 99%", "under 1%". */
export const sharePhrase = (p: number) => inWords(shareLabel(p), p >= 1 || !(p > 0));

/** shareLabel with the "~" flight answers lead with: "~32%". "<1%" and ">99%"
 * are bounds already and take none. */
export function approxShare(p: number): string {
  const label = shareLabel(p);
  return /^\d/.test(label) ? `~${label}` : label;
}

/** A flight's own number. With history behind it (tracked > 0) it is odds, to
 * the nearest percent; with none it is the share of the aircraft that fly such
 * flights, and a share rounds down like every fleet percent on the site. */
export const flightLabel = (p: number, tracked: number | null | undefined) =>
  tracked ? probLabel(p) : shareLabel(p);

/** flightLabel in words: "about 74%". */
export const flightPhrase = (p: number, tracked: number | null | undefined) =>
  tracked ? probPhrase(p) : sharePhrase(p);

/** A 0..1 probability as a whole percent, clamped. */
export const probPct = (p: number) => Math.round(Math.max(0, Math.min(1, p)) * 100);

/** A probability as "74%", with pct()'s edges: "100%" and "0%" only when
 * certain, ">99%" and "<1%" for everything short of that. */
export function probLabel(p: number): string {
  if (p >= 1) return "100%";
  if (p <= 0) return "0%";
  const n = p * 100;
  if (n > 99) return ">99%";
  if (n < 1) return "<1%";
  return `${Math.round(n)}%`;
}

/** probLabel in words, for prose: "about 74%", "over 99%", "under 1%". */
export const probPhrase = (p: number) => inWords(probLabel(p), !(p > 0 && p < 1));

/** A flight number's history odds, worded and rounded one way on the page,
 * the card, the APIs and the calendar feed: "about 12% Starlink odds, weighted
 * to recent UA1932 flights (49 tracked)". Odds, not a share: the estimate is
 * recency-weighted and smoothed, so "12% of 49 had it" would be a count it
 * isn't. Lowercase, no period, so callers can lead with it. */
export function flightShare(p: number, fn: string, n?: number): string {
  return `${probPhrase(p)} Starlink odds, weighted to recent ${fn} flights${n ? ` (${fmt(n)} tracked)` : ""}`;
}

/** The estimate for a flight number with no history, never called an install
 * rate: the express prior sits far below express penetration on purpose. */
export function coldShare(p: number, fn: string, group?: string): string {
  return `No history for ${fn} yet; ${sharePhrase(p)} is our estimate for new ${group ? `${group} ` : ""}flight numbers`;
}

/** A subfleet label for prose: "Mainline (737/787)" → "mainline 737/787",
 * "Hawaiian-operated (A330/A321neo)" → "Hawaiian-operated A330/A321neo". */
export const bandLabel = (label: string) =>
  label.replace(/\s*\((.*)\)$/, " $1").replace(/^(Mainline|Regional)\b/, (w) => w.toLowerCase());

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type ProbTier = "likely" | "maybe" | "unlikely";

/** The one likely / maybe / unlikely cut: 70% and 40%. */
export function probTier(p: number): ProbTier {
  const n = probPct(p);
  return n >= 70 ? "likely" : n >= 40 ? "maybe" : "unlikely";
}

// Built once per zone and shape: toLocale*String({timeZone}) constructs a
// formatter per call, which dominated SSR time on pages with thousands of dates.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    formatters.set(key, f);
  }
  return f;
}

/** Unix seconds, an ISO timestamp, or a bare YYYY-MM-DD (read as that UTC day). */
type DateInput = number | string;

function toDate(input: DateInput): Date | null {
  const d =
    typeof input === "number"
      ? new Date(input * 1000)
      : new Date(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T12:00:00Z` : input);
  return Number.isNaN(d.getTime()) ? null : d;
}

function utc(input: DateInput, options: Intl.DateTimeFormatOptions): string {
  const d = toDate(input);
  return d ? formatter("UTC", options).format(d) : String(input);
}

/** "September 20, 2026"; undefined when the input doesn't parse. */
export function longDate(input: DateInput | null | undefined): string | undefined {
  if (input === null || input === undefined || input === "") return undefined;
  const d = toDate(input);
  return d
    ? formatter("UTC", { month: "long", day: "numeric", year: "numeric" }).format(d)
    : undefined;
}

/** "Sep 21, 2026". */
export const shortDate = (input: DateInput) =>
  utc(input, { month: "short", day: "numeric", year: "numeric" });

/** "Thursday, Nov 26" for a bare date: a day named in a sentence. */
export const weekdayDate = (input: DateInput) =>
  utc(input, { weekday: "long", month: "short", day: "numeric" });

/** "Sep 21"; with `nowSec`, the year is added when it isn't the current one. */
export function monthDay(input: DateInput, nowSec?: number): string {
  const d = toDate(input);
  if (!d) return String(input);
  const otherYear =
    nowSec !== undefined && d.getUTCFullYear() !== new Date(nowSec * 1000).getUTCFullYear();
  return formatter("UTC", {
    month: "short",
    day: "numeric",
    ...(otherYear ? { year: "numeric" } : {}),
  }).format(d);
}

/** "Saturday" for a YYYY-MM-DD calendar day. */
export function weekdayName(input: DateInput): string {
  const d = toDate(input);
  if (!d) return String(input);
  return formatter("UTC", { weekday: "long" }).format(d);
}

/** "seen on 1 day only" / "seen on 2 days only": a time short of usual, in the planner's words. */
export function seenOnDays(days: number | undefined): string {
  const n = days ?? 0;
  return `seen on ${fmt(n)} day${n === 1 ? "" : "s"} only`;
}

const SHORT_DATE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:, (\d{4}))?\b/g;

/**
 * The text with each "Oct 26" or "Oct 26, 2026" held together by no-break
 * spaces, so a narrow line never ends inside a date. For text about to be
 * drawn on a page; an API's or a description's sentence keeps plain spaces.
 */
export const wholeDates = (text: string): string =>
  text.replace(
    SHORT_DATE,
    (_, month: string, day: string, year?: string) =>
      `${month}\u00a0${day}${year ? `,\u00a0${year}` : ""}`
  );

/**
 * The text cut at each short date, words and spaces unchanged, so a page can
 * hold a date on one line by wrapping it where no-break spaces would change
 * the text a reader copies or a test reads.
 */
export function dateRuns(text: string): Array<{ text: string; date: boolean }> {
  const runs: Array<{ text: string; date: boolean }> = [];
  let from = 0;
  for (const m of text.matchAll(SHORT_DATE)) {
    if (m.index > from) runs.push({ text: text.slice(from, m.index), date: false });
    runs.push({ text: m[0], date: true });
    from = m.index + m[0].length;
  }
  if (from < text.length) runs.push({ text: text.slice(from), date: false });
  return runs;
}

/** "Sep 2026" for a YYYY-MM month key. */
export const monthYear = (month: string) => utc(`${month}-01`, { month: "short", year: "numeric" });

/** "MON 14:30", always UTC: the homepage pill clock, 24-hour like the
 * permalink page. The caller names the zone. */
export function formatPillTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const day = formatter("UTC", { weekday: "short" }).format(d).toUpperCase();
  const hhmm = formatter("UTC", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day} ${hhmm}`;
}

/**
 * Wall-clock time in an airport's zone: "Sep 21", "Sun, Sep 21", "7:05 AM PDT"
 * and all of it together. Absolute, never "in 7h": pages are cached and a
 * relative time goes stale with them. A null zone renders UTC, labelled.
 */
export function zonedDeparture(
  sec: number,
  zone: string | null | undefined
): { date: string; day: string; time: string; full: string } {
  const tz = zone ?? "UTC";
  const d = new Date(sec * 1000);
  const day = formatter(tz, { weekday: "short", month: "short", day: "numeric" }).format(d);
  const time = formatter(tz, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(
    d
  );
  return {
    date: formatter(tz, { month: "short", day: "numeric" }).format(d),
    day,
    time,
    // Joined here, not by Intl: ICU versions differ on "at" vs ",".
    full: `${day}, ${time}`,
  };
}

/** "Thursday, November 26, 2026" at `zone`: a departure's date in a sentence
 * that has to stay true when quoted without the page around it. */
export function zonedLongDate(sec: number, zone: string): string {
  return formatter(zone, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(sec * 1000));
}

/** "Nov 26, 2026" at `zone`: the same day as zonedLongDate, for copy with a
 * length budget (a search description). */
export function zonedShortDate(sec: number, zone: string): string {
  return formatter(zone, { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(sec * 1000)
  );
}

/** "8:15 AM" at `zone`, no zone name: for lists whose header names the zone
 * once, so a row never carries a daylight label from the wrong season. */
export function zonedClock(sec: number, zone: string | null | undefined): string {
  return formatter(zone ?? "UTC", { hour: "numeric", minute: "2-digit" }).format(
    new Date(sec * 1000)
  );
}

/** Minutes after local midnight at `zone`, for ordering by time of day. */
export function zonedMinutes(sec: number, zone: string | null | undefined): number {
  const parts = formatter(zone ?? "UTC", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(sec * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/** "Mon" at `zone`. */
export function zonedWeekday(sec: number, zone: string | null | undefined): string {
  return formatter(zone ?? "UTC", { weekday: "short" }).format(new Date(sec * 1000));
}

/** YYYY-MM-DD at `zone` for an epoch: the calendar day a traveller there is on. */
export function zonedIsoDate(sec: number, zone: string): string {
  const parts = formatter(zone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(sec * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "Sep 21, 2026, 14:05 UTC": a data timestamp, never request time. */
export const utcDateTime = (input: DateInput) =>
  `${utc(input, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} UTC`;

/** "Sep 21, 14:05 UTC": utcDateTime without the year, for a sentence whose
 * next date carries it. */
export const utcDayTime = (input: DateInput) =>
  `${utc(input, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} UTC`;

/** "2h 5m", "45m", "3h"; null for a missing or non-positive duration. Minutes
 * are rounded before splitting, so 2h59m30s reads "3h", never "2h 60m". */
export function formatDuration(sec: number | null | undefined): string | null {
  if (!sec || sec <= 0) return null;
  const mins = Math.round(sec / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "today", "yesterday", "5 days ago". */
export function ageLabel(checkedAtSec: number, nowSec: number): string {
  const days = Math.floor((nowSec - checkedAtSec) / 86400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
