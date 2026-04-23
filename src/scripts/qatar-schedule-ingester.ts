/**
 * Qatar Airways schedule + equipment ingester.
 *
 * Polls QR's flight-status API for high-traffic routes for the next ~48h and
 * caches each scheduled flight's equipment code in `qatar_schedule`.
 * `/api/check-flight` reads from this table — we never proxy live calls per
 * the CLAUDE.md upstream-citizenship rule.
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
import {
  type QatarFlight,
  fetchByRoute,
  isQatarFreighterEquipment,
  qatarEquipmentToWifi,
} from "../api/qatar-status";
import {
  initializeDatabase,
  pruneQatarScheduleBefore,
  setMeta,
  upsertQatarSchedule,
} from "../database/database";
import { COUNTERS, metrics, normalizeAirlineTag, withSpan } from "../observability";
import { info, error as logError } from "../utils/logger";

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 45_000; // stagger after server boot
const PER_ROUTE_DELAY_MS = 400; // ~1.5/s — well under any plausible limit
const FORWARD_DAYS = 2; // ingest today + tomorrow (DOH local)

/**
 * High-traffic QR routes. Each direction is a separate API call. Curated for
 * (a) US/EU long-haul where users care most, (b) coverage of every passenger
 * subfleet (B777, A350, B787, B788), (c) major Middle East / Asia / Africa.
 *
 * 70 routes × 2 days = 140 calls/hour ≈ one every 25 seconds. Comfortably
 * below our observed rate-limit ceiling (10 rapid calls returned 200, no
 * captcha).
 */
const ROUTES: Array<[string, string]> = [
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
function dohDateISO(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Qatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function flightToRow(f: QatarFlight, scheduledDate: string) {
  const verdict = qatarEquipmentToWifi(f.equipmentCode);
  return {
    flight_number: `QR${f.flightNumber.replace(/^0+/, "") || "0"}`,
    scheduled_date: scheduledDate,
    departure_airport: f.departureAirport,
    arrival_airport: f.arrivalAirport,
    departure_time: f.scheduledDeparture,
    arrival_time: f.scheduledArrival,
    equipment_code: f.equipmentCode,
    wifi_verdict: verdict,
    flight_status: f.flightStatus,
    last_updated: Math.floor(Date.now() / 1000),
  };
}

interface IngestStats {
  routes_attempted: number;
  routes_failed: number;
  flights_upserted: number;
  by_verdict: { Starlink: number; Rolling: number; None: number };
  pruned: number;
}

export async function ingestQatarSchedule(db: Database): Promise<IngestStats> {
  const stats: IngestStats = {
    routes_attempted: 0,
    routes_failed: 0,
    flights_upserted: 0,
    by_verdict: { Starlink: 0, Rolling: 0, None: 0 },
    pruned: 0,
  };

  const now = Date.now();
  const dates = Array.from({ length: FORWARD_DAYS }, (_, i) => dohDateISO(now + i * 86400_000));

  for (const [origin, destination] of ROUTES) {
    for (const date of dates) {
      stats.routes_attempted++;
      const flights = await fetchByRoute(origin, destination, date);
      if (flights === null) {
        stats.routes_failed++;
        continue;
      }
      const tx = db.transaction(() => {
        for (const f of flights) {
          if (!f.flightNumber || !f.scheduledDeparture) continue;
          // Skip Qatar Cargo freighter flights — not passenger-bookable.
          if (isQatarFreighterEquipment(f.equipmentCode)) continue;
          const row = flightToRow(f, date);
          upsertQatarSchedule(db, row);
          stats.flights_upserted++;
          stats.by_verdict[row.wifi_verdict as keyof typeof stats.by_verdict]++;
        }
      });
      tx();
      await new Promise((r) => setTimeout(r, PER_ROUTE_DELAY_MS));
    }
  }

  // Drop schedule rows whose departure has passed by >2h. Keeps the table at
  // ~few-thousand rows and drops historical noise that /api/check-flight
  // shouldn't return anyway.
  stats.pruned = pruneQatarScheduleBefore(db, Math.floor(now / 1000) - 7200);

  setMeta(db, "lastUpdated", new Date().toISOString(), "QR");
  setMeta(db, "scheduleFlights", stats.flights_upserted, "QR");
  setMeta(db, "scheduleStarlink", stats.by_verdict.Starlink, "QR");
  setMeta(db, "scheduleRolling", stats.by_verdict.Rolling, "QR");
  setMeta(db, "scheduleNone", stats.by_verdict.None, "QR");

  return stats;
}

export function startQatarScheduleIngester(): void {
  info(
    `qatar-schedule-ingester: starting (${INTERVAL_MS / 60_000}min interval, ${ROUTES.length} routes × ${FORWARD_DAYS} days, +${STARTUP_DELAY_MS / 1000}s startup delay)`
  );
  const tick = () =>
    withSpan(
      "qatar_schedule.ingest",
      async (span) => {
        span.setTag("airline", normalizeAirlineTag("QR"));
        try {
          const db = initializeDatabase();
          try {
            const stats = await ingestQatarSchedule(db);
            span.setTag("flights_upserted", stats.flights_upserted);
            span.setTag("routes_failed", stats.routes_failed);
            span.setTag("pruned", stats.pruned);
            metrics.increment(COUNTERS.VENDOR_REQUEST, {
              vendor: "qatar",
              type: "ingest_run",
              status: stats.routes_failed === 0 ? "success" : "partial",
              airline: normalizeAirlineTag("QR"),
            });
            info(
              `qatar-schedule-ingester: upserted ${stats.flights_upserted} flights ` +
                `(${stats.by_verdict.Starlink} Starlink / ${stats.by_verdict.Rolling} Rolling / ` +
                `${stats.by_verdict.None} None); ${stats.routes_failed}/${stats.routes_attempted} route fetches failed; pruned ${stats.pruned}`
            );
          } finally {
            db.close();
          }
        } catch (e) {
          span.setTag("error", true);
          logError("qatar-schedule-ingester tick failed", e);
        }
      },
      { "job.type": "background" }
    );
  setTimeout(tick, STARTUP_DELAY_MS);
  setInterval(tick, INTERVAL_MS);
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
