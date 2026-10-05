/**
 * Air France: the stored community fleet guide read back as programme-type
 * denominators, per-type answers that never blend, key-less assigned-tail
 * answers, and the hub page. The guide fixture is synthetic (built below),
 * and every DB is an in-memory clone.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeAircraftType } from "../src/airlines/aircraft-families";
import {
  AIRLINES,
  COMMUNITY_SOURCE_UPDATED_META,
  SITES,
  isOutsideProgramme,
  programTypeOf,
} from "../src/airlines/registry";
import { resolveFlightVerdict, verdictConfidence } from "../src/api/check-flight-core";
import { breakerEffect } from "../src/api/flight-updater";
import { renderCheckFlightVerdict } from "../src/api/mcp-server";
import { CommunityAirlinePage, TypeShareTable } from "../src/components/community-airline-page";
import {
  addDiscoveredStarlinkPlane,
  getFleetDiscoveryStats,
  getHubStats,
  getNextCommunityFleetTailNeedingFlights,
  getNextFleetTailNeedingFlights,
  getSubfleetPenetration,
  getTypeProgress,
  reconcileConsensus,
  reconcileTypeDeterministicFleets,
  refreshFleetMeta,
  setMeta,
  stampLastUpdatedAt,
  upsertFleetAircraft,
} from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import {
  carrierPrediction,
  carrierRouteAnswer,
  compareRouteForAirline,
  describeCarrierPrediction,
} from "../src/scripts/starlink-predictor";
import { communityWireFields, noModelConfidence } from "../src/server/community-wire";
import { airportCountry, airportDistanceMiles } from "../src/utils/airport-geo";
import { airportTimezone } from "../src/utils/airport-tz";
import { addFleet, addFlight, makeSyntheticDb } from "./helpers";

const AF = AIRLINES.AF;

// ── synthetic guide ─────────────────────────────────────────────────────────

type Mark = "★" | "☆" | "";
interface FixtureSection {
  header: string;
  fr24: string;
  marks: Mark[];
  legendHasStar?: boolean;
}

const repeat = (mark: Mark, n: number): Mark[] => Array(n).fill(mark);

const SECTIONS: Array<FixtureSection | string> = [
  "Air France fleet:",
  "Wide-body long-haul:",
  {
    header: "777-228ER (Cabin A)",
    fr24: "Boeing 777-228(ER)",
    marks: [...repeat("", 8), ...repeat("☆", 6)],
  },
  {
    header: "777-328ER (Cabin B)",
    fr24: "Boeing 777-328(ER)",
    marks: [...repeat("★", 12), ...repeat("", 2)],
  },
  {
    header: "787-9",
    fr24: "Boeing 787-9 Dreamliner",
    marks: [...repeat("☆", 4), ...repeat("", 9)],
  },
  {
    header: "A350-941 (Cabin C)",
    fr24: "Airbus A350-941",
    marks: [...repeat("★", 10), ...repeat("☆", 4)],
  },
  { header: "A330-203", fr24: "Airbus A330-203", marks: repeat("", 8) },
  {
    header: "777-328ER (Cabin H)",
    fr24: "Boeing 777-328(ER)",
    marks: [...repeat("★", 3), ...repeat("", 11)],
    legendHasStar: false,
  },
  "Narrow-body short & medium-haul:",
  { header: "A220-300", fr24: "Airbus A220-300", marks: [...repeat("★", 11), ...repeat("", 3)] },
  { header: "A318-111", fr24: "Airbus A318-111", marks: repeat("☆", 4) },
  { header: "A319-111", fr24: "Airbus A319-111", marks: repeat("", 2) },
  {
    header: "A320-214 (Cabin D)",
    fr24: "Airbus A320-214",
    marks: [...repeat("★", 2), ...repeat("☆", 12)],
  },
  { header: "A320-214 (Cabin E)", fr24: "Airbus A320-214", marks: repeat("", 14) },
  { header: "A321-212 (Cabin F)", fr24: "Airbus A321-212", marks: repeat("☆", 14) },
  { header: "A321-111 (Cabin K)", fr24: "Airbus A321-111", marks: repeat("", 14) },
  { header: "A350-941 (Cabin G)", fr24: "Airbus A350-941", marks: repeat("★", 14) },
  "Air France HOP!",
  { header: "Embraer 170", fr24: "Embraer E170STD", marks: repeat("", 14) },
  { header: "Embraer 190 (Cabin I)", fr24: "Embraer E190STD", marks: repeat("", 14) },
  { header: "Embraer 190 (Cabin J)", fr24: "Embraer E190STD", marks: repeat("★", 14) },
];

const sections = SECTIONS.filter((s): s is FixtureSection => typeof s !== "string");
const tailOf = (si: number, i: number) =>
  `F-G${String.fromCharCode(65 + si)}Q${String.fromCharCode(65 + i)}`;
const FIXTURE_TAILS = sections.flatMap((s, si) =>
  s.marks.map((mark, i) => ({ tail: tailOf(si, i), mark, fr24: s.fr24, header: s.header }))
);
const STARS = FIXTURE_TAILS.filter((t) => t.mark === "★");
type GuideMark = "starlink" | "legacy" | "none";
const GUIDE_UPDATED = "2026-09-12";
const GUIDE = {
  tails: FIXTURE_TAILS.map((t) => ({
    tail: t.tail,
    mark: (t.mark === "★" ? "starlink" : t.mark === "☆" ? "legacy" : "none") as GuideMark,
    section: t.header,
    programType: programTypeOf(AF, t.header).key,
    operator: /^Embraer/.test(t.header) ? "Air France HOP" : null,
  })),
};
const GUIDE_ONLY = FIXTURE_TAILS.find((t) => t.header === "Embraer 190 (Cabin J)")?.tail as string;
const MISMATCHED = FIXTURE_TAILS.find((t) => t.header === "777-328ER (Cabin B)")?.tail as string;

/** FR24-shaped roster: every fixture tail but one, operated_by NULL on every
 * row (buildRoster sets it only for regional-carrier pages), plus a freighter
 * and a new delivery the guide doesn't list yet. */
