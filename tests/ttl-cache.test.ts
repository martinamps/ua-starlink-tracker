import { describe, expect, test } from "bun:test";
import { memo, memoPromise, perOwner } from "../src/utils/ttl-cache";

describe("memo", () => {
  test("recomputes only once the entry is ttl old", () => {
    const m = memo<number>(1000);
    let calls = 0;
    const compute = () => ++calls;
    expect(m("k", compute, 0)).toBe(1);
    expect(m("k", compute, 999)).toBe(1);
    expect(m("k", compute, 1000)).toBe(2);
    expect(m("other", compute, 1000)).toBe(3);
  });

  test("perOwner keeps one instance per owner", () => {
    const of = perOwner<object, number[]>(() => []);
    const a = {};
    expect(of(a)).toBe(of(a));
    expect(of(a)).not.toBe(of({}));
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
