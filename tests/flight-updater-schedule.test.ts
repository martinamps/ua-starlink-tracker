/**
 * The flight updater's schedule: which tail a tick polls. The request rate is
 * fixed (one Flightradar24 request per 22.5 s tick, 3,840 in a day of ticks),
 * so every rule here only moves polls between tails. Two things hold the
 * rate: pickNextTail names one tail, replayed here for a day on a queue the
 * size of production's, and the running loop asks the vendor once per tick,
 * driven here with a counting stand-in. Stepped clock, no network.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { AIRLINES, SITES, enabledAirlines } from "../src/airlines/registry";
import {
  FLIGHT_UPDATER_INTERVAL_MS,
  pickNextTail,
  startFlightUpdater,
} from "../src/api/flight-updater";
import {
  getSlowLapTailDue,
  getStarlinkTailsByCheckAge,
  updateLastFlightCheck,
} from "../src/database/database";
import { makeSyntheticDb } from "./helpers";

const DAY_MS = 86_400_000;
const TICKS_PER_DAY = DAY_MS / FLIGHT_UPDATER_INTERVAL_MS;
const T0 = Date.parse("2026-11-27T00:00:00Z");

const AF_LAP_HOURS = AIRLINES.AF.flightPollLapHours as number;
const MAIN = 1022;
const SLOW = 136;
const TICK_SEC = FLIGHT_UPDATER_INTERVAL_MS / 1000;
const LAP_SEC = AF_LAP_HOURS * 3600;
/** Ticks between two slow-lap polls while the lap is being spread: a slot
 * less a tick, waited out to the next tick. */
const stepTicks = (tails: number) => Math.ceil((LAP_SEC / tails - TICK_SEC) / TICK_SEC);

afterEach(() => setSystemTime());

/** Production's shape on 27 Nov 2026: 1,022 tails people ask about and Air
 * France's 136, the latter last polled as one block, as the one round robin
 * left them. */
function seedQueue(db: ReturnType<typeof makeSyntheticDb>, main = MAIN, slow = SLOW) {
  const insert = db.prepare(
    `INSERT INTO starlink_planes
       (Aircraft, WiFi, TailNumber, OperatedBy, fleet, last_flight_check, last_check_successful, airline)
     VALUES ('Boeing 737-800', 'StrLnk', ?, ?, 'mainline', ?, 1, ?)`
  );
  const start = Math.floor(T0 / 1000);
  const tick = FLIGHT_UPDATER_INTERVAL_MS / 1000;
  db.transaction(() => {
    for (let i = 0; i < main; i++) {
      insert.run(`N${10000 + i}`, "United Airlines", Math.floor(start - (main - i) * tick), "UA");
    }
    // The block ended an hour before the clock starts.
    for (let i = 0; i < slow; i++) {
      insert.run(`F-T${100 + i}`, "Air France", Math.floor(start - 3600 - (slow - i) * tick), "AF");
    }
  })();
}

/** Run `ticks` ticks; a poll is stood in for by the stamp a real one leaves. */
function runTicks(db: ReturnType<typeof makeSyntheticDb>, ticks: number) {
  const polls: Array<{ at: number; tail: string; tier: string }> = [];
  for (let i = 0; i < ticks; i++) {
    const at = T0 + i * FLIGHT_UPDATER_INTERVAL_MS;
    setSystemTime(new Date(at));
    const { tail, tier } = pickNextTail(db);
    if (!tail) continue;
    updateLastFlightCheck(db, tail, true);
    polls.push({ at, tail, tier });
  }
  return polls;
}

describe("the request ceiling", () => {
  test("a tick every 22.5 s is 3,840 ticks a day", () => {
    expect(FLIGHT_UPDATER_INTERVAL_MS).toBe(22_500);
    expect(TICKS_PER_DAY).toBe(3840);
  });

  test("pickNextTail names a tail on every tick of a day on a full queue: 3,840", () => {
    const db = makeSyntheticDb();
    seedQueue(db);
    const polls = runTicks(db, TICKS_PER_DAY);
    expect(polls.length).toBe(TICKS_PER_DAY);
    db.close();
  });

  // The test above calls the picker once per tick itself, so it cannot see a
  // loop that polls twice. This one runs the loop: startFlightUpdater's own
  // tick, with only the vendor replaced.
  test("the running loop asks the vendor for one tail per tick, never two", async () => {
    const db = makeSyntheticDb();
    seedQueue(db, 80, 6);
    // Every tail overdue in both queues, so each tick has work in both.
    db.run("UPDATE starlink_planes SET last_flight_check = last_flight_check - 86400");
    const asked: string[] = [];
    const handle = startFlightUpdater(db, {
      api: {
        getUpcomingFlights: async (tail: string) => {
          asked.push(tail);
          return [];
        },
      },
    });
    expect(handle).toBeDefined();
    const TICKS = 60;
    try {
      for (let i = 0; i < TICKS; i++) {
        setSystemTime(new Date(T0 + i * FLIGHT_UPDATER_INTERVAL_MS));
        const before = asked.length;
        await handle?.tick();
        expect(asked.length - before).toBe(1);
      }
    } finally {
      handle?.stop();
    }
    expect(asked.length).toBe(TICKS);
    expect(asked.some((t) => t.startsWith("F-"))).toBe(true);
    expect(asked.some((t) => t.startsWith("N"))).toBe(true);
    db.close();
  });
});

