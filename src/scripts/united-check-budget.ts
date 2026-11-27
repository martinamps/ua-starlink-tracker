/**
 * The ceiling on checks of united.com.
 *
 * The verifier and fleet discovery each check whatever came due, so the daily
 * count used to be nothing but the number of aircraft due: it rose by itself
 * as tails were equipped. Both now claim a slot here before a check starts.
 * The ledger is the start time of every check in the last 24 hours, kept in
 * `meta` so a restart cannot reset it. On boot it is set against the
 * verification log, and checks only the log holds are counted as well.
 *
 * Two classes share it:
 *  - "settle": an aircraft we do not hold as settled Starlink (unknown,
 *    negative, ambiguous, disputed). These find a new tail or settle a
 *    doubtful one, and may use the whole budget.
 *  - "reconfirm": a settled Starlink aircraft looked at again. It stops
 *    UNITED_SETTLE_RESERVE short, so a slot that frees while the budget is
 *    full always goes to a "settle" check: the verifier ticks more often than
 *    discovery and would otherwise take every one. It is also held to the
 *    budget's own hourly pace. A rolling window repeats its own shape: a
 *    backlog cleared in one burst would come back as the same burst every day,
 *    with hours in between where no slot frees for a "settle" check to take.
 * A run a person forces by hand ("manual") is counted and never refused; the
 * jobs then make room for it.
 *
 * A refused claim is not queued: the job sits the tick out and asks again on
 * its next one. Nothing here can start a check, so the count can only fall.
 *
 * A claim is followed by endUnitedCheck once its check has ended and written
 * its log row. A claim whose check never ended (the process was stopped while
 * the page loaded) has no log row, and the boot read needs to know that: see
 * logSurplus. Each boot moves what the process before it left unended to a
 * kept list and starts its own list empty, so every stop is read by itself.
 */

import type { Database } from "bun:sqlite";
import { getMeta, getRecentUnitedCheckTimes, setMeta } from "../database/database";
import { COUNTERS, GAUGES, metrics, normalizeAirlineTag } from "../observability";

/** Checks of united.com the two jobs may start in any rolling 24 hours. */
export const UNITED_DAILY_CHECK_BUDGET = 364;

/**
 * The most checks in any rolling hour after which a re-confirmation may still
 * start: the daily budget spread evenly, rounded up. Derived, not tuned.
 */
export const UNITED_RECONFIRM_HOURLY_PACE = Math.ceil(UNITED_DAILY_CHECK_BUDGET / 24);

/**
 * Slots only a "settle" check may take: an hour of the budget's own turnover.
 * A burst of newly due unequipped tails (a first-of-family cascade queues a
 * family's worth at once) starts at discovery's full pace, and after that
 * takes every slot as it frees. Each slot held back here is one fewer
 * re-confirmation a day, so it is kept small.
 */
export const UNITED_SETTLE_RESERVE = Math.ceil(UNITED_DAILY_CHECK_BUDGET / 24);

const HOUR_MS = 3600 * 1000;
const WINDOW_MS = 24 * HOUR_MS;
const LEDGER_KEY = "united_check_budget";
/** Start times of claims whose check has not ended, kept beside the ledger. */
const UNDER_WAY_KEY = "united_check_under_way";
/**
 * Start times of claims that a process now gone left unended, for as long as
 * they are inside the window: the claims the boot read lets stand for no log
 * row. One list for the whole day held only its newest three, so a fourth
 * check cut short in a day was counted as logged again, and a rolling day
 * could hold 365 to 367.
 */
const NO_ROW_KEY = "united_check_no_row";
/**
 * The most checks one stop can cut short: the verifier's, discovery's and a
 * hand-forced run's. A boot believes no more unended claims than this of the
 * process before it, so a caller that never calls endUnitedCheck costs three
 * slots a boot, not a day's.
 */
const MAX_UNDER_WAY = 3;

export type UnitedCheckClass = "settle" | "reconfirm" | "manual";
type GatedClass = Exclude<UnitedCheckClass, "manual">;
export type UnitedCheckJob = "verifier" | "discovery";

export interface UnitedBudgetState {
  /** Checks started in the last 24 hours. */
  used: number;
  open: Record<GatedClass, boolean>;
}

/** Every class open: for a forced run, which is counted but not refused. */
export const UNITED_BUDGET_UNGATED: UnitedBudgetState["open"] = { settle: true, reconfirm: true };

