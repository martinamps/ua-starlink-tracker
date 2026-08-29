import { existsSync, writeFileSync } from "node:fs";
import { looksLikeValidTailNumber } from "../airlines/registry";
import { BROWSER_USER_AGENT } from "./constants";
import { error as logError } from "./logger";

/**
 * CSV Fetch & Parse Logic
 */

// Express fleet spreadsheet
const expressSpreadsheetId = "1Mmu1m381RnGMgqxMiEqMni3zJ8uxdfpbeaP6XtN1yxM";
const expressGids = [13, 1106195214, 11, 1735263052, 6, 9, 5, 969079667];

// Mainline fleet spreadsheet
const mainlineSpreadsheetId = "1ZlYgN_IZmd6CSx_nXnuP0L0PiodapDRx3RmNkIpxXAo";
const mainlineGids = [0, 1, 948315825, 3, 4, 6, 5, 70572532, 7, 8, 10, 12, 15, 13, 2098141434];

// Function to create CSV export URLs for each sheet
function createCsvExportUrls() {
  // Create URLs for express fleet sheets
  const expressUrls = expressGids.map((gid) => ({
    gid,
    fleet: "express",
    url: `https://docs.google.com/spreadsheets/d/${expressSpreadsheetId}/export?format=csv&gid=${gid}`,
  }));

  // Create URLs for mainline fleet sheets
  const mainlineUrls = mainlineGids.map((gid) => ({
    gid,
    fleet: "mainline",
    url: `https://docs.google.com/spreadsheets/d/${mainlineSpreadsheetId}/export?format=csv&gid=${gid}`,
  }));

  // Combine both sets of URLs
  return [...expressUrls, ...mainlineUrls];
}

// Function to parse CSV with proper handling of quoted fields
function parseCSV(csvText: string) {
  const lines = csvText.split("\n");
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers: string[] = [];
  let inQuotes = false;
  let currentField = "";
  const headerLine = lines[0];

  // Parse headers with proper handling of quoted fields
  for (let i = 0; i < headerLine.length; i++) {
    const char = headerLine[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      headers.push(currentField.trim());
      currentField = "";
    } else {
      currentField += char;
    }
  }
  headers.push(currentField.trim()); // Add the last header

  const rows: Record<string, string>[] = [];

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue; // Skip empty lines

    const row: string[] = [];
    inQuotes = false;
    currentField = "";

    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        row.push(currentField.trim());
        currentField = "";
      } else {
        currentField += char;
      }
    }
    row.push(currentField.trim()); // Add the last field

    // Create object from row data
    const rowObj: Record<string, string> = {};
    headers.forEach((header, index) => {
      const cleanHeader = header.replace(/"/g, "").trim();
      rowObj[cleanHeader] = index < row.length ? row[index].replace(/"/g, "").trim() : "";
    });

    rows.push(rowObj);
  }

  return { headers, rows };
}

const SHEET_EXPORT_HEADERS = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
  "Accept-Language": "en-US,en;q=0.5",
  "Cache-Control": "no-cache",
} as const;

/** A CSV-export fetch failure that knows whether retrying can ever help:
 * 429/5xx/network are transient export-endpoint moods; any other HTTP status
 * means the gid itself is bad (tab renamed or deleted — fix the gid list). */
export class SheetFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "SheetFetchError";
  }
}

// Two short retries: the export endpoint 429s/5xxs a few tabs per month near
// the end of the 23-tab serial burst (the tabs still exist — verified by
// re-fetching the failed gids), and one hourly cycle aborted over a blip is
// an hour of staleness for nothing. Permanent failures skip the waits.
const SHEET_RETRY_DELAYS_MS = [2_000, 8_000];

interface CsvFetchDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
}

export async function fetchCsvWithRetry(url: string, deps: CsvFetchDeps = {}): Promise<string> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastError: SheetFetchError | null = null;
  for (let attempt = 0; attempt <= SHEET_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(SHEET_RETRY_DELAYS_MS[attempt - 1]);
    try {
      const response = await fetchFn(url, {
        redirect: "follow",
        headers: SHEET_EXPORT_HEADERS,
      });
      if (response.ok) return response.text();
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new SheetFetchError(
        retryable
          ? `HTTP ${response.status} (transient — export rate-limit/outage)`
          : `HTTP ${response.status} (permanent — tab likely renamed or removed; update the gid list)`,
        response.status,
        retryable
      );
    } catch (err) {
      lastError = new SheetFetchError(
        `network error (transient): ${err instanceof Error ? err.message : String(err)}`,
        null,
        true
      );
    }
    if (!lastError.retryable) break;
  }
  throw lastError ?? new SheetFetchError("unreachable", null, false);
}

/** Fetch one Google Sheets tab as CSV via the export endpoint, with the same
 * browser-imitating headers + retry policy the roster scrape uses. */
export async function fetchSheetCsv(docId: string, gid: number): Promise<string> {
  return fetchCsvWithRetry(
    `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`
  );
}