function seedRoster(db: Database) {
  for (const t of FIXTURE_TAILS) {
    if (t.tail === GUIDE_ONLY) continue;
    const type = t.tail === MISMATCHED ? "Boeing 777-228(ER)" : t.fr24;
    upsertFleetAircraft(db, t.tail, type, "fr24", "mainline", null, "AF");
  }
  upsertFleetAircraft(db, "F-GUOB", "Boeing 777-F28", "fr24", "mainline", null, "AF");
  upsertFleetAircraft(db, "F-HOZZ", "Airbus A220-300", "fr24", "mainline", null, "AF");
}

/** The stored state the last guide import left: community-tier ★ tails that
 * match the roster's programme type, the guide rows, and the guide's date. */
function seedGuide(db: Database) {
  const roster = new Map(
    (
      db
        .query("SELECT tail_number, aircraft_type FROM united_fleet WHERE airline = 'AF'")
        .all() as { tail_number: string; aircraft_type: string | null }[]
    ).map((r) => [r.tail_number, r.aircraft_type])
  );
  for (const g of GUIDE.tails) {
    if (g.mark !== "starlink" || !roster.has(g.tail)) continue;
    const type = roster.get(g.tail) ?? null;
    if (programTypeOf(AF, type).key !== g.programType) continue;
    upsertFleetAircraft(db, g.tail, type, "flyertalk_af", "mainline", null, "AF", {
      starlinkStatus: "confirmed",
      verifiedWifi: null,
      evidence: "community",
    });
    addDiscoveredStarlinkPlane(db, g.tail, type, "Starlink", g.operator ?? AF.name, "mainline", {
      sheetGid: "flyertalk_af",
      airline: "AF",
      evidence: "community",
    });
  }
  refreshFleetMeta(db, "AF");
  const iso = `${GUIDE_UPDATED}T00:00:00.000Z`;
  const ins = db.query(
    `INSERT INTO fleet_guide_tails
       (airline, tail_number, section, program_type, mark, guide_updated, fetched_at)
     VALUES ('AF', ?, ?, ?, ?, ?, 0)`
  );
  for (const g of GUIDE.tails) ins.run(g.tail, g.section, g.programType, g.mark, iso);
  setMeta(db, COMMUNITY_SOURCE_UPDATED_META, iso, "AF");
  stampLastUpdatedAt(db, "AF", "community-sync", iso);
}

