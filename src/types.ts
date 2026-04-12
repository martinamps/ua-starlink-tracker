// Shared types for the application

export interface Aircraft {
  Aircraft: string;
  WiFi: string;
  sheet_gid: string;
  sheet_type: string;
  DateFound: string;
  TailNumber: string;
  OperatedBy: string;
  fleet: "express" | "mainline";
}

export interface Flight {
  id: number;
  tail_number: string;
  flight_number: string;
  departure_airport: string;
  arrival_airport: string;
  departure_time: number;
  arrival_time: number;
  last_updated: number;
}

export interface FleetStats {
  express: FleetMetrics;
  mainline: FleetMetrics;
}

interface FleetMetrics {
  total: number;
  starlink: number;
  unverified: number;
  percentage: number;
}

export interface ApiResponse {
  totalCount: number;
  starlinkPlanes: Aircraft[];
  lastUpdated: string;
  fleetStats: FleetStats;
  flightsByTail: Record<string, Flight[]>;
}

// Fleet discovery types
export type FleetSource = "fr24" | "spreadsheet" | "ha_seed" | "canary";
export type StarlinkStatus = "confirmed" | "negative" | "unknown";

export interface FleetAircraft {
  id?: number;
  tail_number: string;
  aircraft_type: string | null;

  // Source tracking
  first_seen_source: FleetSource;
  first_seen_at: number;
  last_seen_at: number;

  // Fleet info
  fleet: "express" | "mainline" | "unknown";
  operated_by: string | null;

  // Verification state
  starlink_status: StarlinkStatus;
  verified_wifi: string | null;
  verified_at: number | null;

  // Discovery scheduling
  discovery_priority: number;
  next_check_after: number;
  check_attempts: number;
  last_check_error: string | null;
}

// ============ /fleet page data ============

export type WifiProvider = "starlink" | "viasat" | "panasonic" | "thales" | "none" | "unknown";
export type BodyClass = "regional" | "narrowbody" | "widebody";

export interface FleetTail {
  tail: string;
  type: string; // raw aircraft_type
  family: string; // normalized family
  provider: WifiProvider;
  fleet: "express" | "mainline" | "unknown";
  verified_at: number | null;
}

export interface FleetFamily {
  family: string;
  body: BodyClass;
  total: number;
  starlink: number;
  tails: FleetTail[];
}

export interface FleetCarrier {
  name: string;
  confirmed: number;
  total: number;
  pct: number;
}

export interface FleetPulse {
  now: number;
  sparkline: number[];
  peak: number;
  trough: number;
  totalHours: number;
}

export interface FleetPageData {
  pulse: FleetPulse;
  families: FleetFamily[];
  carriers: FleetCarrier[];
  bodyClass: Record<BodyClass, Record<WifiProvider, number>>;
  allTails: FleetTail[];
  totalFleet: number;
  totalStarlink: number;
}

export type AirportDeparture = { airport: string; count: number };
export type AirportDepartures = {
  rows: AirportDeparture[];
  windowLabel: string;
};

export interface FleetDiscoveryStats {
  total_fleet: number;
  verified_starlink: number;
  verified_non_starlink: number;
  pending_verification: number;
  discovered_not_in_spreadsheet: number;
  recent_discoveries: Array<{
    tail_number: string;
    aircraft_type: string | null;
    verified_wifi: string | null;
    verified_at: number | null;
    first_seen_source: FleetSource;
  }>;
}
