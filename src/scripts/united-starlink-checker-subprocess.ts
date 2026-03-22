/**
 * Subprocess wrapper for united-starlink-checker
 * Isolates Playwright in a subprocess to prevent SIGKILL from crashing the main server
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { COUNTERS, DISTRIBUTIONS, metrics } from "../observability";
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
  run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
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
      stdio: ["ignore", "pipe", "inherit"], // inherit stderr for unbuffered logs
      env: { ...process.env, SUBPROCESS_MODE: "1" },
    });

    let stdout = "";
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

      if (code !== 0) {
        emit("exit_error");
        reject(new Error(`Process exited with code ${code}`));
        return;
      }

      try {
        // Extract JSON from stdout - Datadog tracer may prepend config output
        // Find the JSON object starting on its own line (not embedded in Datadog output)
        const lines = stdout.split("\n");
        let jsonStr = "";
        let inJson = false;
        let braceCount = 0;

        for (const line of lines) {
          if (!inJson && line.trim().startsWith("{") && !line.includes("DATADOG")) {
            inJson = true;
          }
          if (inJson) {
            jsonStr += line + "\n";
            braceCount += (line.match(/\{/g) || []).length;
            braceCount -= (line.match(/\}/g) || []).length;
            if (braceCount === 0) break;
          }
        }

        if (!jsonStr || !jsonStr.includes("hasStarlink")) {
          throw new Error("No valid result JSON found in output");
        }
        const result = JSON.parse(jsonStr.trim()) as StarlinkCheckResult;
        emit(result.error ? "scrape_error" : "success");
        resolve(result);
      } catch (e) {
        emit("parse_error");
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      emit("spawn_error");
      reject(err);
    });
  });
}
