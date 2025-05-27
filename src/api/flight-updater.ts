import 'dotenv/config';
import { FlightAwareAPI } from './flightaware-api';
import {
  initializeDatabase,
  getStarlinkPlanes,
  updateFlights,
  needsFlightCheck,
  updateLastFlightCheck
} from '../database/database';
import type { Aircraft } from '../types';

async function updateFlightsForTailNumber(api: FlightAwareAPI, tailNumber: string) {
  try {
    console.log(`Fetching upcoming flights for ${tailNumber}`);
    const flights = await api.getUpcomingFlights(tailNumber);
    
    if (flights.length === 0) {
      console.log(`No upcoming flights found for ${tailNumber}`);
    } else {
      console.log(`Found ${flights.length} upcoming flights for ${tailNumber}`);
    }

    const db = initializeDatabase();
    updateFlights(db, tailNumber, flights);
    updateLastFlightCheck(db, tailNumber);
    db.close();
    
    console.log(`Updated ${flights.length} upcoming flights for ${tailNumber}`);
  } catch (error) {
    console.error(`Failed to update flights for ${tailNumber}:`, error);
  }
}

async function updateFlightsIfNeeded(api: FlightAwareAPI, tailNumber: string, hoursThreshold: number = 6) {
  const db = initializeDatabase();
  const needsUpdate = needsFlightCheck(db, tailNumber, hoursThreshold);
  db.close();
  
  if (needsUpdate) {
    await updateFlightsForTailNumber(api, tailNumber);
    return true;
  }
  
  console.log(`Skipping ${tailNumber} - checked recently`);
  return false;
}

// Helper function to create delay with jitter
function createJitteredDelay(baseMs: number, jitterMs: number = 500): number {
  return baseMs + Math.random() * jitterMs;
}

// Process planes in batches with concurrency control
async function processPlanesInBatches(
  api: FlightAwareAPI, 
  planes: Aircraft[], 
  batchSize: number = 3
) {
  let updatedCount = 0;
  let apiCallCount = 0;
  
  // Filter planes that need updates first
  const planesToUpdate: Aircraft[] = [];
  const db = initializeDatabase();
  
  for (const plane of planes) {
    if (!plane.TailNumber) continue;
    if (needsFlightCheck(db, plane.TailNumber)) {
      planesToUpdate.push(plane);
    }
  }
  
  db.close();
  
  console.log(`${planesToUpdate.length} aircraft need flight updates out of ${planes.length} total`);
  
  if (planesToUpdate.length === 0) {
    console.log('No aircraft need flight updates at this time');
    return { updatedCount: 0, apiCallCount: 0 };
  }
  
  // Process in batches
  for (let i = 0; i < planesToUpdate.length; i += batchSize) {
    const batch = planesToUpdate.slice(i, i + batchSize);
    
    // Process batch concurrently but with rate limiting
    const batchPromises = batch.map(async (plane, index) => {
      try {
        // Stagger requests within batch with jitter
        const staggerDelay = createJitteredDelay(index * 2000, 1000); // 2s base + 0-1s jitter
        await new Promise(resolve => setTimeout(resolve, staggerDelay));
        
        const wasUpdated = await updateFlightsIfNeeded(api, plane.TailNumber);
        if (wasUpdated) {
          return { updated: true, apiCall: true, tailNumber: plane.TailNumber };
        }
        return { updated: false, apiCall: false, tailNumber: plane.TailNumber };
      } catch (error) {
        console.error(`Error processing ${plane.TailNumber}:`, error);
        return { updated: false, apiCall: false, tailNumber: plane.TailNumber, error };
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    
    // Count results
    for (const result of batchResults) {
      if (result.updated) updatedCount++;
      if (result.apiCall) apiCallCount++;
    }
    
    // Add delay between batches with jitter
    if (i + batchSize < planesToUpdate.length) {
      const batchDelay = createJitteredDelay(5000, 2000); // 5s base + 0-2s jitter
      console.log(`Batch completed, waiting ${Math.round(batchDelay/1000)}s before next batch...`);
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }
  
  return { updatedCount, apiCallCount };
}

export async function updateAllFlights() {
  const apiKey = process.env.AEROAPI_KEY;
  if (!apiKey) {
    console.error('AEROAPI_KEY environment variable not set');
    return;
  }

  const db = initializeDatabase();
  const planes = getStarlinkPlanes(db);
  db.close();

  const api = new FlightAwareAPI(apiKey);
  
  console.log(`Checking flight updates for ${planes.length} Starlink aircraft...`);
  
  const { updatedCount, apiCallCount } = await processPlanesInBatches(api, planes, 3);
  
  console.log(`Flight updates completed: ${updatedCount} aircraft updated, ${apiCallCount} API calls made`);
}

// Auto-update flights every 6 hours (to align with check threshold)
export function startFlightUpdater() {
  updateAllFlights(); // Initial update
  setInterval(updateAllFlights, 6 * 60 * 60 * 1000); // 6 hours
}

// Export individual functions for manual use
export { updateFlightsForTailNumber, updateFlightsIfNeeded };