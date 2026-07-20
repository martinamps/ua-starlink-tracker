/**
 * Background-job lifecycle tests: the shared startJob runner (overlap skip,
 * stuck-run escape, orphan isolation, throw safety, cadence — all driven by a
 * fake clock, no real intervals), enqueue-only checkNewPlanes, the per-airline
 * alaska-verifier outage breaker, and freshness-gauge coverage executed over
 * the airline registry.
 */

import { describe, expect, test } from "bun:test";
import { AIRLINES, enabledAirlines } from "../src/airlines/registry";
import { checkNewPlanes } from "../src/api/flight-updater";
import { FlightRadar24API } from "../src/api/flightradar24-api";
import type { QatarFlight, fetchByRoute } from "../src/api/qatar-status";
import {
  type getNextAlaskaVerifyTarget,
  getStarlinkTailsByCheckAge,
  needsFlightCheck,
  setMeta,
} from "../src/database/database";
import { metrics } from "../src/observability/metrics";
import { makeAlaskaTick } from "../src/scripts/alaska-verifier";
import {
  FRESHNESS_COVERAGE,
  FRESHNESS_QUERIES,
  buildFreshnessCoverage,
  buildFreshnessQueries,
  emitDataFreshness,
} from "../src/scripts/data-freshness";
import { buildRoster } from "../src/scripts/fleet-sync";
import { ingestQatarSchedule } from "../src/scripts/qatar-schedule-ingester";
import { type SheetScrapeResult, runSheetScrape } from "../src/scripts/sheet-scrape";
import type { FleetStats } from "../src/types";
import { type JobClock, createOutageBreaker, startJob } from "../src/utils/job-runner";
import type { fetchAllSheets } from "../src/utils/utils";
import { addQatarRow, makeSyntheticDb } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// startJob runner — fake clock, ticks driven manually
// ─────────────────────────────────────────────────────────────────────────────

