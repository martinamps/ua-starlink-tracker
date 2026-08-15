/**
 * Log-level policy.
 *
 * The ingestion reduction in the flight-updater / adsb-shadow / verifier paths
 * rests on one property: DEBUG is written to the on-disk log but never to
 * stdout/stderr in production, and Datadog ingests the console stream. If that
 * ever changes, those call sites silently start costing again — so it is pinned
 * here rather than left as a comment.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger } from "../src/utils/logger";

let out: string[] = [];
let err: string[] = [];
let origLog: typeof console.log;
let origErr: typeof console.error;
let origEnv: string | undefined;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  origEnv = process.env.NODE_ENV;
  console.log = (line: string) => out.push(String(line));
  console.error = (line: string) => err.push(String(line));
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.env.NODE_ENV = origEnv ?? "";
});

describe("debug suppression in production", () => {
  test("debug does not reach the console when NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    logger.debug("noisy per-tail line");
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("debug does reach the console outside production", () => {
    process.env.NODE_ENV = "development";
    logger.debug("noisy per-tail line");
    expect(out.length + err.length).toBe(1);
  });

  test("info, warn and error are never suppressed", () => {
    process.env.NODE_ENV = "production";
    logger.info("kept");
    logger.warn("kept");
    logger.error("kept");
    expect(out.length + err.length).toBe(3);
  });

  test("warn and error go to stderr, info to stdout", () => {
    process.env.NODE_ENV = "production";
    logger.info("i");
    expect(out.length).toBe(1);
    out = [];
    logger.warn("w");
    logger.error("e");
    expect(err.length).toBe(2);
    expect(out).toEqual([]);
  });
});

describe("structured fields", () => {
  test("counters passed as data stay out of the message so lines group", () => {
    process.env.NODE_ENV = "production";
    logger.info("Heartbeat: verifier scheduler healthy", { runs: 1234 });
    const record = JSON.parse(out[0]) as { message: string; data?: Record<string, unknown> };
    // The message must be constant across runs — an incrementing counter
    // interpolated into it makes every line a distinct pattern in Datadog.
    expect(record.message).not.toContain("1234");
    expect(record.data).toMatchObject({ runs: 1234 });
  });
});
