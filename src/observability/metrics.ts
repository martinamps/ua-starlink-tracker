/**
 * Datadog Metrics Module
 *
 * Provides typed helpers for emitting metrics via DogStatsD.
 * All metrics are prefixed with "starlink." for consistency.
 *
 * Naming Convention: starlink.{category}.{action}
 */

import { tracer } from "./tracer";

export type Tags = Record<string, string | number>;

/**
 * Typed metrics helpers with consistent "starlink." prefix
 */
export const metrics = {
  /**
   * Increment a counter by 1
   * @param name - Metric name (will be prefixed with "starlink.")
   * @param tags - Optional tags (low cardinality only!)
   */
  increment: (name: string, tags?: Tags) => {
    tracer.dogstatsd.increment(`starlink.${name}`, 1, tags);
  },

  /**
   * Set a gauge value
   * @param name - Metric name (will be prefixed with "starlink.")
   * @param value - Gauge value
   * @param tags - Optional tags
   */
  gauge: (name: string, value: number, tags?: Tags) => {
    tracer.dogstatsd.gauge(`starlink.${name}`, value, tags);
  },

  /**
   * Record a histogram value (for timing, sizes, etc.)
   * @param name - Metric name (will be prefixed with "starlink.")
   * @param value - Value to record
   * @param tags - Optional tags
   */
  histogram: (name: string, value: number, tags?: Tags) => {
    tracer.dogstatsd.histogram(`starlink.${name}`, value, tags);
  },
};

// ============ Pre-defined Metric Names ============

/**
 * Counter metrics - increment on events
 *
 * Usage:
 *   metrics.increment(COUNTERS.SCRAPER_SYNC, { source: "spreadsheet" });
 *   metrics.increment(COUNTERS.VENDOR_REQUEST, { vendor: "flightaware", type: "flights", status: "success" });
 */
export const COUNTERS = {
  // Scraper events
  SCRAPER_SYNC: "scraper.sync", // tags: source:spreadsheet|fr24
  PLANES_DISCOVERED: "planes.discovered", // tags: source:spreadsheet|fr24
  PLANES_STARLINK_DETECTED: "planes.starlink_detected",

  // Verification events
  VERIFICATION_CHECK: "verification.check", // tags: result:success|error
  VERIFICATION_MISMATCH: "verification.mismatch",

  // External API calls
  // vendors: flightaware, fr24, united
  // types: flights (flight data), fleet (aircraft list), verification (starlink check)
  // status: success, rate_limited, error
  VENDOR_REQUEST: "vendor.request",

  // HTTP requests
  HTTP_REQUEST: "http.request", // tags: method, route, status_code
} as const;

/**
 * Gauge metrics - set current values
 *
 * Usage:
 *   metrics.gauge(GAUGES.PLANES_TOTAL, 150);
 */
export const GAUGES = {
  PLANES_TOTAL: "planes.total",
  PLANES_PENDING: "planes.pending",
  PLANES_VERIFIED_STARLINK: "planes.verified_starlink",
} as const;
