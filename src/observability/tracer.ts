/**
 * Datadog APM Tracer Module
 *
 * IMPORTANT: This module must be imported FIRST in server.ts before any other imports.
 * profiling and runtimeMetrics must stay disabled under Bun.
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
  use(plugin: string, config?: Record<string, unknown>): TracerLike;
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
  use(_plugin, _config) {
    return noopTracer;
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
    // No global `airline` tag: DogStatsD concatenates global + per-call tags
    // (airline:hawaiian,united). The default is injected per-call in metrics.ts.
    logInjection: true,
    profiling: false,
    runtimeMetrics: false,
    startupLogs: false,
    // Disable auto-instrumentation by default — `net`/`dns` plugins trace
    // Playwright pipe FDs (tcp.connect localhost:0 noise). Re-enable only fetch.
    plugins: false,
  });

  tracer = ddTracer as unknown as TracerLike;
  // The Qatar schedule ingester hits one endpoint ~6.7k times/day; blocklist it
  // (the fetch plugin has no per-plugin sampleRate). vendor.request keeps
  // full-rate success/error/latency for those calls.
  tracer.use("fetch", {
    blocklist: [/qoreservices\.qatarairways\.com/],
  });
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