function parseLedger(raw: string | null): number[] | null {
  if (raw === null) return null;
  try {
    const starts: unknown = JSON.parse(raw);
    if (Array.isArray(starts) && starts.every((s) => typeof s === "number" && Number.isFinite(s))) {
      return starts as number[];
    }
  } catch {}
  return null;
}

/**
 * Checks the log holds and the ledger does not, found once per process (per
 * handle), when the budget is first read after boot. The ledger is written
 * only by a version that has it: after a revert and a redeploy, the checks the
 * older version made in between are in the verification log alone. Hour by
 * hour, where the log holds more checks than the ledger, the log's surplus is
 * counted too. A check this version made is in both, a little later in the
 * log, so the surplus can run a few over at an hour's edge: it can only close
 * the budget sooner, never open it.
 *
 * `unended` are claims an earlier process made and never saw end: they have
 * no log row, so they stand for none. Counted as logged, such a claim hid one
 * of the older version's checks in the hour a revert began, and a day later
 * the count ran one or two over.
 */
const unledgered = new WeakMap<Database, number[]>();
/** This process's own claims whose check has not ended, oldest first. */
const underWay = new WeakMap<Database, number[]>();

function logSurplus(
  db: Database,
  ledger: readonly number[],
  unended: readonly number[],
  now: number
): number[] {
  const since = now - WINDOW_MS;
  const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);
  const ledgered = new Map<number, number>();
  const noRow = [...unended];
  for (const s of ledger) {
    if (s <= since) continue;
    const at = noRow.indexOf(s);
    if (at >= 0) noRow.splice(at, 1);
    else ledgered.set(hourOf(s), (ledgered.get(hourOf(s)) ?? 0) + 1);
  }
  const surplus: number[] = [];
  // Oldest first, so an hour's surplus is its newest log rows. Which rows of
  // the hour the ledger never saw is not known (a revert that starts inside
  // the hour leaves the older version's checks newest, a return leaves them
  // oldest). The newest free last, so the count is never under the real one.
  const logged = getRecentUnitedCheckTimes(db, Math.floor(since / 1000)).map((s) => s * 1000);
  for (const at of logged) {
    const left = ledgered.get(hourOf(at)) ?? 0;
    if (left > 0) ledgered.set(hourOf(at), left - 1);
    else surplus.push(at);
  }
  return surplus;
}

/**
 * The claims the boot read lets stand for no log row: those kept from earlier
 * boots, and the newest few the process before this one left under way. They
 * are written to the kept list and the under-way list is emptied, so the next
 * stop's claims are not crowded out by this one's. Only claims the ledger
 * still holds are kept: anything else in either list stands for nothing.
 *
 * It can only add to the count. A claim kept here whose check did write its
 * row (the stop fell between the row and its end) counts that check twice
 * for a day. If the write fails, the read still goes by the same claims and
 * the next boot finds both lists as they were.
 */
function takeOverUnended(db: Database, ledger: readonly number[], now: number): number[] {
  // Two claims can share a millisecond, so a time is kept as often as the
  // ledger holds it and no more often.
  const inLedger = new Map<number, number>();
  for (const s of ledger) {
    if (s > now - WINDOW_MS) inLedger.set(s, (inLedger.get(s) ?? 0) + 1);
  }
  const kept = parseLedger(getMeta(db, NO_ROW_KEY, "UA")) ?? [];
  const left = (parseLedger(getMeta(db, UNDER_WAY_KEY, "UA")) ?? [])
    .sort((a, b) => a - b)
    .slice(-MAX_UNDER_WAY);
  const noRow: number[] = [];
  for (const s of [...kept, ...left]) {
    const room = inLedger.get(s) ?? 0;
    if (room === 0) continue;
    inLedger.set(s, room - 1);
    noRow.push(s);
  }
  try {
    db.transaction(() => {
      setMeta(db, NO_ROW_KEY, JSON.stringify(noRow), "UA");
      setMeta(db, UNDER_WAY_KEY, "[]", "UA");
    })();
  } catch {}
  return noRow;
}

/**
 * Start times (ms) inside the window. With no ledger yet (the first run after
 * this shipped) or an unreadable one, the verification log stands in: it has a
 * row per check, and a few more for swap captures, so it can only overcount.
 * An empty start would let a full day's checks follow a full day's checks.
 */
