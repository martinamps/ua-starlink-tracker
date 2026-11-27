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
  normalizeChartRejectReason,
  normalizeScopeTag,
  flightAirlineTag,
  normalizeCarrierPrefix,
  normalizeOpCarrier,
  normalizeProbeOutcome,
  normalizeAirborneMatch,
  normalizeStarlinkStatus,
  classifyUserAgent,
  classifyRequest,
  classifyVisitSource,
  classifyLookupCaller,
  normalizeLookupCaller,
  normalizeLookupShedReason,
  normalizeExtVersion,
  requestClientTags,
  mcpClientTags,
  classifyMcpClient,
  isOwnMonitorAgent,
  bucketDaysOut,
  normalizeLegMatch,
  normalizeLegReason,
  normalizeMcpErrorReason,
  normalizeLegEffect,
  normalizeEquipmentCodeTag,
} from "./metrics";
export type { LookupCaller, LookupShedReason, Tags } from "./metrics";
