/**
 * The flight updater's schedule: which tail a tick polls. The request rate is
 * fixed (one Flightradar24 request per 22.5 s tick, 3,840 a day), so every
 * rule here only moves polls between tails. A day of ticks is replayed on a
 * queue the size of production's, with a stepped clock and no network.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { AIRLINES, SITES, enabledAirlines } from "../src/airlines/registry";
import { FLIGHT_UPDATER_INTERVAL_MS, pickNextTail } from "../src/api/flight-updater";
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

afterEach(() => setSystemTime());

/** Production's shape on 27 Nov 2026: 1,022 tails people ask about and Air
 * France's 136, the latter last polled as one block, as the old round robin
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
  test("a tick every 22.5 s is 3,840 requests a day", () => {
    expect(FLIGHT_UPDATER_INTERVAL_MS).toBe(22_500);
    expect(TICKS_PER_DAY).toBe(3840);
  });

  test("a day of ticks on a full queue polls 3,840 tails and not one more", () => {
    const db = makeSyntheticDb();
    seedQueue(db);
    const polls = runTicks(db, TICKS_PER_DAY);
    expect(polls.length).toBe(TICKS_PER_DAY);
    // One tail per tick: no tick is ever shared between two tiers.
    expect(new Set(polls.map((p) => p.at)).size).toBe(polls.length);
    db.close();
  });
});

describe("a slow-lap airline", () => {
  test("gets one poll per tail per lap, and the main queue gets every other tick", () => {
    const db = makeSyntheticDb();
    seedQueue(db);
    const polls = runTicks(db, TICKS_PER_DAY);
    const slow = polls.filter((p) => p.tier === "slow_lap");
    const main = polls.filter((p) => p.tier === "starlink");

    expect(slow.every((p) => p.tail.startsWith("F-"))).toBe(true);
    expect(main.every((p) => p.tail.startsWith("N"))).toBe(true);
    expect(main.length + slow.length).toBe(TICKS_PER_DAY);

    // 24 h over 136 tails: one each at most. A slot waits for the next tick,
    // so a lap runs a few minutes long and never short.
    const perLap = (SLOW * 24) / AF_LAP_HOURS;
    expect(slow.length).toBeGreaterThanOrEqual(perLap - 4);
    expect(slow.length).toBeLessThanOrEqual(perLap);
    expect(new Set(slow.map((p) => p.tail)).size).toBe(slow.length);

    // Every main tail comes round in under the lap its own share allows.
    const lapMs = (MAIN / (TICKS_PER_DAY - slow.length)) * DAY_MS;
    const last = new Map<string, number>();
    let worst = 0;
    for (const p of main) {
      const prev = last.get(p.tail);
      if (prev !== undefined) worst = Math.max(worst, p.at - prev);
      last.set(p.tail, p.at);
    }
    expect(last.size).toBe(MAIN);
    expect(worst).toBeLessThanOrEqual(lapMs + 2 * FLIGHT_UPDATER_INTERVAL_MS);
    db.close();
  });

  test("is spread over its lap, not polled as a block", () => {
    const db = makeSyntheticDb();
    seedQueue(db);
    const slow = runTicks(db, TICKS_PER_DAY).filter((p) => p.tier === "slow_lap");
    const slotMs = (AF_LAP_HOURS * 3_600_000) / SLOW;
    for (let i = 1; i < slow.length; i++) {
      const gap = slow[i].at - slow[i - 1].at;
      expect(gap).toBeGreaterThanOrEqual(slotMs - 1000);
      // The freshness gauge reads the newest write: it never waits long.
      expect(gap).toBeLessThanOrEqual(slotMs + FLIGHT_UPDATER_INTERVAL_MS + 1000);
    }
    db.close();
  });

  test("keeps its spacing across a restart, since the table holds it", () => {
    const db = makeSyntheticDb();
    seedQueue(db, 5, 4);
    const now = Math.floor(T0 / 1000);
    const slotSec = (AF_LAP_HOURS * 3600) / 4;
    db.run("UPDATE starlink_planes SET last_flight_check = ? WHERE TailNumber = 'F-T100'", [
      now - 60,
    ]);
    expect(getSlowLapTailDue(db, now)).toBeNull();
    expect(getSlowLapTailDue(db, now - 60 + slotSec - 1)).toBeNull();
    expect(getSlowLapTailDue(db, now - 60 + slotSec)).toBe("F-T101");
    db.close();
  });

  test("takes a new tail at its next slot, ahead of the rest", () => {
    const db = makeSyntheticDb();
    seedQueue(db, 5, 4);
    db.run(
      `INSERT INTO starlink_planes (Aircraft, WiFi, TailNumber, OperatedBy, fleet, last_flight_check, airline)
       VALUES ('Airbus A350-900', 'StrLnk', 'F-NEW1', 'Air France', 'mainline', 0, 'AF')`
    );
    expect(getSlowLapTailDue(db, Math.floor(T0 / 1000) + AF_LAP_HOURS * 3600)).toBe("F-NEW1");
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
      expect(a.flightPollLapHours).toBeGreaterThanOrEqual(12);
    }
  });
});
