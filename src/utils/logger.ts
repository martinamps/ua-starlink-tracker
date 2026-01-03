import fs from "node:fs";
import path from "node:path";
import { injectTraceContext } from "../observability/tracer";

export const LOG_DIR = process.env.LOG_DIR || "./logs";
const LOG_PATH = path.join(LOG_DIR, "app.log");

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

/**
 * Extract the calling filename from the stack trace
 */
function getCallerFile(): string {
  const err = new Error();
  const stack = err.stack?.split("\n") || [];

  // Walk the stack to find the first non-logger caller
  for (let i = 2; i < stack.length; i++) {
    const line = stack[i];
    // Match file path in stack trace: "at func (file:line:col)" or "at file:line:col"
    const match = line.match(/at\s+.*?\((.+?):\d+:\d+\)/) || line.match(/at\s+(.+?):\d+:\d+/);
    if (match) {
      const fullPath = match[1];
      if (fullPath.includes("logger.ts")) continue;
      // Return filename without extension
      const basename = path.basename(fullPath);
      return basename.replace(/\.[tj]sx?$/, "");
    }
  }
  return "app";
}

function writeToFile(line: string) {
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // Silent fail for file writes
  }
}

function formatData(data: unknown): unknown {
  if (data === undefined) return undefined;
  if (typeof data === "string") return data;
  if (data instanceof Error) return { error: data.message, stack: data.stack };
  return data;
}

function log(level: LogLevel, message: string, data?: unknown) {
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: level.toLowerCase(),
    logger: getCallerFile(),
    message,
  };

  // Add data if present
  const formattedData = formatData(data);
  if (formattedData !== undefined) {
    record.data = formattedData;
  }

  // Inject trace context if active span exists
  injectTraceContext(record);

  const jsonLine = JSON.stringify(record);
  writeToFile(jsonLine);

  // Skip debug logs in production
  if (level === "DEBUG" && process.env.NODE_ENV === "production") {
    return;
  }

  // In subprocess mode, use stderr for all logs to keep stdout clean for JSON
  const useStderr = process.env.SUBPROCESS_MODE === "1";

  if (useStderr || level === "ERROR" || level === "WARN") {
    console.error(jsonLine);
  } else {
    console.log(jsonLine);
  }
}

// Main logger object
export const logger = {
  info: (message: string, data?: unknown) => log("INFO", message, data),
  warn: (message: string, data?: unknown) => log("WARN", message, data),
  error: (message: string, data?: unknown) => log("ERROR", message, data),
  debug: (message: string, data?: unknown) => log("DEBUG", message, data),
};

// Convenience exports for destructuring: import { log } from "./logger"
export const { info, warn, error, debug } = logger;

// Legacy export for backward compatibility during migration
export const verifierLog = logger;
export function createLogger(_prefix: string) {
  return logger;
}