function loadStarts(db: Database, now: number): number[] {
  const ledger = parseLedger(getMeta(db, LEDGER_KEY, "UA"));
  const starts =
    ledger ??
    getRecentUnitedCheckTimes(db, Math.floor((now - WINDOW_MS) / 1000)).map((s) => s * 1000);
  // With no ledger the log is already the count: nothing is left unledgered.
  if (!unledgered.has(db)) {
    // Whatever is still under way on boot was left by a process that is gone.
    unledgered.set(db, ledger ? logSurplus(db, ledger, takeOverUnended(db, ledger, now), now) : []);
  }
  // A start stamped ahead of the clock (the clock was set back) still counts,
  // until the clock has passed it by a full window.
  return starts.filter((s) => s > now - WINDOW_MS);
}

/** The count the budget goes by: the ledger's starts and the log's surplus. */
function countedStarts(db: Database, starts: readonly number[], now: number): number[] {
  const extra = (unledgered.get(db) ?? []).filter((s) => s > now - WINDOW_MS);
  return extra.length > 0 ? [...starts, ...extra] : [...starts];
}

function stateOf(starts: readonly number[], now: number): UnitedBudgetState {
  const used = starts.length;
  const lastHour = starts.filter((s) => s > now - HOUR_MS).length;
  return {
    used,
    open: {
      settle: used < UNITED_DAILY_CHECK_BUDGET,
      reconfirm:
        used < UNITED_DAILY_CHECK_BUDGET - UNITED_SETTLE_RESERVE &&
        lastHour < UNITED_RECONFIRM_HOURLY_PACE,
    },
  };
}

function emitUsed(used: number): void {
  const tags = { airline: normalizeAirlineTag("UA") };
  metrics.gauge(GAUGES.UNITED_CHECK_BUDGET_USED, used, tags);
  metrics.gauge(GAUGES.UNITED_CHECK_BUDGET_LIMIT, UNITED_DAILY_CHECK_BUDGET, tags);
}

/** What the budget would allow right now. Reads only; each job tick calls it, so it carries the gauge. */
export function unitedBudgetState(db: Database, now = Date.now()): UnitedBudgetState {
  const state = stateOf(countedStarts(db, loadStarts(db, now), now), now);
  emitUsed(state.used);
  return state;
}

/**
 * Take a slot for a check that is about to start. False means the budget is
 * closed to this class and no check may be made. Call it at the last moment
 * before the checker: a claim is spent whether or not the page then loads.
 */
export function claimUnitedCheck(db: Database, cls: UnitedCheckClass, now = Date.now()): boolean {
  return db.transaction(() => {
    const starts = loadStarts(db, now);
    if (cls !== "manual" && !stateOf(countedStarts(db, starts, now), now).open[cls]) return false;
    starts.push(now);
    setMeta(db, LEDGER_KEY, JSON.stringify(starts), "UA");
    const open = (parseLedger(getMeta(db, UNDER_WAY_KEY, "UA")) ?? []).filter(
      (s) => s > now - WINDOW_MS
    );
    setMeta(db, UNDER_WAY_KEY, JSON.stringify([...open, now]), "UA");
    underWay.set(db, [...(underWay.get(db) ?? []), now]);
    emitUsed(countedStarts(db, starts, now).length);
    return true;
  })();
}

/**
 * The check a claim was made for has ended, and its log row is written (a
 * failed check writes one too). Call it once per granted claim, in a finally.
 * It takes this process's oldest open claim: two checks that end out of order
 * swap times a tick apart, and the number left open is still right. Never
 * throws: a missed call only makes the next boot count a slot more.
 *
 * The claim is taken off the kept list too: another process that booted on
 * this file while the check ran (a command-line run) has moved it there.
 */
export function endUnitedCheck(db: Database): void {
  const at = underWay.get(db)?.shift();
  if (at === undefined) return;
  try {
    db.transaction(() => {
      const open = parseLedger(getMeta(db, UNDER_WAY_KEY, "UA")) ?? [];
      const i = open.indexOf(at);
      if (i >= 0) open.splice(i, 1);
      setMeta(db, UNDER_WAY_KEY, JSON.stringify(open), "UA");
      const noRow = parseLedger(getMeta(db, NO_ROW_KEY, "UA"));
      const kept = noRow?.indexOf(at) ?? -1;
      if (noRow && kept >= 0) {
        noRow.splice(kept, 1);
        setMeta(db, NO_ROW_KEY, JSON.stringify(noRow), "UA");
      }
    })();
  } catch {}
}

/** A job had an aircraft due and the budget stopped it: one per tick sat out. */
export function recordUnitedCheckHeld(job: UnitedCheckJob, cls: GatedClass): void {
  metrics.increment(COUNTERS.UNITED_CHECK_HELD, {
    job,
    class: cls,
    airline: normalizeAirlineTag("UA"),
  });
}
