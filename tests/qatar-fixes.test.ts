/**
 * QR answer fixes: origin-scoped through-flight legs, legs the number doesn't
 * fly, all-cancelled history, 787-9 copy, hub confidence values, malformed QR
 * numbers and the FlyerTalk type-gate report. Hermetic: synthetic DBs.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AIRLINES } from "../src/airlines/registry";
import { decideCarrier, resolveFlightVerdict } from "../src/api/check-flight-core";
import { addDaysISO, qatarNoDataReason } from "../src/api/qatar-verdict";
import { upsertQatarEquipmentHistory } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import {
  type GatedTail,
  applyQatarFlyertalkTails,
  typeGatedSummary,
} from "../src/scripts/flyertalk-qatar";
import { reportNew } from "../src/scripts/residential-sync";
import { createApp } from "../src/server/app";
import { airportLocalDate } from "../src/utils/airport-tz";
import { addFleet, bodyOf, makeSyntheticDb, utc } from "./helpers";

const NOW = utc("2026-09-19T08:00:00Z");
const TODAY = "2026-09-19";
const at = (d: number) => addDaysISO(TODAY, d);

function leg(
  db: Database,
  fn: string,
  depSec: number,
  eq: string,
  o: { dep?: string; arr?: string; status?: string; now?: number } = {}
) {
  const dep = o.dep ?? "DOH";
  const now = o.now ?? NOW;
  upsertQatarEquipmentHistory(
    db,
    {
      flight_number: fn,
      departure_airport: dep,
      service_date: airportLocalDate(dep, depSec) ?? "",
      arrival_airport: o.arr ?? "LHR",
      departure_time: depSec,
      arrival_time: depSec + 7 * 3600,
      equipment_code: eq,
      flight_status: o.status ?? (depSec < now ? "ARRIVED" : "SCHEDULED"),
      fetch_origin: dep,
      fetch_destination: o.arr ?? "LHR",
      fetch_date: airportLocalDate(dep, depSec) ?? "",
    },
    Math.min(now, depSec - 5 * 86400)
  );
}

const qr = (db: Database) => createReaderFactory(db)("QR");
const verdict = (
  db: Database,
  fn: string,
  date: string,
  l?: { origin?: string; destination?: string }
) =>
  resolveFlightVerdict(AIRLINES.QR, qr(db), fn, date, {
    now: NOW,
    lookupTail: null,
    ...(l ? { leg: l } : {}),
  });

describe("QR914 DOH→ADL→AKL: an origin-scoped leg is the one leaving that day", () => {
  // Rotation A leaves Doha on at(1) (77W) and reaches ADL→AKL on at(2) 16:55
  // Adelaide time; rotation B leaves Doha on at(2) (388).
  function qr914() {
    const db = makeSyntheticDb();
    leg(db, "QR914", utc(`${at(1)}T16:30:00Z`), "77W", { arr: "ADL" });
    leg(db, "QR914", utc(`${at(2)}T07:25:00Z`), "77W", { dep: "ADL", arr: "AKL" });
    leg(db, "QR914", utc(`${at(2)}T16:30:00Z`), "388", { arr: "ADL" });
    leg(db, "QR914", utc(`${at(3)}T07:25:00Z`), "388", { dep: "ADL", arr: "AKL" });
    return db;
  }

  test("origin=ADL answers the ADL departure on the date, not the next day's", async () => {
    const v = await verdict(qr914(), "QR914", at(2), { origin: "ADL" });
    expect(v.kind).toBe("qatar");
    if (v.kind !== "qatar") return;
    expect(v.rows.map((r) => r.departure_time)).toEqual([utc(`${at(2)}T07:25:00Z`)]);
    expect(v.hasStarlink).toBe(true);
    expect(airportLocalDate("ADL", v.rows[0].departure_time)).toBe(at(2));
  });

  test("origin=DOH and the unscoped answer keep the Doha-date rotation", async () => {
    const db = qr914();
    const doh = await verdict(db, "QR914", at(2), { origin: "DOH" });
    expect(doh.kind === "qatar" && doh.rows.map((r) => r.equipment_code)).toEqual(["388"]);
    const unscoped = await verdict(db, "QR914", at(2));
    expect(unscoped.kind === "qatar" && unscoped.rows.map((r) => r.departure_airport)).toEqual([
      "DOH",
      "ADL",
    ]);
    expect(unscoped.kind === "qatar" && unscoped.hasStarlink).toBe(false);
  });
});

describe("QR no-data copy", () => {
  test("a leg the number doesn't fly names the leg it does fly", async () => {
    const db = makeSyntheticDb();
    leg(db, "QR1", utc(`${at(2)}T06:40:00Z`), "77W");
    const v = await verdict(db, "QR1", at(2), { origin: "LHR", destination: "DOH" });
    expect(v.kind).toBe("qatar_no_data");
    if (v.kind !== "qatar_no_data") return;
    expect(v.reason).toBe("not_on_leg");
    const text = qatarNoDataReason(v);
    expect(text).toContain("doesn't operate LHR→DOH");
    expect(text).toContain("it flies DOH→LHR");
    expect(text).not.toContain("published schedule");
  });

  test("every recent operating day cancelled → says so, not 'haven't observed'", async () => {
    const db = makeSyntheticDb();
    for (let i = 1; i <= 7; i++) {
      leg(db, "QR1126", utc(`${at(-i)}T06:40:00Z`), "320", { status: "CANCELLED" });
    }
    const v = await verdict(db, "QR1126", at(10));
    expect(v.kind).toBe("qatar_no_data");
    if (v.kind !== "qatar_no_data") return;
    expect(v.reason).toBe("all_cancelled");
    expect(qatarNoDataReason(v)).toContain("cancelled");
    expect(qatarNoDataReason(v)).not.toContain("haven't observed");
  });

  test("a scheduled 787-9 reads like the other scheduled answers", async () => {
    const db = makeSyntheticDb();
    leg(db, "QR17", utc(`${at(2)}T06:40:00Z`), "789", { arr: "DUB" });
    const v = await verdict(db, "QR17", at(2));
    expect(v.kind === "qatar" && v.reason).toStartWith("Scheduled Boeing 787-9 DOH→DUB. ");
  });
});

describe("hub /api/check-any-flight QR values", () => {
  const HUB = "airlinestarlinktracker.com";
  const realNow = Math.floor(Date.now() / 1000);
  const realDay = (d: number) =>
    new Date((Math.floor(realNow / 86400) + d) * 86400 * 1000).toISOString().slice(0, 10);

  function app() {
    const db = makeSyntheticDb();
    for (let i = 1; i <= 3; i++) {
      leg(db, "QR31", utc(`${realDay(-i)}T06:40:00Z`), "77W", { now: realNow });
    }
    return createApp(db);
  }
  const get = async (a: ReturnType<typeof createApp>, fn: string, date = realDay(20)) => {
    const r = await bodyOf(a, `/api/check-any-flight?flight_number=${fn}&date=${date}`, HUB);
    return { status: r.status, body: JSON.parse(r.text) as Record<string, unknown> };
  };

  test("no data → confidence no_data; too-thin history → none", async () => {
    const a = app();
    const none = await get(a, "QR8888");
    expect(none.body.hasStarlink).toBeNull();
    expect(none.body.confidence).toBe("no_data");
    const thin = await get(a, "QR31");
    expect(thin.body.probability).toBeUndefined();
    expect(thin.body.confidence).toBe("none");
  });

  test("a QR prefix with a malformed number is invalid, not untracked", async () => {
    const a = app();
    for (const fn of ["QR", "QR1A", "QTR12A"]) {
      const r = await get(a, fn);
      expect(r.status, fn).toBe(400);
      expect(String(r.body.error), fn).toStartWith("Invalid flight number");
    }
    for (const fn of ["QRA1", "UAE123", "EK1A"]) {
      expect(decideCarrier(null, fn, { pool: "lookup" }).outcome, fn).toBe("not_tracked");
    }
  });
});

describe("FlyerTalk QR type gate", () => {
  test("rejected tails come back with their types and a summary line", () => {
    const db = makeSyntheticDb();
    addFleet(db, "A7-BEA", "unknown", { airline: "QR", aircraftType: "Boeing 777-300ER" });
    for (const t of ["A7-BHA", "A7-BHB"]) {
      addFleet(db, t, "unknown", { airline: "QR", aircraftType: "Boeing 787-9" });
    }
    addFleet(db, "A7-APJ", "unknown", { airline: "QR", aircraftType: "Airbus A380-800" });
    const gated: GatedTail[] = [];
    const written = applyQatarFlyertalkTails(db, ["A7-BEA", "A7-BHA", "A7-BHB", "A7-APJ"], gated);
    expect(written).toBe(1);
    expect(gated.map((g) => g.tail).sort()).toEqual(["A7-APJ", "A7-BHA", "A7-BHB"]);
    expect(typeGatedSummary(gated)).toBe("3 type-gated (787-9 ×2, A380-800 ×1)");
  });

  test("the laptop report keeps type-gated tails out of 'not yet confirmed'", () => {
    const line = reportNew("QR", ["A7-BEA", "A7-BHA", "A7-NEW"], {
      confirmed: 1,
      total: 3,
      tails: ["A7-BEA"],
      gated: { "A7-BHA": "Boeing 787-9" },
    });
    expect(line).toContain("1 not yet confirmed on prod: A7-NEW");
    expect(line).toContain("1 type-gated (787-9 ×1)");
    expect(line).not.toContain("A7-BHA");
  });
});