function appliedDb(): Database {
  const db = makeSyntheticDb();
  seedRoster(db);
  seedGuide(db);
  return db;
}

const one = <T>(db: Database, sql: string, ...p: Array<string | number>) =>
  db.query(sql).get(...p) as T;

// ── stored guide ────────────────────────────────────────────────────────────

describe("stored community guide", () => {
  test("★ tails read as community-tier confirmed; nothing claims verified", () => {
    const db = appliedDb();
    const confirmed = one<{ n: number; verified: number }>(
      db,
      "SELECT COUNT(*) n, SUM(verified_wifi IS NOT NULL OR verified_at IS NOT NULL) verified FROM united_fleet WHERE airline='AF' AND starlink_status='confirmed'"
    );
    expect(confirmed.n).toBe(STARS.length - 2);
    expect(confirmed.verified).toBe(0);
    expect(getFleetDiscoveryStats(db, ["AF"]).verified_starlink).toBe(0);
    db.close();
  });

  test("no AF tail is ever negative, through every reconcile path", () => {
    const db = appliedDb();
    reconcileTypeDeterministicFleets(db);
    reconcileConsensus(db);
    expect(
      one<{ n: number }>(
        db,
        "SELECT COUNT(*) n FROM united_fleet WHERE airline='AF' AND starlink_status='negative'"
      ).n
    ).toBe(0);
    expect(AF.typeDeterministicWifi).toBeUndefined();
    db.close();
  });
});

// ── denominators ────────────────────────────────────────────────────────────

describe("programme denominators", () => {
  test("freighters and programme exclusions never enter an AF total", () => {
    const db = appliedDb();
    const types = getTypeProgress(db, "AF");
    const live = types.filter((t) => !t.excluded);
    const excluded = types.filter((t) => t.excluded).map((t) => t.key);
    expect(new Set(excluded)).toEqual(new Set(AF.programExclusions?.families));
    expect(types.some((t) => t.key === "B777F")).toBe(false);
    const liveTotal = live.reduce((s, t) => s + t.total, 0);
    expect(getHubStats(db, ["AF"])[0].fleetTotal).toBe(liveTotal);
    expect(getSubfleetPenetration(db, "AF").get("mainline")?.total).toBe(liveTotal);
    const byKey = new Map(types.map((t) => [t.key, t]));
    expect(byKey.get("B777-200ER")?.equipped).toBe(0);
    expect(byKey.get("B777-300ER")?.equipped).toBeGreaterThan(0);
    expect(byKey.get("A220")?.notInGuide).toBeGreaterThan(0);
    db.close();
  });

  test("QR penetration counts passengers only", () => {
    const db = makeSyntheticDb();
    addFleet(db, "A7-BAA", "confirmed", { airline: "QR", aircraftType: "Boeing 777-3DZ(ER)" });
    addFleet(db, "A7-BFA", "negative", { airline: "QR", aircraftType: "Boeing 777-FDZ" });
    const totals = [...getSubfleetPenetration(db, "QR").values()].map((p) => p.total);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(1);
    db.close();
  });
});

// ── answers ─────────────────────────────────────────────────────────────────

const DATE = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
const NOON = Math.floor(Date.parse(`${DATE}T12:00:00Z`) / 1000);

