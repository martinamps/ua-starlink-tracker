/**
 * Observability Module - Barrel Export
 *
 * Usage:
 *   import { withSpan, metrics, COUNTERS } from "../observability";
 */

export { tracer, withSpan, getActiveSpan, injectTraceContext } from "./tracer";
export type { Span } from "./tracer";
export {
  metrics,
  COUNTERS,
  GAUGES,
  DISTRIBUTIONS,
  normalizeAircraftType,
  normalizeWifiProvider,
  normalizeFleet,
  normalizeAirlineTag,
  normalizeScopeTag,
  flightAirlineTag,
  normalizeCarrierPrefix,
  normalizeOpCarrier,
  normalizeProbeOutcome,
  normalizeStarlinkStatus,
  classifyUserAgent,
  classifyRequest,
  normalizeExtVersion,
  requestClientTags,
  mcpClientTags,
  bucketDaysOut,
  normalizeLegMatch,
  normalizeLegReason,
  normalizeLegEffect,
  normalizeEquipmentCodeTag,
} from "./metrics";
export type { Tags } from "./metrics";
