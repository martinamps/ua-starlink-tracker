/**
 * Starlink Watch: a one-event iCalendar feed per flight+date. Calendar apps
 * re-poll the subscription URL, so every refresh re-renders the event from
 * whatever the DB knows now — odds before assignment, the tail once assigned,
 * and "Swapped:" when the assignment log shows a second tail on the leg.
 *
 * Hand-rolled RFC 5545 (no dependency): CRLF line ends, TEXT escaping, and
 * folding at 75 octets without splitting a UTF-8 sequence.
 */

import type { SiteConfig } from "../airlines/registry";
import { capitalize, coldShare, flightShare, probLabel } from "../components/ui/format";
import type { AssignmentLogRow, SameDayAlternative } from "../database/assignment-log";
import { toIata } from "./airport-code";
import { airportTimezone } from "./airport-tz";

/**
 * Tenants whose check-flight answers come from upcoming_flights. Qatar's come
 * from qatar_schedule (no tails, no assignment log), and the hub has no
 * check-flight page to link the feed from.
 */
export function watchFeedEnabled(site: Pick<SiteConfig, "features" | "scope">): boolean {
  return site.features.checkFlightPage && site.scope !== "ALL" && site.scope !== "QR";
}

export type WatchVerdict =
  | { state: "prediction"; probability: number | null; observations: number }
  | {
      state: "yes";
      tail: string;
      aircraft: string | null;
      confidence: "verified" | "likely";
    }
  | { state: "no"; tail: string | null; aircraft: string | null; wifi: string | null }
  | { state: "none"; message: string | null };

/** Bounded tag for watch.feed_fetch. */
export type WatchFeedState =
  | "prediction"
  | "yes"
  | "no"
  | "swap"
  | "none"
  | "flown"
  | "flown_unknown";

export interface WatchIcsInput {
  canonicalHost: string;
  fn: string;
  /** Departure-airport local date, YYYY-MM-DD. */
  date: string;
  verdict: WatchVerdict;
  history: readonly AssignmentLogRow[];
  alternatives: readonly SameDayAlternative[];
  dep: string | null;
  arr: string | null;
  depUnix: number | null;
  arrUnix: number | null;
  now: number;
}

export const WATCH_REFRESH_NOTE =
  "Aircraft usually assigned ~2 days out; Google Calendar refreshes every 8–24h, Apple ~hourly.";

/** 'None' is the verifier's spelling of "no WiFi installed", never a provider name. */
function isNoWifi(wifi: string | null | undefined): boolean {
  return !wifi || !wifi.trim() || /^none$/i.test(wifi.trim());
}

export function describeNonStarlinkWifi(wifi: string | null | undefined): string {
  return isNoWifi(wifi) ? "no WiFi" : `${wifi?.trim()} WiFi`;
}

export function watchPermalink(canonicalHost: string, fn: string, date: string): string {
  return `https://${canonicalHost}/check-flight/${fn}/${date}?utm_source=cal`;
}

/** Tails seen on the leg, in first-seen order. */
function legTails(history: readonly AssignmentLogRow[], dep: string | null): string[] {
  const rows = dep ? history.filter((h) => h.departure_airport === dep) : history;
  const tails: string[] = [];
  for (const r of rows) if (!tails.includes(r.tail_number)) tails.push(r.tail_number);
  return tails;
}

function currentTail(verdict: WatchVerdict): string | null {
  return verdict.state === "yes" || verdict.state === "no" ? verdict.tail : null;
}

/**
 * A swap needs a second tail AND the current tail to differ from the first
 * one seen. A flight that merely dropped out of upcoming_flights is not a
 * swap: the log only covers tracked tails, so absence proves nothing.
 */
export function isSwap(
  history: readonly AssignmentLogRow[],
  verdict: WatchVerdict,
  dep: string | null
): boolean {
  const tails = legTails(history, dep);
  const tail = currentTail(verdict);
  return tails.length >= 2 && tail !== null && tail !== tails[0];
}

export function watchFeedState(
  history: readonly AssignmentLogRow[],
  verdict: WatchVerdict,
  dep: string | null
): WatchFeedState {
  return isSwap(history, verdict, dep) ? "swap" : verdict.state;
}

function aircraftSuffix(parts: (string | null)[]): string {
  const kept = parts.filter((p): p is string => !!p);
  return kept.length > 0 ? ` (${kept.join(", ")})` : "";
}

