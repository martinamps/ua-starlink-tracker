import { looksLikeValidTailNumber } from "../airlines/registry";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability/metrics";
import { BROWSER_USER_AGENT } from "./constants";
import { error as logError, warn } from "./logger";

/**
 * CSV Fetch & Parse Logic
 */

/** The community fleet spreadsheets and the tabs we read from each. A tab the
 * owner adds is logged, not read, until someone classifies it here. */
export const FLEET_SHEETS = [
  {
    fleet: "express",
    docId: "1Mmu1m381RnGMgqxMiEqMni3zJ8uxdfpbeaP6XtN1yxM",
    // gid 1735263052 was deleted upstream ~2026-10-27 (it listed no Starlink tails).
    gids: [13, 1106195214, 11, 6, 9, 5, 969079667],
  },
  {
    fleet: "mainline",
    docId: "1ZlYgN_IZmd6CSx_nXnuP0L0PiodapDRx3RmNkIpxXAo",
    gids: [0, 1, 948315825, 3, 4, 6, 5, 70572532, 7, 8, 10, 12, 15, 13, 2098141434],
  },
] as const;

const SHEET_FETCH_TIMEOUT_MS = 30_000;

export interface SheetTab {
  gid: number;
  name: string;
}

/** Tab list from a public sheet's htmlview page, which declares each tab as
 * `items.push({name: "E175", ..., gid: "13", ...})`. */
