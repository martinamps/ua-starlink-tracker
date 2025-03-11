// This version uses native fetch which is built into Node.js 18+
const fs = require('fs');

// Spreadsheet ID
const spreadsheetId = '1Mmu1m381RnGMgqxMiEqMni3zJ8uxdfpbeaP6XtN1yxM';

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
  0  // Adding gid=0 in case there's a main sheet with this ID
];

// Function to create CSV export URLs for each sheet
function createCsvExportUrls() {
  return gids.map(gid => {
    return {
      gid: gid,
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`
    };
  });
}

// Function to parse CSV with proper handling of quoted fields
function parseCSV(csvText) {
  const lines = csvText.split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };
  
  const headers = [];
  let inQuotes = false;
  let currentField = '';
  let headerLine = lines[0];
  
  // Parse headers with proper handling of quoted fields
  for (let i = 0; i < headerLine.length; i++) {
    const char = headerLine[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      headers.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  headers.push(currentField.trim()); // Add the last header
  
  const rows = [];
  
  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue; // Skip empty lines
    
    const row = [];
    inQuotes = false;
    currentField = '';
    
    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        row.push(currentField.trim());
        currentField = '';
      } else {
        currentField += char;
      }
    }
    row.push(currentField.trim()); // Add the last field
    
    // Create object from row data
    const rowObj = {};
    headers.forEach((header, index) => {
      const cleanHeader = header.replace(/"/g, '').trim();
      rowObj[cleanHeader] = index < row.length ? row[index].replace(/"/g, '').trim() : '';
    });
    
    rows.push(rowObj);
  }
  
  return { headers, rows };
}

// Function to fetch all CSV data and filter for Starlink WiFi
async function fetchAllSheets() {
  const exportUrls = createCsvExportUrls();
  const sheetData = {};
  const starlinkAircraft = [];
  
  for (const sheet of exportUrls) {
    try {
      const response = await fetch(sheet.url, {
        redirect: 'follow', // Explicitly follow redirects
        headers: {
          // Add browser-like headers to avoid being blocked
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cache-Control': 'no-cache'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      
      const csvText = await response.text();
      sheetData[`sheet_${sheet.gid}`] = csvText;
      console.log(`Successfully fetched sheet with gid=${sheet.gid}`);
      
      // Parse the CSV with proper handling
      const { headers, rows } = parseCSV(csvText);
      
      // Add sheet name/type info (try to identify from first row)
      let sheetType = "";
      if (rows.length > 0) {
        const firstRow = rows[0];
        if (firstRow['Aircraft']) {
          sheetType = firstRow['Aircraft'].split('-')[0] || 'Unknown';
        }
      }
      
      // Filter for Starlink WiFi
      const filtered = rows.filter(row => {
        return row['WiFi'] && row['WiFi'].trim() === 'StrLnk';
      });
      
      // Add sheet info to each aircraft
      filtered.forEach(aircraft => {
        aircraft['sheet_gid'] = sheet.gid;
        aircraft['sheet_type'] = sheetType;
        starlinkAircraft.push(aircraft);
      });
      
      console.log(`Found ${filtered.length} Starlink aircraft in sheet ${sheet.gid}`);
    } catch (error) {
      console.error(`Failed to fetch sheet with gid=${sheet.gid}: ${error.message}`);
    }
  }
  
  return { 
    allSheets: sheetData, 
    starlinkAircraft: starlinkAircraft 
  };
}

// Function to save to CSV file
function saveToCSV(data, filename) {
  if (!data || !data.length) {
    console.log("No data to save");
    return;
  }
  
  const headers = Object.keys(data[0]);
  const csvContent = [
    headers.join(','),
    ...data.map(item => 
      headers.map(header => {
        // Convert to string and handle null/undefined
        const value = String(item[header] || '');
        // Escape quotes and wrap fields with commas in quotes
        return value.includes(',') || value.includes('"') 
          ? `"${value.replace(/"/g, '""')}"`
          : value;
      }).join(',')
    )
  ].join('\n');
  
  fs.writeFileSync(filename, csvContent);
  console.log(`Data saved to ${filename}`);
}

// Main function
async function main() {
  try {
    const result = await fetchAllSheets();
    
    console.log(`Successfully fetched ${Object.keys(result.allSheets).length} sheets`);
    console.log(`Found ${result.starlinkAircraft.length} aircraft with Starlink WiFi`);
    
    // Display results in console table
    console.table(result.starlinkAircraft);
    
    // Save Starlink aircraft to CSV
    if (result.starlinkAircraft.length > 0) {
      saveToCSV(result.starlinkAircraft, 'starlink_aircraft.csv');
    }
    
    // Return the data for further processing if needed
    return result.starlinkAircraft;
  } catch (error) {
    console.error("Error:", error);
  }
}

// Run the main function
main();