export function watchSummary(input: WatchIcsInput): string {
  const { fn, verdict, dep, arr, history } = input;
  let body: string;
  switch (verdict.state) {
    case "prediction":
      body =
        verdict.probability === null
          ? `${fn} · Starlink status pending`
          : `${fn} · ${probLabel(verdict.probability)} chance of Starlink`;
      break;
    case "yes": {
      const route = dep && arr ? ` ${toIata(dep)}→${toIata(arr)}` : "";
      const aircraft = verdict.aircraft ? ` (${verdict.aircraft})` : "";
      body = `${fn}${route} · Starlink ✅ ${verdict.tail}${aircraft}`;
      break;
    }
    case "no":
      body = `${fn} · No Starlink${aircraftSuffix([
        verdict.tail,
        isNoWifi(verdict.wifi) ? "no WiFi" : (verdict.wifi?.trim() ?? null),
      ])}`;
      break;
    case "none":
      body = `${fn} · Starlink status pending`;
      break;
  }
  return isSwap(history, verdict, dep) ? `Swapped: ${body}` : body;
}

// Date and time are formatted separately: ICU versions disagree on how to
// join them ("Sep 19 at 3:00 AM" vs "Sep 19, 3:00 AM"), and feeds must not
// change with the host's ICU.
function formatLocal(unixSec: number, airport: string | null): string {
  const timeZone = (airport && airportTimezone(toIata(airport))) || "UTC";
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(new Date(unixSec * 1000));
  return `${date}, ${formatLocalTime(unixSec, airport)}`;
}

function formatLocalTime(unixSec: number, airport: string | null): string {
  const timeZone = (airport && airportTimezone(toIata(airport))) || "UTC";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(unixSec * 1000));
}

export function watchDescription(input: WatchIcsInput): string[] {
  const { fn, verdict, history, alternatives, dep } = input;
  const lines: string[] = [];
  const legRows = dep ? history.filter((h) => h.departure_airport === dep) : history;
  // Rows for the date mean a tail was seen and has since moved off: the
  // current one is unknown, not unassigned.
  const pending =
    legRows.length > 0 ? "Current aircraft not confirmed." : "No aircraft assigned yet.";
  switch (verdict.state) {
    case "prediction":
      lines.push(
        verdict.probability === null
          ? pending
          : verdict.observations > 0
            ? `${pending} ${capitalize(flightShare(verdict.probability, fn, verdict.observations))}.`
            : `${pending} ${coldShare(verdict.probability, fn)}.`
      );
      break;
    case "yes":
      lines.push(
        `Aircraft: ${verdict.tail}${verdict.aircraft ? ` (${verdict.aircraft})` : ""} — Starlink ${verdict.confidence === "verified" ? "verified" : "listed, not yet verified"}.`
      );
      break;
    case "no":
      lines.push(
        `Aircraft: ${verdict.tail ?? "assigned"}${verdict.aircraft ? ` (${verdict.aircraft})` : ""} — ${describeNonStarlinkWifi(verdict.wifi)}, not Starlink.`
      );
      break;
    case "none":
      lines.push(verdict.message ?? pending);
      break;
  }

  if (legRows.length > 0) {
    lines.push("", "Assignment history:");
    for (const r of legRows) {
      lines.push(`${r.tail_number} first seen assigned ${formatLocal(r.first_seen, dep)}`);
    }
  }

  if (verdict.state === "no" && alternatives.length > 0) {
    lines.push("", "Starlink flights on this route that day:");
    for (const a of alternatives) {
      lines.push(
        `${a.flight_number} ${formatLocalTime(a.departure_time, dep)} (${a.tail_number}${a.aircraft_type ? `, ${a.aircraft_type}` : ""})`
      );
    }
  }

  lines.push("", WATCH_REFRESH_NOTE, watchPermalink(input.canonicalHost, input.fn, input.date));
  return lines;
}

