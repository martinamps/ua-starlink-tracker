/**
 * Starlink Watch routes: GET /cal/{FN}/{YYYY-MM-DD}[.ics] and the same-day
 * alternatives attached to firm-no check-flight answers.
 *
 * Served from the DB only: a calendar app re-polls every subscription on its
 * own schedule, so an FR24 call per fetch would turn every subscriber into a
 * scraper. The FR24 lookup is stood in for by the legs check-flight last
 * resolved (logged to flight_assignment_log), so the feed and the page agree.
 */

import {
  buildAirlineFlightNumberVariants,
  canonicalPermalinkFor,
  ensureAirlinePrefix,
} from "../airlines/flight-number";
import type { AirlineConfig, SiteConfig } from "../airlines/registry";
import {
  type FlightVerdict,
  type ResolveDeps,
  resolveFlightVerdict,
  verdictSummary,
} from "../api/check-flight-core";
import { type FallbackSegment, resolveTailVerdict } from "../api/flight-verdict";
import type { AssignmentLogRow, SameDayAlternative } from "../database/assignment-log";
import { unixNow } from "../database/sql/windows";
import { COUNTERS, metrics, normalizeAirlineTag } from "../observability/metrics";
import { flightDateWindow, isRealIsoDate } from "../utils/airport-tz";
import { type WatchVerdict, buildWatchIcs, watchFeedEnabled, watchFeedState } from "../utils/ics";
import { type RequestContext, type ScopedReader, tenantConfig } from "./context";
import { CACHE, CORS_ANY_ORIGIN, text } from "./respond";

/** Past this, schedules aren't loaded and the feed would only restate the prior. */
const WATCH_MAX_DAYS_OUT = 330;
/** Alternatives only mean something while the schedule for that day is loaded. */
const ALTERNATIVES_MAX_DAYS_OUT = 1;

function watchNotFound(): Response {
  return text("Not found", "text/plain; charset=utf-8", {
    status: 404,
    cache: CACHE.fiveMinutes,
    headers: { "X-Robots-Tag": "noindex" },
  });
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
  const fn = ensureAirlinePrefix(cfg, decoded);
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
  const first = [...history].sort(
    (a, b) =>
      (a.departure_time ?? Number.POSITIVE_INFINITY) -
      (b.departure_time ?? Number.POSITIVE_INFINITY)
  )[0];
  const historyLeg: WatchLeg = first
    ? {
        dep: first.departure_airport,
        arr: first.arrival_airport,
        depUnix: first.departure_time,
        arrUnix: first.arrival_time,
      }
    : { dep: null, arr: null, depUnix: null, arrUnix: null };

  // The feed is tail-level; QR answers from the scheduled type, and QR hosts
  // serve no feed (watchFeedEnabled).
  if (verdict.kind.startsWith("qatar")) return { verdict: NONE, leg: historyLeg };
  const s = verdictSummary(verdict);
  const a = s.assignment;
  const leg = a
    ? { dep: a.origin, arr: a.destination, depUnix: a.departure, arrUnix: a.arrival }
    : historyLeg;
  if (a && s.hasStarlink === true) {
    return {
      verdict: {
        state: "yes",
        tail: a.tail,
        aircraft: a.aircraft,
        confidence: s.confidence as "verified" | "likely",
      },
      leg,
    };
  }
  if (a && s.hasStarlink === false) {
    return { verdict: { state: "no", tail: a.tail, aircraft: a.aircraft, wifi: a.wifi }, leg };
  }
  if (s.probability !== null && s.observations !== null) {
    return {
      verdict: { state: "prediction", probability: s.probability, observations: s.observations },
      leg,
    };
  }
  return { verdict: NONE, leg };
}

const NONE: WatchVerdict = { state: "none", message: null };

/**
 * DB-only stand-in for the FR24 lookup: per leg, the most recently seen tail
 * the updater doesn't track. Tracked tails are skipped because this only runs
 * when upcoming_flights holds no equipped row for the flight, and a tracked
 * tail missing there has moved off it. null (no usable rows) falls through to
 * the prediction, exactly like a date outside FR24's window.
 */
export function loggedTailLookup(
  history: readonly AssignmentLogRow[]
): NonNullable<ResolveDeps["lookupTail"]> {
  return async (reader, _fn, _date, _start, _end, now) => {
    const byLeg = new Map<string, AssignmentLogRow>();
    for (const r of history) {
      if (r.departure_time === null || r.arrival_time === null) continue;
      if (reader.getStarlinkPlaneByTail(r.tail_number)) continue;
      const cur = byLeg.get(r.departure_airport);
      if (!cur || r.last_seen > cur.last_seen) byLeg.set(r.departure_airport, r);
    }
    if (byLeg.size === 0) return null;
    return [...byLeg.values()]
      .sort((a, b) => (a.departure_time ?? 0) - (b.departure_time ?? 0))
      .map((r): FallbackSegment => {
        const v = resolveTailVerdict(reader, r.tail_number, now);
        return {
          tail_number: r.tail_number,
          aircraft_model: v.aircraft_model ?? null,
          origin: r.departure_airport,
          destination: r.arrival_airport ?? "",
          departure_time: r.departure_time ?? 0,
          arrival_time: r.arrival_time ?? 0,
          hasStarlink: v.hasStarlink,
          confidence: v.confidence,
          verified_wifi: v.verified_wifi,
          verified_at: v.verified_at,
          operated_by: v.operated_by,
          fleet_type: v.fleet_type,
        };
      });
  };
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
  const cfg = tenantConfig(ctx.tenant);
  if (!cfg || !watchFeedEnabled(ctx.site)) return watchNotFound();
  const parsed = parseWatchPath(cfg, ctx.url.pathname);
  if (!parsed) return watchNotFound();

  const now = unixNow();
  const window = flightDateWindow(parsed.date, now);
  if (!window || window.daysOut < -1 || window.daysOut > WATCH_MAX_DAYS_OUT) {
    return watchNotFound();
  }

  const history = ctx.reader.getAssignmentHistory(
    buildAirlineFlightNumberVariants(cfg, parsed.fn),
    parsed.date
  );
  const verdict = await resolveFlightVerdict(cfg, ctx.reader, parsed.fn, parsed.date, {
    now,
    lookupTail: loggedTailLookup(history),
  });
  if (verdict.kind === "invalid_date" || verdict.kind === "invalid_flight_number") {
    return watchNotFound();
  }

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
  return text(ctx.req.method === "HEAD" ? null : body, "text/calendar; charset=utf-8", {
    cache: CACHE.fifteenMinutes,
    headers: {
      "Content-Disposition": `inline; filename="starlink-watch-${parsed.fn}-${parsed.date}.ics"`,
      "X-Robots-Tag": "noindex",
      ...CORS_ANY_ORIGIN,
    },
  });
}
