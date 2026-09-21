/**
 * Qatar Airways flight verdicts, in three tiers:
 *
 *  1. Inside Qatar's published window (DOH today-1..+6), the scheduled
 *     equipment code of live rows, classified at read time. A fitted type is a
 *     yes on the "installed" rung, never "verified": the code names a type, not
 *     an airframe, and Qatar can swap it.
 *  2. Beyond the window (or a date not fetched yet), a conservative
 *     probability: the Wilson 90% lower bound of the share of recent operating
 *     days this flight number flew a fully fitted type, season-aware.
 *  3. Otherwise an explicit no-data answer — never a guessed no.
 *
 * Everything is served from the DB (qatar_schedule, qatar_equipment_history,
 * qatar_fetch_coverage) that the hourly ingester writes.
 */

import { zeroPaddedVariants } from "../airlines/flight-number";
import { qatarEquipment } from "../airlines/registry";
import type { QatarHistoryRow, QatarScheduleRow } from "../database/database";
import type { ScopedReader } from "../database/reader";
import {
  COUNTERS,
  metrics,
  normalizeAirlineTag,
  normalizeEquipmentCodeTag,
} from "../observability";
import {
  type FlightDateWindow,
  iataSeasonIndex,
  iataSeasonKey,
  iataSeasonStart,
  localDayEndSec,
  matchesLocalDate,
} from "../utils/airport-tz";
import { warn } from "../utils/logger";
import {
  QATAR_PUBLISHED_DAYS_FORWARD,
  type QatarClass,
  dohDateISO,
  qatarDaysOut,
  qatarEquipmentClass,
  qatarEquipmentName,
} from "./qatar-status";

export const QATAR_HISTORY_WINDOW_DAYS = 28;
// Swap-risk and season subsets need this many operating days to mean anything.
const MIN_SUBSET_DAYS = 7;
const MIN_PROBABILITY_DAYS = 4;
const SWAP_RISK_SHARE = 0.1;
const WILSON_Z_90 = 1.645;
// Qatar publishes through about the end of UTC day (fetch day + 6), so the
// +6 DOH date is only partly out: evening departures to Doha are missing.
// An empty fetch proves absence only up to +5, and only for a local day that
// ends inside the horizon of the fetch that recorded it.
const TRUSTED_ABSENCE_DAYS = QATAR_PUBLISHED_DAYS_FORWARD - 1;
const PUBLISH_HORIZON_DAYS = 6;

export interface QatarLeg {
  flight_number: string;
  departure_airport: string | null;
  arrival_airport: string | null;
  departure_time: number;
  arrival_time: number | null;
  equipment_code: string | null;
  flight_status: string | null;
  klass: QatarClass;
}

export type QatarScheduleClass = QatarClass | "mixed" | "cancelled";

export interface QatarMixEntry {
  equipment_code: string | null;
  aircraft_type: string;
  class: QatarClass;
  count: number;
}

export type QatarGrade = "high" | "medium" | "low";

export type QatarVerdict =
  | {
      kind: "qatar";
      window: FlightDateWindow;
      normalized: string;
      hasStarlink: boolean | null;
      qclass: QatarScheduleClass;
      reason: string;
      rows: QatarLeg[];
    }
  | {
      kind: "qatar_no_data";
      window: FlightDateWindow;
      normalized: string;
      daysOut: number;
      /** past: nothing on record; not_tracked: never seen on a curated route;
       * not_scheduled: its routes were fetched for the date and it isn't there;
       * not_observed: no usable history beyond the window; all_cancelled: every
       * recent operating day was cancelled; not_on_leg: it flies that date,
       * just not the requested leg. */
      reason:
        | "past"
        | "not_tracked"
        | "not_scheduled"
        | "not_observed"
        | "all_cancelled"
        | "not_on_leg";
      /** not_on_leg: the leg asked for ("LHR→DOH", "from LHR") and what it flies. */
      asked?: string;
      flies?: string;
    }
  | {
      kind: "qatar_history";
      window: FlightDateWindow;
      normalized: string;
      daysOut: number;
      basis: "history" | "schedule";
      nDays: number;
      nFlown: number;
      nScheduled: number;
      yesDays: number;
      rollingDays: number;
      noDays: number;
      unknownDays: number;
      probability: number | null;
      grade: QatarGrade;
      mix: QatarMixEntry[];
      season: { query: string | null; used: string; shifted: boolean; tooFar: boolean };
      mostlyRolling: boolean;
      swapRisk?: boolean;
      /** swapRisk: flown days first published on a fitted type, and how many
       * of those Qatar moved off one before departure. */
      swapObserved?: number;
      swapDays?: number;
      notFetched?: boolean;
      /** Fetched, but Qatar hadn't published the whole date yet. */
      partlyPublished?: boolean;
      scheduledRow?: QatarLeg;
    };

