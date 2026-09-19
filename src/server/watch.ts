/**
 * Starlink Watch routes: GET /cal/{FN}/{YYYY-MM-DD}[.ics] and the same-day
 * alternatives attached to firm-no check-flight answers.
 *
 * Served from the DB only (lookupTail: null): a calendar app re-polls every
 * subscription on its own schedule, so an FR24 call per fetch would turn every
 * subscriber into a scraper.
 */

import {
  buildAirlineFlightNumberVariants,
  canonicalPermalinkFor,
  ensureAirlinePrefix,
} from "../airlines/flight-number";
import type { AirlineConfig, SiteConfig } from "../airlines/registry";
import {
  type FlightVerdict,
  negativeWifi,
  resolveFlightVerdict,
  scheduledFlights,
  verdictConfidence,
} from "../api/check-flight-core";
import type { AssignmentLogRow, SameDayAlternative } from "../database/assignment-log";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability/metrics";
import { flightDateWindow } from "../utils/airport-tz";
import { type WatchVerdict, buildWatchIcs, watchFeedEnabled, watchFeedState } from "../utils/ics";
import { type RequestContext, type ScopedReader, tenantConfig } from "./context";

/** Past this, schedules aren't loaded and the feed would only restate the prior. */
const WATCH_MAX_DAYS_OUT = 330;
/** Alternatives only mean something while the schedule for that day is loaded. */
const ALTERNATIVES_MAX_DAYS_OUT = 1;

const WATCH_NOT_FOUND_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Robots-Tag": "noindex",
  "Cache-Control": "public, max-age=300",
};

function watchNotFound(): Response {
  return new Response("Not found", { status: 404, headers: WATCH_NOT_FOUND_HEADERS });
}

function isRealIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date;
}

export function parseWatchPath(
  cfg: AirlineConfig,
  pathname: string
): { fn: string; date: string } | null {
  const rest = pathname.slice("/cal/".length).replace(/\/+$/, "");
  const [rawFn, rawDate, extra] = rest.split("/");
  if (!rawFn || !rawDate || extra !== undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawFn);
  } catch {
    return null;
  }
  const fn = ensureAirlinePrefix(cfg, decoded.replace(/[\s\-.]/g, ""));
  const date = rawDate.replace(/\.ics$/i, "");
  if (!canonicalPermalinkFor(cfg).test(fn) || !isRealIsoDate(date)) return null;
  return { fn, date };
}

interface WatchLeg {
  dep: string | null;
  arr: string | null;
  depUnix: number | null;
  arrUnix: number | null;
}

type VerdictWithWindow = Exclude<
  FlightVerdict,
  { kind: "invalid_date" } | { kind: "invalid_flight_number" }
>;

/** The feed's view of a verdict, plus the leg its times come from. */
export function watchVerdictFrom(
  verdict: VerdictWithWindow,
  history: readonly AssignmentLogRow[]
): { verdict: WatchVerdict; leg: WatchLeg } {
  const latest = [...history].sort((a, b) => b.last_seen - a.last_seen)[0];
  const historyLeg: WatchLeg = latest
    ? {
        dep: latest.departure_airport,
        arr: latest.arrival_airport,
        depUnix: latest.departure_time,
        arrUnix: latest.arrival_time,
      }
    : { dep: null, arr: null, depUnix: null, arrUnix: null };

  switch (verdict.kind) {
    case "scheduled": {
      const f = scheduledFlights(verdict)[0];
      return {
        verdict: {
          state: "yes",
          tail: f.tail_number,
          aircraft: f.aircraft_type ?? null,
          confidence: verdictConfidence(verdict),
        },
        leg: {
          dep: f.departure_airport,
          arr: f.arrival_airport,
          depUnix: f.departure_time,
          arrUnix: f.arrival_time,
        },
      };
    }
    case "scheduled_no": {
      const f = verdict.flights[0];
      return {
        verdict: {
          state: "no",
          tail: f.tail_number,
          aircraft: f.aircraft_type ?? null,
          wifi: negativeWifi(f),
        },
        leg: {
          dep: f.departure_airport,
          arr: f.arrival_airport,
          depUnix: f.departure_time,
          arrUnix: f.arrival_time,
        },
      };
    }
    case "fr24": {
      const s = verdict.starlink[0];
      return {
        verdict: {
          state: "yes",
          tail: s.tail_number,
          aircraft: s.aircraft_model,
          confidence: verdictConfidence(verdict),
        },
        leg: {
          dep: s.origin,
          arr: s.destination,
          depUnix: s.departure_time,
          arrUnix: s.arrival_time,
        },
      };
    }
    case "fr24_no": {
      const s = verdict.segments.find((x) => x.hasStarlink === false) ?? verdict.segments[0];
      return {
        verdict: {
          state: "no",
          tail: s.tail_number,
          aircraft: s.aircraft_model,
          wifi: s.verified_wifi ?? null,
        },
        leg: {
          dep: s.origin,
          arr: s.destination,
          depUnix: s.departure_time,
          arrUnix: s.arrival_time,
        },
      };
    }
    case "prediction":
      return {
        verdict: {
          state: "prediction",
          probability: verdict.pred.probability,
          observations: verdict.pred.n_observations,
        },
        leg: historyLeg,
      };
    case "no_model":
      return {
        verdict:
          verdict.answer.kind === "penetration"
            ? { state: "prediction", probability: verdict.answer.pen.pct, observations: 0 }
            : { state: "none", message: null },
        leg: historyLeg,
      };
    case "qatar":
    case "qatar_no_data":
    case "qatar_history":
      return { verdict: { state: "none", message: null }, leg: historyLeg };
  }
}

