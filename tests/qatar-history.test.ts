/**
 * Qatar equipment history, fetch coverage and the three-tier QR verdict
 * (published type → observed-type history → no data). Hermetic: synthetic
 * in-memory DBs with a fixed clock.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AIRLINES } from "../src/airlines/registry";
import { resolveFlightVerdict, verdictTelemetry } from "../src/api/check-flight-core";
import { qatarDaysOut, qatarEquipmentToWifi } from "../src/api/qatar-status";
import {
  addDaysISO,
  qatarHistoryReason,
  qatarHistoryStats,
  qatarMixSentence,
  wilsonLowerBound,
} from "../src/api/qatar-verdict";
import {
  getQatarEquipmentHistory,
  getQatarEquipmentHistoryByWindow,
  getQatarFetchCoverage,
  getQatarHistoryRoutes,
  markQatarHistoryStale,
  pruneQatarEquipmentHistory,
  pruneQatarFetchCoverage,
  pruneQatarScheduleBefore,
  pruneQatarScheduleGlobalBefore,
  recordQatarFetchCoverage,
  upsertQatarEquipmentHistory,
  upsertQatarSchedule,
} from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { COUNTERS, metrics } from "../src/observability/metrics";
import { backtestQatarHistory, qatarSwapStudy } from "../src/scripts/qatar-history-backtest";
import { airportLocalDate, iataSeasonIndex, iataSeasonKey } from "../src/utils/airport-tz";
import { makeSyntheticDb, utc } from "./helpers";

// 11:00 in Doha.
const NOW = utc("2026-09-19T08:00:00Z");
const TODAY = "2026-09-19";

interface LegOpts {
  dep?: string;
  arr?: string;
  hourZ?: string;
  status?: string;
  fetch?: [string, string];
  fetchDate?: string;
  seenAt?: number;
}

function historyLeg(db: Database, fn: string, date: string, eq: string, o: LegOpts = {}) {
  const dep = o.dep ?? "DOH";
  const depSec = utc(`${date}T${o.hourZ ?? "06:40"}:00Z`);
  const seenAt = o.seenAt ?? NOW;
  upsertQatarEquipmentHistory(
    db,
    {
      flight_number: fn,
      departure_airport: dep,
      service_date: airportLocalDate(dep, depSec) ?? date,
      arrival_airport: o.arr ?? "LHR",
      departure_time: depSec,
      arrival_time: depSec + 7 * 3600,
      equipment_code: eq,
      flight_status: o.status ?? (depSec < NOW ? "ARRIVED" : "SCHEDULED"),
      fetch_origin: o.fetch?.[0] ?? dep,
      fetch_destination: o.fetch?.[1] ?? o.arr ?? "LHR",
      fetch_date: o.fetchDate ?? date,
    },
    seenAt
  );
  return depSec;
}

function scheduleRow(
  db: Database,
  fn: string,
  date: string,
  eq: string,
  o: { wifi?: string; status?: string; dep?: string; arr?: string } = {}
) {
  const depSec = utc(`${date}T06:40:00Z`);
  upsertQatarSchedule(db, {
    flight_number: fn,
    scheduled_date: date,
    departure_airport: o.dep ?? "DOH",
    arrival_airport: o.arr ?? "LHR",
    departure_time: depSec,
    arrival_time: depSec + 7 * 3600,
    equipment_code: eq,
    wifi_verdict: o.wifi ?? qatarEquipmentToWifi(eq),
    flight_status: o.status ?? "SCHEDULED",
    last_updated: NOW,
  });
  return depSec;
}

/** One DOH-LHR leg per day for `days` consecutive dates starting at `from`. */
function daily(db: Database, fn: string, from: string, days: number, eq: (i: number) => string) {
  for (let i = 0; i < days; i++) historyLeg(db, fn, addDaysISO(from, i), eq(i));
}

function qr(db: Database) {
  return createReaderFactory(db)("QR");
}

const at = (dateOffset: number) => addDaysISO(TODAY, dateOffset);