describe("AF answers", () => {
  const verdictOn = async (
    db: Database,
    fn: string,
    deps: Parameters<typeof resolveFlightVerdict>[4] = { lookupTail: null }
  ) => resolveFlightVerdict(AF, createReaderFactory(db)("AF"), fn, DATE, deps);

  test("a ★ tail's scheduled flight is a likely yes", async () => {
    const db = appliedDb();
    const star = STARS.find((t) => t.header === "A350-941 (Cabin G)")?.tail as string;
    addFlight(db, star, "AF100", "XXA", NOON, { airline: "AF" });
    const v = await verdictOn(db, "AF100");
    expect(v.kind).toBe("scheduled");
    if (v.kind === "scheduled") expect(verdictConfidence(v)).toBe("likely");
    db.close();
  });

  test("before the first guide sync there is no per-type answer to give", async () => {
    const db = makeSyntheticDb();
    seedRoster(db);
    const v = await verdictOn(db, "AF200");
    if (v.kind !== "no_model") throw new Error(v.kind);
    expect(v.answer.kind).toBe("no_model");
    db.close();
  });

  test("before the first guide sync an assigned tail is never called unlisted", async () => {
    const db = makeSyntheticDb();
    seedRoster(db);
    const star = STARS.find((t) => t.header === "A350-941 (Cabin G)")?.tail as string;
    addFlight(db, star, "AF100", "XXA", NOON, { airline: "AF" });
    const fromDb = await verdictOn(db, "AF100");
    const fromFr24 = await verdictOn(db, "AF400", { lookupTail: async () => [seg(star)] });
    for (const v of [fromDb, fromFr24]) {
      if (v.kind !== "no_model") throw new Error(v.kind);
      expect(v.answer.kind).toBe("no_model");
      expect("assignment" in communityWireFields(v.answer)).toBe(false);
    }
    db.close();
  });

  test.each([
    ["rejected by the type gate (DB row)", "db"],
    ["absent from the roster (FR24)", "fr24"],
  ])("a guide-★ tail %s reads as listed, never as no WiFi", async (_label, path) => {
    const db = appliedDb();
    const tail = path === "db" ? MISMATCHED : GUIDE_ONLY;
    if (path === "db") addFlight(db, tail, "AF500", "XXA", NOON, { airline: "AF" });
    const v =
      path === "db"
        ? await verdictOn(db, "AF500")
        : await verdictOn(db, "AF500", { lookupTail: async () => [seg(tail)] });
    if (v.kind !== "no_model" || v.answer.kind !== "assigned_unconfirmed") throw new Error(v.kind);
    expect(v.answer.mark).toBe("starlink");
    const text = describeCarrierPrediction(AF, v.answer);
    expect(text).toMatch(/listed with Starlink/);
    expect(text).not.toMatch(/no WiFi|not on the Starlink list/);
    expect(
      (communityWireFields(v.answer).assignment as { guide_status: string }).guide_status
    ).toBe("starlink_listed");
    db.close();
  });

  test("a newer non-★ row for the same departure supersedes an older ★ row", async () => {
    const star = STARS.find((t) => t.header === "A350-941 (Cabin G)")?.tail as string;
    const other = GUIDE.tails.find((t) => t.mark === "legacy" && t.programType === "B787")
      ?.tail as string;
    for (const [starAge, expected] of [
      [-600, "no_model"],
      [600, "scheduled"],
    ] as const) {
      const db = appliedDb();
      addFlight(db, star, "AF700", "XXA", NOON, { airline: "AF" });
      addFlight(db, other, "AF700", "XXA", NOON, { airline: "AF" });
      db.query("UPDATE upcoming_flights SET last_updated = ? WHERE tail_number = ?").run(
        NOON + starAge,
        star
      );
      const v = await verdictOn(db, "AF700");
      expect(v.kind).toBe(expected);
      if (v.kind === "no_model") {
        expect(v.answer.kind).toBe("assigned_unconfirmed");
        if (v.answer.kind === "assigned_unconfirmed") expect(v.answer.tail).toBe(other);
      }
      db.close();
    }
  });

  test("a leg names the unequipped tail flying that leg, not the first hop's", async () => {
    const [first, second] = GUIDE.tails.filter((t) => t.mark === "legacy").map((t) => t.tail);
    const db = appliedDb();
    addFlight(db, first, "AF710", "CDG", NOON, { airline: "AF", arrivalAirport: "NCE" });
    addFlight(db, second, "AF710", "NCE", NOON + 3 * 3600, {
      airline: "AF",
      arrivalAirport: "CDG",
    });
    for (const [origin, tail] of [
      ["CDG", first],
      ["NCE", second],
    ]) {
      const v = await verdictOn(db, "AF710", { lookupTail: null, leg: { origin } });
      if (v.kind !== "no_model" || v.answer.kind !== "assigned_unconfirmed")
        throw new Error(v.kind);
      expect(v.answer.tail).toBe(tail);
      expect("leg" in v && v.leg?.match).toBe("exact");
    }
    db.close();
  });

  test("an evening departure west of UTC matches its local date, not the UTC one", async () => {
    const db = appliedDb();
    const star = STARS.find((t) => t.header === "A350-941 (Cabin G)")?.tail as string;
    const nextDay = new Date(Date.parse(`${DATE}T00:00:00Z`) + 86400_000)
      .toISOString()
      .slice(0, 10);
    // 21:50 in Martinique (UTC-4) is 01:50Z the next day.
    const dep = Math.floor(Date.parse(`${nextDay}T01:50:00Z`) / 1000);
    addFlight(db, star, "AF607", "FDF", dep, { airline: "AF" });
    const reader = createReaderFactory(db)("AF");
    const onLocal = await resolveFlightVerdict(AF, reader, "AF607", DATE, { lookupTail: null });
    const onUtc = await resolveFlightVerdict(AF, reader, "AF607", nextDay, { lookupTail: null });
    expect(onLocal.kind).toBe("scheduled");
    expect(onUtc.kind).not.toBe("scheduled");
    db.close();
  });

  test("unassigned: per-type progress, cited, no blended number", async () => {
    const db = appliedDb();
    const v = await verdictOn(db, "AF200");
    if (v.kind !== "no_model" || v.answer.kind !== "type_progress") throw new Error(v.kind);
    expect(Array.isArray(v.answer.types)).toBe(true);
    const text = describeCarrierPrediction(AF, v.answer);
    expect(text).toMatch(/depends on the aircraft type/);
    expect(text).toMatch(/FlyerTalk/);
    expect(text).not.toMatch(/%/);
    db.close();
  });

  test.each([
    ["Boeing 777-328(ER)", "B777-300ER", false],
    ["Boeing 777", null, true],
    ["Airbus A330-203", "A330", false],
    ["Concorde", undefined, false],
    // A codeshare on a variant AF doesn't fly says nothing about AF's 787-9s.
    ["Boeing 787-10", undefined, false],
  ] as const)("aircraft_type %s", async (type, key, ambiguous) => {
    const db = appliedDb();
    const v = await verdictOn(db, "AF200", { lookupTail: null, aircraftType: type });
    if (v.kind !== "no_model") throw new Error(v.kind);
    if (key === undefined) {
      expect(v.answer.kind).toBe("type_progress");
    } else {
      if (v.answer.kind !== "type_rate") throw new Error(v.answer.kind);
      if (ambiguous) {
        expect(v.answer.ambiguous?.length).toBe(2);
        expect(v.answer.share).toBeNull();
      } else {
        expect(v.answer.type.key).toBe(key as string);
        expect(v.answer.share).toBeGreaterThanOrEqual(0);
        expect(v.answer.share).toBeLessThanOrEqual(1);
      }
      if (key === "A330")
        expect(describeCarrierPrediction(AF, v.answer)).toMatch(/not in the Starlink programme/);
    }
    db.close();
  });

  test("a non-★ assigned tail is named from the DB, without a live lookup", async () => {
    const db = appliedDb();
    const legacy = GUIDE.tails.find((t) => t.mark === "legacy" && t.programType === "B787")
      ?.tail as string;
    addFlight(db, legacy, "AF300", "XXA", NOON, { airline: "AF" });
    let called = 0;
    const v = await verdictOn(db, "AF300", {
      lookupTail: async () => {
        called++;
        return [];
      },
    });
    expect(called).toBe(0);
    if (v.kind !== "no_model" || v.answer.kind !== "assigned_unconfirmed") throw new Error(v.kind);
    expect(v.answer.tail).toBe(legacy);
    expect(describeCarrierPrediction(AF, v.answer)).toMatch(/legacy WiFi/);
    db.close();
  });

  const seg = (tail: string) => ({
    tail_number: tail,
    aircraft_model: null,
    origin: "XXA",
    destination: "XXB",
    departure_time: NOON,
    arrival_time: NOON + 3600,
    hasStarlink: null,
    confidence: "unknown" as const,
  });

  test.each([
    ["an AF tail", tailOf(0, 0), "assigned_unconfirmed"],
    ["a partner tail", "PH-BHA", "partner_operated"],
  ])("FR24 reporting %s", async (_label, tail, kind) => {
    const db = appliedDb();
    const v = await verdictOn(db, "AF400", { lookupTail: async () => [seg(tail)] });
    if (v.kind !== "no_model") throw new Error(v.kind);
    expect(v.answer.kind).toBe(kind);
    db.close();
  });

  test("wire fields: additive, no probability, hasStarlink never false", async () => {
    const db = appliedDb();
    addFlight(db, tailOf(0, 0), "AF300", "XXA", NOON, { airline: "AF" });
    const answers = [
      await verdictOn(db, "AF200"),
      await verdictOn(db, "AF200", { lookupTail: null, aircraftType: "Boeing 777-300ER" }),
      await verdictOn(db, "AF200", { lookupTail: null, aircraftType: "Boeing 777" }),
      await verdictOn(db, "AF300"),
      await verdictOn(db, "AF400", { lookupTail: async () => [seg("PH-BHA")] }),
    ];
    for (const v of answers) {
      if (v.kind !== "no_model") throw new Error(v.kind);
      const f = communityWireFields(v.answer);
      expect(noModelConfidence(v.answer)).toBe("assignment" in f ? "tail" : "type");
      expect("probability" in f).toBe(false);
      expect("prediction" in f).toBe(false);
      if (v.answer.kind === "type_progress") expect(Array.isArray(f.by_type)).toBe(true);
      if (v.answer.kind === "type_rate") {
        const rate = f.type_rate as { share: unknown; status?: unknown; ambiguous?: unknown };
        expect(rate.share === null || typeof rate.share === "number").toBe(true);
        expect(rate.ambiguous === true || typeof rate.status === "string").toBe(true);
      }
      if (v.answer.kind === "assigned_unconfirmed" || v.answer.kind === "partner_operated") {
        expect(typeof (f.assignment as { tail_number: unknown }).tail_number).toBe("string");
      }
    }
    db.close();
  });

  describe("MCP check_flight text", () => {
    const mcpText = async (
      db: Database,
      fn: string,
      deps: Parameters<typeof resolveFlightVerdict>[4] = { lookupTail: null }
    ) => {
      const reader = createReaderFactory(db)("AF");
      const v = await resolveFlightVerdict(AF, reader, fn, DATE, deps);
      if (v.kind === "invalid_date" || v.kind === "invalid_flight_number") throw new Error(v.kind);
      const r = await renderCheckFlightVerdict(AF, reader, v, DATE);
      return { kind: v.kind, text: r.content[0].text };
    };

    test.each([
      ["an assigned AF tail", "db"],
      ["a partner-operated codeshare", "partner"],
    ])("%s is an assignment, never 'no assignment data'", async (_label, path) => {
      const db = appliedDb();
      const legacy = GUIDE.tails.find((t) => t.mark === "legacy" && t.programType === "B787")
        ?.tail as string;
      if (path === "db") addFlight(db, legacy, "AF300", "XXA", NOON, { airline: "AF" });
      const { kind, text } =
        path === "db"
          ? await mcpText(db, "AF300")
          : await mcpText(db, "AF400", { lookupTail: async () => [seg("PH-BHA")] });
      expect(kind).toBe("no_model");
      expect(text).not.toContain("no assignment data");
      expect(text).toContain(path === "db" ? legacy : "PH-BHA");
      db.close();
    });

    test("an unassigned flight still says there is no assignment", async () => {
      const db = appliedDb();
      const { kind, text } = await mcpText(db, "AF200");
      expect(kind).toBe("no_model");
      expect(text).toContain("no assignment data");
      db.close();
    });

    test("a starred tail names the community guide, not a spreadsheet", async () => {
      const db = appliedDb();
      const star = STARS.find((t) => t.header === "A350-941 (Cabin G)")?.tail as string;
      addFlight(db, star, "AF100", "XXA", NOON, { airline: "AF" });
      const { kind, text } = await mcpText(db, "AF100");
      expect(kind).toBe("scheduled");
      expect(text).toContain(AF.communitySource?.label as string);
      expect(text).toMatch(/community data/);
      expect(text).not.toMatch(/spreadsheet/i);
      db.close();
    });
  });

  test("routes never infer absence or blend", () => {
    const db = appliedDb();
    const reader = createReaderFactory(db)("AF");
    const r = compareRouteForAirline(AF, reader, "CDG", "JFK");
    expect(r?.kind).toBe("no_data");
    expect(carrierRouteAnswer(AF, reader, "CDG", "JFK")).toBeNull();
    expect(carrierPrediction(AF, reader, "AF1").kind).not.toBe("penetration");
    db.close();
  });
});

