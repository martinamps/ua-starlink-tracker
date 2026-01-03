/**
 * Observability Module - Barrel Export
 *
 * Usage:
 *   import { withSpan, metrics, COUNTERS } from "../observability";
 */

export { tracer, withSpan, getActiveSpan, injectTraceContext } from "./tracer";
export type { Span } from "./tracer";
export { metrics, COUNTERS, GAUGES } from "./metrics";
export type { Tags } from "./metrics";
