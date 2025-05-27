import { fetchAllSheets } from "./src/utils/utils";

async function runScrape() {
  console.log("Starting spreadsheet scrape...");
  
  try {
    const { totalAircraftCount, starlinkAircraft, fleetStats } = await fetchAllSheets();
    
    console.log("\n=== Scrape Results ===\n");
    console.log(`Total aircraft: ${totalAircraftCount}`);
    console.log(`Starlink aircraft: ${starlinkAircraft.length}`);
    
    console.log("\n=== Fleet Stats ===\n");
    console.log("Express:");
    console.log(`  Total: ${fleetStats.express.total}`);
    console.log(`  Starlink: ${fleetStats.express.starlink}`);
    console.log(`  Percentage: ${fleetStats.express.percentage.toFixed(2)}%`);
    
    console.log("\nMainline:");
    console.log(`  Total: ${fleetStats.mainline.total}`);
    console.log(`  Starlink: ${fleetStats.mainline.starlink}`);
    console.log(`  Percentage: ${fleetStats.mainline.percentage.toFixed(2)}%`);
    
    console.log("\nCombined:");
    console.log(`  Total: ${fleetStats.combined.total}`);
    console.log(`  Starlink: ${fleetStats.combined.starlink}`);
    console.log(`  Percentage: ${fleetStats.combined.percentage.toFixed(2)}%`);
    
    console.log("\n=== Starlink Aircraft Details ===\n");
    starlinkAircraft.forEach((aircraft, index) => {
      console.log(`${index + 1}. ${aircraft.TailNumber || 'Unknown'} (${aircraft.fleet})`);
      console.log(`   Type: ${aircraft["Aircraft"] || 'Unknown'}`);
      console.log(`   Operated By: ${aircraft.OperatedBy || 'Unknown'}`);
      console.log(`   Date Found: ${aircraft.DateFound || 'Unknown'}`);
      console.log();
    });
  } catch (err) {
    console.error("Error scraping data:", err);
    process.exit(1);
  }
}

runScrape();