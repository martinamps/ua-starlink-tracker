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

import { error, info, warn } from "./logger";

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
  /** Remembers when each run started, across restarts. With it, a boot inside
   * the interval waits until last start + intervalMs instead of re-running at
   * initialDelayMs, and the interval counts from that first run. */
  stamps?: JobStampStore;
}

/** Last run start per job name, in epoch ms; null when never run or unreadable. */
export interface JobStampStore {
  read(name: string): number | null;
  write(name: string, ms: number): void;
}

/** A stamp up to this far ahead of now is clock skew between writer and
 * reader, and counts as a run that just started. */
export const STAMP_SKEW_TOLERANCE_MS = 60_000;

/** The stamp to schedule from, or null to run on the usual boot delay. A stamp
 * further ahead than the skew tolerance was written while the clock ran ahead,
 * or by a bad write; trusting it would hold the job back past its due time on
 * every restart until real time caught up. */
export function usableStampMs(lastStartMs: number | null, nowMs: number): number | null {
  if (lastStartMs === null || !Number.isFinite(lastStartMs)) return null;
  if (lastStartMs > nowMs + STAMP_SKEW_TOLERANCE_MS) return null;
  return Math.min(lastStartMs, nowMs);
}

/** First tick after boot: the usual delay, or later if the last run started
 * less than an interval ago. */
export function bootDelayMs(
  baseDelayMs: number,
  lastStartMs: number | null,
  intervalMs: number,
  nowMs: number
): number {
  const last = usableStampMs(lastStartMs, nowMs);
  if (last === null) return baseDelayMs;
  return Math.max(baseDelayMs, last + intervalMs - nowMs);
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
  const stamps = opts.stamps;

  let runSeq = 0;
  let active: { id: number; startedAt: number } | null = null;

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
    // Stamped on start, not success, so a crash-looping deploy can't re-run it.
    if (stamps) {
      try {
        stamps.write(name, active.startedAt);
      } catch (err) {
        error(`[job:${name}] could not store run stamp`, err);
      }
    }
    try {
      await run({ isCurrent: () => active?.id === id });
    } catch (err) {
      error(`[job:${name}] run failed`, err);
    } finally {
      if (active?.id === id) active = null;
    }
  };

  const safeTick = () => {
    tick().catch((err) => error(`[job:${name}] scheduler error`, err));
  };

  if (stamps) {
    let last: number | null = null;
    try {
      last = stamps.read(name);
    } catch (err) {
      error(`[job:${name}] could not read run stamp; running on the boot schedule`, err);
    }
    const bootNow = clock.now();
    if (last !== null && Number.isFinite(last) && usableStampMs(last, bootNow) === null) {
      warn(
        `[job:${name}] run stamp ${new Date(last).toISOString()} is ahead of now; ignoring it and running on the boot schedule`
      );
      last = null;
    }
    const delay = bootDelayMs(initialDelayMs ?? intervalMs, last, intervalMs, bootNow);
    if (last !== null && delay > (initialDelayMs ?? intervalMs)) {
      info(
        `[job:${name}] last run ${Math.round((bootNow - last) / 60000)}min ago; next in ${Math.round(delay / 60000)}min`
      );
    }
    let interval: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const initial = clock.setTimeout(() => {
      if (stopped) return;
      safeTick();
      interval = clock.setInterval(safeTick, intervalMs);
    }, delay);
    return {
      tick,
      stop: () => {
        stopped = true;
        clock.clearTimeout(initial);
        if (interval !== null) clock.clearInterval(interval);
      },
    };
  }

  const interval = clock.setInterval(safeTick, intervalMs);
  const initial = initialDelayMs !== undefined ? clock.setTimeout(safeTick, initialDelayMs) : null;

  return {
    tick,
    stop: () => {
      clock.clearInterval(interval);
      if (initial !== null) clock.clearTimeout(initial);
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
