import type { Flight } from "../types";

interface FlightAwareConfig {
  apiKey: string;
  baseUrl: string;
}

interface FlightAwareFlight {
  ident: string;
  origin: { code: string; name: string };
  destination: { code: string; name: string };
  scheduled_out: string;
  scheduled_in: string;
  actual_out?: string;
  actual_in?: string;
}

interface FlightAwareResponse {
  flights: FlightAwareFlight[];
}

type FlightUpdate = Pick<Flight, 'flight_number' | 'departure_airport' | 'arrival_airport' | 'departure_time' | 'arrival_time'>;

export class FlightAwareAPI {
  private config: FlightAwareConfig;
  private lastRequestTime: number = 0;
  private minRequestInterval: number = 1000; // 1 second minimum between requests

  constructor(apiKey: string) {
    this.config = {
      apiKey,
      baseUrl: 'https://aeroapi.flightaware.com/aeroapi'
    };
  }

  private async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.waitForRateLimit();
        return await operation();
      } catch (error: any) {
        if (error.message?.includes('429') && attempt < maxRetries) {
          // Exponential backoff with jitter for 429 errors
          const baseDelay = Math.min(60000, Math.pow(2, attempt) * 10000); // 10s, 20s, 40s, max 60s
          const jitter = Math.random() * 5000; // 0-5s jitter
          const delay = baseDelay + jitter;
          
          console.log(`Rate limited (429), waiting ${Math.round(delay/1000)}s before retry ${attempt + 1}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    throw new Error('Max retries exceeded');
  }

  async getUpcomingFlights(tailNumber: string): Promise<FlightUpdate[]> {
    return this.retryWithBackoff(async () => {
      const url = `${this.config.baseUrl}/flights/${tailNumber}`;
      
      const response = await fetch(url, {
        headers: {
          'x-apikey': this.config.apiKey,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 404) {
          console.log(`No flights found for tail number: ${tailNumber}`);
          return [];
        }
        throw new Error(`FlightAware API error: ${response.status} ${response.statusText}`);
      }

      const data: FlightAwareResponse = await response.json();
      
      // Filter for future flights only
      const now = new Date();
      return data.flights
        .filter(flight => {
          const departureTime = new Date(flight.scheduled_out);
          return departureTime > now;
        })
        .map(flight => ({
          flight_number: flight.ident,
          departure_airport: flight.origin.code,
          arrival_airport: flight.destination.code,
          departure_time: Math.floor(new Date(flight.scheduled_out).getTime() / 1000),
          arrival_time: Math.floor(new Date(flight.scheduled_in).getTime() / 1000)
        }))
        .slice(0, 10); // Limit to next 10 flights
    });
  }

  async checkRateLimit(): Promise<{ remaining: number; resetTime: number }> {
    // Simple rate limit check by making a minimal API call
    const response = await fetch(`${this.config.baseUrl}/flights/N12345`, {
      method: 'HEAD',
      headers: {
        'x-apikey': this.config.apiKey
      }
    });

    return {
      remaining: parseInt(response.headers.get('X-RateLimit-Remaining') || '0'),
      resetTime: parseInt(response.headers.get('X-RateLimit-Reset') || '0')
    };
  }
}