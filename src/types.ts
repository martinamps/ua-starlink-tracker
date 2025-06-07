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
  percentage: number;
}

export interface ApiResponse {
  totalCount: number;
  starlinkPlanes: Aircraft[];
  lastUpdated: string;
  fleetStats: FleetStats;
  flightsByTail: Record<string, Flight[]>;
}
