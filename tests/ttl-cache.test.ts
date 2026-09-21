import { describe, expect, test } from "bun:test";
import { sleep } from "../src/utils/sleep";
import { memo, memoPromise, memoStale, perOwner } from "../src/utils/ttl-cache";

describe("memo", () => {
  test("recomputes only once the entry is ttl old", () => {
    const m = memo<number>({ ttlSec: 10, maxEntries: 100 });
    let calls = 0;
    const compute = () => ++calls;
    expect(m("k", compute, 0)).toBe(1);
    expect(m("k", compute, 9)).toBe(1);
    expect(m("k", compute, 10)).toBe(2);
    expect(m("other", compute, 10)).toBe(3);
  });

  test("past maxEntries a write sweeps the expired entries, never the live ones", () => {
    const m = memo<string>({ ttlSec: 10, maxEntries: 2 });
    m("old", () => "old", 0);
    m("live", () => "live", 5);
    m("new", () => "new", 12);
    expect(m("live", () => "again", 12)).toBe("live");
    expect(m("old", () => "rebuilt", 12)).toBe("rebuilt");
  });

  test("perOwner keeps one instance per owner", () => {
    const of = perOwner<object, number[]>(() => []);
    const a = {};
    expect(of(a)).toBe(of(a));
    expect(of(a)).not.toBe(of({}));
  });
});

describe("memoStale", () => {
  test("serves the stale value while one rebuild runs after the response", async () => {
    const m = memoStale<number>({ ttlSec: 10 });
    let calls = 0;
    const compute = () => ++calls;
    expect(m("k", compute, 0)).toBe(1);
    expect(m("k", compute, 20)).toBe(1);
    expect(m("k", compute, 21)).toBe(1);
    await sleep(0);
    expect(calls).toBe(2);
    expect(m("k", compute)).toBe(2);
  });

  test("a failed rebuild keeps the stale value and the next request retries", async () => {
    const errors: string[] = [];
    const m = memoStale<number>({ ttlSec: 10, onError: (key) => errors.push(key) });
    m("k", () => 1, 0);
    expect(
      m(
        "k",
        () => {
          throw new Error("down");
        },
        20
      )
    ).toBe(1);
    await sleep(0);
    expect(errors).toEqual(["k"]);
    expect(m("k", () => 3, 30)).toBe(1);
    await sleep(0);
    expect(m("k", () => 4)).toBe(3);
  });
});

describe("memoPromise", () => {
  test("shares the in-flight promise, then applies the outcome's ttl", async () => {
    const c = memoPromise<number[]>({ ttlSec: 100, maxEntries: 10 });
    const p = Promise.resolve([]);
    c.set("k", p, 0, (s) => (s.ok && s.value.length === 0 ? 10 : 100));
    expect(c.get("k", 5)).toBe(p);
    await p;
    expect(c.get("k", 9)).toBe(p);
    expect(c.get("k", 10)).toBeUndefined();
  });

  test("a zero ttl evicts on settle and a rejection never goes unhandled", async () => {
    const c = memoPromise<number>({ ttlSec: 100, maxEntries: 10 });
    const p = Promise.reject(new Error("down"));
    c.set("k", p, 0, (s) => (s.ok ? 100 : 0));
    await p.catch(() => {});
    expect(c.get("k", 1)).toBeUndefined();
  });

  test("a replaced entry is not touched by the old promise settling", async () => {
    const c = memoPromise<number>({ ttlSec: 100, maxEntries: 10 });
    const old = Promise.reject(new Error("old"));
    c.set("k", old, 0, () => 0);
    const fresh = Promise.resolve(1);
    c.set("k", fresh, 0);
    await old.catch(() => {});
    expect(c.get("k", 1)).toBe(fresh);
  });
});
