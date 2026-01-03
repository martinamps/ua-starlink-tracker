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

import tracer, { type Span } from "dd-trace";
import formats from "dd-trace/ext/formats";

const isEnabled = process.env.DD_TRACE_ENABLED === "true";

// Only initialize tracer when enabled to avoid overhead in development
if (isEnabled) {
  tracer.init({
    service: process.env.DD_SERVICE || "ua-starlink-tracker",
    env: process.env.DD_ENV || "development",
    version: process.env.DD_VERSION || "unknown",
    logInjection: true,
    profiling: false, // Required for Bun compatibility
    runtimeMetrics: false, // Required for Bun compatibility
    startupLogs: true,
  });
}

// ============ Ergonomic Helpers ============

/**
 * Wrap an async function in a trace span - cleaner than tracer.trace() directly
 * Automatically handles errors and sets common tags
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  tags?: Record<string, string | number>
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
  });
}

/**
 * Get current active span for trace context injection
 */
export function getActiveSpan(): Span | null {
  return tracer.scope().active();
}

/**
 * Inject trace context into a log record for correlation
 */
export function injectTraceContext(record: Record<string, unknown>): void {
  const span = tracer.scope().active();
  if (span) {
    tracer.inject(span.context(), formats.LOG, record);
  }
}

export { tracer };
export type { Span };
