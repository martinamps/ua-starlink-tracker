/**
 * Subprocess wrapper for united-starlink-checker
 * Isolates Playwright in a subprocess to prevent SIGKILL from crashing the main server
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { COUNTERS, metrics } from "../observability";
import type { StarlinkCheckResult } from "./united-starlink-checker";

const SCRIPT_PATH = path.join(import.meta.dir, "united-starlink-checker.ts");
const TIMEOUT_MS = 60000; // 60 second timeout

export async function checkStarlinkStatusSubprocess(
  flightNumber: string,
  date: string,
  origin: string,
  destination: string
): Promise<StarlinkCheckResult> {
  return new Promise((resolve, reject) => {
    const args = [SCRIPT_PATH, flightNumber, date, origin, destination];
    const child = spawn("bun", args, {
      stdio: ["ignore", "pipe", "inherit"], // inherit stderr for unbuffered logs
      env: { ...process.env, SUBPROCESS_MODE: "1" },
      timeout: TIMEOUT_MS,
    });

    let stdout = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        vendor: "united",
        type: "verification",
        status: "error",
      });
      reject(new Error(`Timeout after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);

      if (signal === "SIGKILL") {
        metrics.increment(COUNTERS.VENDOR_REQUEST, {
          vendor: "united",
          type: "verification",
          status: "error",
        });
        reject(new Error("Process killed (likely Playwright/bun FD bug)"));
        return;
      }

      if (code !== 0) {
        metrics.increment(COUNTERS.VENDOR_REQUEST, {
          vendor: "united",
          type: "verification",
          status: "error",
        });
        reject(new Error(`Process exited with code ${code}`));
        return;
      }

      try {
        // Extract JSON from stdout - Datadog tracer may prepend config output
        // Look for our result object which contains hasStarlink
        const jsonMatch = stdout.match(/\{[\s\S]*"hasStarlink"[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error("No valid result JSON found in output");
        }
        const result = JSON.parse(jsonMatch[0]) as StarlinkCheckResult;
        // Emit metric based on result
        if (result.error) {
          metrics.increment(COUNTERS.VENDOR_REQUEST, {
            vendor: "united",
            type: "verification",
            status: "error",
          });
        } else {
          metrics.increment(COUNTERS.VENDOR_REQUEST, {
            vendor: "united",
            type: "verification",
            status: "success",
          });
        }
        resolve(result);
      } catch (e) {
        metrics.increment(COUNTERS.VENDOR_REQUEST, {
          vendor: "united",
          type: "verification",
          status: "error",
        });
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      metrics.increment(COUNTERS.VENDOR_REQUEST, {
        vendor: "united",
        type: "verification",
        status: "error",
      });
      reject(err);
    });
  });
}
