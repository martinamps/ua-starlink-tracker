/**
 * Qatar Airways schedule + equipment ingester.
 *
 * Polls QR's flight-status API on 128 curated route directions, three DOH
 * dates per tick: today, tomorrow, and one rotating date in +2..+6 (Qatar
 * publishes equipment ~7 days ahead, so every published date is re-read at
 * least every 5 hours). Each successful fetch writes:
 *   - qatar_schedule: the scheduled equipment per flight + date;
 *   - qatar_equipment_history: one row per leg per operating day, kept 60
 *     days, which answers dates beyond the window from observed types;
 *   - qatar_fetch_coverage: that (route, date) was read, so an in-window
 *     "no rows" can be trusted as "doesn't operate that day".
 * The check-flight surfaces read only these tables — we never proxy live
 * calls per the CLAUDE.md upstream-citizenship rule.
 *
 * Why route-pull and not flight-number sweep:
 *   - QR1xx–QR15xx is sparsely populated; sweeping numbers would waste 80% of
 *     calls on FS_NOT_FOUND.
 *   - One by-route call returns every daily frequency on that route in one
 *     shot — far better signal-per-request.
 *   - Top routes give us coverage for the questions users actually ask.
 *
 * 60-minute interval matches updateStarlinkData (UA spreadsheet scrape) —
 * QR's published schedules are stable enough that hourly is plenty.
 *
 * CLI:
 *   bun src/scripts/qatar-schedule-ingester.ts            # one-shot ingest
 *   bun src/scripts/qatar-schedule-ingester.ts --routes   # print route list
 */

import type { Database } from "bun:sqlite";
import { AIRLINES } from "../airlines/registry";
import {
  type QatarFlight,
  dohDateISO,
  fetchByRoute,
  isQatarFreighterEquipment,
  qatarEquipmentToWifi,
} from "../api/qatar-status";
import { addDaysISO } from "../api/qatar-verdict";
import {
  countQatarForwardSchedule,
  getMeta,
  initializeDatabase,
  markQatarHistoryStale,
  pruneQatarEquipmentHistory,
  pruneQatarFetchCoverage,
  pruneQatarScheduleBefore,
  pruneQatarScheduleGlobalBefore,
  recordQatarFetchCoverage,
  setMeta,
  stampLastUpdated,
  upsertQatarEquipmentHistory,
  upsertQatarSchedule,
} from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag, withSpan } from "../observability";
import { airportLocalDate } from "../utils/airport-tz";
import { type JobHandle, type JobRunContext, startJob } from "../utils/job-runner";
import { info, error as logError, warn } from "../utils/logger";
import { sleep } from "../utils/sleep";

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 45_000; // stagger after server boot
const PER_ROUTE_DELAY_MS = 400; // ~1.5/s — well under any plausible limit
// DOH-local offsets fetched every tick; a third rotates through +2..+6.
const NEAR_OFFSETS = [0, 1];
const FAR_OFFSET_MIN = 2;
const FAR_OFFSET_SPAN = 5; // +2..+6
const FAR_CURSOR_META = "qatarFarOffsetCursor";
const HISTORY_KEEP_DAYS = 60;
const COVERAGE_KEEP_DAYS = 10;
// qatar_schedule rows older than this can only be off-pair leftovers the
// route-scoped prune never matches.
const SCHEDULE_GLOBAL_PRUNE_SEC = 48 * 3600;
// Stop early when the upstream is down: each null costs ~18s of retries, and
// a full 384-call outage would run into the job's 2h stuck escape. A healthy
// run with a clustered regional error streak must NOT trip it.
const BREAKER_NULL_STREAK = 15;
const BREAKER_MIN_ATTEMPTS = 60;
const BREAKER_FAILURE_RATIO = 0.5;

/**
 * High-traffic QR routes. Each direction is a separate API call. Curated for
 * (a) US/EU long-haul where users care most, (b) coverage of every passenger
 * subfleet (B777, A350, B787, B788), (c) major Middle East / Asia / Africa.
 *
 * 128 directions × 3 dates = 384 calls/hour ≈ one every 9 seconds. Comfortably
 * below our observed rate-limit ceiling (10 rapid calls returned 200, no
 * captcha).
 */
