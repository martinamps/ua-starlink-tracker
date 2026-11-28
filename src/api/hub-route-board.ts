/**
 * The hub's "every flight between two airports": each airline's own nonstop
 * board (route-flights.ts) for the pair, merged into one list. A row carries
 * exactly the answer its airline's route page gives, so the hub says no more
 * about a flight than that airline's own tracker does.
 *
 * Only airlines answered flight by flight take part; a community-sourced
 * airline has no per-flight answer, and an airline the hub only states a
 * dated fact for has no board at all.
 */

import { type AirlineConfig, publicAirlines, siteForAirline } from "../airlines/registry";
import type { ScopedReader } from "../database/reader";
import {
  type RouteFlightBoard,
  type RouteFlightRow,
  buildRouteFlightBoard,
  rankGroup,
  rankOdds,
} from "./route-flights";

export interface HubRouteAirline {
  code: string;
  name: string;
  shortName: string;
  board: RouteFlightBoard;
  /** The pair's route page on the airline's own live site, when it has one. */
  routePage: string | null;
}

export interface HubRouteRow {
  airline: string;
  airlineName: string;
  row: RouteFlightRow;
  /** The flight's answer page on its airline's own live site, else null. */
  page: string | null;
}

export interface HubRouteBoard {
  origin: string;
  destination: string;
  date: string | null;
  weekday: string | null;
  /** Every airline asked, with or without a nonstop on the pair. */
  airlines: HubRouteAirline[];
  rows: HubRouteRow[];
  utc_times?: true;
}

/** Airlines whose flights the hub answers one by one. */
export function hubRouteAirlines(): AirlineConfig[] {
  return publicAirlines().filter((a) => !a.communitySource);
}

/** Does any of those airlines hold this pair? The page exists only then. */
export function hubRouteHasData(
  getReader: (code: string) => ScopedReader,
  origin: string,
  destination: string
): boolean {
  return hubRouteAirlines().some((cfg) => getReader(cfg.code).routeHasData(origin, destination));
}

/** "8:15 AM" → minutes after midnight, for ordering rows of different airlines. */
export function clockMinutes(clock: string | null): number {
  const m = clock?.match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return 24 * 60;
  const h = Number(m[1]) % 12;
  return (m[3].toUpperCase() === "P" ? h + 12 : h) * 60 + Number(m[2]);
}

function liveSite(cfg: AirlineConfig, feature: "checkFlightPage" | "routePlannerPage") {
  const site = siteForAirline(cfg.code, true);
  return site?.features[feature] ? site : null;
}

export function buildHubRouteBoard(
  getReader: (code: string) => ScopedReader,
  origin: string,
  destination: string,
  opts: { date?: string | null; nowSec?: number } = {}
): HubRouteBoard {
  const airlines: HubRouteAirline[] = [];
  const rows: HubRouteRow[] = [];
  for (const cfg of hubRouteAirlines()) {
    const board = buildRouteFlightBoard(cfg, getReader(cfg.code), origin, destination, opts);
    const planner = liveSite(cfg, "routePlannerPage");
    const flights = liveSite(cfg, "checkFlightPage");
    airlines.push({
      code: cfg.code,
      name: cfg.name,
      shortName: cfg.shortName,
      board,
      routePage: planner
        ? `https://${planner.canonicalHost}/route-planner/${origin}/${destination}`
        : null,
    });
    for (const row of board.flights) {
      rows.push({
        airline: cfg.code,
        airlineName: cfg.shortName,
        row,
        page: flights ? `https://${flights.canonicalHost}${row.page}` : null,
      });
    }
  }
  // The airlines' own order, across airlines: regulars first, the assigned
  // plane's answer or the best odds next, then the earlier departure.
  rows.sort(
    (a, b) =>
      rankGroup(a.row) - rankGroup(b.row) ||
      rankOdds(b.row) - rankOdds(a.row) ||
      clockMinutes(a.row.typical_departure) - clockMinutes(b.row.typical_departure) ||
      a.row.flight_number.localeCompare(b.row.flight_number)
  );
  const first = airlines[0]?.board;
  return {
    origin,
    destination,
    date: first?.date ?? null,
    weekday: first?.weekday ?? null,
    airlines,
    rows,
    ...(first?.utc_times ? { utc_times: true as const } : {}),
  };
}
