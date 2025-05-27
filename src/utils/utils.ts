import { writeFileSync, existsSync } from "fs";

/**
 * CSV Fetch & Parse Logic
 */

// Express fleet spreadsheet
const expressSpreadsheetId = "1Mmu1m381RnGMgqxMiEqMni3zJ8uxdfpbeaP6XtN1yxM";
const expressGids = [13, 1106195214, 11, 1735263052, 6, 9, 5, 969079667];

// Mainline fleet spreadsheet
const mainlineSpreadsheetId = "1ZlYgN_IZmd6CSx_nXnuP0L0PiodapDRx3RmNkIpxXAo";
const mainlineGids = [
  0, 1, 948315825, 3, 4, 6, 5, 70572532, 7, 8, 10, 12, 15, 13, 2098141434,
];

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
      rowObj[cleanHeader] =
        index < row.length ? row[index].replace(/"/g, "").trim() : "";
    });

    rows.push(rowObj);
  }

  return { headers, rows };
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

  for (const sheet of exportUrls) {
    try {
      const response = await fetch(sheet.url, {
        redirect: "follow",
        headers: {
          // Add browser-like headers to avoid being blocked
          "User-Agent": "Mozilla/5.0",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
          "Accept-Language": "en-US,en;q=0.5",
          "Cache-Control": "no-cache",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const csvText = await response.text();
      const { headers, rows } = parseCSV(csvText);

      // Add to the appropriate fleet total
      if (sheet.fleet === "express") {
        expressTotal += rows.length;
      } else {
        mainlineTotal += rows.length;
      }

      // Identify "sheetType" from first row's "Aircraft" col if present
      let sheetType = "";
      if (rows.length > 0 && rows[0]["Aircraft"]) {
        sheetType = rows[0]["Aircraft"].split("-")[0] || "Unknown";
      }

      // Filter for Starlink WiFi
      const filtered = rows.filter((row) => row["WiFi"]?.trim() === "StrLnk");

      // Count Starlink aircraft by fleet type
      if (sheet.fleet === "express") {
        expressStarlink += filtered.length;
      } else {
        mainlineStarlink += filtered.length;
      }

      filtered.forEach((aircraft) => {
        aircraft["sheet_gid"] = String(sheet.gid);
        aircraft["sheet_type"] = sheetType;
        aircraft["fleet"] = sheet.fleet;

        // Use the "Reg #" column for tail number if available
        if (aircraft["Reg #"]) {
          aircraft["TailNumber"] = aircraft["Reg #"].trim();
        } else {
          // Fall back to extracting from Aircraft field if Reg # not available
          const aircraftStr = aircraft["Aircraft"] || "";

          // Improved tail number extraction - looking for N-number pattern
          let tailNumber = "";
          const nNumberMatch = aircraftStr.match(/\b(N\d+[A-Z]*)\b/);
          if (nNumberMatch && nNumberMatch[1]) {
            tailNumber = nNumberMatch[1];
          } else {
            // If no N-number found, try fleet number or registration
            const regMatch = aircraftStr.match(/\b([A-Z]-[A-Z0-9]+)\b/);
            if (regMatch && regMatch[1]) {
              tailNumber = regMatch[1];
            } else {
              // Last resort - use first part before space if nothing else found
              tailNumber = aircraftStr.split(" ")[0] || "";
            }
          }

          aircraft["TailNumber"] = tailNumber;
        }

        // Get the "Operated By" field if it exists, otherwise use "United Airlines"
        aircraft["OperatedBy"] = aircraft["Operated By"] || "United Airlines";

        // Don't overwrite DateFound - let database preserve existing dates

        starlinkAircraft.push(aircraft);
      });
    } catch (error) {
      console.error(`Failed to fetch sheet with gid=${sheet.gid}: `, error);
    }
  }

  // Total counts across both fleets
  const totalAircraftCount = expressTotal + mainlineTotal;
  const totalStarlinkCount = expressStarlink + mainlineStarlink;

  return {
    totalAircraftCount,
    starlinkAircraft,
    fleetStats: {
      express: {
        total: expressTotal,
        starlink: expressStarlink,
        percentage:
          expressTotal > 0 ? (expressStarlink / expressTotal) * 100 : 0,
      },
      mainline: {
        total: mainlineTotal,
        starlink: mainlineStarlink,
        percentage:
          mainlineTotal > 0 ? (mainlineStarlink / mainlineTotal) * 100 : 0,
      },
      combined: {
        total: totalAircraftCount,
        starlink: totalStarlinkCount,
        percentage:
          totalAircraftCount > 0
            ? (totalStarlinkCount / totalAircraftCount) * 100
            : 0,
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
