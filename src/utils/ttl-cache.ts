/**
 * The in-process caches the request path keeps: a synchronous TTL memo, its
 * stale-while-revalidate twin, and a promise cache whose entries live as long
 * as their outcome deserves. One clock for all three: unix seconds, passed as
 * `nowSec` so a test's injected clock and the TTL compare share a timebase.
 */

import { unixNow } from "../database/sql/windows";

interface MemoOptions {
  ttlSec: number;
  /** Past this many entries a write first sweeps the expired ones. */
  maxEntries: number;
}

/** A synchronous value memo. A key recomputes once its entry is `ttlSec` old. */
export function memo<T>(opts: MemoOptions) {
  const entries = new Map<string, { value: T; at: number }>();
  return (key: string, compute: () => T, nowSec = unixNow()): T => {
    const hit = entries.get(key);
    if (hit && nowSec - hit.at < opts.ttlSec) return hit.value;
    const value = compute();
    if (entries.size >= opts.maxEntries) {
      for (const [k, e] of entries) if (nowSec - e.at >= opts.ttlSec) entries.delete(k);
    }
    entries.set(key, { value, at: nowSec });
    return value;
  };
}

/**
 * Stale-while-revalidate, single-flight: a cold key computes inline; an
 * expired one is served as-is while one rebuild runs after the response. A
 * failed rebuild keeps the stale value and lets the next request retry.
 */
export function memoStale<T>(opts: {
  ttlSec: number;
  onError?: (key: string, err: unknown) => void;
}) {
  const entries = new Map<string, { value: T; at: number; refreshing: boolean }>();
  return (key: string, compute: () => T, nowSec = unixNow()): T => {
    const hit = entries.get(key);
    if (!hit) {
      const value = compute();
      entries.set(key, { value, at: nowSec, refreshing: false });
      return value;
    }
    if (nowSec - hit.at >= opts.ttlSec && !hit.refreshing) {
      hit.refreshing = true;
      setTimeout(() => {
        try {
          entries.set(key, { value: compute(), at: unixNow(), refreshing: false });
        } catch (err) {
          hit.refreshing = false;
          opts.onError?.(key, err);
        }
      }, 0);
    }
    return hit.value;
  };
}

/**
 * One `make()` per owner object, released with it: per-app caches keyed on
 * something the app holds (its reader factory) so two apps in one process —
 * tests, mainly — never share entries.
 */
export function perOwner<O extends object, V>(make: () => V): (owner: O) => V {
  const byOwner = new WeakMap<O, V>();
  return (owner) => {
    let v = byOwner.get(owner);
    if (v === undefined) {
      v = make();
      byOwner.set(owner, v);
    }
    return v;
  };
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Keyed in-flight promises: concurrent callers share one fetch, and once it
 * settles `ttlFor` sets how long its outcome is replayed (0 evicts). A
 * rejection is always handled here, so a cached promise never surfaces as an
 * unhandled rejection.
 */
export function memoPromise<T>(opts: MemoOptions) {
  interface Entry {
    promise: Promise<T>;
    at: number;
    ttl: number;
  }
  const entries = new Map<string, Entry>();

  return {
    get(key: string, nowSec: number): Promise<T> | undefined {
      const e = entries.get(key);
      return e && nowSec - e.at < e.ttl ? e.promise : undefined;
    },

    set(
      key: string,
      promise: Promise<T>,
      nowSec: number,
      ttlFor: (s: Settled<T>) => number = () => opts.ttlSec
    ): void {
      if (entries.size > opts.maxEntries) {
        for (const [k, e] of entries) if (nowSec - e.at >= e.ttl) entries.delete(k);
      }
      const entry: Entry = { promise, at: nowSec, ttl: opts.ttlSec };
      entries.set(key, entry);
      const settle = (s: Settled<T>) => {
        if (entries.get(key) !== entry) return;
        entry.ttl = ttlFor(s);
        if (entry.ttl <= 0) entries.delete(key);
      };
      promise.then(
        (value) => settle({ ok: true, value }),
        (error) => settle({ ok: false, error })
      );
    },

    clear(): void {
      entries.clear();
    },
  };
}
