import fs from "node:fs";
import path from "node:path";

export const LOG_DIR = process.env.LOG_DIR || "./logs";
const LOG_PATH = path.join(LOG_DIR, "verifier.log");

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function formatMessage(level: LogLevel, prefix: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  let line = `${timestamp} [${level}] [${prefix}] ${message}`;
  if (data !== undefined) {
    const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    line += `\n${dataStr}`;
  }
  return line;
}

function writeToFile(line: string) {
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch (err) {
    console.error("Failed to write to log file:", err);
  }
}

export function createLogger(prefix: string) {
  return {
    info(message: string, data?: unknown) {
      const line = formatMessage("INFO", prefix, message, data);
      console.log(`[${prefix}] ${message}`);
      writeToFile(line);
    },

    warn(message: string, data?: unknown) {
      const line = formatMessage("WARN", prefix, message, data);
      console.warn(`[${prefix}] ${message}`);
      writeToFile(line);
    },

    error(message: string, data?: unknown) {
      const line = formatMessage("ERROR", prefix, message, data);
      console.error(`[${prefix}] ${message}`);
      writeToFile(line);
    },

    debug(message: string, data?: unknown) {
      const line = formatMessage("DEBUG", prefix, message, data);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[${prefix}] ${message}`);
      }
      writeToFile(line);
    },
  };
}

export const verifierLog = createLogger("Verifier");
