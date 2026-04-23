/**
 * Datadog APM Tracer Module
 *
 * IMPORTANT: This module must be imported FIRST in server.ts before any other imports.
 *
 * Bun Compatibility Notes:
 * - dd-trace works with Bun v1.1.6+ but with limitations
 * - Automatic instrumentation does NOT work - must use manual tracing
 * - profiling and runtimeMetrics must be disabled
 */

export type Span = import("dd-trace").Span;

type TraceTags = Record<string, string | number>;
type TraceContextCarrier = Record<string, unknown>;

interface TracerLike {
  dogstatsd: {
    increment(name: string, value: number, tags?: TraceTags): void;
    gauge(name: string, value: number, tags?: TraceTags): void;
    distribution(name: string, value: number, tags?: TraceTags): void;
  };
  inject(context: unknown, format: unknown, record: TraceContextCarrier): void;
  scope(): { active(): Span | null };
  trace<T>(name: string, fn: (span: Span) => T | Promise<T>): T | Promise<T>;
}

const isEnabled = process.env.DD_TRACE_ENABLED === "true";

const noopSpan = {
  addTags(_tags: TraceTags) {},
  context() {
    return null;
  },
  setTag(_name: string, _value: unknown) {},
} as unknown as Span;

const noopTracer: TracerLike = {
  dogstatsd: {
    distribution(_name, _value, _tags) {},
    gauge(_name, _value, _tags) {},
    increment(_name, _value, _tags) {},
  },
  inject(_context, _format, _record) {},
  scope() {
    return { active: () => null };
  },
  trace(_name, fn) {
    return fn(noopSpan);
  },
};

let tracer: TracerLike = noopTracer;
let logFormat: unknown = null;

if (isEnabled) {
  const [{ default: ddTracer }, { default: ddFormats }] = await Promise.all([
    import("dd-trace"),
    import("dd-trace/ext/formats"),
  ]);

  ddTracer.init({
    service: process.env.DD_SERVICE || "ua-starlink-tracker",
    env: process.env.DD_ENV || "development",
    version: process.env.DD_VERSION || "unknown",
    tags: {
      airline: process.env.AIRLINE || "united",
    },
    logInjection: true,
    profiling: false,
    runtimeMetrics: false,
    startupLogs: true,
  });

  tracer = ddTracer as unknown as TracerLike;
  logFormat = ddFormats.LOG;
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  tags?: TraceTags
): Promise<T> {
  return tracer.trace(name, async (span) => {
    if (tags) {
      span.addTags(tags);
    }
    try {
      return await fn(span);
    } catch (err) {
      span.setTag("error", err);
      throw err;
    }
  }) as Promise<T>;
}

export function getActiveSpan(): Span | null {
  return tracer.scope().active();
}

export function injectTraceContext(record: TraceContextCarrier): void {
  const span = tracer.scope().active();
  if (span && logFormat) {
    tracer.inject(span.context(), logFormat, record);
  }
}

export { tracer };