async function verdict(db: Database, fn: string, date: string, now = NOW) {
  return resolveFlightVerdict(AIRLINES.QR, qr(db), fn, date, { now, lookupTail: null });
}

describe("qatar_equipment_history persistence", () => {
  test("upsert keeps first-seen facts, updates the rest, clears stale_at", () => {
    const db = makeSyntheticDb();
    const depSec = historyLeg(db, "QR1", at(3), "77W", { seenAt: NOW });
    markQatarHistoryStale(db, "DOH", "LHR", at(3), NOW + 60);
    historyLeg(db, "QR1", at(3), "388", { seenAt: NOW + 3600, status: "DELAYED" });
    const [row] = db.query("SELECT * FROM qatar_equipment_history").all() as Array<
      Record<string, unknown>
    >;
    expect(row.first_equipment_code).toBe("77W");
    expect(row.first_seen_at).toBe(NOW);
    expect(row.first_seen_lead_sec).toBe(depSec - NOW);
    expect(row.equipment_code).toBe("388");
    expect(row.flight_status).toBe("DELAYED");
    expect(row.last_seen_at).toBe(NOW + 3600);
    expect(row.stale_at).toBeNull();
  });

  test("both legs of a through-flight are stored (QR914 DOH-ADL, ADL-AKL)", () => {
    const db = makeSyntheticDb();
    historyLeg(db, "QR914", at(1), "77W", { arr: "ADL", hourZ: "20:00", fetch: ["DOH", "AKL"] });
    historyLeg(db, "QR914", at(2), "77W", {
      dep: "ADL",
      arr: "AKL",
      hourZ: "12:00",
      fetch: ["DOH", "AKL"],
    });
    expect(getQatarEquipmentHistory(db, ["QR914"], at(0), at(6)).length).toBe(2);
  });

  test("service_date is the departure airport's local date", () => {
    const doh = utc("2026-09-20T22:30:00Z");
    expect(airportLocalDate("DOH", doh)).toBe("2026-09-21");
    expect(airportLocalDate("LHR", doh)).toBe("2026-09-20");
    expect(airportLocalDate("WAW", utc("2026-09-20T23:30:00Z"))).toBe("2026-09-21");
  });

  test("markQatarHistoryStale retires only unseen, future rows of the same fetch key", () => {
    const db = makeSyntheticDb();
    historyLeg(db, "QR1", at(3), "77W", { seenAt: NOW - 3600 });
    historyLeg(db, "QR3", at(3), "388", { seenAt: NOW + 10 });
    historyLeg(db, "QR5", at(-2), "77W", { seenAt: NOW - 3600, fetchDate: at(3) });
    historyLeg(db, "QR7", at(3), "77W", { seenAt: NOW - 3600, fetch: ["DOH", "MAN"] });
    const staled = markQatarHistoryStale(db, "DOH", "LHR", at(3), NOW);
    expect(staled).toBe(1);
    const live = getQatarEquipmentHistory(db, ["QR1", "QR3", "QR5", "QR7"], at(-5), at(6));
    expect(live.map((r) => r.flight_number).sort()).toEqual(["QR3", "QR5", "QR7"]);
    const byWindow = getQatarEquipmentHistoryByWindow(db, ["QR1"], NOW, NOW + 7 * 86400);
    expect(byWindow[0].stale_at).not.toBeNull();
    historyLeg(db, "QR1", at(3), "77W", { seenAt: NOW + 3600 });
    expect(getQatarEquipmentHistory(db, ["QR1"], at(0), at(6)).length).toBe(1);
  });

  test("the global 48h schedule prune removes an off-pair leg the route prune leaves", () => {
    const db = makeSyntheticDb();
    scheduleRow(db, "QR914", at(-3), "77W", { dep: "ADL", arr: "AKL" });
    scheduleRow(db, "QR1", at(-1), "77W");
    expect(pruneQatarScheduleBefore(db, NOW - 7200, [["DOH", "AKL"]])).toBe(0);
    expect(pruneQatarScheduleGlobalBefore(db, NOW - 48 * 3600)).toBe(1);
    const left = db.query("SELECT flight_number FROM qatar_schedule").all();
    expect(left).toEqual([{ flight_number: "QR1" }]);
  });

  test("history and coverage prunes respect their cutoffs", () => {
    const db = makeSyntheticDb();
    historyLeg(db, "QR1", at(-61), "77W");
    historyLeg(db, "QR1", at(-59), "77W");
    recordQatarFetchCoverage(db, "DOH", "LHR", at(-11), NOW);
    recordQatarFetchCoverage(db, "DOH", "LHR", at(-9), NOW);
    expect(pruneQatarEquipmentHistory(db, at(-60))).toBe(1);
    expect(pruneQatarFetchCoverage(db, at(-10))).toBe(1);
    const cov = getQatarFetchCoverage(db, [{ origin: "DOH", destination: "LHR" }], [at(-9)]);
    expect(cov.has(`DOH-LHR-${at(-9)}`)).toBe(true);
  });

  test("readers over a DB without the new tables answer empty, never throw", () => {
    const bare = new Database(":memory:");
    expect(getQatarEquipmentHistory(bare, ["QR1"], at(0), at(6))).toEqual([]);
    expect(getQatarEquipmentHistoryByWindow(bare, ["QR1"], 0, NOW)).toEqual([]);
    expect(getQatarHistoryRoutes(bare, ["QR1"], at(-28))).toEqual([]);
    expect(getQatarFetchCoverage(bare, [{ origin: "DOH", destination: "LHR" }], [at(0)]).size).toBe(
      0
    );
    bare.close();
  });
});