export const ROUTES: Array<[string, string]> = [
  // North America
  ["DOH", "JFK"],
  ["JFK", "DOH"],
  ["DOH", "ORD"],
  ["ORD", "DOH"],
  ["DOH", "IAD"],
  ["IAD", "DOH"],
  ["DOH", "DFW"],
  ["DFW", "DOH"],
  ["DOH", "LAX"],
  ["LAX", "DOH"],
  ["DOH", "SEA"],
  ["SEA", "DOH"],
  ["DOH", "BOS"],
  ["BOS", "DOH"],
  ["DOH", "MIA"],
  ["MIA", "DOH"],
  ["DOH", "ATL"],
  ["ATL", "DOH"],
  ["DOH", "PHL"],
  ["PHL", "DOH"],
  ["DOH", "YYZ"],
  ["YYZ", "DOH"],
  ["DOH", "YUL"],
  ["YUL", "DOH"],
  // Europe — UK/Ireland
  ["DOH", "LHR"],
  ["LHR", "DOH"],
  ["DOH", "MAN"],
  ["MAN", "DOH"],
  ["DOH", "EDI"],
  ["EDI", "DOH"],
  ["DOH", "DUB"],
  ["DUB", "DOH"],
  // Europe — continent
  ["DOH", "CDG"],
  ["CDG", "DOH"],
  ["DOH", "FRA"],
  ["FRA", "DOH"],
  ["DOH", "MUC"],
  ["MUC", "DOH"],
  ["DOH", "AMS"],
  ["AMS", "DOH"],
  ["DOH", "MAD"],
  ["MAD", "DOH"],
  ["DOH", "BCN"],
  ["BCN", "DOH"],
  ["DOH", "FCO"],
  ["FCO", "DOH"],
  ["DOH", "MXP"],
  ["MXP", "DOH"],
  ["DOH", "ZRH"],
  ["ZRH", "DOH"],
  ["DOH", "VIE"],
  ["VIE", "DOH"],
  ["DOH", "CPH"],
  ["CPH", "DOH"],
  ["DOH", "ARN"],
  ["ARN", "DOH"],
  ["DOH", "OSL"],
  ["OSL", "DOH"],
  ["DOH", "WAW"],
  ["WAW", "DOH"],
  ["DOH", "IST"],
  ["IST", "DOH"],
  // Asia
  ["DOH", "SIN"],
  ["SIN", "DOH"],
  ["DOH", "BKK"],
  ["BKK", "DOH"],
  ["DOH", "HKG"],
  ["HKG", "DOH"],
  ["DOH", "PVG"],
  ["PVG", "DOH"],
  ["DOH", "PEK"],
  ["PEK", "DOH"],
  ["DOH", "ICN"],
  ["ICN", "DOH"],
  ["DOH", "NRT"],
  ["NRT", "DOH"],
  ["DOH", "HND"],
  ["HND", "DOH"],
  ["DOH", "KUL"],
  ["KUL", "DOH"],
  ["DOH", "CGK"],
  ["CGK", "DOH"],
  ["DOH", "MNL"],
  ["MNL", "DOH"],
  ["DOH", "DEL"],
  ["DEL", "DOH"],
  ["DOH", "BOM"],
  ["BOM", "DOH"],
  ["DOH", "BLR"],
  ["BLR", "DOH"],
  ["DOH", "MAA"],
  ["MAA", "DOH"],
  ["DOH", "CCU"],
  ["CCU", "DOH"],
  ["DOH", "HYD"],
  ["HYD", "DOH"],
  ["DOH", "CMB"],
  ["CMB", "DOH"],
  ["DOH", "DAC"],
  ["DAC", "DOH"],
  // Australia
  ["DOH", "SYD"],
  ["SYD", "DOH"],
  ["DOH", "MEL"],
  ["MEL", "DOH"],
  ["DOH", "PER"],
  ["PER", "DOH"],
  ["DOH", "BNE"],
  ["BNE", "DOH"],
  ["DOH", "AKL"],
  ["AKL", "DOH"],
  // Middle East / Africa
  ["DOH", "RUH"],
  ["RUH", "DOH"],
  ["DOH", "JED"],
  ["JED", "DOH"],
  ["DOH", "MCT"],
  ["MCT", "DOH"],
  ["DOH", "CAI"],
  ["CAI", "DOH"],
  ["DOH", "JNB"],
  ["JNB", "DOH"],
  ["DOH", "CPT"],
  ["CPT", "DOH"],
  ["DOH", "NBO"],
  ["NBO", "DOH"],
  // South America
  ["DOH", "GRU"],
  ["GRU", "DOH"],
  ["DOH", "EZE"],
  ["EZE", "DOH"],
];

