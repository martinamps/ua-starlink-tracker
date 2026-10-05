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

/** Share as "35%", floored so no page claims more than the data: "100%" only
 * when every aircraft has it, ">99%" and "<1%" at the edges. */
export function pct(n: number, total: number): string {
  if (total <= 0) return "0%";
  if (n >= total) return "100%";
  const p = (n / total) * 100;
  if (p > 99) return ">99%";
  if (p > 0 && p < 1) return "<1%";
  return `${Math.floor(p)}%`;
}

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
export function probPhrase(p: number): string {
  const label = probLabel(p);
  if (label.startsWith(">")) return `over ${label.slice(1)}`;
  if (label.startsWith("<")) return `under ${label.slice(1)}`;
  return p > 0 && p < 1 ? `about ${label}` : label;
}

/** A flight number's history share, worded and rounded one way on the page,
 * the card, the APIs and the calendar feed: "about 12% of 49 recent UA1932
 * flights had Starlink". Lowercase, no period, so callers can lead with it. */
export function flightShare(p: number, fn: string, n?: number): string {
  return `${probPhrase(p)} of ${n ? `${fmt(n)} ` : ""}recent ${fn} flights had Starlink`;
}

/** The estimate for a flight number with no history, never called an install
 * rate: the express prior sits far below express penetration on purpose. */
export function coldShare(p: number, fn: string, group?: string): string {
  return `No history for ${fn} yet; ${probPhrase(p)} is our estimate for new ${group ? `${group} ` : ""}flight numbers`;
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

/** "Sep 2026" for a YYYY-MM month key. */
export const monthYear = (month: string) => utc(`${month}-01`, { month: "short", year: "numeric" });

/** "MON 14:30 UTC": the homepage pill clock, 24-hour like the permalink page. */
export function formatPillTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const day = formatter("UTC", { weekday: "short" }).format(d).toUpperCase();
  const hhmm = formatter("UTC", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day} ${hhmm} UTC`;
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