describe("QR verdict: published schedule window", () => {
  test("classifies at read time: a 788 stored as Rolling answers yes", async () => {
    const db = makeSyntheticDb();
    scheduleRow(db, "QR1", at(3), "788", { wifi: "Rolling" });
    const v = await verdict(db, "QR1", at(3));
    expect(v.kind).toBe("qatar");
    if (v.kind === "qatar") {
      expect(v.hasStarlink).toBe(true);
      expect(v.qclass).toBe("yes");
      expect(v.reason).toContain("Qatar reports");
      expect(v.reason).toContain("787-8 fleet");
    }
  });

  test.each([
    ["789", null, "rolling"],
    ["388", false, "no"],
    ["779", null, "unknown"],
  ])("%s → hasStarlink %p (%s)", async (eq, want, qclass) => {
    const db = makeSyntheticDb();
    scheduleRow(db, "QR11", at(2), eq);
    const v = await verdict(db, "QR11", at(2));
    expect(v.kind).toBe("qatar");
    if (v.kind === "qatar") {
      expect(v.hasStarlink).toBe(want);
      expect(v.qclass).toBe(qclass);
    }
  });

  test("an unrecognised code is counted with the airline tag", async () => {
    const db = makeSyntheticDb();
    scheduleRow(db, "QR11", at(2), "7X9");
    const calls: Array<{ name: string; tags?: Record<string, string | number> }> = [];
    const original = metrics.increment;
    metrics.increment = (name, tags) => {
      calls.push({ name, tags });
    };
    try {
      await verdict(db, "QR11", at(2));
    } finally {
      metrics.increment = original;
    }
    const hit = calls.find((c) => c.name === COUNTERS.QATAR_UNKNOWN_EQUIPMENT);
    expect(hit?.tags).toEqual({ airline: "qatar", code: "7X9" });
  });

  test("every matched row cancelled → null with a cancelled reason", async () => {
    const db = makeSyntheticDb();
    scheduleRow(db, "QR1", at(1), "77W", { status: "CANCELLED" });
    const v = await verdict(db, "QR1", at(1));
    expect(v.kind).toBe("qatar");
    if (v.kind === "qatar") {
      expect(v.hasStarlink).toBeNull();
      expect(v.reason).toContain("cancelled");
      expect(verdictTelemetry(v).outcome).toBe("no_data");
    }
  });

  test("QR001, QR1 and a bare 1 resolve to the same rows", async () => {
    const db = makeSyntheticDb();
    scheduleRow(db, "QR1", at(1), "77W");
    for (const fn of ["QR001", "QR1", "1"]) {
      const v = await verdict(db, fn, at(1));
      expect(v.kind, fn).toBe("qatar");
      if (v.kind === "qatar") expect(v.rows.length, fn).toBe(1);
    }
  });

  test("a row only in history is answered through the union", async () => {
    const db = makeSyntheticDb();
    historyLeg(db, "QR15", at(1), "77W");
    const v = await verdict(db, "QR15", at(1));
    expect(v.kind).toBe("qatar");
    if (v.kind === "qatar") expect(v.hasStarlink).toBe(true);
  });

  test("a schedule row whose history twin went stale is a phantom", async () => {
    const db = makeSyntheticDb();
    scheduleRow(db, "QR15", at(1), "77W");
    historyLeg(db, "QR15", at(1), "77W", { seenAt: NOW - 3600 });
    markQatarHistoryStale(db, "DOH", "LHR", at(1), NOW);
    const v = await verdict(db, "QR15", at(1));
    expect(v.kind).not.toBe("qatar");
  });

  test("through-flight legs on one date are one answer (DOH→ADL→AKL)", async () => {
    const db = makeSyntheticDb();
    historyLeg(db, "QR914", at(1), "77W", { arr: "ADL", hourZ: "08:00", fetch: ["DOH", "AKL"] });
    historyLeg(db, "QR914", at(1), "77W", {
      dep: "ADL",
      arr: "AKL",
      hourZ: "09:30",
      fetch: ["DOH", "AKL"],
    });
    const v = await verdict(db, "QR914", at(1));
    expect(v.kind).toBe("qatar");
    if (v.kind === "qatar") expect(v.reason).toContain("DOH→ADL");
  });

  test("a through-flight's later leg belongs to the day its rotation left Doha", async () => {
    const db = makeSyntheticDb();
    historyLeg(db, "QR914", at(1), "77W", { arr: "ADL", hourZ: "20:00", fetch: ["DOH", "AKL"] });
    historyLeg(db, "QR914", at(2), "77W", {
      dep: "ADL",
      arr: "AKL",
      hourZ: "12:00",
      fetch: ["DOH", "AKL"],
    });
    const departing = await verdict(db, "QR914", at(1));
    expect(departing.kind).toBe("qatar");
    if (departing.kind === "qatar") {
      expect(departing.rows.length).toBe(2);
      expect(departing.rows[0].departure_airport).toBe("DOH");
    }
    expect((await verdict(db, "QR914", at(2))).kind).not.toBe("qatar");
  });

  test("REST/MCP telemetry keeps type answers apart from verified ones", async () => {
    const db = makeSyntheticDb();
    scheduleRow(db, "QR1", at(1), "77W");
    scheduleRow(db, "QR3", at(1), "388");
    const yes = verdictTelemetry(await verdict(db, "QR1", at(1)));
    const no = verdictTelemetry(await verdict(db, "QR3", at(1)));
    expect(yes.outcome).toBe("type_yes");
    expect(no.outcome).toBe("type_no");
    expect(yes.confidence).not.toBe("high");
  });
});