/** YYYY-MM-DD in DOH local time (UTC+3, no DST) for an epoch-ms instant. */
function dohDateFromMs(ms: number): string {
  return dohDateISO(Math.floor(ms / 1000));
}

const stripZeros = (fn: string) => fn.replace(/^0+/, "") || "0";

/**
 * A by-route response lists every flight on the pair, including other
 * carriers' legs and codeshares marketed under another number; only QR's own
 * operated flight belongs in QR answers. Freighters are not bookable.
 */
function isOwnPassengerFlight(f: QatarFlight): boolean {
  if (!f.flightNumber || !f.scheduledDeparture) return false;
  if (f.carrier && f.carrier.toUpperCase() !== "QR") return false;
  if (f.mktFlightNumber && stripZeros(f.mktFlightNumber) !== stripZeros(f.flightNumber)) {
    return false;
  }
  return !isQatarFreighterEquipment(f.equipmentCode);
}

function flightToRow(f: QatarFlight, scheduledDate: string, nowSec: number) {
  const verdict = qatarEquipmentToWifi(f.equipmentCode);
  return {
    flight_number: `QR${stripZeros(f.flightNumber)}`,
    scheduled_date: scheduledDate,
    departure_airport: f.departureAirport,
    arrival_airport: f.arrivalAirport,
    departure_time: f.scheduledDeparture,
    arrival_time: f.scheduledArrival,
    equipment_code: f.equipmentCode,
    wifi_verdict: verdict,
    flight_status: f.flightStatus,
    last_updated: nowSec,
  };
}

/** Departure-airport local date; unmapped airports fall back to UTC. */
function serviceDate(departureAirport: string, departureSec: number): string {
  return (
    airportLocalDate(departureAirport, departureSec) ??
    new Date(departureSec * 1000).toISOString().slice(0, 10)
  );
}

interface IngestStats {
  routes_attempted: number;
  routes_failed: number;
  flights_upserted: number;
  history_upserted: number;
  history_staled: number;
  /** Current forward schedule by stored verdict, not this run's tally. */
  by_verdict: { Starlink: number; Rolling: number; None: number };
  pruned: number;
  far_offset: number;
  breaker_tripped: boolean;
  outcome: "success" | "partial" | "error" | "abandoned";
}

export interface IngestOptions {
  now?: number;
  /** Inter-fetch pacing; tests pass 0. */
  delayMs?: number;
}