function icsUtc(unixSec: number): string {
  return `${new Date(unixSec * 1000).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function icsDate(date: string): string {
  return date.replace(/-/g, "");
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const MAX_OCTETS = 75;

/** RFC 5545 §3.1: continuation lines start with one space, which counts. */
export function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= MAX_OCTETS) return line;
  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    if (currentBytes + b > MAX_OCTETS) {
      out.push(current);
      current = " ";
      currentBytes = 1;
    }
    current += ch;
    currentBytes += b;
  }
  out.push(current);
  return out.join("\r\n");
}

interface CalendarParts {
  canonicalHost: string;
  fn: string;
  date: string;
  /** RFC 5545 DURATION a client should wait between polls. */
  refresh: string;
  now: number;
  depUnix: number | null;
  arrUnix: number | null;
  lastModified: number;
  sequence: number;
  summary: string;
  description: string[];
  url: string;
}

function renderCalendar(c: CalendarParts): string {
  const timing =
    c.depUnix !== null
      ? [
          `DTSTART:${icsUtc(c.depUnix)}`,
          ...(c.arrUnix !== null && c.arrUnix > c.depUnix ? [`DTEND:${icsUtc(c.arrUnix)}`] : []),
        ]
      : [`DTSTART;VALUE=DATE:${icsDate(c.date)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(c.date))}`];

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//unitedstarlinktracker//watch//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(`Starlink Watch ${c.fn}`)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${c.refresh}`,
    `X-PUBLISHED-TTL:${c.refresh}`,
    "BEGIN:VEVENT",
    `UID:${c.fn}-${c.date}@${c.canonicalHost}`,
    `DTSTAMP:${icsUtc(c.now)}`,
    ...timing,
    `LAST-MODIFIED:${icsUtc(c.lastModified)}`,
    `SEQUENCE:${c.sequence}`,
    `SUMMARY:${escapeIcsText(c.summary)}`,
    `DESCRIPTION:${escapeIcsText(c.description.join("\n"))}`,
    `URL:${c.url}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export function buildWatchIcs(input: WatchIcsInput): string {
  const { canonicalHost, fn, date, history, depUnix, arrUnix, now } = input;
  return renderCalendar({
    canonicalHost,
    fn,
    date,
    refresh: "PT1H",
    now,
    depUnix,
    arrUnix,
    lastModified: history.reduce((m, h) => Math.max(m, h.first_seen), 0) || now,
    sequence: legTails(history, input.dep).length,
    summary: watchSummary(input),
    description: watchDescription(input),
    url: watchPermalink(canonicalHost, fn, date),
  });
}

// ─── A flight whose date has passed ──────────────────────────────────────────

export interface FlownWatchInput {
  canonicalHost: string;
  fn: string;
  date: string;
  /** Our stored assignment rows for the flight's local date; may be empty. */
  history: readonly AssignmentLogRow[];
  now: number;
}

/** Nothing about a flown flight changes, so apps are asked to poll weekly. */
const FLOWN_REFRESH = "P7D";

/**
 * A client keeps the higher SEQUENCE of an event it already holds. The live
 * feed counts tails, so the final version starts far above any count.
 */
const FLOWN_SEQUENCE_BASE = 1000;

/**
 * The record of a flown flight: on its first leg, the aircraft we last saw
 * assigned, with the Starlink flag stored beside it at the time; whether that
 * aircraft flew it is flownConfirmed's to say. Nothing here
 * reads today's fleet tables, so a later install never rewrites the past.
 */
export function flownRecord(history: readonly AssignmentLogRow[]): AssignmentLogRow | null {
  const first = [...history].sort(
    (a, b) =>
      (a.departure_time ?? Number.POSITIVE_INFINITY) -
      (b.departure_time ?? Number.POSITIVE_INFINITY)
  )[0];
  if (!first) return null;
  return history
    .filter((h) => h.departure_airport === first.departure_airport)
    .reduce((best, h) =>
      h.last_seen > best.last_seen ||
      (h.last_seen === best.last_seen && h.first_seen > best.first_seen)
        ? h
        : best
    );
}

export function flownFeedState(history: readonly AssignmentLogRow[]): WatchFeedState {
  return flownRecord(history) ? "flown" : "flown_unknown";
}

/**
 * The live feed names an aircraft only while its latest refresh still holds
 * the flight, and says "Current aircraft not confirmed" once the row stops
 * being refreshed: the log covers tracked tails only, so a swap onto an
 * untracked one shows as silence. last_seen is that last refresh, frozen. A
 * tail with a departure inside six hours is refreshed every 1 to 1.5 hours,
 * every four at worst after failures (needsFlightCheck), so one still on the
 * flight at departure was seen inside this window, and one last seen before it
 * had moved off or was never re-read. Either way the final calendar may not
 * say more than the live one did.
 */
const FLOWN_CONFIRMED_WITHIN_SEC = 6 * 3600;

/** Was the record still the flight's assignment when it left, by the live feed's rule. */
export function flownConfirmed(record: AssignmentLogRow): boolean {
  return (
    record.departure_time !== null &&
    record.last_seen >= record.departure_time - FLOWN_CONFIRMED_WITHIN_SEC
  );
}

export function flownSummary(fn: string, record: AssignmentLogRow | null): string {
  if (!record) return `Date passed: ${fn} · no aircraft record`;
  const { tail_number: tail, departure_airport: dep, arrival_airport: arr } = record;
  if (!flownConfirmed(record)) {
    return `Date passed: ${fn} · aircraft not confirmed (last seen assigned: ${tail})`;
  }
  if (record.starlink === 1) {
    const route = arr ? ` ${toIata(dep)}→${toIata(arr)}` : "";
    return `Flown: ${fn}${route} · Starlink ✅ ${tail}`;
  }
  return record.starlink === 0
    ? `Flown: ${fn} · No Starlink (${tail})`
    : `Flown: ${fn} · ${tail}, Starlink not recorded`;
}

/** "about 30 hours" / "about 3 days": how long before departure a row went quiet. */
function gapBeforeDeparture(record: AssignmentLogRow): string | null {
  if (record.departure_time === null) return null;
  const hours = Math.round((record.departure_time - record.last_seen) / 3600);
  if (hours < 48) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

export function flownDescription(input: FlownWatchInput): string[] {
  const { fn, history, canonicalHost } = input;
  const record = flownRecord(history);
  const lines: string[] = [];
  if (!record) {
    lines.push(
      "This flight's date has passed.",
      "We hold no record of the aircraft that flew it, so we can't say whether it had Starlink."
    );
  } else {
    const had =
      record.starlink === 1
        ? "it was listed with Starlink at the time"
        : record.starlink === 0
          ? "it was not a Starlink aircraft at the time"
          : "we stored no Starlink status for it";
    if (flownConfirmed(record)) {
      lines.push(
        "This flight's date has passed.",
        `Last aircraft we saw assigned: ${record.tail_number}; ${had}.`
      );
    } else {
      const gap = gapBeforeDeparture(record);
      lines.push(
        "This flight's date has passed.",
        "We could not confirm which aircraft flew it, so we can't say whether it had Starlink.",
        `Last aircraft we saw assigned: ${record.tail_number}${gap ? `, ${gap} before departure` : ""}; ${had}. Another aircraft may have flown the flight.`
      );
    }
    const legRows = history.filter((h) => h.departure_airport === record.departure_airport);
    lines.push("", "Assignment history:");
    for (const r of legRows) {
      lines.push(
        `${r.tail_number} first seen assigned ${formatLocal(r.first_seen, record.departure_airport)}`
      );
    }
  }
  lines.push(
    "",
    "This calendar is final and no longer changes; the subscription can be removed.",
    flownPermalink(canonicalHost, fn)
  );
  return lines;
}

/** The dated check page only says the date has passed; the undated one stays useful. */
function flownPermalink(canonicalHost: string, fn: string): string {
  return `https://${canonicalHost}/check-flight/${fn}?utm_source=cal`;
}

/**
 * The final calendar of a past flight: the same UID as the live feed, so a
 * calendar app updates the event it holds instead of adding a second one.
 */
export function buildFlownWatchIcs(input: FlownWatchInput): string {
  const { canonicalHost, fn, date, history, now } = input;
  const record = flownRecord(history);
  const legTailCount = record ? legTails(history, record.departure_airport).length : 0;
  return renderCalendar({
    canonicalHost,
    fn,
    date,
    refresh: FLOWN_REFRESH,
    now,
    depUnix: record?.departure_time ?? null,
    arrUnix: record?.arrival_time ?? null,
    // The moment the feed turned final (two UTC days after the date began):
    // stable across polls and later than any LAST-MODIFIED the live feed sent.
    lastModified: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) + 2 * 86400,
    sequence: FLOWN_SEQUENCE_BASE + legTailCount,
    summary: flownSummary(fn, record),
    description: flownDescription(input),
    url: flownPermalink(canonicalHost, fn),
  });
}
