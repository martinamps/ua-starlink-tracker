/**
 * The ceiling on checks of united.com.
 *
 * The verifier and fleet discovery each check whatever came due, so the daily
 * count used to be nothing but the number of aircraft due: it rose by itself
 * as tails were equipped. Both now claim a slot here before a check starts.
 * The ledger is the start time of every check in the last 24 hours, kept in
 * `meta` so a restart cannot reset it.
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
 * Start times (ms) inside the window. With no ledger yet (the first run after
 * this shipped) or an unreadable one, the verification log stands in: it has a
 * row per check, and a few more for swap captures, so it can only overcount.
 * An empty start would let a full day's checks follow a full day's checks.
 */
function loadStarts(db: Database, now: number): number[] {
  const starts =
    parseLedger(getMeta(db, LEDGER_KEY, "UA")) ??
    getRecentUnitedCheckTimes(db, Math.floor((now - WINDOW_MS) / 1000)).map((s) => s * 1000);
  // A start stamped ahead of the clock (the clock was set back) still counts,
  // until the clock has passed it by a full window.
  return starts.filter((s) => s > now - WINDOW_MS);
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
  const state = stateOf(loadStarts(db, now), now);
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
    if (cls !== "manual" && !stateOf(starts, now).open[cls]) return false;
    starts.push(now);
    setMeta(db, LEDGER_KEY, JSON.stringify(starts), "UA");
    emitUsed(starts.length);
    return true;
  })();
}

/** A job had an aircraft due and the budget stopped it: one per tick sat out. */
export function recordUnitedCheckHeld(job: UnitedCheckJob, cls: GatedClass): void {
  metrics.increment(COUNTERS.UNITED_CHECK_HELD, {
    job,
    class: cls,
    airline: normalizeAirlineTag("UA"),
  });
}