function fakeClock() {
  let now = 0;
  const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const timeouts: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const clock: JobClock = {
    now: () => now,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, cleared: false });
      return (intervals.length - 1) as unknown as ReturnType<typeof setInterval>;
    },
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms, cleared: false });
      return (timeouts.length - 1) as unknown as ReturnType<typeof setTimeout>;
    },
    clearInterval: (t) => {
      intervals[t as unknown as number].cleared = true;
    },
    clearTimeout: (t) => {
      timeouts[t as unknown as number].cleared = true;
    },
  };
  const advance = (ms: number) => {
    now += ms;
  };
  return { clock, advance, intervals, timeouts };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("startJob runner", () => {
  test("registers cadence: interval at intervalMs, initial tick at initialDelayMs", async () => {
    const fc = fakeClock();
    let runs = 0;
    startJob({
      name: "t_cadence",
      intervalMs: 22_500,
      initialDelayMs: 15_000,
      run: () => {
        runs++;
      },
      clock: fc.clock,
    });

    expect(fc.intervals.map((i) => i.ms)).toEqual([22_500]);
    expect(fc.timeouts.map((t) => t.ms)).toEqual([15_000]);

    fc.timeouts[0].fn();
    await new Promise((r) => setTimeout(r, 0)); // let the initial tick settle
    fc.intervals[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
  });

  test("no initial tick when initialDelayMs omitted", () => {
    const fc = fakeClock();
    startJob({ name: "t_no_initial", intervalMs: 1000, run: () => {}, clock: fc.clock });
    expect(fc.timeouts).toHaveLength(0);
    expect(fc.intervals).toHaveLength(1);
  });

  test("overlap skip: a tick during an in-flight run does not start a second run", async () => {
    const fc = fakeClock();
    const gate = deferred();
    let runs = 0;
    const job = startJob({
      name: "t_overlap",
      intervalMs: 1000,
      run: () => {
        runs++;
        return gate.promise;
      },
      clock: fc.clock,
    });

    const first = job.tick();
    await job.tick(); // skipped — first still in flight
    expect(runs).toBe(1);

    gate.resolve();
    await first;
    await job.tick(); // idle again — runs
    expect(runs).toBe(2);
  });

  test("stuck escape: past stuckTimeoutMs the next tick proceeds, and the orphan's settle can't clear its successor's flag", async () => {
    const fc = fakeClock();
    const gates = [deferred(), deferred(), deferred()];
    let runs = 0;
    const job = startJob({
      name: "t_stuck",
      intervalMs: 1000,
      stuckTimeoutMs: 60_000,
      run: () => gates[runs++].promise,
      clock: fc.clock,
    });

    const first = job.tick();
    fc.advance(59_999);
    await job.tick(); // within deadline — skipped
    expect(runs).toBe(1);

    fc.advance(1);
    const second = job.tick(); // past deadline — abandons run 1, starts run 2
    expect(runs).toBe(2);

    // Orphaned run 1 finally settles — must not mark the job idle while run 2
    // is still in flight (the 19h-wedge fix's token semantics).
    gates[0].resolve();
    await first;
    await job.tick(); // run 2 in flight and not stuck — still skipped
    expect(runs).toBe(2);

    gates[1].resolve();
    await second;
    gates[2].resolve(); // pre-resolve so the final tick completes cleanly
    await job.tick();
    expect(runs).toBe(3);
  });

  test("an abandoned run's late settle sees isCurrent()=false; the successor sees true", async () => {
    const fc = fakeClock();
    const gates = [deferred(), deferred()];
    let i = 0;
    let staleSettles = 0;
    let freshSettles = 0;
    const job = startJob({
      name: "t_ctx",
      intervalMs: 1000,
      stuckTimeoutMs: 60_000,
      run: async (ctx) => {
        const gate = gates[i++];
        await gate.promise;
        // The pattern flight-updater/alaska use to keep orphans from mutating
        // shared counters/breakers their successor reads.
        if (ctx.isCurrent()) freshSettles++;
        else staleSettles++;
      },
      clock: fc.clock,
    });

    const first = job.tick();
    fc.advance(60_000);
    const second = job.tick(); // abandons run 1

    gates[0].resolve();
    await first; // orphan settles late — must observe stale
    expect(staleSettles).toBe(1);
    expect(freshSettles).toBe(0);

    gates[1].resolve();
    await second; // current run settles — observes fresh
    expect(freshSettles).toBe(1);
  });

  test("a throwing run is logged, the tick resolves, and the next tick runs", async () => {
    const fc = fakeClock();
    let runs = 0;
    const job = startJob({
      name: "t_throw",
      intervalMs: 1000,
      run: () => {
        runs++;
        if (runs === 1) throw new Error("boom");
      },
      clock: fc.clock,
    });

    await job.tick(); // must not reject
    await job.tick();
    expect(runs).toBe(2);
  });

  test("a rejecting async run does not wedge the job", async () => {
    const fc = fakeClock();
    let runs = 0;
    const job = startJob({
      name: "t_reject",
      intervalMs: 1000,
      run: async () => {
        runs++;
        if (runs === 1) throw new Error("async boom");
      },
      clock: fc.clock,
    });

    await job.tick();
    await job.tick();
    expect(runs).toBe(2);
  });

  test("stop clears the interval and the pending initial timeout", () => {
    const fc = fakeClock();
    const job = startJob({
      name: "t_stop",
      intervalMs: 1000,
      initialDelayMs: 500,
      run: () => {},
      clock: fc.clock,
    });
    job.stop();
    expect(fc.intervals[0].cleared).toBe(true);
    expect(fc.timeouts[0].cleared).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zombie-run isolation: an abandoned (stuck-escaped) run whose fetch settles
// late must not DELETE/re-INSERT the roster or stamp lastUpdated — that
// silently regresses the successor's data under a fresh freshness gauge.
// ─────────────────────────────────────────────────────────────────────────────

function deferredVal<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sheetRoster = (tails: string[]) =>
  tails.map((t) => ({
    TailNumber: t,
    Aircraft: "Boeing 737-900",
    WiFi: "Starlink",
    OperatedBy: "United Airlines",
    fleet: "mainline",
    sheet_gid: "test",
    sheet_type: "test",
    DateFound: "2026-04-12",
  }));

const SHEET_STATS: FleetStats = {
  express: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
  mainline: { total: 100, starlink: 30, unverified: 0, percentage: 30 },
};

const uaSheetTails = (db: ReturnType<typeof makeSyntheticDb>) =>
  (
    db
      .query(
        "SELECT TailNumber FROM starlink_planes WHERE airline = 'UA' AND sheet_gid != 'discovery'"
      )
      .all() as Array<{ TailNumber: string }>
  )
    .map((r) => r.TailNumber)
    .sort();

describe("zombie runs cannot regress successor data", () => {
  test("sheet_scrape: abandoned run's late fetch leaves roster + meta untouched", async () => {
    const db = makeSyntheticDb();
    const fc = fakeClock();
    const zombieFetch = deferredVal<Awaited<ReturnType<typeof fetchAllSheets>>>();
    const results: SheetScrapeResult[] = [];

    let call = 0;
    const fetchSheets = (() => {
      call++;
      if (call === 1) return zombieFetch.promise; // run 1 wedges on the sheet fetch
      return Promise.resolve({
        totalAircraftCount: 900,
        starlinkAircraft: sheetRoster(["N50001", "N50002"]),
        fleetStats: SHEET_STATS,
      });
    }) as unknown as typeof fetchAllSheets;

    const job = startJob({
      name: "t_sheet_zombie",
      intervalMs: 3_600_000,
      stuckTimeoutMs: 60_000,
      clock: fc.clock,
      run: async (ctx) => {
        results.push(await runSheetScrape(db, fetchSheets, ctx));
      },
    });

    const first = job.tick(); // run 1 in flight, fetch pending
    fc.advance(60_000);
    await job.tick(); // abandons run 1; run 2 (successor) writes its roster

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("success");
    expect(uaSheetTails(db)).toEqual(["N50001", "N50002"]);
    const metaAfterSuccessor = db
      .query("SELECT value FROM meta WHERE key = 'UA:lastUpdated'")
      .get() as { value: string } | null;

    // Zombie's fetch finally resolves with a DIFFERENT roster — must discard.
    zombieFetch.resolve({
      totalAircraftCount: 900,
      starlinkAircraft: sheetRoster(["N66666"]),
      fleetStats: SHEET_STATS,
    } as Awaited<ReturnType<typeof fetchAllSheets>>);
    await first;

    expect(results).toHaveLength(2);
    expect(results[1].outcome).toBe("abandoned");
    expect(uaSheetTails(db)).toEqual(["N50001", "N50002"]);
    expect(
      (db.query("SELECT value FROM meta WHERE key = 'UA:lastUpdated'").get() as { value: string })
        ?.value
    ).toBe(metaAfterSuccessor?.value as string);
    job.stop();
    db.close();
  });

  test("qatar ingester: abandoned run's late fetch leaves schedule + meta untouched", async () => {
    const db = makeSyntheticDb();
    const fc = fakeClock();
    const now = Math.floor(Date.now() / 1000);
    const zombieFetch = deferredVal<QatarFlight[] | null>();
    const results: Awaited<ReturnType<typeof ingestQatarSchedule>>[] = [];

    // Successor-equivalent state the zombie must not disturb.
    addQatarRow(db, "QR701", now + 6 * 3600, "Starlink");
    setMeta(db, "lastUpdated", "2026-06-04T00:00:00.000Z", "QR");

    let run = 0;
    const fetchRoute = (() => {
      if (run === 1) return zombieFetch.promise; // run 1 wedges on its first route
      return Promise.resolve(null); // run 2: total outage — no writes, fast
    }) as unknown as typeof fetchByRoute;

    const job = startJob({
      name: "t_qr_zombie",
      intervalMs: 3_600_000,
      stuckTimeoutMs: 60_000,
      clock: fc.clock,
      run: async (ctx) => {
        run++;
        results.push(await ingestQatarSchedule(db, fetchRoute, ctx));
      },
    });

    const first = job.tick(); // run 1 pending on route fetch
    fc.advance(60_000);
    await job.tick(); // abandons run 1; run 2 is a fast no-op outage

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("error");

    // Zombie's fetch resolves with a flight that would upsert + prune + stamp.
    zombieFetch.resolve([
      {
        flightNumber: "0702",
        departureAirport: "DOH",
        arrivalAirport: "JFK",
        scheduledDeparture: now + 7200,
        scheduledArrival: now + 7 * 3600,
        equipmentCode: "77W",
        flightStatus: "Scheduled",
      } as QatarFlight,
    ]);
    await first;

    expect(results).toHaveLength(2);
    expect(results[1].outcome).toBe("abandoned");
    const rows = db.query("SELECT flight_number FROM qatar_schedule").all() as Array<{
      flight_number: string;
    }>;
    expect(rows).toEqual([{ flight_number: "QR701" }]);
    expect(
      (db.query("SELECT value FROM meta WHERE key = 'QR:lastUpdated'").get() as { value: string })
        .value
    ).toBe("2026-06-04T00:00:00.000Z");
    job.stop();
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkNewPlanes — enqueue-only (the 22.5s trickle does the fetching)
// ─────────────────────────────────────────────────────────────────────────────

describe("checkNewPlanes is enqueue-only", () => {
  function seedPlanes(db: ReturnType<typeof makeSyntheticDb>) {
    const insert = db.prepare(
      `INSERT INTO starlink_planes
         (Aircraft, WiFi, TailNumber, OperatedBy, fleet, last_flight_check, airline)
       VALUES (?, 'StrLnk', ?, 'United Airlines', 'mainline', ?, 'UA')`
    );
    insert.run("Boeing 737-800", "N11111", 0); // new — never checked
    insert.run("Boeing 737-800", "N22222", 0); // new — never checked
    insert.run("Boeing 737-800", "N33333", Math.floor(Date.now() / 1000)); // already checked
  }

  test("reports queued planes without any FR24 call", async () => {
    const db = makeSyntheticDb();
    seedPlanes(db);

    const fr24Spy = FlightRadar24API.prototype.getUpcomingFlights;
    let fr24Calls = 0;
    FlightRadar24API.prototype.getUpcomingFlights = async () => {
      fr24Calls++;
      throw new Error("checkNewPlanes must not fetch");
    };
    try {
      const enqueued = await checkNewPlanes(db);
      expect(enqueued).toBe(2);
      expect(fr24Calls).toBe(0);
    } finally {
      FlightRadar24API.prototype.getUpcomingFlights = fr24Spy;
    }

    // No writes: the rows stay at last_flight_check=0 for the trickle.
    const still = db
      .query("SELECT COUNT(*) AS cnt FROM starlink_planes WHERE last_flight_check = 0")
      .get() as { cnt: number };
    expect(still.cnt).toBe(2);
    db.close();
  });

  test("trickle ordering picks the enqueued tails first", () => {
    const db = makeSyntheticDb();
    seedPlanes(db);

    const ordered = getStarlinkTailsByCheckAge(db);
    expect(new Set(ordered.slice(0, 2))).toEqual(new Set(["N11111", "N22222"]));
    expect(needsFlightCheck(db, ordered[0])).toBe(true);
    expect(needsFlightCheck(db, ordered[1])).toBe(true);
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// outage breaker (generic) + alaska-verifier per-airline wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("outage breaker", () => {
  test("trips after N consecutive failures, skips M consults, then recovers", () => {
    const breaker = createOutageBreaker(3, 2);

    expect(breaker.record("failure")).toBe(false);
    expect(breaker.record("failure")).toBe(false);
    expect(breaker.record("failure")).toBe(true); // tripped

    expect(breaker.shouldSkip()).toBe(true);
    expect(breaker.shouldSkip()).toBe(true);
    expect(breaker.shouldSkip()).toBe(false); // skip window exhausted

    // Vendor back up: a success keeps the streak at zero.
    expect(breaker.record("success")).toBe(false);
    expect(breaker.record("failure")).toBe(false);
    expect(breaker.record("failure")).toBe(false);
    expect(breaker.record("success")).toBe(false); // resets the streak
    expect(breaker.record("failure")).toBe(false);
    expect(breaker.record("failure")).toBe(false);
    expect(breaker.record("failure")).toBe(true);
  });

  test("neutral outcomes leave the failure streak untouched", () => {
    const breaker = createOutageBreaker(3, 2);
    expect(breaker.record("failure")).toBe(false);
    expect(breaker.record("failure")).toBe(false);
    expect(breaker.record("neutral")).toBe(false);
    expect(breaker.record("neutral")).toBe(false);
    expect(breaker.record("failure")).toBe(true); // still the 3rd consecutive failure
  });
});

describe("alaska-verifier per-airline breaker", () => {
  const fakeTarget = (() => ({ tail_number: "N1" })) as unknown as typeof getNextAlaskaVerifyTarget;

  test("AS-only outage trips only AS; HA keeps verifying and the rotation proceeds", async () => {
    const calls: string[] = [];
    const tick = makeAlaskaTick(["AS", "HA"], {
      openDb: () => makeSyntheticDb(),
      getTarget: fakeTarget,
      check: async (_db, airline) => {
        calls.push(airline);
        return airline === "AS" ? "error" : "success";
      },
      breakerFor: () => createOutageBreaker(3, 2),
    });
    const count = (a: string) => calls.filter((c) => c === a).length;

    // 6 ticks alternate AS,HA,…: 3 AS errors (trips on the 3rd), 3 HA successes.
    for (let i = 0; i < 6; i++) await tick();
    expect(count("AS")).toBe(3);
    expect(count("HA")).toBe(3);

    // Next 4 ticks: both AS turns skipped, both HA turns still verify.
    for (let i = 0; i < 4; i++) await tick();
    expect(count("AS")).toBe(3);
    expect(count("HA")).toBe(5);

    // AS skip window exhausted — its next turn fetches again.
    await tick();
    expect(count("AS")).toBe(4);
  });

  test("a stale (abandoned) tick does not feed the breaker", async () => {
    let checks = 0;
    const tick = makeAlaskaTick(["AS"], {
      openDb: () => makeSyntheticDb(),
      getTarget: fakeTarget,
      check: async () => {
        checks++;
        return "error";
      },
      breakerFor: () => createOutageBreaker(1, 5), // would trip on the first recorded failure
    });

    await tick({ isCurrent: () => false }); // stale settle — record suppressed
    await tick({ isCurrent: () => true }); // must NOT be skipped by a phantom trip; trips for real
    expect(checks).toBe(2);

    await tick({ isCurrent: () => true }); // skipped — the current run's failure tripped it
    expect(checks).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// freshness gauges — every enabled airline has a MAX(timestamp) anchor
// ─────────────────────────────────────────────────────────────────────────────

describe("data-freshness coverage", () => {
  test("every enabled airline appears in some freshness job's coverage", () => {
    const covered = new Set(Object.values(FRESHNESS_COVERAGE).flat());
    for (const cfg of enabledAirlines()) {
      expect(covered).toContain(cfg.code);
    }
  });

  test("every freshness job has a query and every query has declared coverage", () => {
    expect(Object.keys(FRESHNESS_QUERIES).sort()).toEqual(Object.keys(FRESHNESS_COVERAGE).sort());
    for (const airlines of Object.values(FRESHNESS_COVERAGE)) {
      expect(airlines.length).toBeGreaterThan(0);
    }
  });

  // Seed one row in the table each job's query reads, for the given airline.
  // Executes the coverage claim: declaring an airline a query can't surface
  // (wrong table, wrong literal, filtered by WHERE) fails here.
  function seedFreshnessRow(
    db: ReturnType<typeof makeSyntheticDb>,
    job: string,
    airline: string,
    ts: number
  ): void {
    switch (job) {
      case "flight_updater":
        db.query(
          "INSERT INTO upcoming_flights (tail_number, flight_number, last_updated, airline) VALUES ('N1', 'X1', ?, ?)"
        ).run(ts, airline);
        break;
      case "verifier":
        db.query(
          "INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, airline) VALUES ('N1', 'test', ?, 1, ?)"
        ).run(ts, airline);
        break;
      case "departures":
        db.query(
          "INSERT INTO departure_log (tail_number, airport, departed_at, airline) VALUES ('N1', 'SFO', ?, ?)"
        ).run(ts, airline);
        break;
      case "qatar_ingester":
        db.query(
          "INSERT INTO qatar_schedule (flight_number, scheduled_date, last_updated) VALUES ('QR701', '2026-06-03', ?)"
        ).run(ts);
        break;
      case "fleet_progress":
        db.query(
          "INSERT INTO fleet_progress (airline, segment, type_code, total, starlink_complete, fetched_at) VALUES (?, 'mainline_nb', 'Totals', 878, 67, ?)"
        ).run(airline, ts);
        break;
      case "faa_registry":
        db.query(
          "INSERT INTO faa_registry (tail_number, faa_status, last_refreshed) VALUES ('N73275', 'V', ?)"
        ).run(ts);
        break;
      case "adsb_sweep":
        db.query(
          "INSERT INTO adsb_sweeps (swept_at, provider, requests, latency_ms, tails_queried, observed, airborne, matched, mismatched, no_assignment, no_callsign) VALUES (?, 'airplanes.live', 1, 250, 425, 40, 36, 11, 0, 25, 0)"
        ).run(ts);
        break;
      default:
        throw new Error(`no seeder for freshness job ${job} — add one with the query`);
    }
  }

  test("every declared airline actually surfaces in its job's query results", () => {
    const db = makeSyntheticDb();
    const ts = 1_750_000_000;
    for (const [job, airlines] of Object.entries(FRESHNESS_COVERAGE)) {
      for (const airline of airlines) seedFreshnessRow(db, job, airline, ts);
    }
    for (const [job, airlines] of Object.entries(FRESHNESS_COVERAGE)) {
      const rows = db
        .query(FRESHNESS_QUERIES[job as keyof typeof FRESHNESS_QUERIES])
        .all() as Array<{
        airline: string;
        ts: number | null;
      }>;
      for (const row of rows) {
        expect(typeof row.airline).toBe("string");
        expect(row.ts === null || typeof row.ts === "number").toBe(true);
      }
      const seen = new Set(rows.map((r) => r.airline));
      for (const airline of airlines) {
        expect(seen).toContain(airline);
      }
    }
    db.close();
  });

  test("verifier freshness counts NULL-wifi checks — the check happened", () => {
    // An alaska-json verifier without type-table coverage logs rows with
    // has_starlink NULL forever; the gauge must still see those checks
    // instead of going mute (a dead verifier and a wifi-less one must both
    // be visible, and the timestamp distinguishes them).
    const db = makeSyntheticDb();
    const ts = 1_750_000_000;
    db.query(
      "INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, airline) VALUES ('N1', 'alaska', ?, NULL, 'AS')"
    ).run(ts);
    const rows = db.query(FRESHNESS_QUERIES.verifier).all() as Array<{
      airline: string;
      ts: number | null;
    }>;
    expect(rows).toEqual([{ airline: "AS", ts }]);
    db.close();
  });

  test("qatar_ingester gauge tracks MAX(last_updated) in qatar_schedule", () => {
    const db = makeSyntheticDb();
    db.query(
      `INSERT INTO qatar_schedule (flight_number, scheduled_date, last_updated)
       VALUES ('QR701', '2026-06-03', 1000), ('QR702', '2026-06-03', 2000)`
    ).run();

    const rows = db.query(FRESHNESS_QUERIES.qatar_ingester).all() as Array<{
      airline: string;
      ts: number | null;
    }>;
    expect(rows).toEqual([{ airline: "QR", ts: 2000 }]);
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// qatar_ingester sentinel — empty table must read as maximally stale, not mute
// ─────────────────────────────────────────────────────────────────────────────

describe("qatar_ingester freshness sentinel", () => {
  type GaugeCall = { name: string; value: number; tags?: Record<string, string | number> };

  function captureGauges(
    db: ReturnType<typeof makeSyntheticDb>,
    queries?: Record<string, string>
  ): GaugeCall[] {
    const calls: GaugeCall[] = [];
    const original = metrics.gauge;
    metrics.gauge = (name, value, tags) => {
      calls.push({ name, value, tags });
    };
    try {
      emitDataFreshness(db, queries);
    } finally {
      metrics.gauge = original;
    }
    return calls;
  }

  const qatarGauge = (calls: GaugeCall[]) =>
    calls.find((c) => c.name === "data.freshness_seconds" && c.tags?.job === "qatar_ingester");

  test("empty qatar_schedule and no meta → gauge emits with age-since-epoch", () => {
    const db = makeSyntheticDb();
    const call = qatarGauge(captureGauges(db));
    expect(call).toBeDefined();
    expect(call?.tags?.airline).toBe("qatar");
    expect(call?.tags?.dataset).toBe("qatar_ingester");
    // ts fell back to 0 — staleness is the full epoch age, decades not hours.
    expect(call?.value as number).toBeGreaterThan(50 * 365 * 24 * 3600);
    db.close();
  });

  test("empty qatar_schedule with a meta stamp → gauge falls back to meta age", () => {
    const db = makeSyntheticDb();
    setMeta(db, "lastUpdated", new Date(Date.now() - 3_600_000).toISOString(), "QR");
    const call = qatarGauge(captureGauges(db));
    expect(call).toBeDefined();
    expect(call?.value as number).toBeGreaterThanOrEqual(3590);
    expect(call?.value as number).toBeLessThan(4000);
    db.close();
  });

  test("rows in qatar_schedule win over the meta fallback", () => {
    const db = makeSyntheticDb();
    const recent = Math.floor(Date.now() / 1000) - 60;
    db.query(
      "INSERT INTO qatar_schedule (flight_number, scheduled_date, last_updated) VALUES ('QR701', '2026-06-03', ?)"
    ).run(recent);
    setMeta(db, "lastUpdated", new Date(Date.now() - 3_600_000).toISOString(), "QR");
    const call = qatarGauge(captureGauges(db));
    expect(call?.value as number).toBeLessThan(300);
    db.close();
  });

  test("QR disabled → no qatar_ingester query, coverage, or gauge emission", () => {
    expect(Object.keys(buildFreshnessQueries(false))).not.toContain("qatar_ingester");
    expect(Object.keys(buildFreshnessCoverage(false))).not.toContain("qatar_ingester");

    const db = makeSyntheticDb();
    // Empty table + no meta = maximally stale; a disabled QR must still go
    // quiet instead of paging forever.
    const call = qatarGauge(captureGauges(db, buildFreshnessQueries(false)));
    expect(call).toBeUndefined();
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fleet-sync buildRoster — qx-qxe/as-asa overlap dedupe + src-derived operator
// ─────────────────────────────────────────────────────────────────────────────

describe("fleet-sync buildRoster", () => {
  const AS = AIRLINES.AS;
  const e175 = (reg: string) => ({ registration: reg, aircraftType: "Embraer E175LR" });
  const b737 = (reg: string) => ({ registration: reg, aircraftType: "Boeing 737-890" });

  test("overlapping source pages dedupe by tail (no double-count)", () => {
    const roster = buildRoster(AS, [
      // Primary livery page lists the full fleet, regional E175s included.
      { aircraft: [b737("N644AS"), e175("N654QX")] },
      // Regional page overlaps on N654QX.
      { subfleet: "horizon", aircraft: [e175("N654QX"), e175("N658QX")] },
    ]);
    expect(roster.length).toBe(3);
  });

  test("operator is src-derived only: qx-qxe rows get Horizon Air, as-asa rows emit null", () => {
    const roster = buildRoster(AS, [
      { aircraft: [b737("N644AS"), e175("N654QX")] },
      { subfleet: "horizon", aircraft: [e175("N658QX")] },
    ]);
    // as-asa-sourced E175: type-classified subfleet, but operator stays null
    // so COALESCE keeps the DB value (SkyWest-operated AS E175s exist).
    const livery = roster.find((r) => r.registration === "N654QX");
    expect(livery?.subfleet).toBe("horizon");
    expect(livery?.operator).toBeNull();
    // qx-qxe-sourced tail: the page itself proves the operator.
    const regional = roster.find((r) => r.registration === "N658QX");
    expect(regional?.subfleet).toBe("horizon");
    expect(regional?.operator).toBe("Horizon Air");
    expect(roster.find((r) => r.registration === "N644AS")?.operator).toBeNull();
  });

  test("configured page subfleet beats the type classifier", () => {
    const roster = buildRoster(AS, [{ subfleet: "horizon", aircraft: [b737("N999XX")] }]);
    expect(roster[0].subfleet).toBe("horizon");
  });
});
