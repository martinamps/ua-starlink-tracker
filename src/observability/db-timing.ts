/**
 * SQLite timing attribution.
 *
 * APM had no visibility into the query layer at all: dd-trace runs with
 * `plugins: false` and bun:sqlite has no dd-trace plugin regardless, so page
 * latency could not be attributed to SQL. Answering "did this query regress"
 * meant reading the diff and guessing.
 *
 * The obvious fix — a span per query — was rejected: this service already emits
 * 72% of the org's APM ingest, the background jobs run tens of thousands of
 * queries a day, and a span each would multiply that for signal nobody reads
 * most of the time.
 *
 * Instead each query's duration is folded into the span that is ALREADY open
 * (web.request for a page, the job span for a background tick) as two tags:
 *
 *   db.query_count — how many queries this request/tick ran
 *   db.time_ms     — how long it spent inside SQLite
 *
 * Zero new spans, and it answers both questions that mattered: what share of a
 * request is SQL, and is a handler running an N+1 (a query_count that scales
 * with result size rather than staying flat).
 */

import { type Span, getActiveSpan } from "./tracer";

export type { Span };

/** Per-span accumulator. Weak so a finished span is collectable. */
const perSpan = new WeakMap<Span, { n: number; ms: number }>();

/** Which span to attribute to. Injectable so this is testable: with tracing
 * disabled (tests, local dev) the tracer is a no-op and getActiveSpan() is
 * always null, which would make the whole path unobservable. */
export type SpanSource = () => Span | null;

function record(elapsedMs: number, spanFor: SpanSource): void {
  const span = spanFor();
  if (!span) return;
  const acc = perSpan.get(span) ?? { n: 0, ms: 0 };
  acc.n += 1;
  acc.ms += elapsedMs;
  perSpan.set(span, acc);
  // Re-set on every query: last write wins, so the span carries the running
  // total and needs no end-of-request hook to finalize it.
  span.setTag("db.query_count", acc.n);
  span.setTag("db.time_ms", Math.round(acc.ms * 1000) / 1000);
}

type AnyFn = (...args: unknown[]) => unknown;
const TIMED_METHODS = ["all", "get", "run", "values", "iterate"] as const;

/** Wrap a prepared statement so its execution methods report their duration. */
function timeStatement<T extends object>(stmt: T, spanFor: SpanSource): T {
  for (const name of TIMED_METHODS) {
    const original = (stmt as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    (stmt as Record<string, unknown>)[name] = function timed(this: unknown, ...args: unknown[]) {
      const started = performance.now();
      try {
        return (original as AnyFn).apply(this, args);
      } finally {
        record(performance.now() - started, spanFor);
      }
    };
  }
  return stmt;
}

interface QueryableDb {
  query: (sql: string) => unknown;
}

/**
 * Instrument a database handle in place.
 *
 * Wraps `query()` so the statement it returns reports execution time. bun:sqlite
 * caches prepared statements per SQL string, so a statement can be handed back
 * more than once — wrapping is therefore idempotent per statement object, and
 * re-instrumenting the same handle is a no-op.
 */
export function instrumentDatabase<T extends QueryableDb>(
  db: T,
  spanFor: SpanSource = getActiveSpan
): T {
  const flag = db as unknown as { __dbTimingInstrumented?: boolean };
  if (flag.__dbTimingInstrumented) return db;
  flag.__dbTimingInstrumented = true;

  const originalQuery = db.query.bind(db);
  const wrapped = new WeakSet<object>();
  db.query = (sql: string) => {
    const stmt = originalQuery(sql);
    if (stmt && typeof stmt === "object" && !wrapped.has(stmt)) {
      wrapped.add(stmt);
      timeStatement(stmt, spanFor);
    }
    return stmt;
  };
  return db;
}

/** Test-only view of what a span accumulated. */
export function dbStatsForSpan(span: Span): { n: number; ms: number } | undefined {
  return perSpan.get(span);
}