export function parseSheetTabs(html: string): SheetTab[] {
  const tabs: SheetTab[] = [];
  for (const m of html.matchAll(
    /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(-?\d+)"/g
  )) {
    tabs.push({ gid: Number(m[2]), name: m[1].replace(/\\\//g, "/") });
  }
  return tabs;
}

/** The live tab list, or null when it can't be read (the scrape then falls
 * back to the known gids and fails closed on any missing one). */
export async function fetchSheetTabs(docId: string): Promise<SheetTab[] | null> {
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${docId}/htmlview`, {
      redirect: "follow",
      headers: { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en-US,en;q=0.5" },
      signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const tabs = parseSheetTabs(await res.text());
    return tabs.length > 0 ? tabs : null;
  } catch {
    return null;
  }
}

export interface TabReconciliation {
  fetch: number[];
  /** Deleted upstream and nothing listed from it: safe to skip. */
  vanishedEmpty: number[];
  /** Deleted upstream while listings still cite it: replacing the roster
   * would delete those listings, so the scrape refuses. */
  vanishedListed: number[];
  added: SheetTab[];
}

export function reconcileSheetTabs(
  known: readonly number[],
  live: SheetTab[] | null,
  listedGids: ReadonlySet<string>
): TabReconciliation {
  if (!live) return { fetch: [...known], vanishedEmpty: [], vanishedListed: [], added: [] };
  const liveGids = new Set(live.map((t) => t.gid));
  const vanished = known.filter((g) => !liveGids.has(g));
  return {
    fetch: known.filter((g) => liveGids.has(g)),
    vanishedEmpty: vanished.filter((g) => !listedGids.has(String(g))),
    vanishedListed: vanished.filter((g) => listedGids.has(String(g))),
    added: live.filter((t) => !known.includes(t.gid)),
  };
}

const loggedTabDrift = new Set<string>();

function reportTabDrift(fleet: string, r: TabReconciliation): void {
  const once = (key: string, log: () => void) => {
    if (loggedTabDrift.has(key)) return;
    loggedTabDrift.add(key);
    log();
  };
  const count = (state: string) =>
    metrics.increment(COUNTERS.SHEET_TAB_DRIFT, { airline: normalizeAirlineTag("UA"), state });
  for (const gid of r.vanishedEmpty) {
    count("vanished_empty");
    once(`gone:${gid}`, () =>
      warn(`Sheet tab gid=${gid} (${fleet}) no longer exists and lists nothing; skipping it`)
    );
  }
  for (const gid of r.vanishedListed) {
    count("vanished_listed");
    logError(
      `Sheet tab gid=${gid} (${fleet}) no longer exists but starlink_planes still lists tails from it; refusing the roster replace`
    );
  }
  for (const tab of r.added) {
    count("new");
    once(`new:${tab.gid}`, () =>
      warn(
        `New sheet tab ${JSON.stringify(tab.name)} gid=${tab.gid} (${fleet}) is not read; add it to FLEET_SHEETS if it belongs in the roster`
      )
    );
  }
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

/** Fetch one Google Sheets tab as CSV via the export endpoint, with the same
 * browser-imitating headers the roster scrape uses. */
export async function fetchSheetCsv(docId: string, gid: number): Promise<string> {
  const response = await fetch(
    `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`,
    {
      redirect: "follow",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS),
    }
  );
  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }
  return response.text();
}

const SHEET_STARLINK_ALIASES = new Set(["strlnk", "starlink", "stalink", "starlnk", "strlink"]);

/**
 * Canonical Starlink spelling for a sheet WiFi cell, or null when the cell
 * isn't Starlink. Hand-typed cells drift ('Stalink' on N14228), and the value
 * is stored raw — downstream `wifi IN ('StrLnk','Starlink')` checks only work
 * if typos are rewritten to a canonical form, not merely accepted. The exact
 * canonical spellings pass through untouched; aliases take the sheet's own.
 */
export function normalizeSheetWifi(
  raw: string | null | undefined,
  fleet: string
): "StrLnk" | "Starlink" | null {
  const v = (raw ?? "").replace(/[\s\u00a0]+/g, "");
  if (v === "StrLnk" || v === "Starlink") return v;
  if (!SHEET_STARLINK_ALIASES.has(v.toLowerCase())) return null;
  return fleet === "express" ? "StrLnk" : "Starlink";
}

/** An unrecognised cell that is probably a new misspelling worth a look. */
export function looksLikeStarlinkTypo(raw: string | null | undefined): boolean {
  const v = (raw ?? "").replace(/[\s\u00a0]+/g, "").toLowerCase();
  return (
    v.length >= 4 && normalizeSheetWifi(v, "mainline") === null && /^st.*l.*k|lnk$|link$/.test(v)
  );
}

// Function to fetch all CSV data and filter for Starlink WiFi
export async function fetchAllSheets(
  opts: {
    /** sheet_gid values starlink_planes currently lists from. */
    listedGids?: ReadonlySet<string>;
    fetchTabs?: typeof fetchSheetTabs;
    fetchCsv?: typeof fetchSheetCsv;
  } = {}
) {
  const {
    listedGids = new Set<string>(),
    fetchTabs = fetchSheetTabs,
    fetchCsv = fetchSheetCsv,
  } = opts;
  const exportUrls: Array<{ gid: number; fleet: string; docId: string }> = [];
  const blockingGids: number[] = [];
  for (const sheet of FLEET_SHEETS) {
    const r = reconcileSheetTabs(sheet.gids, await fetchTabs(sheet.docId), listedGids);
    reportTabDrift(sheet.fleet, r);
    blockingGids.push(...r.vanishedListed);
    for (const gid of r.fetch) exportUrls.push({ gid, fleet: sheet.fleet, docId: sheet.docId });
  }
  if (blockingGids.length > 0) {
    throw new Error(
      `fetchAllSheets: tab(s) ${blockingGids.join(", ")} deleted upstream while still listed; aborting to avoid deleting their listings`
    );
  }
  const warnedWifi = new Set<string>();
  const starlinkAircraft: Record<string, string>[] = [];

  // Separate counts for express and mainline fleets
  let expressTotal = 0;
  let mainlineTotal = 0;
  let expressStarlink = 0;
  let mainlineStarlink = 0;

  const failedGids: string[] = [];

  for (const sheet of exportUrls) {
    try {
      const { rows } = parseCSV(await fetchCsv(sheet.docId, sheet.gid));

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
        const wifi = normalizeSheetWifi(row.WiFi, sheet.fleet);
        if (wifi) {
          row.WiFi = wifi;
          return true;
        }
        if (looksLikeStarlinkTypo(row.WiFi) && !warnedWifi.has(row.WiFi)) {
          warnedWifi.add(row.WiFi);
          warn(`Unrecognised sheet WiFi value ${JSON.stringify(row.WiFi)} (gid ${sheet.gid})`);
        }
        return false;
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
      logError(`Failed to fetch sheet with gid=${sheet.gid}`, err);
      failedGids.push(String(sheet.gid));
    }
  }

  if (failedGids.length > 0) {
    throw new Error(
      `fetchAllSheets: ${failedGids.length} sheet(s) failed (gids: ${failedGids.join(", ")}); aborting to avoid partial DELETE in updateDatabase`
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