describe("QR verdict: no rows inside the window", () => {
  function seededQR1() {
    const db = makeSyntheticDb();
    daily(db, "QR1", at(-10), 10, () => "77W");
    return db;
  }

  test("fetched route + date with no rows → doesn't operate (no data)", async () => {
    const db = seededQR1();
    recordQatarFetchCoverage(db, "DOH", "LHR", at(3), NOW);
    recordQatarFetchCoverage(db, "DOH", "LHR", at(2), NOW);
    const v = await verdict(db, "QR1", at(3));
    expect(v.kind).toBe("qatar_no_data");
    if (v.kind === "qatar_no_data") expect(v.reason).toBe("not_scheduled");
  });

  test("not fetched yet → history answer flagged notFetched", async () => {
    const v = await verdict(seededQR1(), "QR1", at(3));
    expect(v.kind).toBe("qatar_history");
    if (v.kind === "qatar_history") {
      expect(v.notFetched).toBe(true);
      expect(v.nDays).toBe(10);
      expect(qatarHistoryReason(v)).toContain("hasn't been checked");
    }
  });

  test("+6 is only partly published → history, never not_scheduled", async () => {
    const db = seededQR1();
    recordQatarFetchCoverage(db, "DOH", "LHR", at(6), NOW);
    recordQatarFetchCoverage(db, "DOH", "LHR", at(5), NOW);
    const v = await verdict(db, "QR1", at(6));
    expect(v.kind).toBe("qatar_history");
    if (v.kind === "qatar_history") {
      expect(v.notFetched).toBe(true);
      expect(v.partlyPublished).toBe(true);
      expect(qatarHistoryReason(v)).toContain("full schedule");
    }
  });

  function seededQR702() {
    const db = makeSyntheticDb();
    for (let i = 1; i <= 10; i++) {
      historyLeg(db, "QR702", at(-i), "77W", { dep: "JFK", arr: "DOH", hourZ: "02:00" });
    }
    return db;
  }

  test("a +5 date last fetched while it was +6 isn't proof of absence", async () => {
    const db = seededQR702();
    recordQatarFetchCoverage(db, "JFK", "DOH", at(5), NOW - 86400);
    recordQatarFetchCoverage(db, "JFK", "DOH", at(4), NOW);
    expect((await verdict(db, "QR702", at(5))).kind).toBe("qatar_history");
    recordQatarFetchCoverage(db, "JFK", "DOH", at(5), NOW);
    expect((await verdict(db, "QR702", at(5))).kind).toBe("qatar_no_data");
  });

  test("a fetch just after DOH midnight doesn't cover a west-origin +5 evening", async () => {
    const db = seededQR702();
    // 01:00 in Doha, still the previous UTC day.
    const now = utc("2026-09-18T22:00:00Z");
    recordQatarFetchCoverage(db, "JFK", "DOH", at(5), now);
    recordQatarFetchCoverage(db, "JFK", "DOH", at(4), now);
    const v = await verdict(db, "QR702", at(5), now);
    expect(v.kind).toBe("qatar_history");
    if (v.kind === "qatar_history") expect(v.partlyPublished).toBe(true);
  });

  test("never seen on a tracked route → no data", async () => {
    const v = await verdict(makeSyntheticDb(), "QR8888", at(2));
    expect(v.kind).toBe("qatar_no_data");
    if (v.kind === "qatar_no_data") expect(v.reason).toBe("not_tracked");
  });

  test("a past date with nothing on record → no data", async () => {
    const v = await verdict(seededQR1(), "QR1", at(-5 - 30));
    expect(v.kind).toBe("qatar_no_data");
  });
});

