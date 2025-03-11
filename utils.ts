import { writeFileSync, existsSync } from "fs";

/**
 * CSV Fetch & Parse Logic
 */

const spreadsheetId = "1Mmu1m381RnGMgqxMiEqMni3zJ8uxdfpbeaP6XtN1yxM";

// Array of all the gid values you found
const gids = [
  13,
  1106195214,
  11,
  1735263052,
  6,
  9,
  5,
  969079667,
  0 // Adding gid=0 in case there's a main sheet with this ID
];

// Function to create CSV export URLs for each sheet
function createCsvExportUrls() {
  return gids.map(gid => ({
    gid,
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`
  }));
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
      rowObj[cleanHeader] = index < row.length
        ? row[index].replace(/"/g, "").trim()
        : "";
    });

    rows.push(rowObj);
  }

  return { headers, rows };
}

// Function to fetch all CSV data and filter for Starlink WiFi
export async function fetchAllSheets() {
  const exportUrls = createCsvExportUrls();
  const starlinkAircraft: Record<string, string>[] = [];
  let totalAircraftCount = 0;

  for (const sheet of exportUrls) {
    try {
      const response = await fetch(sheet.url, {
        redirect: "follow",
        headers: {
          // Add browser-like headers to avoid being blocked
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
          "Accept-Language": "en-US,en;q=0.5",
          "Cache-Control": "no-cache"
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const csvText = await response.text();
      const { headers, rows } = parseCSV(csvText);

      totalAircraftCount += rows.length;

      // Identify "sheetType" from first row's "Aircraft" col if present
      let sheetType = "";
      if (rows.length > 0 && rows[0]["Aircraft"]) {
        sheetType = rows[0]["Aircraft"].split("-")[0] || "Unknown";
      }

      // Filter for Starlink WiFi
      const filtered = rows.filter(row => row["WiFi"]?.trim() === "StrLnk");
      filtered.forEach(aircraft => {
        aircraft["sheet_gid"] = String(sheet.gid);
        aircraft["sheet_type"] = sheetType;
        
        // Extract tail number from Aircraft field (usually appears before the first space)
        const aircraftStr = aircraft["Aircraft"] || "";
        const tailNumber = aircraftStr.split(" ")[0] || "";
        aircraft["TailNumber"] = tailNumber;
        
        // Get the "Operated By" field if it exists, otherwise use "United Airlines"
        aircraft["OperatedBy"] = aircraft["Operated By"] || "United Airlines";
        
        // Set the date found to today
        aircraft["DateFound"] = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
        
        starlinkAircraft.push(aircraft);
      });
    } catch (error) {
      console.error(`Failed to fetch sheet with gid=${sheet.gid}: `, error);
    }
  }

  return {
    totalAircraftCount,
    starlinkAircraft
  };
}

// Helper function to create the database file if it doesn't exist
export function ensureDatabaseFileExists(dbPath: string) {
  if (!existsSync(dbPath)) {
    writeFileSync(dbPath, ""); // Create an empty file
  }
}