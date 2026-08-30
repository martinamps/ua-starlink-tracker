/**
 * One scheduler for every background job. Replaces six hand-rolled
 * setInterval loops that had three different overlap/stuck policies — the
 * 2026-05-20 19h wedge happened because the stuck-run escape existed in only
 * two of them.
 *
 * Policy: ticks never overlap; a run past stuckTimeoutMs is abandoned (the
 * orphan keeps awaiting but loses the flag, so the next tick proceeds and the
 * orphan's eventual settle can't clear its successor's flag); a throwing run
 * is logged and never kills the interval.
 */

import { error, warn } from "./logger";

export interface JobClock {
  now(): number;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearInterval(t: ReturnType<typeof setInterval>): void;
  clearTimeout(t: ReturnType<typeof setTimeout>): void;
}

const REAL_CLOCK: JobClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearInterval: (t) => clearInterval(t),
  clearTimeout: (t) => clearTimeout(t),
};

const DEFAULT_STUCK_TIMEOUT_MS = 15 * 60 * 1000;

// Per-job liveness registry for /healthz. Every stamp is real wall-clock,
// independent of the injectable test clock: healthz asks "are THIS process's
// timers firing", not what a fake clock says.
//
// Registration happens in startJob, not at first tick. Counting only ticked
// jobs made "JOBS_ENABLED but the timers never fired" report jobs:0 — the
// same shape as DISABLE_JOBS=1, so the exact wedge the probe exists for read
// as healthy forever.
interface JobLiveness {
  intervalMs: number;
  stuckTimeoutMs: number;
  registeredAt: number;
  /** Last tick that got past the stuck-skip and actually started a run. A
   * tick that only bounced off a wedged predecessor proves the timer fired,
   * not that the job is alive, so it deliberately doesn't stamp. */
  lastRunStartedAt: number | null;
  /** Last run that settled, success or failure. A run hung forever never
   * stamps this — the one wedge a tick-entry heartbeat cannot see, because
   * the stuck escape keeps starting fresh runs on schedule. */
  lastRunEndedAt: number | null;
}

const jobLiveness = new Map<string, JobLiveness>();

/** Silence past this and the job is wedged or its timer is gone, not merely
 * between runs. Floored at 10 min so the 22.5s flight updater can't page on a
 * single delayed tick, and held above the runner's own stuck timeout so an
 * abandoned-then-restarted run is not mistaken for a dead one. */
function stalenessBudgetMs(j: JobLiveness): number {
  return Math.max(10 * 60_000, 2 * j.intervalMs, 2 * j.stuckTimeoutMs);
}

export interface SchedulerStatus {
  /** Registered jobs, ticked or not. 0 means none were started (DISABLE_JOBS=1, tests). */
  jobs: number;
  /** Newest run-start across all jobs — a coarse "something is firing" signal. */
  lastTickAt: number | null;
  /** Jobs whose own cadence says they should have completed a run by now. */
  staleJobs: string[];
}

export function schedulerStatus(now = Date.now()): SchedulerStatus {
  let last: number | null = null;
  const staleJobs: string[] = [];
  for (const [name, j] of jobLiveness) {
    if (j.lastRunStartedAt !== null && (last === null || j.lastRunStartedAt > last)) {
      last = j.lastRunStartedAt;
    }
    // Never-run jobs are measured from registration, so a scheduler whose
    // timers never fire goes stale on its own budget instead of hiding
    // behind a sibling job's heartbeat.
    if (now - (j.lastRunEndedAt ?? j.registeredAt) > stalenessBudgetMs(j)) staleJobs.push(name);
  }
  return { jobs: jobLiveness.size, lastTickAt: last, staleJobs };
}

export interface JobRunContext {
  /** False once the runner has abandoned this run (stuck escape). An orphan
   * settling late must not mutate state its successor reads — guard breaker
   * feeds and failure counters on this. */
  isCurrent(): boolean;
}

export interface JobOptions {
  name: string;
  intervalMs: number;
  /** Delay before the first tick. Omit for interval-only (first run after intervalMs). */
  initialDelayMs?: number;
  stuckTimeoutMs?: number;
  run: (ctx: JobRunContext) => unknown | Promise<unknown>;
  clock?: JobClock;
}

export interface JobHandle {
  /** One scheduling decision + run. Never rejects — tests drive this directly. */
  tick(): Promise<void>;
  stop(): void;
}

export function startJob(opts: JobOptions): JobHandle {
  const { name, intervalMs, initialDelayMs, run } = opts;
  const stuckTimeoutMs = opts.stuckTimeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS;
  const clock = opts.clock ?? REAL_CLOCK;

  let runSeq = 0;
  let active: { id: number; startedAt: number } | null = null;

  const liveness: JobLiveness = {
    intervalMs,
    stuckTimeoutMs,
    registeredAt: Date.now(),
    lastRunStartedAt: null,
    lastRunEndedAt: null,
  };
  jobLiveness.set(name, liveness);

  const tick = async (): Promise<void> => {
    if (active) {
      const elapsed = clock.now() - active.startedAt;
      if (elapsed < stuckTimeoutMs) {
        warn(`[job:${name}] skipping tick — previous run still in progress`);
        return;
      }
      error(
        `[job:${name}] run stuck for ${Math.round(elapsed / 60000)}min — abandoning it and starting a new run`
      );
    }
    const id = ++runSeq;
    active = { id, startedAt: clock.now() };
    liveness.lastRunStartedAt = Date.now();
    try {
      await run({ isCurrent: () => active?.id === id });
    } catch (err) {
      error(`[job:${name}] run failed`, err);
    } finally {
      // Settled at all — a throwing job is alive; failure paging is the
      // job's own metrics' business, not the scheduler deadman's.
      liveness.lastRunEndedAt = Date.now();
      if (active?.id === id) active = null;
    }
  };

  const safeTick = () => {
    tick().catch((err) => error(`[job:${name}] scheduler error`, err));
  };

  const interval = clock.setInterval(safeTick, intervalMs);
  const initial = initialDelayMs !== undefined ? clock.setTimeout(safeTick, initialDelayMs) : null;

  return {
    tick,
    stop: () => {
      clock.clearInterval(interval);
      if (initial !== null) clock.clearTimeout(initial);
      // Deliberately stopped is not unhealthy — leaving it registered would
      // age a shut-down job into a permanent /healthz degrade.
      if (jobLiveness.get(name) === liveness) jobLiveness.delete(name);
    },
  };
}

export type BreakerOutcome = "success" | "failure" | "neutral";

export interface OutageBreaker {
  /** Call after selecting work for a tick; true = sit this tick out. */
  shouldSkip(): boolean;
  /** Feed each run's outcome; returns true the moment the breaker trips.
   * "neutral" = the run never reached the vendor — streak untouched. */
  record(outcome: BreakerOutcome): boolean;
}

/**
 * Tick-count breaker for vendor outages: after `threshold` consecutive
 * failures, skip the next `skipTicks` consults. Distinct from flight-updater's
 * wall-clock circuit breaker (30-min reset, shared across two call paths).
 */
export function createOutageBreaker(threshold: number, skipTicks: number): OutageBreaker {
  let failures = 0;
  let skipRemaining = 0;
  return {
    shouldSkip(): boolean {
      if (skipRemaining > 0) {
        skipRemaining--;
        return true;
      }
      return false;
    },
    record(outcome: BreakerOutcome): boolean {
      if (outcome === "failure") {
        failures++;
        if (failures >= threshold) {
          failures = 0;
          skipRemaining = skipTicks;
          return true;
        }
      } else if (outcome === "success") {
        failures = 0;
      }
      return false;
    },
  };
}