describe("QR verdict: observed-type history beyond the window", () => {
  test("20 all-777 operating days → high-grade probability in (0.8, 1)", async () => {
    const db = makeSyntheticDb();
    daily(db, "QR1", at(-19), 20, () => "77W");
    const v = await verdict(db, "QR1", at(20));
    expect(v.kind).toBe("qatar_history");
    if (v.kind === "qatar_history") {
      expect(v.basis).toBe("history");
      expect(v.probability).toBeGreaterThan(0.8);
      expect(v.probability).toBeLessThan(1);
      expect(v.grade).toBe("high");
      expect(v.nFlown + v.nScheduled).toBe(v.nDays);
      const t = verdictTelemetry(v);
      expect(t.outcome).toBe("predicted");
      expect(["high", "medium", "low"]).toContain(t.confidence);
    }
  });

  test("11 all-yes days reach 0.8; 10 do not", async () => {
    const db = makeSyntheticDb();
    daily(db, "QR21", at(-11), 11, () => "359");
    daily(db, "QR22", at(-10), 10, () => "359");
    const eleven = await verdict(db, "QR21", at(20));
    const ten = await verdict(db, "QR22", at(20));
    if (eleven.kind !== "qatar_history" || ten.kind !== "qatar_history") {
      throw new Error("expected history verdicts");
    }
    expect(eleven.probability).toBeGreaterThanOrEqual(0.8);
    expect(ten.probability).toBeLessThan(0.8);
  });

  test("3 operating days → no probability", async () => {
    const db = makeSyntheticDb();
    daily(db, "QR31", at(-3), 3, () => "77W");
    const v = await verdict(db, "QR31", at(20));
    expect(v.kind).toBe("qatar_history");
    if (v.kind === "qatar_history") {
      expect(v.probability).toBeNull();
      expect(verdictTelemetry(v).outcome).toBe("no_data");
    }
  });

  test("all 787-9 → a maybe with no probability, never a confident 0%", async () => {
    const db = makeSyntheticDb();
    daily(db, "QR41", at(-19), 20, () => "789");
    const v = await verdict(db, "QR41", at(20));
    if (v.kind !== "qatar_history") throw new Error(v.kind);
    expect(v.probability).toBeNull();
    expect(v.mostlyRolling).toBe(true);
    expect(v.rollingDays).toBe(20);
    expect(qatarHistoryReason(v)).toContain("787-9");
    expect(qatarHistoryReason(v)).not.toContain("0 on types");
  });

  test("all A380 → probability 0 with a plain 'none fitted' reason", async () => {
    const db = makeSyntheticDb();
    daily(db, "QR43", at(-19), 20, () => "388");
    const v = await verdict(db, "QR43", at(20));
    if (v.kind !== "qatar_history") throw new Error(v.kind);
    expect(v.probability).toBe(0);
    expect(v.mostlyRolling).toBe(false);
    expect(qatarHistoryReason(v)).toContain("none on a Starlink-fitted type");
  });

  test("30 yes + 5 787-9 of 35 days is not badgeable", async () => {
    const db = makeSyntheticDb();
    daily(db, "QR42", at(-28), 35, (i) => (i % 7 === 3 ? "789" : "77W"));
    const v = await verdict(db, "QR42", at(20));
    if (v.kind !== "qatar_history") throw new Error(v.kind);
    expect(v.nDays).toBe(35);
    expect(v.yesDays).toBe(30);
    expect(v.probability).toBeLessThan(0.8);
  });

  test("a through-flight counts operating days, not legs", async () => {
    const db = makeSyntheticDb();
    for (let i = 1; i <= 14; i++) {
      historyLeg(db, "QR914", at(-i), "77W", { arr: "ADL", hourZ: "20:00", fetch: ["DOH", "AKL"] });
      historyLeg(db, "QR914", at(-i + 1), "77W", {
        dep: "ADL",
        arr: "AKL",
        hourZ: "12:00",
        fetch: ["DOH", "AKL"],
      });
    }
    const v = await verdict(db, "QR914", at(20));
    if (v.kind !== "qatar_history") throw new Error(v.kind);
    expect(v.nDays).toBe(14);
    expect(v.mix.reduce((n, m) => n + m.count, 0)).toBe(v.nDays);
  });

  test("next season with few in-season days borrows all history, one grade down", async () => {
    const now = utc("2026-10-20T08:00:00Z");
    const db = makeSyntheticDb();
    for (let i = -28; i <= 6; i++) historyLeg(db, "QR51", addDaysISO("2026-10-20", i), "77W");
    const v = await verdict(db, "QR51", "2026-11-10", now);
    if (v.kind !== "qatar_history") throw new Error(v.kind);
    expect(v.season.query).toBe("W26");
    expect(v.season.shifted).toBe(true);
    expect(v.grade).toBe("medium");
    expect(qatarHistoryReason(v)).toContain("2026-10-25");
  });

  test("just after a season change, borrowing the last season costs a grade", async () => {
    const now = utc("2026-10-27T08:00:00Z");
    const db = makeSyntheticDb();
    for (let i = -28; i <= 2; i++) historyLeg(db, "QR54", addDaysISO("2026-10-27", i), "77W");
    const v = await verdict(db, "QR54", "2026-11-10", now);
    if (v.kind !== "qatar_history") throw new Error(v.kind);
    expect(v.season.shifted).toBe(false);
    expect(v.nDays).toBeGreaterThanOrEqual(14);
    expect(v.grade).toBe("medium");
  });

  test("once the query's season has 7+ days, only that season counts", async () => {
    const now = utc("2026-11-01T08:00:00Z");
    const db = makeSyntheticDb();
    for (let i = -28; i <= 6; i++) {
      const d = addDaysISO("2026-11-01", i);
      historyLeg(db, "QR52", d, d >= "2026-10-25" ? "77W" : "388");
    }
    const v = await verdict(db, "QR52", "2026-11-20", now);
    if (v.kind !== "qatar_history") throw new Error(v.kind);
    expect(v.season.used).toBe("W26");
    expect(v.season.shifted).toBe(false);
    expect(v.nDays).toBe(14);
    expect(v.noDays).toBe(0);
  });

  test("two or more seasons ahead → no probability", async () => {
    const db = makeSyntheticDb();
    daily(db, "QR53", at(-19), 20, () => "77W");
    const v = await verdict(db, "QR53", "2027-06-10");
    if (v.kind !== "qatar_history") throw new Error(v.kind);
    expect(v.season.tooFar).toBe(true);
    expect(v.probability).toBeNull();
  });

  test("no usable history beyond the window → no data", async () => {
    const v = await verdict(makeSyntheticDb(), "QR61", at(20));
    expect(v.kind).toBe("qatar_no_data");
  });
});