describe("a slow-lap airline", () => {
  test("has each tail polled once per lap, and the main queue gets every other tick", () => {
    const db = makeSyntheticDb();
    seedQueue(db);
    const polls = runTicks(db, TICKS_PER_DAY);
    const slow = polls.filter((p) => p.tier === "slow_lap");
    const main = polls.filter((p) => p.tier === "starlink");

    expect(slow.every((p) => p.tail.startsWith("F-"))).toBe(true);
    expect(main.every((p) => p.tail.startsWith("N"))).toBe(true);
    expect(main.length + slow.length).toBe(TICKS_PER_DAY);

    // A tail comes round a lap after its last poll: never sooner, and at
    // most two ticks later (its own tick, and one more when the stamp's
    // whole second falls just short).
    const byTail = new Map<string, number[]>();
    for (const p of slow) byTail.set(p.tail, [...(byTail.get(p.tail) ?? []), p.at]);
    expect(byTail.size).toBe(SLOW);
    let laps = 0;
    for (const at of byTail.values()) {
      for (let i = 1; i < at.length; i++) {
        const lapMs = at[i] - at[i - 1];
        expect(lapMs).toBeGreaterThanOrEqual(LAP_SEC * 1000);
        expect(lapMs).toBeLessThanOrEqual(LAP_SEC * 1000 + 2 * FLIGHT_UPDATER_INTERVAL_MS);
        laps++;
      }
    }
    expect(laps).toBeGreaterThan(SLOW);
    // So it never takes more than its share of a day's ticks.
    expect(slow.length).toBeLessThanOrEqual(Math.ceil((SLOW * 24) / AF_LAP_HOURS));

    // Every main tail comes round in the lap that the ticks left to it allow.
    const k = stepTicks(SLOW);
    const mainLapMs = MAIN * FLIGHT_UPDATER_INTERVAL_MS * (k / (k - 1));
    const last = new Map<string, number>();
    let worst = 0;
    for (const p of main) {
      const prev = last.get(p.tail);
      if (prev !== undefined) worst = Math.max(worst, p.at - prev);
      last.set(p.tail, p.at);
    }
    expect(last.size).toBe(MAIN);
    expect(worst).toBeLessThanOrEqual(mainLapMs + 2 * FLIGHT_UPDATER_INTERVAL_MS);
    db.close();
  });

  test("is spread over its lap, not polled as a block", () => {
    const db = makeSyntheticDb();
    seedQueue(db);
    const slow = runTicks(db, TICKS_PER_DAY).filter((p) => p.tier === "slow_lap");
    const stepMs = stepTicks(SLOW) * FLIGHT_UPDATER_INTERVAL_MS;
    // The freshness gauge reads the newest write. The longest wait is the one
    // gap that closes the lap.
    const closingGapMs = LAP_SEC * 1000 - (SLOW - 1) * stepMs;
    for (let i = 1; i < slow.length; i++) {
      const gap = slow[i].at - slow[i - 1].at;
      expect(gap).toBeGreaterThanOrEqual(stepMs);
      expect(gap).toBeLessThanOrEqual(closingGapMs + 2 * FLIGHT_UPDATER_INTERVAL_MS);
    }
    expect(closingGapMs).toBeLessThan(3_600_000);
    db.close();
  });

  test("keeps its spacing across a restart, since the table holds it", () => {
    const db = makeSyntheticDb();
    seedQueue(db, 5, 4);
    const now = Math.floor(T0 / 1000);
    const slotSec = LAP_SEC / 4;
    db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE airline = 'AF'", [
      now - LAP_SEC - 100,
    ]);
    db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = 'F-T100'", [
      now - 60,
    ]);
    expect(getSlowLapTailDue(db, now)).toBeNull();
    expect(getSlowLapTailDue(db, now - 60 + slotSec - 1)).toBeNull();
    expect(getSlowLapTailDue(db, now - 60 + slotSec)).toBe("F-T101");
    // The updater passes its tick, so a tail whose slot falls between two
    // ticks goes at the earlier one.
    expect(getSlowLapTailDue(db, now - 60 + slotSec - TICK_SEC, TICK_SEC)).toBe("F-T101");
    db.close();
  });

  test("leaves a tail alone until its own lap is up, however long the airline has waited", () => {
    const db = makeSyntheticDb();
    seedQueue(db, 5, 4);
    const now = Math.floor(T0 / 1000);
    db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE airline = 'AF'", [now]);
    expect(getSlowLapTailDue(db, now + LAP_SEC - 1)).toBeNull();
    expect(getSlowLapTailDue(db, now + LAP_SEC)).toBe("F-T100");
    db.close();
  });

  test("does not catch up after an outage: overdue tails still go a slot apart", () => {
    const db = makeSyntheticDb();
    seedQueue(db, 5, 4);
    const now = Math.floor(T0 / 1000);
    db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE airline = 'AF'", [
      now - 3 * LAP_SEC,
    ]);
    expect(getSlowLapTailDue(db, now)).toBe("F-T100");
    db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = 'F-T100'", [now]);
    expect(getSlowLapTailDue(db, now + TICK_SEC, TICK_SEC)).toBeNull();
    expect(getSlowLapTailDue(db, now + LAP_SEC / 4)).toBe("F-T101");
    db.close();
  });

  test("is not held by one stamp ahead of the clock: only that tail waits", () => {
    const db = makeSyntheticDb();
    seedQueue(db, 5, 4);
    const now = Math.floor(T0 / 1000);
    db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE airline = 'AF'", [
      now - LAP_SEC - 100,
    ]);
    db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = 'F-T100'", [
      now + 6 * 3600,
    ]);
    expect(getSlowLapTailDue(db, now)).toBe("F-T101");
    // Its own turn comes a lap after the clock passes the stamp.
    for (const t of ["F-T101", "F-T102", "F-T103"]) {
      db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = ?", [now, t]);
    }
    expect(getSlowLapTailDue(db, now + 6 * 3600 + LAP_SEC - 1)).not.toBe("F-T100");
    db.close();
  });

  test("takes a new tail at its next slot, ahead of the rest", () => {
    const db = makeSyntheticDb();
    seedQueue(db, 5, 4);
    db.run(
      `INSERT INTO starlink_planes (Aircraft, WiFi, TailNumber, OperatedBy, fleet, last_flight_check, airline)
       VALUES ('Airbus A350-900', 'StrLnk', 'F-NEW1', 'Air France', 'mainline', 0, 'AF')`
    );
    // seedQueue stamped the others about an hour before T0: a slot on from
    // the newest of them, the new tail is the one that goes.
    expect(getSlowLapTailDue(db, Math.floor(T0 / 1000))).toBeNull();
    expect(getSlowLapTailDue(db, Math.floor(T0 / 1000) + LAP_SEC / 5)).toBe("F-NEW1");
    db.close();
  });

  test("is out of the main queue", () => {
    const db = makeSyntheticDb();
    seedQueue(db, 3, 2);
    expect(getStarlinkTailsByCheckAge(db)).toEqual(["N10000", "N10001", "N10002"]);
    db.close();
  });

  test("is only ever an airline with no per-flight surface", () => {
    const slow = enabledAirlines().filter((a) => a.flightPollLapHours);
    expect(slow.map((a) => a.code)).toEqual(["AF"]);
    for (const a of slow) {
      // Each of these reads upcoming_flights for the airline: the hub's fleet
      // surfaces, its content pages and lookups, a tenant host, MCP ?scope=.
      expect(a.publicInHub).toBe(false);
      expect(a.hubContentOnly ?? false).toBe(false);
      expect(a.hubFlightLookup ?? false).toBe(false);
      expect(Object.values(SITES).some((s) => s.scope === a.code)).toBe(false);
    }
  });

  test("keeps a lap that records Air France's departures and drifts round the clock", () => {
    // Above 8 h the departure log starts to lose legs (about 6% at 10 h, as
    // measured 27 Nov 2026): a longer lap is a decision, not a tidy-up.
    expect(AF_LAP_HOURS).toBeLessThanOrEqual(8);
    // A whole number of laps a day would poll each tail at the same clock
    // times every day. This one moves at least half an hour a day.
    const offWholeLaps = Math.abs(24 - Math.round(24 / AF_LAP_HOURS) * AF_LAP_HOURS);
    expect(offWholeLaps).toBeGreaterThanOrEqual(0.5);
  });
});