// ── flight-updater idle tier ────────────────────────────────────────────────

describe("community fleet fallback tier", () => {
  test("AS unknown tails keep priority; AF fills only idle capacity", () => {
    const db = appliedDb();
    addFleet(db, "N613AS", "unknown", {
      airline: "AS",
      aircraftType: "Boeing 737-700",
      verifiedAt: null,
    });
    expect(getNextFleetTailNeedingFlights(db)).toBe("N613AS");
    const next = getNextCommunityFleetTailNeedingFlights(db);
    expect(next && AF.tailPattern.test(next)).toBe(true);
    const equipped = new Set(
      (
        db.query("SELECT TailNumber FROM starlink_planes WHERE airline='AF'").all() as {
          TailNumber: string;
        }[]
      ).map((r) => r.TailNumber)
    );
    expect(equipped.has(next as string)).toBe(false);
    expect(next).not.toBe("F-GUOB");
    expect(getNextCommunityFleetTailNeedingFlights(db, [next as string])).not.toBe(next);
    db.close();
  });

  test("never polls a family outside the programme", () => {
    const db = appliedDb();
    const seen: string[] = [];
    for (let t = getNextCommunityFleetTailNeedingFlights(db); t; ) {
      seen.push(t);
      t = getNextCommunityFleetTailNeedingFlights(db, seen);
    }
    expect(seen.length).toBeGreaterThan(0);
    const types = new Map(
      (
        db.query("SELECT tail_number, aircraft_type FROM united_fleet").all() as {
          tail_number: string;
          aircraft_type: string;
        }[]
      ).map((r) => [r.tail_number, r.aircraft_type])
    );
    for (const tail of seen) {
      expect(isOutsideProgramme("AF", normalizeAircraftType(types.get(tail)))).toBe(false);
    }
    db.close();
  });

  // Empty is neutral on every tier: five idle A7-BC* (14:52Z) then F-GSQ*
  // (16:28Z) starlink-tier empties opened the breaker twice on 2026-09-20.
  test.each([
    ["updated", "reset"],
    ["error", "count"],
    ["empty", "none"],
  ] as const)("breaker: %s → %s", (outcome, effect) => {
    expect(breakerEffect(outcome)).toBe(effect);
  });
});

