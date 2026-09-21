import type { CheckFlightBody } from "../../client/flight-answer";

export interface FlightRouteFact {
  departure_airport: string;
  arrival_airport: string;
  times: number;
  dur_sec: number | null;
  /** Newest evidence for this leg (unix seconds); null when the row carries none. */
  last_seen_at: number | null;
  /** Whether /route-planner/{dep}/{arr} serves; false renders the pair unlinked. */
  linkable: boolean;
}

export interface FlightUpcomingDeparture {
  departure_airport: string;
  arrival_airport: string;
  departure_time: number;
  /** YYYY-MM-DD at the departure airport: the date a traveller books and the
   * date the lookup answers for. Null when the airport's zone is unknown. */
  departure_local_date?: string | null;
  /** IANA zone of the departure airport, for rendering local clock time. */
  departure_tz?: string | null;
  tail_number: string;
  aircraft_type: string | null;
  /** The slot's current tail passes the equipped test the verdict uses. */
  starlink: boolean;
  wifiLabel: string;
}

/** Server-assembled facts for a /check-flight/{fn} permalink — the page's
 * unique crawlable substance; the client lookup flow layers on top. */
export interface FlightFacts {
  flightNumber: string;
  airlineName: string;
  /** United.com (or the carrier's verifier) checks of aircraft on this number,
   * whole log, not departures; see observedSince. */
  observedTotal: number;
  observedStarlink: number;
  /** Earliest check counted in observedTotal (unix seconds). */
  observedSince?: number | null;
  /** The per-flight model's answer: the same number /api/predict-flight and
   * MCP predict_flight_starlink give. Null for carriers without a model. */
  prediction?: {
    probability: number;
    n_observations: number;
    confidence: "high" | "medium" | "low";
  } | null;
  /** For carriers whose flight-number band fixes the aircraft type (AS800–999
   * on Hawaiian widebodies): that band's Starlink share, the API's "type" answer. */
  typeRule?: { probability: number; label: string } | null;
  aircraftTypes: string[];
  /** Newest check that found Starlink on this number: a check time, not a departure. */
  lastStarlink: { tail: string; checked_at: number } | null;
  routes: FlightRouteFact[];
  upcoming: FlightUpcomingDeparture[];
  /** Other marketing flight numbers on this flight's primary route — sibling
   * permalinks, so the corpus links laterally instead of only via /routes. */
  siblings: string[];
  /** Newest sighting (unix sec) when the flight has gone quiet long enough to
   * say so on the page; null otherwise. */
  notObservedSince?: number | null;
  /** aircraftTypes with their /fleet/{slug} page, each page linked once. */
  aircraftTypeLinks?: Array<{ label: string; href: string | null }>;
}

/** A permalink segment that is not a flight number this site can answer for.
 * `query` is the offending segment (null when it could not be decoded), never
 * trusted — React escapes it at render. */
export interface InvalidFlightQuery {
  query: string | null;
  reason: "not-a-flight-number" | "other-carrier";
  airportHint: boolean;
}

/** The dated permalink's answer: the /api/check-flight body the server built
 * from the database, rendered by the same function the browser re-check uses. */
export interface DatedAnswer {
  flightNumber: string;
  date: string;
  daysOut: number;
  body: CheckFlightBody;
}