describe("QR verdict: swap risk inside the window", () => {
  /** Published 77W five days out every day; every 5th day flew a 388. */
  function swappy() {
    const db = makeSyntheticDb();
    for (let i = 0; i < 20; i++) {
      const d = at(-20 + i);
      const dep = utc(`${d}T06:40:00Z`);
      historyLeg(db, "QR7", d, "77W", { seenAt: dep - 5 * 86400 });
      if (i % 5 === 0) historyLeg(db, "QR7", d, "388", { seenAt: dep - 86400 });
    }
    scheduleRow(db, "QR7", at(3), "77W");
    scheduleRow(db, "QR7", at(1), "77W");
    return db;
  }

  test("+3 on a frequently swapped number → probability, not a firm yes", async () => {
    const v = await verdict(swappy(), "QR7", at(3));
    expect(v.kind).toBe("qatar_history");
    if (v.kind === "qatar_history") {
      expect(v.basis).toBe("schedule");
      expect(v.swapRisk).toBe(true);
      expect(v.swapObserved).toBe(20);
      expect(v.swapDays).toBe(4);
      expect(v.scheduledRow?.equipment_code).toBe("77W");
      expect(v.probability).toBeLessThan(0.8);
      const reason = qatarHistoryReason(v);
      expect(reason).toContain("4 of its last 20 flown days");
      expect(reason).not.toContain("operating days");
    }
  });

  test("a planned weekday rotation is not swap risk (QR500 788 some days, A330 others)", async () => {
    const db = makeSyntheticDb();
    for (let i = 0; i < 27; i++) {
      const d = at(-20 + i);
      const dep = utc(`${d}T06:40:00Z`);
      historyLeg(db, "QR500", d, i % 7 < 3 ? "788" : "332", { seenAt: dep - 5 * 86400 });
    }
    scheduleRow(db, "QR500", at(3), "788");
    const v = await verdict(db, "QR500", at(3));
    expect(v.kind).toBe("qatar");
    if (v.kind === "qatar") expect(v.hasStarlink).toBe(true);
  });

  test("not-yet-flown days and late first sightings don't count as swaps", async () => {
    const db = makeSyntheticDb();
    for (let i = 0; i < 20; i++) {
      const d = at(-20 + i);
      const dep = utc(`${d}T06:40:00Z`);
      // First seen the day before departure: Qatar published it late, not a swap.
      historyLeg(db, "QR9", d, "77W", { seenAt: dep - 86400 });
      if (i % 3 === 0) historyLeg(db, "QR9", d, "388", { seenAt: dep - 3600 });
    }
    for (const i of [1, 2, 4, 5]) historyLeg(db, "QR9", at(i), i % 2 ? "388" : "77W");
    scheduleRow(db, "QR9", at(3), "77W");
    const v = await verdict(db, "QR9", at(3));
    expect(v.kind).toBe("qatar");
  });

  test("+1 keeps the firm scheduled-type yes", async () => {
    const v = await verdict(swappy(), "QR7", at(1));
    expect(v.kind).toBe("qatar");
    if (v.kind === "qatar") expect(v.hasStarlink).toBe(true);
  });
});

