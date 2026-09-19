/**
 * Air France: FlyerTalk guide parse + community-tier apply, programme-type
 * denominators, per-type answers that never blend, key-less assigned-tail
 * answers, and the hub page. The guide fixture is synthetic (built below —
 * no real cabin or seat text), and every DB is an in-memory clone.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AIRLINES, SITES, programTypeOf } from "../src/airlines/registry";
import { resolveFlightVerdict, verdictConfidence } from "../src/api/check-flight-core";
import { CommunityAirlinePage, TypeShareTable } from "../src/components/community-airline-page";
import {
  getFleetDiscoveryStats,
  getHubStats,
  getNextCommunityFleetTailNeedingFlights,
  getNextFleetTailNeedingFlights,
  getSubfleetPenetration,
  getTypeProgress,
  reconcileConsensus,
  reconcileTypeDeterministicFleets,
  upsertFleetAircraft,
} from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import {
  type ParsedGuide,
  applyAirFranceGuide,
  parseAirFranceGuide,
} from "../src/scripts/flyertalk-airfrance";
import { isDeterministicFetchError } from "../src/scripts/residential-sync";
import {
  carrierPrediction,
  carrierRouteAnswer,
  compareRouteForAirline,
  describeCarrierPrediction,
} from "../src/scripts/starlink-predictor";
import { communityWireFields } from "../src/server/community-wire";
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
const LEGEND_MISMATCH = sections
  .filter((s) => s.legendHasStar === false)
  .reduce((n, s) => n + s.marks.filter((m) => m === "★").length, 0);

// Marks render three ways on FlyerTalk: a bare entity, a colour span, and
// (rarely) a space before the star.
function markHtml(mark: Mark, i: number): string {
  const entity = mark === "★" ? "&#9733;" : "&#9734;";
  if (!mark) return "";
  if (i % 3 === 1) return `<span style="color:#333333">${entity}</span>`;
  return i % 5 === 4 ? ` ${entity}` : entity;
}

function guideHtml(opts: { sections?: Array<FixtureSection | string>; footer?: boolean } = {}) {
  const lines: string[] = [];
  let si = 0;
  for (const s of opts.sections ?? SECTIONS) {
    if (typeof s === "string") {
      lines.push(`<b><u>${s.replace(/&/g, "&amp;")}</u></b>`);
      continue;
    }
    lines.push(`<b>${s.header}</b>`);
    lines.push(s.marks.map((m, i) => `${tailOf(si, i)}${markHtml(m, i)}`).join(" / "));
    lines.push("Configuration: SYNTHETIC-CABIN-LAYOUT");
    lines.push(
      s.legendHasStar === false
        ? "Wi-Fi: legacy (&#9734; equipped)"
        : "Wi-Fi: &#9733; Starlink / &#9734; legacy Wi-Fi"
    );
    lines.push("J seat: SYNTHETIC-SEAT in a 1-2-1 configuration");
    si++;
  }
  if (opts.footer !== false)
    lines.push("<i>Version 1.0 by curator - last updated 12 September 2026</i>");
  return `<html><div id="wikipost-2213677">${lines.join("<br />\n")}</div><!--  END WIKIPOST   -->
<div class="post">Spotted F-GZZZ&#9733; today</div></html>`;
}

const GUIDE = parseAirFranceGuide(guideHtml());
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

function appliedDb(): Database {
  const db = makeSyntheticDb();
  seedRoster(db);
  applyAirFranceGuide(db, GUIDE);
  return db;
}

const one = <T>(db: Database, sql: string, ...p: Array<string | number>) =>
  db.query(sql).get(...p) as T;

// ── parse ───────────────────────────────────────────────────────────────────

describe("parseAirFranceGuide", () => {
  test("structure: sections, tails, marks, operators, dates", () => {
    expect(GUIDE.sections).toBeGreaterThanOrEqual(15);
    expect(GUIDE.tails.length).toBe(FIXTURE_TAILS.length);
    for (const t of GUIDE.tails) expect(AF.tailPattern.test(t.tail)).toBe(true);
    expect(new Set(GUIDE.tails.map((t) => t.mark))).toEqual(
      new Set(["starlink", "legacy", "none"])
    );
    expect(GUIDE.tails.filter((t) => t.mark === "starlink").length).toBe(STARS.length);
    expect(GUIDE.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(GUIDE.legendMismatch).toBe(LEGEND_MISMATCH);
    const keys = new Set(GUIDE.tails.map((t) => t.programType));
    expect(keys.has("B777-200ER")).toBe(true);
    expect(keys.has("B777-300ER")).toBe(true);
    expect(keys.has("B777")).toBe(false);
    const hop = GUIDE.tails.filter((t) => t.operator === "Air France HOP");
    expect(hop.length).toBeGreaterThan(0);
    expect(hop.every((t) => /^E1[79]0$/.test(t.programType))).toBe(true);
  });

  test("span-wrapped and spaced stars parse; a reply-post tail does not", () => {
    const spanned = GUIDE.tails.find((t) => t.tail === tailOf(1, 1));
    const spaced = GUIDE.tails.find((t) => t.tail === tailOf(1, 4));
    expect(spanned?.mark).toBe("starlink");
    expect(spaced?.mark).toBe("starlink");
    expect(GUIDE.tails.some((t) => t.tail === "F-GZZZ")).toBe(false);
  });

  test.each([
    ["missing block", () => parseAirFranceGuide("<html>nothing</html>")],
    ["missing footer", () => parseAirFranceGuide(guideHtml({ footer: false }))],
    [
      "unknown type header",
      () =>
        parseAirFranceGuide(
          guideHtml({ sections: [...SECTIONS, { header: "Concorde", fr24: "x", marks: [""] }] })
        ),
    ],
    [
      "bare 777 header",
      () =>
        parseAirFranceGuide(
          guideHtml({ sections: [...SECTIONS, { header: "777", fr24: "x", marks: [""] }] })
        ),
    ],
    [
      "duplicate tail",
      () => {
        const html = guideHtml().replace(tailOf(2, 0), tailOf(1, 0));
        return parseAirFranceGuide(html);
      },
    ],
    ["too few tails", () => parseAirFranceGuide(guideHtml({ sections: SECTIONS.slice(0, 8) }))],
  ])("%s throws a deterministic layout error", (_label, run) => {
    let err: unknown;
    try {
      run();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(isDeterministicFetchError(err)).toBe(true);
  });
});

// ── apply ───────────────────────────────────────────────────────────────────

describe("applyAirFranceGuide", () => {
  test("★ tails become community-tier confirmed; nothing claims verified", () => {
    const db = makeSyntheticDb();
    seedRoster(db);
    const r = applyAirFranceGuide(db, GUIDE);
    expect(r.absent).toEqual([GUIDE_ONLY]);
    expect(r.mismatch).toEqual([MISMATCHED]);
    const confirmed = one<{ n: number; verified: number }>(
      db,
      "SELECT COUNT(*) n, SUM(verified_wifi IS NOT NULL OR verified_at IS NOT NULL) verified FROM united_fleet WHERE airline='AF' AND starlink_status='confirmed'"
    );
    expect(confirmed.n).toBe(STARS.length - 2);
    expect(confirmed.verified).toBe(0);
    const sp = db
      .query(
        "SELECT TailNumber, sheet_gid, OperatedBy, verified_wifi FROM starlink_planes WHERE airline='AF'"
      )
      .all() as {
      TailNumber: string;
      sheet_gid: string;
      OperatedBy: string;
      verified_wifi: string | null;
    }[];
    expect(sp.length).toBe(confirmed.n);
    expect(sp.every((r) => r.sheet_gid === "flyertalk_af" && r.verified_wifi === null)).toBe(true);
    const hopTail = FIXTURE_TAILS.find(
      (t) => t.header === "Embraer 190 (Cabin J)" && t.tail !== GUIDE_ONLY
    )?.tail;
    const mainTail = FIXTURE_TAILS.find((t) => t.header === "A350-941 (Cabin G)")?.tail;
    expect(sp.find((r) => r.TailNumber === hopTail)?.OperatedBy).toBe("Air France HOP");
    expect(sp.find((r) => r.TailNumber === mainTail)?.OperatedBy).not.toBe("Air France HOP");
    expect(
      one<{ n: number }>(
        db,
        "SELECT COUNT(*) n FROM united_fleet WHERE airline='AF' AND operated_by IS NOT NULL"
      ).n
    ).toBe(0);
    const stamp = one<{ value: string }>(
      db,
      "SELECT value FROM meta WHERE key='AF:lastUpdated'"
    ).value;
    expect(Number.isNaN(Date.parse(stamp))).toBe(false);
    expect(stamp).toContain("T");
    expect(getFleetDiscoveryStats(db, ["AF"]).verified_starlink).toBe(0);
    db.close();
  });

  test("idempotent; the guide table is replaced, not appended", () => {
    const db = appliedDb();
    const before = one<{ n: number }>(
      db,
      "SELECT COUNT(*) n FROM starlink_planes WHERE airline='AF'"
    ).n;
    applyAirFranceGuide(db, GUIDE);
    expect(
      one<{ n: number }>(db, "SELECT COUNT(*) n FROM starlink_planes WHERE airline='AF'").n
    ).toBe(before);
    expect(
      one<{ n: number }>(db, "SELECT COUNT(*) n FROM fleet_guide_tails WHERE airline='AF'").n
    ).toBe(GUIDE.tails.length);
    db.close();
  });

  const unstar = (guide: ParsedGuide, n: number): ParsedGuide => {
    const drop = new Set(
      guide.tails
        .filter((t) => t.mark === "starlink" && t.tail !== GUIDE_ONLY && t.tail !== MISMATCHED)
        .slice(0, n)
        .map((t) => t.tail)
    );
    return {
      ...guide,
      tails: guide.tails.map((t) => (drop.has(t.tail) ? { ...t, mark: "legacy" as const } : t)),
    };
  };

  test("delisted tails are reported, not demoted — unless the owner asks, and never to negative", () => {
    const db = appliedDb();
    const r = applyAirFranceGuide(db, unstar(GUIDE, 2));
    expect(r.delisted.length).toBe(2);
    expect(r.demoted).toBe(0);
    const tail = r.delisted[0];
    expect(
      one<{ s: string }>(db, "SELECT starlink_status s FROM united_fleet WHERE tail_number=?", tail)
        .s
    ).toBe("confirmed");

    const d = applyAirFranceGuide(db, unstar(GUIDE, 2), { demoteDelisted: true });
    expect(d.demoted).toBe(2);
    expect(
      one<{ s: string }>(db, "SELECT starlink_status s FROM united_fleet WHERE tail_number=?", tail)
        .s
    ).toBe("unknown");
    expect(
      one<{ n: number }>(db, "SELECT COUNT(*) n FROM starlink_planes WHERE TailNumber=?", tail).n
    ).toBe(0);
    db.close();
  });

  test("refuses more than 10 delisted, and a roster below minFleetSanity", () => {
    const db = appliedDb();
    expect(() => applyAirFranceGuide(db, unstar(GUIDE, 11))).toThrow(/refusing/);
    db.close();
    const empty = makeSyntheticDb();
    expect(() => applyAirFranceGuide(empty, GUIDE)).toThrow(/fleet sync/);
    empty.close();
  });

  test("no AF tail is ever negative, through every reconcile path", () => {
    const db = appliedDb();
    reconcileTypeDeterministicFleets(db);
    reconcileConsensus(db);
    applyAirFranceGuide(db, unstar(GUIDE, 3), { demoteDelisted: true });
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
      await verdictOn(db, "AF300"),
      await verdictOn(db, "AF400", { lookupTail: async () => [seg("PH-BHA")] }),
    ];
    for (const v of answers) {
      if (v.kind !== "no_model") throw new Error(v.kind);
      const f = communityWireFields(v.answer);
      expect("probability" in f).toBe(false);
      expect("prediction" in f).toBe(false);
      if (v.answer.kind === "type_progress") expect(Array.isArray(f.by_type)).toBe(true);
      if (v.answer.kind === "type_rate") {
        const share = (f.type_rate as { share: unknown }).share;
        expect(share === null || typeof share === "number").toBe(true);
      }
      if (v.answer.kind === "assigned_unconfirmed" || v.answer.kind === "partner_operated") {
        expect(typeof (f.assignment as { tail_number: unknown }).tail_number).toBe("string");
      }
    }
    db.close();
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
        lastSynced: "2026-09-18T00:00:00.000Z",
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
