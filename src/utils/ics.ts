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
import type { AssignmentLogRow, SameDayAlternative } from "../database/assignment-log";
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
export type WatchFeedState = "prediction" | "yes" | "no" | "swap" | "none";

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

function stripIcaoK(code: string): string {
  return code.length === 4 && code.startsWith("K") ? code.slice(1) : code;
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
          : `${fn} · Starlink odds ~${Math.round(verdict.probability * 100)}%`;
      break;
    case "yes": {
      const route = dep && arr ? ` ${stripIcaoK(dep)}→${stripIcaoK(arr)}` : "";
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

function formatLocal(unixSec: number, airport: string | null): string {
  const timeZone = (airport && airportTimezone(stripIcaoK(airport))) || "UTC";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(unixSec * 1000));
}

function formatLocalTime(unixSec: number, airport: string | null): string {
  const timeZone = (airport && airportTimezone(stripIcaoK(airport))) || "UTC";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(unixSec * 1000));
}

export function watchDescription(input: WatchIcsInput): string[] {
  const { verdict, history, alternatives, dep } = input;
  const lines: string[] = [];
  switch (verdict.state) {
    case "prediction":
      lines.push(
        verdict.probability === null
          ? "No aircraft assigned yet."
          : verdict.observations > 0
            ? `No aircraft assigned yet. ~${Math.round(verdict.probability * 100)}% of ${verdict.observations} recent departures of this flight used a Starlink aircraft.`
            : `No aircraft assigned yet. ~${Math.round(verdict.probability * 100)}% is the fleet-wide Starlink install rate.`
      );
      break;
    case "yes":
      lines.push(
        `Aircraft: ${verdict.tail}${verdict.aircraft ? ` (${verdict.aircraft})` : ""} — Starlink ${verdict.confidence === "verified" ? "verified" : "likely (listed as installed, not yet verified onboard)"}.`
      );
      break;
    case "no":
      lines.push(
        `Aircraft: ${verdict.tail ?? "assigned"}${verdict.aircraft ? ` (${verdict.aircraft})` : ""} — ${describeNonStarlinkWifi(verdict.wifi)}, not Starlink.`
      );
      break;
    case "none":
      lines.push(verdict.message ?? "No aircraft assigned yet.");
      break;
  }

  const legRows = dep ? history.filter((h) => h.departure_airport === dep) : history;
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

export function buildWatchIcs(input: WatchIcsInput): string {
  const { canonicalHost, fn, date, history, depUnix, arrUnix, now } = input;
  const tails = legTails(history, input.dep);
  const lastModified = history.reduce((m, h) => Math.max(m, h.first_seen), 0) || now;
  const url = watchPermalink(canonicalHost, fn, date);

  const timing =
    depUnix !== null
      ? [
          `DTSTART:${icsUtc(depUnix)}`,
          ...(arrUnix !== null && arrUnix > depUnix ? [`DTEND:${icsUtc(arrUnix)}`] : []),
        ]
      : [`DTSTART;VALUE=DATE:${icsDate(date)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(date))}`];

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//unitedstarlinktracker//watch//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(`Starlink Watch ${fn}`)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    "BEGIN:VEVENT",
    `UID:${fn}-${date}@${canonicalHost}`,
    `DTSTAMP:${icsUtc(now)}`,
    ...timing,
    `LAST-MODIFIED:${icsUtc(lastModified)}`,
    `SEQUENCE:${tails.length}`,
    `SUMMARY:${escapeIcsText(watchSummary(input))}`,
    `DESCRIPTION:${escapeIcsText(watchDescription(input).join("\n"))}`,
    `URL:${url}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}