/** "QR1", "QR001" and pinned "1" all name the same flight: Qatar's feeds pad
 * numbers at their own widths. */
export function qatarFlightVariants(normalized: string): string[] {
  return zeroPaddedVariants([normalized]);
}

export function addDaysISO(dateISO: string, days: number): string {
  return new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Wilson score interval lower bound — a small all-yes sample stays well
 * under 1, so a handful of observations can't clear the badge threshold. */
export function wilsonLowerBound(successes: number, n: number, z = WILSON_Z_90): number {
  if (n <= 0) return 0;
  const p = Math.min(Math.max(successes / n, 0), 1);
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.min(1, Math.max(0, (centre - margin) / (1 + z2 / n)));
}

const CLASS_RANK: Record<QatarClass, number> = { yes: 0, rolling: 1, no: 2, unknown: 3 };
const FLOWN_STATUSES = new Set(["ARRIVED", "DEPARTED", "LANDED", "ENRT", "AIRBORNE", "DIVERTED"]);

function isCancelled(status: string | null): boolean {
  return (status ?? "").toUpperCase() === "CANCELLED";
}

type HistoryInput = Pick<
  QatarHistoryRow,
  | "departure_airport"
  | "arrival_airport"
  | "departure_time"
  | "service_date"
  | "equipment_code"
  | "flight_status"
>;

interface Chain<T extends HistoryInput = HistoryInput> {
  legs: T[];
  klass: QatarClass;
  serviceDate: string;
  flown: boolean;
}

/**
 * One chain per operating day: a leg continues the previous chain when it
 * departs where that chain's last leg arrived, within 24h (QR914 DOH-ADL-AKL is
 * one day, not two). The chain takes its worst leg's class — the legs share an
 * airframe, so they normally agree, and a disagreement must not count as yes.
 */
export function qatarOperatingDays<T extends HistoryInput>(rows: readonly T[]): Chain<T>[] {
  const sorted = [...rows].sort((a, b) => a.departure_time - b.departure_time);
  const chains: Chain<T>[] = [];
  for (const leg of sorted) {
    let joined: Chain<T> | null = null;
    for (let i = chains.length - 1; i >= 0; i--) {
      const c = chains[i];
      if (leg.departure_time - c.legs[0].departure_time > 3 * 86400) break;
      const last = c.legs[c.legs.length - 1];
      const gap = leg.departure_time - last.departure_time;
      if (last.arrival_airport === leg.departure_airport && gap > 0 && gap < 86400) {
        joined = c;
        break;
      }
    }
    const klass = qatarEquipmentClass(leg.equipment_code);
    const flown = FLOWN_STATUSES.has((leg.flight_status ?? "").toUpperCase());
    if (joined) {
      joined.legs.push(leg);
      if (CLASS_RANK[klass] > CLASS_RANK[joined.klass]) joined.klass = klass;
      joined.flown ||= flown;
    } else {
      chains.push({ legs: [leg], klass, serviceDate: leg.service_date, flown });
    }
  }
  return chains;
}

export interface QatarHistoryStats {
  nDays: number;
  nFlown: number;
  nScheduled: number;
  yesDays: number;
  rollingDays: number;
  noDays: number;
  unknownDays: number;
  probability: number | null;
  grade: QatarGrade;
  mix: QatarMixEntry[];
  season: { query: string | null; used: string; shifted: boolean; tooFar: boolean };
  /** 787-9 (installs under way) is the most common type: a maybe, so no
   * yes-share floor is reported. */
  mostlyRolling: boolean;
}

const GRADE_DOWN: Record<QatarGrade, QatarGrade> = { high: "medium", medium: "low", low: "low" };

/**
 * Probability that `queryDate` flies a fully fitted type, from observed
 * operating days. Airlines re-plan equipment per IATA season, so the query's
 * own season is used alone once it has enough days; otherwise borrowing
 * other seasons' days costs a grade; two or more seasons out is not observable.
 */
export function qatarHistoryStats(
  rows: readonly HistoryInput[],
  queryDate: string,
  todayDate: string
): QatarHistoryStats {
  const all = qatarOperatingDays(rows.filter((r) => !isCancelled(r.flight_status)));
  const qs = iataSeasonKey(queryDate);
  const ts = iataSeasonKey(todayDate);
  const inSeason = qs ? all.filter((c) => iataSeasonKey(c.serviceDate) === qs) : [];
  const ahead = qs && ts ? iataSeasonIndex(qs) - iataSeasonIndex(ts) : 0;

  let used = all;
  const season = { query: qs, used: "mixed", shifted: false, tooFar: false };
  if (qs && inSeason.length >= MIN_SUBSET_DAYS) {
    used = inSeason;
    season.used = qs;
  } else if (ahead === 1) {
    season.shifted = true;
  } else if (ahead >= 2) {
    season.tooFar = true;
  }

  const count = (k: QatarClass) => used.filter((c) => c.klass === k).length;
  const nDays = used.length;
  const yesDays = count("yes");
  const rollingDays = count("rolling");
  const noDays = count("no");
  const unknownDays = count("unknown");
  const nFlown = used.filter((c) => c.flown).length;

  // One entry per operating day, named by the leg that set the day's class,
  // so the counts add up to nDays.
  const mixMap = new Map<string, QatarMixEntry>();
  for (const c of used) {
    const leg = c.legs.find((l) => qatarEquipmentClass(l.equipment_code) === c.klass) ?? c.legs[0];
    const code = leg.equipment_code;
    const e = mixMap.get(code ?? "");
    if (e) e.count++;
    else {
      mixMap.set(code ?? "", {
        equipment_code: code,
        aircraft_type: qatarEquipmentName(code),
        class: qatarEquipmentClass(code),
        count: 1,
      });
    }
  }

  let grade: QatarGrade = nDays >= 14 ? "high" : nDays >= MIN_SUBSET_DAYS ? "medium" : "low";
  const borrowsOtherSeasons =
    used === all && qs !== null && all.some((c) => iataSeasonKey(c.serviceDate) !== qs);
  if (season.shifted || borrowsOtherSeasons) grade = GRADE_DOWN[grade];

  const mostlyRolling =
    rollingDays > 0 && rollingDays >= yesDays && rollingDays >= noDays + unknownDays;

  return {
    nDays,
    nFlown,
    nScheduled: nDays - nFlown,
    yesDays,
    rollingDays,
    noDays,
    unknownDays,
    probability:
      !season.tooFar && !mostlyRolling && nDays >= MIN_PROBABILITY_DAYS
        ? wilsonLowerBound(yesDays, nDays)
        : null,
    grade,
    mix: [...mixMap.values()].sort((a, b) => b.count - a.count),
    season,
    mostlyRolling,
  };
}

type SwapInput = HistoryInput &
  Pick<QatarHistoryRow, "first_equipment_code" | "first_seen_lead_sec">;

/**
 * Real swaps, not rotation: of the flown operating days Qatar first published
 * on a fitted type at least `minLeadDays` out, how many flew something else.
 * A number that alternates types by weekday is planned, and each date's own
 * published type already says which one it gets.
 */
export function qatarSwapStats(
  rows: readonly SwapInput[],
  nowSec: number,
  minLeadDays = 2
): { observed: number; swapped: number } {
  let observed = 0;
  let swapped = 0;
  const flown = qatarOperatingDays(rows.filter((r) => !isCancelled(r.flight_status))).filter(
    (c) => c.legs[0].departure_time < nowSec
  );
  for (const c of flown) {
    const publishedFitted = c.legs.every(
      (l) =>
        l.first_seen_lead_sec >= minLeadDays * 86400 &&
        qatarEquipmentClass(l.first_equipment_code ?? l.equipment_code) === "yes"
    );
    if (!publishedFitted) continue;
    observed++;
    if (c.klass !== "yes") swapped++;
  }
  return { observed, swapped };
}

/** "777-300ER ×6, A350-1000 ×4, 787-9 ×2" */
export function qatarMixSentence(mix: readonly QatarMixEntry[]): string {
  const short = (name: string) => name.replace(/^(Boeing|Airbus) /, "");
  return mix.map((m) => `${short(m.aircraft_type)} ×${m.count}`).join(", ");
}

// Unknown codes are the one class a stale registry can produce silently.
const warnedCodes = new Set<string>();
function noteUnknownCode(code: string | null): void {
  metrics.increment(COUNTERS.QATAR_UNKNOWN_EQUIPMENT, {
    airline: normalizeAirlineTag("QR"),
    code: normalizeEquipmentCodeTag(code),
  });
  const key = code ?? "";
  if (warnedCodes.has(key)) return;
  warnedCodes.add(key);
  warn(`unrecognised Qatar equipment code ${JSON.stringify(code)} — add it to QATAR_EQUIPMENT`);
}

function toLeg(r: QatarHistoryRow | QatarScheduleRow): QatarLeg | null {
  if (r.departure_time === null) return null;
  return {
    flight_number: r.flight_number,
    departure_airport: r.departure_airport,
    arrival_airport: r.arrival_airport,
    departure_time: r.departure_time,
    arrival_time: r.arrival_time,
    equipment_code: r.equipment_code,
    flight_status: r.flight_status,
    klass: qatarEquipmentClass(r.equipment_code),
  };
}

const legKey = (r: { departure_airport: string | null; departure_time: number | null }) =>
  `${r.departure_airport ?? ""}|${r.departure_time}`;

/** Live legs of the operating day(s) that START on the queried local date:
 * history ∪ schedule, history preferred (it knows staleness; schedule's
 * UNIQUE(fn, date) keeps one leg of a through-flight), and a schedule row
 * whose history twin went stale is a phantom too. A through-flight's later
 * leg that departs on the date but belongs to the previous day's rotation is
 * dropped: it answers a different departure. */
function liveLegs(
  reader: ScopedReader,
  variants: string[],
  date: string,
  window: FlightDateWindow
): QatarLeg[] {
  const onDate = (r: { departure_airport: string | null; departure_time: number }) =>
    matchesLocalDate(date, r.departure_airport ?? "", r.departure_time, window.start, window.end);
  const from = window.queryStart - 86400;
  const to = window.queryEnd + 86400;

  const byKey = new Map<string, QatarLeg>();
  const stale = new Set<string>();
  for (const h of reader.getQatarEquipmentHistoryByWindow(variants, from, to)) {
    if (h.stale_at !== null) stale.add(legKey(h));
    else {
      const leg = toLeg(h);
      if (leg) byKey.set(legKey(h), leg);
    }
  }
  for (const s of reader.getQatarScheduleByFlight(variants, from, to)) {
    const k = legKey(s);
    if (stale.has(k) || byKey.has(k)) continue;
    const leg = toLeg(s);
    if (leg) byKey.set(k, leg);
  }

  const legs = [...byKey.values()].sort((a, b) => a.departure_time - b.departure_time);
  const out: QatarLeg[] = [];
  let chain: QatarLeg[] = [];
  const flush = () => {
    if (chain.length > 0 && onDate(chain[0])) out.push(...chain);
    chain = [];
  };
  for (const leg of legs) {
    const last = chain[chain.length - 1];
    const gap = last ? leg.departure_time - last.departure_time : 0;
    if (!last || last.arrival_airport !== leg.departure_airport || gap <= 0 || gap >= 86400) {
      flush();
    }
    chain.push(leg);
  }
  flush();
  return out;
}

export function qatarLiveLegs(
  reader: ScopedReader,
  normalized: string,
  date: string,
  window: FlightDateWindow
): QatarLeg[] {
  return liveLegs(reader, qatarFlightVariants(normalized), date, window);
}

/**
 * Live legs that leave their own airport on the queried local date, whichever
 * rotation they belong to: QR914's ADL→AKL on the 23rd is the 22nd's Doha
 * departure, so an origin-scoped ask must look one rotation back.
 */
export function qatarLegsDepartingOn(
  reader: ScopedReader,
  normalized: string,
  date: string,
  window: FlightDateWindow,
  prevWindow: FlightDateWindow
): QatarLeg[] {
  const variants = qatarFlightVariants(normalized);
  const byKey = new Map<string, QatarLeg>();
  for (const l of liveLegs(reader, variants, addDaysISO(date, -1), prevWindow)) {
    byKey.set(legKey(l), l);
  }
  for (const l of liveLegs(reader, variants, date, window)) byKey.set(legKey(l), l);
  return [...byKey.values()]
    .filter((l) =>
      matchesLocalDate(date, l.departure_airport ?? "", l.departure_time, window.start, window.end)
    )
    .sort((a, b) => a.departure_time - b.departure_time);
}

/** A leg the flight number doesn't fly on a date it does operate. */
export function qatarNotOnLeg(
  normalized: string,
  date: string,
  window: FlightDateWindow,
  nowSec: number,
  asked: string,
  rows: readonly QatarLeg[]
): Extract<QatarVerdict, { kind: "qatar_no_data" }> {
  return {
    kind: "qatar_no_data",
    window,
    normalized,
    daysOut: qatarDaysOut(date, nowSec),
    reason: "not_on_leg",
    asked,
    flies: routeText(rows),
  };
}

/** "its 777 fleet", "its 777 and A350 fleets" — the families of fitted rows. */
function fleetPhrase(rows: readonly QatarLeg[]): string {
  const fleets = [
    ...new Set(
      rows.map((r) => (qatarEquipment(r.equipment_code)?.family ?? "").replace(/^B(?=7)/, ""))
    ),
  ];
  const list =
    fleets.length === 1
      ? fleets[0]
      : `${fleets.slice(0, -1).join(", ")} and ${fleets[fleets.length - 1]}`;
  return `its ${list} ${fleets.length === 1 ? "fleet" : "fleets"}`;
}

/** "DOH→ADL→AKL" for a through-flight, "DOH→LHR" for one leg. */
function routeText(rows: readonly QatarLeg[]): string {
  const paths: string[][] = [];
  for (const r of rows) {
    const dep = r.departure_airport ?? "?";
    const arr = r.arrival_airport ?? "?";
    const cur = paths[paths.length - 1];
    if (cur && cur[cur.length - 1] === dep) cur.push(arr);
    else paths.push([dep, arr]);
  }
  return paths.map((p) => p.join("→")).join(", ");
}

function typesText(rows: readonly QatarLeg[]): string {
  return [...new Set(rows.map((r) => qatarEquipmentName(r.equipment_code)))].join(", ");
}

export const QATAR_FAMILY_SENTENCE =
  "Qatar reports its 777, A350 and 787-8 fleets fitted; 787-9 installs are under way; A380, A330 and narrowbodies aren't in the program.";

export const QATAR_LOOKUP_LLMS_LINE =
  "/api/check-any-flight and MCP check_flight answer flight numbers on selected Qatar routes by Qatar's published aircraft type (~6 days out), then by the last 28 days of observed types. No tail-level check.";

export const QATAR_ROLLING_NOTE =
  "Qatar's 787-9 Starlink installs are under way (due end-2026); this aircraft may or may not be equipped yet.";

function scheduleAnswer(
  rows: QatarLeg[],
  normalized: string,
  date: string,
  window: FlightDateWindow
): Extract<QatarVerdict, { kind: "qatar" }> {
  const base = { kind: "qatar" as const, window, normalized, rows };
  const active = rows.filter((r) => !isCancelled(r.flight_status));
  if (active.length === 0) {
    return {
      ...base,
      hasStarlink: null,
      qclass: "cancelled",
      reason: `Qatar lists ${normalized} on ${date} as cancelled.`,
    };
  }
  const classes = new Set(active.map((r) => r.klass));
  const types = typesText(active);
  if (classes.has("unknown")) {
    const codes = [
      ...new Set(active.filter((r) => r.klass === "unknown").map((r) => r.equipment_code)),
    ];
    for (const c of codes) noteUnknownCode(c);
    return {
      ...base,
      hasStarlink: null,
      qclass: "unknown",
      reason: `Scheduled aircraft code ${codes.map((c) => c ?? "(none)").join(", ")} isn't one we recognise, so we can't say whether it has Starlink.`,
    };
  }
  if (classes.size === 1 && classes.has("yes")) {
    return {
      ...base,
      hasStarlink: true,
      qclass: "yes",
      reason: `Scheduled ${types} ${routeText(active)}. Qatar reports ${fleetPhrase(active)} fully fitted with Starlink. Qatar can change the aircraft before departure.`,
    };
  }
  if (classes.size === 1 && classes.has("no")) {
    return {
      ...base,
      hasStarlink: false,
      qclass: "no",
      reason: `Scheduled ${types} — not part of Qatar's Starlink program.`,
    };
  }
  if (classes.has("rolling") && !classes.has("no")) {
    return {
      ...base,
      hasStarlink: null,
      qclass: "rolling",
      reason: `Scheduled ${types} ${routeText(active)}. ${QATAR_ROLLING_NOTE}`,
    };
  }
  return {
    ...base,
    hasStarlink: null,
    qclass: "mixed",
    reason: `Mixed equipment scheduled (${types}) — outcome depends on which aircraft operates.`,
  };
}

export function resolveQatarVerdict(
  reader: ScopedReader,
  normalized: string,
  date: string,
  window: FlightDateWindow,
  nowSec: number,
  /** The live legs to answer from; a leg-scoped caller passes its selection. */
  liveRows?: QatarLeg[]
): QatarVerdict {
  const variants = qatarFlightVariants(normalized);
  const daysOut = qatarDaysOut(date, nowSec);
  const today = dohDateISO(nowSec);
  const noData = (reason: Extract<QatarVerdict, { kind: "qatar_no_data" }>["reason"]) =>
    ({ kind: "qatar_no_data", window, normalized, daysOut, reason }) as const;

  let recentRows: QatarHistoryRow[] | null = null;
  const recent = () => {
    recentRows ??= reader.getQatarEquipmentHistory(
      variants,
      addDaysISO(today, -QATAR_HISTORY_WINDOW_DAYS),
      addDaysISO(today, QATAR_PUBLISHED_DAYS_FORWARD)
    );
    return recentRows;
  };
  const history = () => qatarHistoryStats(recent(), date, today);

  const rows = liveRows ?? liveLegs(reader, variants, date, window);
  if (rows.length > 0) {
    const answer = scheduleAnswer(rows, normalized, date, window);
    // Two or more days out, a fitted type on a number Qatar often swaps after
    // publishing is a probability, not a yes: 77W→388 and 788→789 swaps happen.
    if (answer.qclass === "yes" && daysOut >= 2) {
      const swaps = qatarSwapStats(recent(), nowSec);
      if (swaps.observed >= MIN_SUBSET_DAYS && swaps.swapped / swaps.observed > SWAP_RISK_SHARE) {
        return {
          kind: "qatar_history",
          window,
          normalized,
          daysOut,
          basis: "schedule",
          ...history(),
          probability: wilsonLowerBound(swaps.observed - swaps.swapped, swaps.observed),
          grade: swaps.observed >= 14 ? "high" : "medium",
          swapRisk: true,
          swapObserved: swaps.observed,
          swapDays: swaps.swapped,
          scheduledRow: answer.rows.find((r) => !isCancelled(r.flight_status)),
        };
      }
    }
    return answer;
  }

  if (daysOut < -1) return noData("past");

  let notFetched = false;
  let partlyPublished = false;
  if (daysOut <= QATAR_PUBLISHED_DAYS_FORWARD) {
    const routes = reader.getQatarHistoryRoutes(
      variants,
      addDaysISO(today, -QATAR_HISTORY_WINDOW_DAYS)
    );
    if (routes.length === 0) return noData("not_tracked");
    // Qatar files a by-route date on the origin's local day; the previous
    // date is required too as a margin, not because legs are known to move.
    const prev = addDaysISO(date, -1);
    const covered = reader.getQatarFetchCoverage(routes, [date, prev]);
    const key = (r: { origin: string; destination: string }, d: string) =>
      `${r.origin}-${r.destination}-${d}`;
    const allFetched = routes.every((r) => covered.has(key(r, date)) && covered.has(key(r, prev)));
    const fullyPublished = (r: { origin: string; destination: string }) => {
      const fetchedAt = covered.get(key(r, date)) ?? 0;
      const horizon = (Math.floor(fetchedAt / 86400) + PUBLISH_HORIZON_DAYS + 1) * 86400;
      return horizon >= localDayEndSec(r.origin, date);
    };
    if (allFetched && daysOut <= TRUSTED_ABSENCE_DAYS && routes.every(fullyPublished)) {
      return noData("not_scheduled");
    }
    notFetched = true;
    partlyPublished = allFetched;
  }

  const stats = history();
  if (stats.nDays === 0) {
    const seen = recent();
    return noData(
      seen.length > 0 && seen.every((r) => isCancelled(r.flight_status))
        ? "all_cancelled"
        : "not_observed"
    );
  }
  return {
    kind: "qatar_history",
    window,
    normalized,
    daysOut,
    basis: "history",
    ...stats,
    ...(notFetched ? { notFetched: true } : {}),
    ...(partlyPublished ? { partlyPublished: true } : {}),
  };
}

// ── Shared copy (REST + MCP render the same sentences) ──────────────────────

export function qatarNoDataReason(v: Extract<QatarVerdict, { kind: "qatar_no_data" }>): string {
  switch (v.reason) {
    case "not_scheduled":
      return `Not in Qatar's published schedule for this date on the routes we track (selected Qatar routes only; Qatar publishes the aircraft about a week out). ${QATAR_FAMILY_SENTENCE}`;
    case "past":
      return `No Qatar schedule on record for ${v.normalized} on this date. ${QATAR_FAMILY_SENTENCE}`;
    case "all_cancelled":
      return `Qatar cancelled ${v.normalized} on every recent operating day we track (last ${QATAR_HISTORY_WINDOW_DAYS} days), so there's no aircraft pattern to estimate from. ${QATAR_FAMILY_SENTENCE}`;
    case "not_on_leg":
      return `${v.normalized} doesn't operate ${v.asked ?? "that leg"} on this date${v.flies ? `; it flies ${v.flies}` : ""}.`;
    default:
      return `We haven't observed ${v.normalized} on the Qatar routes we track yet (selected Qatar routes only; Qatar publishes the aircraft about a week out). ${QATAR_FAMILY_SENTENCE}`;
  }
}

const pctFloor = (p: number) => Math.floor(p * 100);

export function qatarHistoryReason(v: Extract<QatarVerdict, { kind: "qatar_history" }>): string {
  const notes: string[] = [];
  if (v.rollingDays > 0 && !v.mostlyRolling) notes.push("787-9 installs are mid-rollout.");
  const seasonStart = v.season.query ? iataSeasonStart(v.season.query) : null;
  if (v.season.shifted && seasonStart) {
    notes.push(`Schedule season changes ${seasonStart}; equipment may shift.`);
  }
  if (v.partlyPublished) notes.push("Qatar hasn't published its full schedule for this date yet.");
  else if (v.notFetched) notes.push("Qatar hasn't been checked for this date yet.");
  const tail = notes.length ? ` ${notes.join(" ")}` : "";

  if (v.season.tooFar) {
    return `More than a schedule season ahead; Qatar's equipment plans aren't observable yet. ${QATAR_FAMILY_SENTENCE}`;
  }
  const mix = qatarMixSentence(v.mix);
  const lastDays = `${v.normalized} over its last ${v.nDays} operating day${v.nDays === 1 ? "" : "s"} (flown and scheduled): ${mix}`;
  if (v.mostlyRolling) {
    const lead = v.scheduledRow
      ? `Scheduled ${qatarEquipmentName(v.scheduledRow.equipment_code)} (Starlink-fitted type), but`
      : "Qatar publishes the aircraft about a week ahead.";
    return `${lead} ${lastDays} — mostly 787-9. ${QATAR_ROLLING_NOTE}${tail}`;
  }
  if (v.swapRisk && v.scheduledRow && v.probability !== null) {
    const n = v.swapObserved ?? 0;
    return `Scheduled ${qatarEquipmentName(v.scheduledRow.equipment_code)} (Starlink-fitted type), but Qatar moved ${v.normalized} off a fitted type after publishing it on ${v.swapDays ?? 0} of its last ${n} flown day${n === 1 ? "" : "s"}; at least ${pctFloor(v.probability)}% chance it stays on a fitted type.${tail}`;
  }
  if (v.probability === null) {
    return `Qatar publishes the aircraft about a week ahead. ${lastDays} — too few to estimate yet.${tail}`;
  }
  if (v.yesDays === 0) {
    return `Qatar publishes the aircraft about a week ahead. ${lastDays} — none on a Starlink-fitted type.${tail}`;
  }
  const pct = pctFloor(v.probability);
  return `Qatar publishes the aircraft about a week ahead. ${lastDays} — ${v.yesDays} on types Qatar reports fully fitted with Starlink${pct > 0 ? ` (at least ${pct}%)` : ""}.${tail}`;
}
