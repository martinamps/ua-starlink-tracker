/**
 * The site page that answers the same question an MCP tool just answered,
 * and keeps answering it after the chat ends (a swapped aircraft, a newly
 * assigned flight). Each URL passes the same gate its page handler applies
 * (src/server/app.ts), so an answer never links a page that would 404 or
 * noindex: no gate passed, no link.
 *
 * `utm_source=mcp` is how the visit-source tag (observability/metrics.ts)
 * counts the person who follows one as sent by an assistant: most MCP
 * clients open links with no referrer.
 */
import {
  CANONICAL_FLIGHT_PERMALINK,
  buildFlightLookupVariants,
  canonicalFlightInput,
  icaoCallsignToIata,
  isFlightZero,
  permalinkCarrier,
  stripFlightNumberZeros,
} from "../airlines/flight-number";
import { type AirlineConfig, type SiteConfig, siteForAirline } from "../airlines/registry";
import type { ScopedReader } from "../database/reader";
import { ROUTE_AIRPORT_RE } from "../database/sql/fragments";
import { airportTimezone, flightDateWindow, isRealIsoDate } from "../utils/airport-tz";

const MCP_UTM_SOURCE = "mcp";

export type LivePage = { kind: "flight" | "route" | "planner"; url: string };

const LEADS: Record<LivePage["kind"], string> = {
  flight: "Live answer, updated if the aircraft is swapped",
  route: "Live route page, updated as aircraft are assigned",
  planner: "Live route planner for this trip",
};

/** The one plain line an answer ends with. */
export function livePageLine(page: LivePage): string {
  return `${LEADS[page.kind]}: ${page.url}`;
}

function pageUrl(site: SiteConfig, path: string, query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...query, utm_source: MCP_UTM_SOURCE });
  return `https://${site.canonicalHost}${path}?${params}`;
}

/**
 * /check-flight/{fn}[/{date}] on the airline's live site, when the router
 * would serve that flight's indexable page (checkFlightPage's existence gate).
 * A date well past drops to the undated page, which still answers; the dated
 * one only says the day has gone.
 */
export function flightLivePage(
  cfg: AirlineConfig,
  reader: ScopedReader,
  flightNumber: string,
  date: string | null
): LivePage | null {
  const site = siteForAirline(cfg.code, true);
  if (!site?.features.checkFlightPage) return null;
  const fn = stripFlightNumberZeros(icaoCallsignToIata(canonicalFlightInput(flightNumber)));
  if (!CANONICAL_FLIGHT_PERMALINK.test(fn) || isFlightZero(fn)) return null;
  if (permalinkCarrier(cfg, fn) !== cfg) return null;
  if (!reader.flightNumberHasData(buildFlightLookupVariants(cfg, fn))) return null;
  const window = date && isRealIsoDate(date) ? flightDateWindow(date) : null;
  const dated = window && window.daysOut >= -1 ? `/${date}` : "";
  return { kind: "flight", url: pageUrl(site, `/check-flight/${fn}${dated}`) };
}

/** /route-planner/{origin}/{destination}, only where that page renders and indexes. */
export function routeLivePage(
  cfg: AirlineConfig,
  reader: ScopedReader,
  origin: string,
  destination: string
): LivePage | null {
  const site = siteForAirline(cfg.code, true);
  if (!site?.features.routePlannerPage) return null;
  if (!ROUTE_AIRPORT_RE.test(origin) || !ROUTE_AIRPORT_RE.test(destination)) return null;
  if (origin === destination) return null;
  // routeIsRecent alone makes the page indexable; a pair indexed only by
  // today's board is skipped rather than built here.
  if (!reader.routeHasData(origin, destination) || !reader.routeIsRecent(origin, destination)) {
    return null;
  }
  return { kind: "route", url: pageUrl(site, `/route-planner/${origin}/${destination}`) };
}

/**
 * The planner's own search for the pair, which runs the same itinerary
 * search plan_starlink_itinerary does. Gated like the router's hop to it:
 * both ends somewhere this airline departs from.
 */
export function plannerLivePage(
  cfg: AirlineConfig,
  reader: ScopedReader,
  origin: string,
  destination: string,
  date: string | null
): LivePage | null {
  const site = siteForAirline(cfg.code, true);
  if (!site?.features.routePlannerPage) return null;
  if (!ROUTE_AIRPORT_RE.test(origin) || !ROUTE_AIRPORT_RE.test(destination)) return null;
  if (origin === destination) return null;
  const served = (code: string) => Boolean(airportTimezone(code)) && reader.airportHasData(code);
  if (!served(origin) || !served(destination)) return null;
  const query: Record<string, string> = { origin, destination };
  if (date && (flightDateWindow(date)?.daysOut ?? -1) >= 0) query.date = date;
  return { kind: "planner", url: pageUrl(site, "/route-planner", query) };
}