describe("QR helpers", () => {
  test("qatarDaysOut is keyed on the DOH day", () => {
    expect(qatarDaysOut("2026-09-20", utc("2026-09-19T20:59:00Z"))).toBe(1);
    expect(qatarDaysOut("2026-09-20", utc("2026-09-19T21:01:00Z"))).toBe(0);
    // A LAX-local date late on the 19th is still +1 against DOH's 19th.
    expect(qatarDaysOut("2026-09-20", utc("2026-09-19T08:00:00Z"))).toBe(1);
  });

  test("IATA season boundaries", () => {
    expect(iataSeasonKey("2026-10-24")).toBe("S26");
    expect(iataSeasonKey("2026-10-25")).toBe("W26");
    expect(iataSeasonKey("2027-03-27")).toBe("W26");
    expect(iataSeasonKey("2027-03-28")).toBe("S27");
    expect(iataSeasonKey("junk")).toBeNull();
    expect(iataSeasonIndex("W26") - iataSeasonIndex("S26")).toBe(1);
    expect(iataSeasonIndex("S27") - iataSeasonIndex("W26")).toBe(1);
  });

  test("wilsonLowerBound is bounded and monotonic in successes", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    let prev = -1;
    for (let k = 0; k <= 20; k++) {
      const p = wilsonLowerBound(k, 20);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  test("qatarMixSentence names each type with a count", () => {
    const stats = qatarHistoryStats(
      [
        {
          departure_airport: "DOH",
          arrival_airport: "LHR",
          departure_time: NOW - 86400,
          service_date: at(-1),
          equipment_code: "77W",
          flight_status: "ARRIVED",
        },
      ],
      at(20),
      TODAY
    );
    expect(qatarMixSentence(stats.mix)).toBe("777-300ER ×1");
  });
});

describe("qatar history backtest", () => {
  test("scores point-in-time answers and never badges an A380 number", () => {
    const db = makeSyntheticDb();
    daily(db, "QR1", at(-28), 35, () => "77W");
    daily(db, "QR3", at(-28), 35, (i) => (i === 30 ? "77W" : "388"));
    const rows = db.query("SELECT * FROM qatar_equipment_history").all() as Parameters<
      typeof backtestQatarHistory
    >[0];
    const r = backtestQatarHistory(rows, { lead: 1 });
    expect(r.scored).toBeGreaterThan(0);
    expect(r.badged).toBeGreaterThan(0);
    expect(r.precision).toBe(1);
    expect(r.badgeShare).toBeGreaterThan(0);
    expect(r.badgeShare).toBeLessThanOrEqual(1);
    expect(r.brier).toBeGreaterThanOrEqual(0);
    expect(r.gateViolations.neverBadgeTypes).toEqual([]);
    const swaps = qatarSwapStudy([
      { first_equipment_code: "788", equipment_code: "789", first_seen_lead_sec: 3 * 86400 },
      { first_equipment_code: "77W", equipment_code: "351", first_seen_lead_sec: 5 * 86400 },
    ]);
    expect(swaps["2-3"]).toEqual({ observed: 1, classChanging: 1, b788to789: 1 });
    expect(swaps["4-6"].classChanging).toBe(0);
  });
});
