/**
 * Subprocess wrapper for united-starlink-checker
 * Isolates Playwright in a subprocess to prevent SIGKILL from crashing the main server
 */

import { spawn } from "node:child_process";
import path from "node:path";
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
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SUBPROCESS_MODE: "1" },
      timeout: TIMEOUT_MS,
    });

    let stdout = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    // Forward child's stderr to parent's stderr (preserves log output)
    child.stderr.pipe(process.stderr);

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timeout after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timeout);

      if (signal === "SIGKILL") {
        reject(new Error("Process killed (likely Playwright/bun FD bug)"));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}`));
        return;
      }

      try {
        const result = JSON.parse(stdout) as StarlinkCheckResult;
        resolve(result);
      } catch (e) {
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