/**
 * Same-day Starlink departures on the firm-no leg, or null when the verdict
 * isn't a firm no or the date is past the loaded schedule. Null means "omit
 * the field"; [] means "we looked and found none".
 */
export function sameDayAlternativesFor(
  reader: ScopedReader,
  verdict: VerdictWithWindow,
  date: string
): SameDayAlternative[] | null {
  if (verdict.kind !== "scheduled_no" && verdict.kind !== "fr24_no") return null;
  const { daysOut } = verdict.window;
  if (daysOut < -1 || daysOut > ALTERNATIVES_MAX_DAYS_OUT) return null;
  const leg =
    verdict.kind === "scheduled_no"
      ? {
          origin: verdict.flights[0].departure_airport,
          destination: verdict.flights[0].arrival_airport,
          at: verdict.flights[0].departure_time,
        }
      : {
          origin: verdict.segments[0].origin,
          destination: verdict.segments[0].destination,
          at: verdict.segments[0].departure_time,
        };
  if (!leg.origin || !leg.destination) return [];
  return reader.getSameDayStarlinkAlternatives({
    origin: leg.origin,
    destination: leg.destination,
    dateLocal: date,
    aroundUnix: leg.at,
    exclude: [verdict.normalized],
  });
}

/** Spread into a check-flight response body; adds nothing unless populated. */
export function sameDayAlternativesField(
  reader: ScopedReader,
  verdict: VerdictWithWindow,
  date: string
): { sameDayAlternatives?: SameDayAlternative[] } {
  const alternatives = sameDayAlternativesFor(reader, verdict, date);
  return alternatives === null ? {} : { sameDayAlternatives: alternatives };
}

/**
 * The page's own lookup fetch is the one /api/check-flight caller that renders
 * the Watch row; Sec-Fetch-Site tells it apart from the extension and scripts.
 */
export function recordWatchCtaShown(req: Request, site: SiteConfig, cfg: AirlineConfig): void {
  if (!watchFeedEnabled(site)) return;
  if (req.headers.get("sec-fetch-site") !== "same-origin") return;
  metrics.increment(COUNTERS.WATCH_CTA_SHOWN, {
    airline: normalizeAirlineTag(cfg.code),
    surface: "check_flight",
  });
}

export async function watchFeed(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const cfg = tenantConfig(ctx.tenant);
  if (!cfg || !watchFeedEnabled(ctx.site)) return watchNotFound();
  const parsed = parseWatchPath(cfg, ctx.url.pathname);
  if (!parsed) return watchNotFound();

  const now = Math.floor(Date.now() / 1000);
  const window = flightDateWindow(parsed.date, now);
  if (!window || window.daysOut < -1 || window.daysOut > WATCH_MAX_DAYS_OUT) {
    return watchNotFound();
  }

  const verdict = await resolveFlightVerdict(cfg, ctx.reader, parsed.fn, parsed.date, {
    now,
    lookupTail: null,
  });
  if (verdict.kind === "invalid_date" || verdict.kind === "invalid_flight_number") {
    return watchNotFound();
  }

  const history = ctx.reader.getAssignmentHistory(
    buildAirlineFlightNumberVariants(cfg, parsed.fn),
    parsed.date
  );
  const { verdict: watch, leg } = watchVerdictFrom(verdict, history);
  const alternatives = sameDayAlternativesFor(ctx.reader, verdict, parsed.date) ?? [];

  metrics.increment(COUNTERS.WATCH_FEED_FETCH, {
    airline: normalizeAirlineTag(cfg.code),
    state: watchFeedState(history, watch, leg.dep),
  });

  const body = buildWatchIcs({
    canonicalHost: ctx.site.canonicalHost,
    fn: parsed.fn,
    date: parsed.date,
    verdict: watch,
    history,
    alternatives,
    ...leg,
    now,
  });
  return new Response(ctx.req.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="starlink-watch-${parsed.fn}-${parsed.date}.ics"`,
      "Cache-Control": "public, max-age=900",
      "X-Robots-Tag": "noindex",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
