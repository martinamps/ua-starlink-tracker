// Shared types for the application

import type { SUBFLEET_KEY_LIST } from "./airlines/registry";

// Derived from the registry's literal key list (which tests/vocabulary.test.ts
// pins against the runtime-derived SUBFLEET_KEYS) — no third copy to drift.
export type SubfleetKey = (typeof SUBFLEET_KEY_LIST)[number] | "unknown";

export interface Aircraft {
  Aircraft: string;
  WiFi: string;
  sheet_gid: string;
  sheet_type: string;
  /** NULL for type-settled rows — renderers must not interpolate it raw. */
  DateFound: string | null;
  TailNumber: string;
  OperatedBy: string;
  fleet: SubfleetKey;
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
  airline: string;
}

export interface FleetStats {
  express: FleetMetrics;
  mainline: FleetMetrics;
}

export type RolloutStatus = "complete" | "phase_done" | "in_progress";

export interface PerAirlineStat {
  code: string;
  name: string;
  starlink: number;
  total: number;
  fleetTotal?: number;
  installs30d?: number;
  status?: RolloutStatus;
  statusLabel?: string;
  phaseNote?: string;
  accentColor?: string;
  href?: string;
}

export interface RecentInstall {
  airline: string;
  TailNumber: string;
  Aircraft: string;
  OperatedBy: string;
  DateFound: string;
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
  /** Per-airline subfleet split; null on the hub (no cross-airline aggregate). */
  fleetStats: FleetStats | null;
  flightsByTail: Record<string, Flight[]>;
}

// Fleet discovery types
export type FleetSource =
  | "fr24"
  | "spreadsheet"
  | "ha_seed"
  | "as_seed"
  | "canary"
  | "flyertalk_qr"
  | "flyertalk_as";
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
  fleet: SubfleetKey;
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
  fleet: SubfleetKey;
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

export interface InstallPaceWeek {
  weekStart: string;
  installs: number;
}

export interface InstallPace {
  weeks: InstallPaceWeek[];
  express: { starlink: number; total: number };
  mainline: { starlink: number; total: number };
  mainlinePaceWk: number;
  remainingMainline: number;
  projectedFinishMonth: string | null;
}

export interface FleetPageData {
  pulse: FleetPulse;
  families: FleetFamily[];
  carriers: FleetCarrier[];
  bodyClass: Record<BodyClass, Record<WifiProvider, number>>;
  allTails: FleetTail[];
  totalFleet: number;
  totalStarlink: number;
  /** null on the hub site — install pace is a single-airline narrative. */
  installPace: InstallPace | null;
}

export interface RouteScheduleRow {
  origin: string;
  destination: string;
  departures: number;
  flight_numbers: number;
  next_departure: number;
}

export interface RouteSchedule {
  rows: RouteScheduleRow[];
  /** All departures matching the window/predicate — not capped by the row LIMIT. */
  totalDepartures: number;
  windowLabel: string;
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
