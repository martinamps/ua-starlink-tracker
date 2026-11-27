import type { CheckFlightBody } from "../../client/flight-answer";
import type { TypeOutlookRef } from "../outlook-copy";

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

/** The next departure our own rows name an aircraft for, with that aircraft's
 * settled answer: what the undated page opens with instead of odds. */
export interface AssignedDeparture {
  hasStarlink: boolean;
  /** Observed on Starlink, as against listed and not yet observed. Always true on a no. */
  verified: boolean;
  tail: string;
  aircraft: string | null;
  /** The Wi-Fi a no names ("Panasonic", "no", "non-Starlink"); null on a yes. */
  wifi: string | null;
  origin: string;
  destination: string;
  departure: number;
  /** IANA zone of the departure airport: the date printed is the traveller's. */
  departureZone: string;
  /** When our schedule data last showed this aircraft on the departure (unix seconds). */
  seenAt: number;
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
  typeRule?: {
    /** Null where the aircraft we know leaves no single share to quote. */
    probability: number | null;
    label: string;
    /** Set when the aircraft we know on this number, not the band alone,
     * decided the answer: the answer in prose. */
    aircraft?: string;
    /** The airline's own count behind `probability`, with the chart's date. */
    count?: { connected: number; total: number; asOf: string };
  } | null;
  aircraftTypes: string[];
  /** Newest check that found Starlink on this number: a check time, not a departure. */
  lastStarlink: { tail: string; checked_at: number } | null;
  routes: FlightRouteFact[];
  upcoming: FlightUpcomingDeparture[];
  /** The first of `upcoming`, when its aircraft's status is settled. */
  nextAssigned?: AssignedDeparture | null;
  /** Other marketing flight numbers on this flight's primary route — sibling
   * permalinks, so the corpus links laterally instead of only via /routes. */
  siblings: string[];
  /** Newest sighting (unix sec) when the flight has gone quiet long enough to
   * say so on the page; null otherwise. */
  notObservedSince?: number | null;
  /** Departure airports of `routes` whose /routes/{airport} page serves, each once:
   * the page that answers "what else leaves from here with Starlink?". */
  airportLinks?: string[];
  /** aircraftTypes with their /fleet/{slug} page, each page linked once. */
  aircraftTypeLinks?: Array<{ label: string; href: string | null }>;
  /** The rollout outlook of the type seen on this number most recently, where
   * that type is still being fitted and its pace was backtested. */
  typeOutlook?: TypeOutlookRef | null;
}

/** A permalink segment that is not a flight number this site can answer for.
 * `query` is the offending segment (null when it could not be decoded), never
 * trusted — React escapes it at render. */
export interface InvalidFlightQuery {
  query: string | null;
  /** "tail": a registration, and not one of this site's aircraft. */
  reason: "not-a-flight-number" | "other-carrier" | "tail";
  airportHint: boolean;
  /** Another airline's flight: the page of ours that answers it or lists who we track. */
  elsewhere?: FlightElsewhere;
  /** This site's own flight that a look-alike code most likely meant (US852 → UA852):
   * a canonical permalink the server built, offered as a link. */
  didYouMean?: string;
  /** Five digits behind the site's code: longer than any flight number. */
  tooManyDigits?: boolean;
  /** The airport the segment names, on record, for the planner link's origin. */
  airportCode?: string;
}

/** A link off a single-airline site, built by the server from the registry
 * alone. "sister" names a live tracker of ours; "hub" and "airlines" name none. */
export interface FlightElsewhere {
  kind: "sister" | "hub" | "airlines";
  href: string;
  label: string;
}

/** The dated permalink's answer: the /api/check-flight body the server built
 * from the database, rendered by the same function the browser re-check uses. */
export interface DatedAnswer {
  flightNumber: string;
  date: string;
  daysOut: number;
  /** The leg the page was asked about (?origin=&destination=), when it parsed;
   * the browser re-check asks the API for the same leg. */
  leg?: { origin?: string; destination?: string };
  body: CheckFlightBody;
  /** A change of aircraft on the answered departure, from our own log. */
  swap?: PlaneSwap | null;
}

/** "gained"/"lost" when one side is known to have Starlink and the other known
 * not to; "same" when both are known alike; "unknown" when either isn't known. */
export type SwapStarlinkChange = "gained" | "lost" | "same" | "unknown";

export interface PlaneSwap {
  /** The first tail logged on the departure; the Starlink change is measured from it. */
  from: string;
  /** Tails logged after `from` and before `to`, in the order first seen. */
  between: string[];
  to: string;
  /** When we first logged `to` on the departure (unix seconds). */
  seenAt: number;
  /** IANA zone of the departure airport; null renders UTC. */
  zone: string | null;
  /** Whether `from` and `to` have Starlink: `to` as the answer card says it. */
  toStarlink: boolean;
  fromStarlink: boolean | null;
  change: SwapStarlinkChange;
  /** The swapped leg's airports (IATA), set only when the flight flies more
   * than one leg that day, so the note can say which one changed. */
  leg?: { dep: string; arr: string | null } | null;
}
