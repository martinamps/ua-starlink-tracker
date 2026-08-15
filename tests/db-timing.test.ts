/**
 * SQLite timing attribution.
 *
 * dd-trace runs with `plugins: false` and bun:sqlite has no plugin, so page
 * latency could not be attributed to SQL at all. Rather than a span per query
 * — this service already emits 72% of the org's APM ingest, and the background
 * jobs run tens of thousands of queries a day — each query's duration is folded
 * into the span that is already open, as db.query_count / db.time_ms.
 *
 * Tests inject their own span source: with tracing disabled the real tracer is
 * a no-op whose active span is always null.
 */

import { describe, expect, test } from "bun:test";
import { type Span, dbStatsForSpan, instrumentDatabase } from "../src/observability/db-timing";
import { makeSyntheticDb } from "./helpers";

/** Minimal stand-in for a dd-trace span that records the tags it is given. */
function fakeSpan() {
  const tags: Record<string, unknown> = {};
  const span = {
    setTag(k: string, v: unknown) {
      tags[k] = v;
    },
  } as unknown as Span;
  return { span, tags };
}

const instrumented = (span: Span | null) => instrumentDatabase(makeSyntheticDb(), () => span);

describe("instrumentDatabase", () => {
  test("counts queries and accumulates time onto the active span", () => {
    const { span, tags } = fakeSpan();
    const db = instrumented(span);
    db.query("SELECT 1").get();
    db.query("SELECT 2").get();
    db.query("SELECT COUNT(*) AS n FROM starlink_planes").get();

    expect(dbStatsForSpan(span)?.n).toBe(3);
    expect(tags["db.query_count"]).toBe(3);
    expect(typeof tags["db.time_ms"]).toBe("number");
    expect(tags["db.time_ms"] as number).toBeGreaterThanOrEqual(0);
    db.close();
  });

  test("all/get/run are each timed", () => {
    const { span } = fakeSpan();
    const db = instrumented(span);
    db.query("SELECT * FROM starlink_planes LIMIT 1").all();
    db.query("SELECT 1").get();
    db.query("CREATE TEMP TABLE t_timing (x INTEGER)").run();
    expect(dbStatsForSpan(span)?.n).toBe(3);
    db.close();
  });

  test("queries outside any span are a no-op, not a crash", () => {
    const db = instrumented(null);
    expect(() => db.query("SELECT 1").get()).not.toThrow();
    db.close();
  });

  test("results are unchanged by the wrapper", () => {
    const plain = makeSyntheticDb();
    const before = plain.query("SELECT 7 AS v").get();
    const { span } = fakeSpan();
    const db = instrumentDatabase(plain, () => span);
    expect(db.query("SELECT 7 AS v").get()).toEqual(before);
    db.close();
  });

  test("instrumenting twice does not double-count", () => {
    const { span } = fakeSpan();
    const once = instrumentDatabase(makeSyntheticDb(), () => span);
    const twice = instrumentDatabase(once, () => span);
    twice.query("SELECT 1").get();
    expect(dbStatsForSpan(span)?.n).toBe(1);
    twice.close();
  });

  test("a query that throws during EXECUTION still records its time", () => {
    const { span } = fakeSpan();
    const db = instrumented(span);
    db.query("CREATE TEMP TABLE t_fail (x INTEGER NOT NULL)").run();
    expect(() => db.query("INSERT INTO t_fail (x) VALUES (NULL)").run()).toThrow();
    // The CREATE plus the failed INSERT — the failure is inside .run(), so the
    // finally block still records it.
    expect(dbStatsForSpan(span)?.n).toBe(2);
    db.close();
  });

  test("a PREPARE failure is not counted — nothing executed", () => {
    // bun:sqlite prepares inside db.query(), so a bad statement throws before a
    // statement object exists to wrap. Documenting the boundary rather than
    // pretending the wrapper sees it.
    const { span } = fakeSpan();
    const db = instrumented(span);
    expect(() => db.query("SELECT * FROM no_such_table").all()).toThrow();
    expect(dbStatsForSpan(span)).toBeUndefined();
    db.close();
  });

  test("separate spans accumulate separately", () => {
    const a = fakeSpan();
    const b = fakeSpan();
    let current: Span = a.span;
    const db = instrumentDatabase(makeSyntheticDb(), () => current);
    db.query("SELECT 1").get();
    current = b.span;
    db.query("SELECT 1").get();
    db.query("SELECT 2").get();
    expect(dbStatsForSpan(a.span)?.n).toBe(1);
    expect(dbStatsForSpan(b.span)?.n).toBe(2);
    db.close();
  });

  test("a repeated SQL string is wrapped once, not layered", () => {
    // bun:sqlite caches prepared statements per SQL string; double-wrapping the
    // same statement object would count one execution twice.
    const { span } = fakeSpan();
    const db = instrumented(span);
    for (let i = 0; i < 5; i++) db.query("SELECT 1").get();
    expect(dbStatsForSpan(span)?.n).toBe(5);
    db.close();
  });
});
