/**
 * Each caller's own share of the live FR24 lookups.
 *
 * The request-path guards in flight-verdict.ts are shared by everyone: three
 * queue places two seconds apart, fifteen lookups a minute. One caller sending
 * a batch took every place, and the next person read "Live assignment lookup
 * is busy" for a flight that could have been verified. Here a caller is the
 * same thing the per-address limiter counts (its bucket and the address), and
 * a caller past its share is answered with the estimate at once, without
 * asking for a queue place.
 *
 * The address lives only as a key of the map below: never in a log, a metric
 * tag or the database.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { LookupCaller } from "../observability";

export interface LookupAsker {
  caller: LookupCaller;
  /** The limiter's bucket and address; null = no share kept (local calls). */
  key: string | null;
}

const askers = new AsyncLocalStorage<LookupAsker>();

/** Runs a request's handler as its caller, so a lookup deep inside knows whose it is. */
export function asLookupAsker<T>(asker: LookupAsker, run: () => T): T {
  return askers.run(asker, run);
}

export function currentLookupAsker(): LookupAsker | undefined {
  return askers.getStore();
}

export interface LookupAllowance {
  /** Lookups in hand at once: waiting for a place or being fetched. */
  atOnce: number;
  /** Lookups a caller that has been quiet may take in a row. */
  burst: number;
  /** Lookups a minute once the burst is spent. */
  perMin: number;
}

// One Google Flights page is many flights from one address, and an assistant's
// users share its few addresses, so these two fan out. The extension runs
// three cards at a time (CARD_CONCURRENCY) and stops a pass at 40 new lookups
// (MAX_NEW_LOOKUPS_PER_PASS, both chrome-extension/content.js). Places are 2s
// apart, so the 40th lookup of a pass that needs all 40 comes 78s after the
// first, by when 7 have refilled: 33 are needed, and 34 leaves one to spare.
// Three at once is the whole queue: with fewer, the third card would be shed
// again (flight-verdict.ts, FR24_REQUEST_MAX_QUEUE_MS).
// tests/lookup-budget.test.ts walks that pass against the extension's numbers.
export const FAN_OUT_ALLOWANCE: LookupAllowance = { atOnce: 3, burst: 34, perMin: 6 };
// A person on our page checks one flight at a time, a handful in a minute. Two
// at once leaves the third queue place to somebody else whatever this caller
// sends. Six a minute is under half of the fifteen everyone shares.
export const SINGLE_ALLOWANCE: LookupAllowance = { atOnce: 2, burst: 6, perMin: 6 };

export function lookupAllowance(caller: LookupCaller): LookupAllowance {
  return caller === "extension" || caller === "mcp" ? FAN_OUT_ALLOWANCE : SINGLE_ALLOWANCE;
}

// ~200 bytes a caller. The flight check API sees about a thousand addresses a
// week, so the cap is only ever met by a flood of new ones.
export const MAX_LOOKUP_CALLERS = 5000;
const SWEEP_INTERVAL_SEC = 60;
// A lookup ends within its 9s deadline, 14s if the transport's own guard has
// to fire. One still counted in hand after this never reported back, and must
// not lock its caller out for good.
export const LOOKUP_IN_HAND_MAX_SEC = 30;

interface Share {
  tokens: number;
  at: number;
  open: number;
  takenAt: number;
  allowance: LookupAllowance;
}

export class LookupBudget {
  private shares = new Map<string, Share>();
  private sweptAt = 0;

  constructor(private maxCallers = MAX_LOOKUP_CALLERS) {}

  /** Claims one lookup; false = this caller is past its share. */
  take(key: string, allowance: LookupAllowance, nowSec: number): boolean {
    let share = this.shares.get(key);
    if (share) {
      // Re-inserted so the map's order is least-recently-asked first.
      this.shares.delete(key);
      refill(share, nowSec);
      share.allowance = allowance;
    } else {
      this.makeRoom(nowSec);
      share = { tokens: allowance.burst, at: nowSec, open: 0, takenAt: nowSec, allowance };
    }
    this.shares.set(key, share);
    if (share.open >= allowance.atOnce || share.tokens < 1) return false;
    share.tokens -= 1;
    share.open += 1;
    share.takenAt = nowSec;
    return true;
  }

  /**
   * Ends a claimed lookup. `asked: false` gives the lookup back: it was shed
   * before FR24 was asked, so it took nobody's place.
   */
  settle(key: string, { asked }: { asked: boolean }): void {
    const share = this.shares.get(key);
    if (!share) return;
    share.open = Math.max(0, share.open - 1);
    if (!asked) share.tokens = Math.min(share.allowance.burst, share.tokens + 1);
  }

  get size(): number {
    return this.shares.size;
  }

  clear(): void {
    this.shares.clear();
    this.sweptAt = 0;
  }

  private makeRoom(nowSec: number): void {
    if (nowSec - this.sweptAt >= SWEEP_INTERVAL_SEC || this.shares.size >= this.maxCallers) {
      this.sweptAt = nowSec;
      for (const [key, share] of this.shares) {
        refill(share, nowSec);
        // A full share with nothing in hand is what a new caller starts with.
        if (share.open === 0 && share.tokens >= share.allowance.burst) this.shares.delete(key);
      }
    }
    // Still full: every caller is mid-budget. The one that asked longest ago
    // goes, and starts afresh if it returns. A lookup of its own still in hand
    // settles against nothing.
    while (this.shares.size >= this.maxCallers) {
      const oldest = this.shares.keys().next();
      if (oldest.done) break;
      this.shares.delete(oldest.value);
    }
  }
}

function refill(share: Share, nowSec: number): void {
  if (nowSec - share.takenAt > LOOKUP_IN_HAND_MAX_SEC) share.open = 0;
  const elapsed = Math.max(0, nowSec - share.at);
  share.tokens = Math.min(
    share.allowance.burst,
    share.tokens + (elapsed * share.allowance.perMin) / 60
  );
  share.at = Math.max(share.at, nowSec);
}
