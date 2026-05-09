/**
 * Subprocess wrapper for united-starlink-checker
 * Isolates Playwright in a subprocess to prevent SIGKILL from crashing the main server
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { COUNTERS, DISTRIBUTIONS, metrics } from "../observability";
import { warn } from "../utils/logger";
import type { StarlinkCheckResult } from "./united-starlink-checker";

const SCRIPT_PATH = path.join(import.meta.dir, "united-starlink-checker.ts");
const TIMEOUT_MS = 60000; // 60 second timeout

// Process-wide mutex: only ONE Playwright subprocess may run at a time.
// verifier + discovery + any ad-hoc caller all serialize through this.
let inFlight: Promise<unknown> | null = null;

// Distinct status values let us alert on specific failure modes
// (e.g. a spike in `timeout` means United is slow; `killed` means
// the Playwright/bun FD bug is flaring up).
type UnitedStatus =
  | "success"
  | "scrape_error" // subprocess ran clean but result.error set (DOM parse etc)
  | "timeout"
  | "killed"
  | "exit_error"
  | "parse_error"
  | "spawn_error";

function emitUnitedMetrics(status: UnitedStatus, startedAt: number) {
  const tags = { vendor: "united", type: "verification", status };
  metrics.increment(COUNTERS.VENDOR_REQUEST, tags);
  metrics.distribution(DISTRIBUTIONS.VENDOR_DURATION_MS, Date.now() - startedAt, tags);
}

export async function checkStarlinkStatusSubprocess(
  flightNumber: string,
  date: string,
  origin: string,
  destination: string
): Promise<StarlinkCheckResult> {
  // Wait for any in-flight scrape to finish before starting ours.
  while (inFlight) {
    await inFlight.catch(() => {});
  }

  const run = runSubprocess(flightNumber, date, origin, destination);
  inFlight = run;
  // .finally() returns a chained promise that also rejects when run rejects.
  // Nothing consumes that chain → unhandled rejection. The caller already
  // gets the rejection via `return run` below, so swallow the chain's copy.
  run
    .finally(() => {
      if (inFlight === run) inFlight = null;
    })
    .catch(() => {});
  return run;
}

// Datadog tracer may prepend config lines; scan for the first JSON object
// on its own line and balance braces so we don't grab a partial object.
function extractResultJson(stdout: string): StarlinkCheckResult | null {
  const lines = stdout.split("\n");
  let jsonStr = "";
  let inJson = false;
  let braceCount = 0;

  for (const line of lines) {
    if (!inJson && line.trim().startsWith("{") && !line.includes("DATADOG")) {
      inJson = true;
    }
    if (inJson) {
      jsonStr += `${line}\n`;
      braceCount += (line.match(/\{/g) || []).length;
      braceCount -= (line.match(/\}/g) || []).length;
      if (braceCount === 0) break;
    }
  }

  if (!jsonStr || !jsonStr.includes("hasStarlink")) return null;
  try {
    return JSON.parse(jsonStr.trim()) as StarlinkCheckResult;
  } catch {
    return null;
  }
}

function runSubprocess(
  flightNumber: string,
  date: string,
  origin: string,
  destination: string
): Promise<StarlinkCheckResult> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const args = [SCRIPT_PATH, flightNumber, date, origin, destination];
    // No `timeout` option on spawn — we run our own timer so the SIGKILL shows
    // up in the close handler with a known `timedOut` flag. Node's built-in
    // timeout sends SIGTERM at the same instant and races, making timeouts
    // nondeterministically look like exit_error.
    const child = spawn("bun", args, {
      // Pipe stderr so launch/Playwright errors land in our structured logger
      // instead of vanishing into the container's stdout stream.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUBPROCESS_MODE: "1" },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let metricsEmitted = false;

    // close fires after our timeout kills the child; guard so we emit exactly once.
    const emit = (status: UnitedStatus) => {
      if (metricsEmitted) return;
      metricsEmitted = true;
      emitUnitedMetrics(status, startedAt);
    };

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      emit("timeout");
      reject(new Error(`Timeout after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);

      if (signal === "SIGKILL") {
        // timedOut=true means we killed it; otherwise the OS/bun did (FD bug, OOM).
        emit(timedOut ? "timeout" : "killed");
        reject(
          new Error(
            timedOut
              ? `Timeout after ${TIMEOUT_MS / 1000}s`
              : "Process killed (likely Playwright/bun FD bug)"
          )
        );
        return;
      }

      const result = extractResultJson(stdout);

      if (code !== 0) {
        // Subprocess mode now exits 0 even on scrape errors, so a non-zero
        // exit means a hard crash (module load, OOM). Prefer whatever the
        // child managed to write before dying; fall back to its stderr so
        // the log row carries the real reason instead of just the code.
        if (stderr.trim()) {
          warn(`Checker subprocess exited ${code}`, { stderr: stderr.slice(-2000) });
        }
        if (result) {
          emit("scrape_error");
          resolve(result.error ? result : { ...result, error: `Process exited with code ${code}` });
          return;
        }
        emit("exit_error");
        const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
        reject(new Error(`Process exited with code ${code}${detail ? `: ${detail}` : ""}`));
        return;
      }

      if (!result) {
        emit("parse_error");
        if (stderr.trim()) {
          warn("Checker subprocess produced no parseable JSON", { stderr: stderr.slice(-2000) });
        }
        reject(new Error(`Failed to parse output: ${stdout}`));
        return;
      }
      emit(result.error ? "scrape_error" : "success");
      resolve(result);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      emit("spawn_error");
      reject(err);
    });
  });
}