export async function ingestQatarSchedule(
  db: Database,
  fetchRoute: typeof fetchByRoute = fetchByRoute,
  ctx?: JobRunContext,
  opts: IngestOptions = {}
): Promise<IngestStats> {
  const now = opts.now ?? Date.now();
  const nowSec = Math.floor(now / 1000);
  const delayMs = opts.delayMs ?? PER_ROUTE_DELAY_MS;

  // The cursor only advances on a run that wrote something, so skipped or
  // failed ticks can't starve an offset.
  const cursor = Number(getMeta(db, FAR_CURSOR_META, "QR") ?? 0) || 0;
  const farOffset =
    FAR_OFFSET_MIN + (((cursor % FAR_OFFSET_SPAN) + FAR_OFFSET_SPAN) % FAR_OFFSET_SPAN);

  const stats: IngestStats = {
    routes_attempted: 0,
    routes_failed: 0,
    flights_upserted: 0,
    history_upserted: 0,
    history_staled: 0,
    by_verdict: { Starlink: 0, Rolling: 0, None: 0 },
    pruned: 0,
    far_offset: farOffset,
    breaker_tripped: false,
    outcome: "success",
  };

  const dates = [...NEAR_OFFSETS, farOffset].map((d) => dohDateFromMs(now + d * 86400_000));
  const fetchedRoutes = new Map<string, [string, string]>();
  let nullStreak = 0;

  fetching: for (const [origin, destination] of ROUTES) {
    for (const date of dates) {
      stats.routes_attempted++;
      const fetchStartSec = opts.now === undefined ? Math.floor(Date.now() / 1000) : nowSec;
      const flights = await fetchRoute(origin, destination, date);
      // A run the job runner has abandoned (stuck escape) settles its fetches
      // late — its upserts/prune/stamp would regress the successor's schedule
      // under a fresh lastUpdated. Log and discard before any further write.
      if (ctx && !ctx.isCurrent()) {
        logError(
          "qatar-schedule-ingester: run was abandoned mid-fetch; discarding results, no writes"
        );
        stats.outcome = "abandoned";
        return stats;
      }
      if (flights === null) {
        stats.routes_failed++;
        nullStreak++;
        const successes = stats.routes_attempted - stats.routes_failed;
        if (
          (nullStreak >= BREAKER_NULL_STREAK && successes === 0) ||
          (stats.routes_attempted >= BREAKER_MIN_ATTEMPTS &&
            stats.routes_failed / stats.routes_attempted > BREAKER_FAILURE_RATIO)
        ) {
          stats.breaker_tripped = true;
          warn(
            `qatar-schedule-ingester: breaker tripped after ${stats.routes_failed}/${stats.routes_attempted} failed fetches; stopping this run`
          );
          break fetching;
        }
        continue;
      }
      nullStreak = 0;
      fetchedRoutes.set(`${origin}-${destination}`, [origin, destination]);
      const writeSec = opts.now === undefined ? Math.floor(Date.now() / 1000) : nowSec;
      const tx = db.transaction(() => {
        for (const f of flights) {
          if (!isOwnPassengerFlight(f)) continue;
          const row = flightToRow(f, date, writeSec);
          upsertQatarSchedule(db, row);
          stats.flights_upserted++;
          if (!f.departureAirport || f.scheduledDeparture === null) continue;
          upsertQatarEquipmentHistory(
            db,
            {
              flight_number: row.flight_number,
              departure_airport: f.departureAirport,
              service_date: serviceDate(f.departureAirport, f.scheduledDeparture),
              arrival_airport: f.arrivalAirport,
              departure_time: f.scheduledDeparture,
              arrival_time: f.scheduledArrival,
              equipment_code: f.equipmentCode,
              flight_status: f.flightStatus,
              fetch_origin: origin,
              fetch_destination: destination,
              fetch_date: date,
            },
            writeSec
          );
          stats.history_upserted++;
        }
        stats.history_staled += markQatarHistoryStale(
          db,
          origin,
          destination,
          date,
          fetchStartSec,
          writeSec
        );
        recordQatarFetchCoverage(db, origin, destination, date, writeSec);
      });
      tx();
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  stats.outcome =
    stats.routes_failed === 0
      ? "success"
      : stats.routes_failed === stats.routes_attempted
        ? "error"
        : "partial";

  // Final gate before the destructive phase — abandonment can also land
  // during the inter-route delays after the last fetch resolved.
  if (ctx && !ctx.isCurrent()) {
    logError("qatar-schedule-ingester: run was abandoned; skipping prune + meta stamp");
    stats.outcome = "abandoned";
    return stats;
  }

  // Total fetch failure = an outage, not an observation: no prune (would
  // drain the table) and no lastUpdated stamp (would mask staleness).
  if (stats.outcome === "error") {
    logError(
      `qatar-schedule-ingester: all ${stats.routes_attempted} route fetches failed; leaving qatar_schedule and meta untouched`
    );
    return stats;
  }

  // Drop schedule rows whose departure has passed by >2h, but only on routes
  // we successfully fetched this run — a failing route keeps its stale rows
  // instead of draining toward empty during a partial outage.
  stats.pruned = pruneQatarScheduleBefore(db, nowSec - 7200, [...fetchedRoutes.values()]);
  stats.pruned += pruneQatarScheduleGlobalBefore(db, nowSec - SCHEDULE_GLOBAL_PRUNE_SEC);
  const today = dohDateFromMs(now);
  pruneQatarEquipmentHistory(db, addDaysISO(today, -HISTORY_KEEP_DAYS));
  pruneQatarFetchCoverage(db, addDaysISO(today, -COVERAGE_KEEP_DAYS));

  stampLastUpdated(db, "QR", "schedule-ingester");
  setMeta(db, FAR_CURSOR_META, cursor + 1, "QR");
  // Meaning: the current forward schedule, recomputed from the table so the
  // numbers don't swing with which far date this run happened to fetch.
  const forward = countQatarForwardSchedule(db, nowSec);
  stats.by_verdict = { Starlink: forward.Starlink, Rolling: forward.Rolling, None: forward.None };
  setMeta(db, "scheduleFlights", forward.total, "QR");
  setMeta(db, "scheduleStarlink", forward.Starlink, "QR");
  setMeta(db, "scheduleRolling", forward.Rolling, "QR");
  setMeta(db, "scheduleNone", forward.None, "QR");

  return stats;
}

export function startQatarScheduleIngester(db: Database): JobHandle | undefined {
  if (!AIRLINES.QR.enabled) {
    info("qatar-schedule-ingester: QR disabled in registry; not starting");
    return undefined;
  }
  info(
    `qatar-schedule-ingester: starting (${INTERVAL_MS / 60_000}min interval, ${ROUTES.length} routes × ${NEAR_OFFSETS.length + 1} dates (+0, +1, rotating +${FAR_OFFSET_MIN}..+${FAR_OFFSET_MIN + FAR_OFFSET_SPAN - 1}), +${STARTUP_DELAY_MS / 1000}s startup delay)`
  );
  const tick = (ctx: JobRunContext) =>
    withSpan(
      "qatar_schedule.ingest",
      async (span) => {
        span.setTag("airline", normalizeAirlineTag("QR"));
        try {
          const stats = await ingestQatarSchedule(db, undefined, ctx);
          span.setTag("flights_upserted", stats.flights_upserted);
          span.setTag("routes_failed", stats.routes_failed);
          span.setTag("pruned", stats.pruned);
          span.setTag("history_upserted", stats.history_upserted);
          span.setTag("history_staled", stats.history_staled);
          span.setTag("far_offset", stats.far_offset);
          span.setTag("breaker_tripped", stats.breaker_tripped);
          metrics.increment(COUNTERS.VENDOR_REQUEST, {
            vendor: "qatar",
            type: "ingest_run",
            status: stats.outcome,
            airline: normalizeAirlineTag("QR"),
          });
          info(
            `qatar-schedule-ingester: upserted ${stats.flights_upserted} flights, ` +
              `${stats.history_upserted} history legs (${stats.history_staled} staled, far +${stats.far_offset}); ` +
              `forward schedule ${stats.by_verdict.Starlink} Starlink / ${stats.by_verdict.Rolling} Rolling / ` +
              `${stats.by_verdict.None} None; ${stats.routes_failed}/${stats.routes_attempted} route fetches failed${stats.breaker_tripped ? " (breaker tripped)" : ""}; pruned ${stats.pruned}`
          );
        } catch (e) {
          span.setTag("error", true);
          logError("qatar-schedule-ingester tick failed", e);
        }
      },
      { "job.type": "background" }
    );
  return startJob({
    name: "qatar_schedule_ingester",
    intervalMs: INTERVAL_MS,
    initialDelayMs: STARTUP_DELAY_MS,
    // A degraded run (the breaker still allows ~half of 384 fetches to time
    // out) can exceed the hourly interval — don't declare it stuck until it
    // misses two ticks.
    stuckTimeoutMs: 2 * INTERVAL_MS,
    run: tick,
  });
}

if (import.meta.main) {
  if (process.argv.includes("--routes")) {
    console.log(`${ROUTES.length} routes:`);
    for (const [o, d] of ROUTES) console.log(`  ${o}-${d}`);
    process.exit(0);
  }
  const db = initializeDatabase();
  ingestQatarSchedule(db)
    .then((s) => {
      console.log(JSON.stringify(s, null, 2));
      db.close();
    })
    .catch((e) => {
      logError("qatar-schedule-ingester CLI failed", e);
      db.close();
      process.exit(1);
    });
}
