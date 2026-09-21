/**
 * The in-process caches the request path keeps: a synchronous TTL memo and a
 * promise cache whose entries live as long as their outcome deserves.
 */

/** A synchronous value memo. `get` recomputes once an entry is `ttlMs` old. */
export function memo<T>(ttlMs: number) {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  return (key: string, compute: () => T, now = Date.now()): T => {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = compute();
    entries.set(key, { value, expiresAt: now + ttlMs });
    return value;
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
 * settles `ttlFor` sets how long its outcome is replayed (0 evicts). Clocks are
 * caller-supplied seconds, so a test's injected `now` and the TTL compare share
 * one timebase. A rejection is always handled here, so a cached promise never
 * surfaces as an unhandled rejection.
 */
export function memoPromise<T>(opts: { ttlSec: number; maxEntries: number }) {
  interface Entry {
    promise: Promise<T>;
    at: number;
    ttl: number;
  }
  const entries = new Map<string, Entry>();

  return {
    get(key: string, now: number): Promise<T> | undefined {
      const e = entries.get(key);
      return e && now - e.at < e.ttl ? e.promise : undefined;
    },

    set(
      key: string,
      promise: Promise<T>,
      now: number,
      ttlFor: (s: Settled<T>) => number = () => opts.ttlSec
    ): void {
      if (entries.size > opts.maxEntries) {
        for (const [k, e] of entries) if (now - e.at >= e.ttl) entries.delete(k);
      }
      const entry: Entry = { promise, at: now, ttl: opts.ttlSec };
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