// Departure airports seen in real FR24 AF/HOP schedules (Sept 2026).
const AF_FR24_DEPARTURES =
  `AMS ATH ATL BCN BEL BER BES BIQ BLR BOD BOM CAI CAY CDG CFR CKY DEL DLA DUB
DUS EZE FCO FDF FRA GRU HKG HND ICN JNB LIS LJU LYS MAD MAN MIA MPL MRS NBJ NCE NKC NSI NTE ORY PEK
PRG PTP RAK RBA RUN SSG TLS TRN VCE WAW YOW ZAG`.split(/\s+/);

// Seasonal and thin AF/HOP routes FR24 hadn't scheduled yet in September.
const AF_SEASONAL =
  "ABV BRI BSL CAG CMF CTA DBV FAO HER IBZ JMK JTR MLH OLB PMO POP RAI SID SPU ZNZ".split(" ");

describe("AF network airports", () => {
  test.each([...AF_FR24_DEPARTURES, ...AF_SEASONAL])(
    "%s has a zone, coordinates and a non-US country",
    (iata) => {
      expect(airportTimezone(iata)).toBeTruthy();
      expect(airportDistanceMiles(iata, "CDG")).not.toBeNull();
      if (!["ATL", "MIA"].includes(iata)) expect(airportCountry(iata)).not.toBe("US");
    }
  );
});