// Function to fetch all CSV data and filter for Starlink WiFi
export async function fetchAllSheets() {
  const exportUrls = createCsvExportUrls();
  const starlinkAircraft: Record<string, string>[] = [];

  // Separate counts for express and mainline fleets
  let expressTotal = 0;
  let mainlineTotal = 0;
  let expressStarlink = 0;
  let mainlineStarlink = 0;

  const failedSheets: string[] = [];

  for (const sheet of exportUrls) {
    try {
      const csvText = await fetchCsvWithRetry(sheet.url);
      const { headers, rows } = parseCSV(csvText);

      // Add to the appropriate fleet total
      if (sheet.fleet === "express") {
        expressTotal += rows.length;
      } else {
        mainlineTotal += rows.length;
      }

      // Identify "sheetType" from first row's "Aircraft" col if present
      let sheetType = "";
      if (rows.length > 0 && rows[0].Aircraft) {
        sheetType = rows[0].Aircraft.split("-")[0] || "Unknown";
      }

      // Filter for Starlink WiFi (both "StrLnk" for express and "Starlink" for mainline)
      const filtered = rows.filter((row) => {
        const wifi = row.WiFi?.trim();
        return wifi === "StrLnk" || wifi === "Starlink";
      });

      // Count Starlink aircraft by fleet type
      if (sheet.fleet === "express") {
        expressStarlink += filtered.length;
      } else {
        mainlineStarlink += filtered.length;
      }

      for (const aircraft of filtered) {
        aircraft.sheet_gid = String(sheet.gid);
        aircraft.sheet_type = sheetType;
        aircraft.fleet = sheet.fleet;

        // Use the "Reg #" column for tail number if available
        if (aircraft["Reg #"]) {
          aircraft.TailNumber = aircraft["Reg #"].trim();
        } else {
          // Fall back to extracting from Aircraft field if Reg # not available
          const aircraftStr = aircraft.Aircraft || "";

          // Improved tail number extraction - looking for N-number pattern
          let tailNumber = "";
          const nNumberMatch = aircraftStr.match(/\b(N\d+[A-Z]*)\b/);
          if (nNumberMatch?.[1]) {
            tailNumber = nNumberMatch[1];
          } else {
            // If no N-number found, try fleet number or registration
            const regMatch = aircraftStr.match(/\b([A-Z]-[A-Z0-9]+)\b/);
            if (regMatch?.[1]) {
              tailNumber = regMatch[1];
            } else {
              const candidate = aircraftStr.split(" ")[0] || "";
              tailNumber = looksLikeValidTailNumber(candidate) ? candidate : "";
            }
          }

          aircraft.TailNumber = tailNumber;
        }

        // Get the "Operated By" field if it exists, otherwise use "United Airlines"
        aircraft.OperatedBy = aircraft["Operated By"] || "United Airlines";

        // Don't overwrite DateFound - let database preserve existing dates

        starlinkAircraft.push(aircraft);
      }
    } catch (err) {
      // fleet + gid together: gid 13 exists in BOTH spreadsheets, so a bare
      // gid can't identify which tab failed. The SheetFetchError message
      // already says transient-vs-permanent and what to do about each.
      const attempts = err instanceof SheetFetchError && err.retryable ? " after retries" : "";
      logError(`Failed to fetch ${sheet.fleet} sheet gid=${sheet.gid}${attempts}`, err);
      failedSheets.push(`${sheet.fleet}:${sheet.gid}`);
    }
  }

  if (failedSheets.length > 0) {
    throw new Error(
      `fetchAllSheets: ${failedSheets.length} sheet(s) failed (${failedSheets.join(", ")}); aborting to avoid partial DELETE in updateDatabase`
    );
  }

  // Total counts across both fleets
  const totalAircraftCount = expressTotal + mainlineTotal;
  const totalStarlinkCount = expressStarlink + mainlineStarlink;

  // Cache update happens in sheet-scrape AFTER updateDatabase accepts the
  // roster, so cache and DB share one refusal decision — a partial parse
  // (one sheet interstitial) must not desync /api/fleet-discovery either.

  return {
    totalAircraftCount,
    starlinkAircraft,
    fleetStats: {
      express: {
        total: expressTotal,
        starlink: expressStarlink,
        unverified: 0,
        percentage: expressTotal > 0 ? (expressStarlink / expressTotal) * 100 : 0,
      },
      mainline: {
        total: mainlineTotal,
        starlink: mainlineStarlink,
        unverified: 0,
        percentage: mainlineTotal > 0 ? (mainlineStarlink / mainlineTotal) * 100 : 0,
      },
      combined: {
        total: totalAircraftCount,
        starlink: totalStarlinkCount,
        unverified: 0,
        percentage: totalAircraftCount > 0 ? (totalStarlinkCount / totalAircraftCount) * 100 : 0,
      },
    },
  };
}

// Helper function to create the database file if it doesn't exist
export function ensureDatabaseFileExists(dbPath: string) {
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, ""); // Create an empty file
  }
}

// ============================================
// Spreadsheet Cache for Discovery Comparison
// ============================================

// In-memory cache of tail numbers from the spreadsheet
// Updated hourly when fetchAllSheets() runs
let spreadsheetTailsCache: Set<string> = new Set();
let spreadsheetCacheUpdatedAt = 0;

/**
 * Update the spreadsheet tails cache
 * Called automatically by fetchAllSheets()
 */
export function updateSpreadsheetCache(tailNumbers: string[]) {
  spreadsheetTailsCache = new Set(tailNumbers);
  spreadsheetCacheUpdatedAt = Date.now();
}

/**
 * Check if a tail number is in the cached spreadsheet
 */
export function isInSpreadsheetCache(tailNumber: string): boolean {
  return spreadsheetTailsCache.has(tailNumber);
}

/**
 * Get all tail numbers from the cached spreadsheet
 */
export function getSpreadsheetCacheTails(): Set<string> {
  return spreadsheetTailsCache;
}

/**
 * Get cache metadata
 */
export function getSpreadsheetCacheInfo(): { size: number; updatedAt: number } {
  return {
    size: spreadsheetTailsCache.size,
    updatedAt: spreadsheetCacheUpdatedAt,
  };
}