// ── page ────────────────────────────────────────────────────────────────────

describe("/airlines/air-france page", () => {
  const render = (
    db: Database,
    guideUpdated: string,
    nowMs = Date.parse("2026-09-19T00:00:00Z")
  ) => {
    const reader = createReaderFactory(db)("AF");
    return renderToStaticMarkup(
      CommunityAirlinePage({
        site: SITES.airline,
        cfg: AF,
        types: reader.getTypeProgress(),
        tails: reader.getFleetGuideTails(),
        guideUpdated,
        facts: null,
        nowMs,
      })
    );
  };

  test("type table, tail anchors, provenance; no freighter, no cabin text", () => {
    const db = appliedDb();
    const html = render(db, "2026-09-12T00:00:00.000Z");
    for (const s of [
      "By aircraft type",
      "777-300ER",
      "777-200ER",
      "Not started",
      "Retiring",
      "FlyerTalk",
      "Community-curated",
    ]) {
      expect(html).toContain(s);
    }
    expect(html).toContain(`id="${GUIDE_ONLY}"`);
    expect(html).toContain('id="F-HOZZ"');
    expect(html).not.toContain("F-GUOB");
    expect(html).not.toMatch(/SYNTHETIC-(CABIN|SEAT)/);
    expect(html).not.toMatch(/hasn't been updated/);
    db.close();
  });

  test("a stale guide says so", () => {
    const db = appliedDb();
    expect(render(db, "2026-06-01T00:00:00.000Z")).toMatch(/hasn(&#x27;|')t been updated/);
    db.close();
  });

  test("compact table carries counts, never a percentage", () => {
    const db = appliedDb();
    const html = renderToStaticMarkup(
      TypeShareTable({ types: getTypeProgress(db, "AF"), compact: true })
    );
    expect(html).toContain("777-300ER");
    expect(html.replace(/style="[^"]*"/g, "")).not.toMatch(/\d%/);
    db.close();
  });
});

// ── registry ────────────────────────────────────────────────────────────────

describe("AF registry", () => {
  test.each([
    ["Boeing 777-328(ER)", "B777-300ER"],
    ["Boeing 777-228(ER)", "B777-200ER"],
    ["777-300ER", "B777-300ER"],
    ["Boeing 777", "B777"],
    ["Boeing 777-F28", "B777F"],
    ["Boeing 787-9 Dreamliner", "B787"],
    ["Airbus A220-300", "A220"],
    ["Embraer E190STD", "E190"],
  ])("programTypeOf(AF, %s) → %s", (raw, key) => {
    expect(programTypeOf(AF, raw).key).toBe(key);
  });

  test("other airlines keep the shared family", () => {
    expect(programTypeOf(AIRLINES.UA, "Boeing 777-322(ER)").key).toBe("B777");
  });

  test.each([
    ["F-HTYA", true],
    ["F-GSQA", true],
    ["F-OABC", false],
    ["N123AF", false],
    ["F-HTY", false],
  ])("tail %s → %p", (tail, ok) => {
    expect(AF.tailPattern.test(tail)).toBe(ok);
  });
});
