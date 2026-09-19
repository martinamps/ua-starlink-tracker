/**
 * The shared plumbing Air France touches: FlyerTalk applier tiers (AS/QR
 * unchanged), residential-sync AF validation, flight-number helpers, the
 * untracked-demand tag, and the UA host contract. Hermetic.
 */

import { describe, expect, test } from "bun:test";
import {
  buildAirlineFlightNumberVariants,
  detectMarketingCarrier,
} from "../src/airlines/flight-number";
import { AIRLINES, airlineSlug, isOutsideProgramme } from "../src/airlines/registry";
import { normalizeCarrierPrefix } from "../src/observability";
import type { ParsedGuide } from "../src/scripts/flyertalk-airfrance";
import { applyFlyertalkTails } from "../src/scripts/flyertalk-common";
import { fetchAfSource, validateAf } from "../src/scripts/residential-sync";
import { createApp } from "../src/server/app";
import { addFleet, makeSyntheticDb, openSnapshot, req } from "./helpers";

describe("applyFlyertalkTails evidence tiers", () => {
  const stamps = (db: ReturnType<typeof makeSyntheticDb>, tail: string) =>
    db
      .query(
        `SELECT uf.starlink_status, uf.verified_wifi AS uf_wifi, uf.verified_at IS NOT NULL AS uf_at,
                uf.operated_by, sp.verified_wifi AS sp_wifi, sp.OperatedBy, sp.sheet_gid
         FROM united_fleet uf JOIN starlink_planes sp ON sp.TailNumber = uf.tail_number
         WHERE uf.tail_number = ?`
      )
      .get(tail);

  test("AS stays at the observed tier, stamped and operator-asserted", () => {
    const db = makeSyntheticDb();
    addFleet(db, "N613AS", "unknown", {
      airline: "AS",
      aircraftType: "Boeing 737-700",
      verifiedAt: null,
    });
    applyFlyertalkTails(db, ["N613AS"], {
      airline: "AS",
      gid: "flyertalk_as",
      operator: "Alaska Airlines",
      gateLabel: "t",
      gate: () => ({ aircraftType: "Boeing 737-700" }),
    });
    expect(stamps(db, "N613AS")).toEqual({
      starlink_status: "confirmed",
      uf_wifi: "Starlink",
      uf_at: 1,
      operated_by: "Alaska Airlines",
      sp_wifi: "Starlink",
      OperatedBy: "Alaska Airlines",
      sheet_gid: "flyertalk_as",
    });
    db.close();
  });

  test("community tier: no verified stamps, operator override on the sp row only", () => {
    const db = makeSyntheticDb();
    addFleet(db, "F-HBLA", "unknown", {
      airline: "AF",
      aircraftType: "Embraer E190LR",
      verifiedAt: null,
    });
    applyFlyertalkTails(db, ["F-HBLA"], {
      airline: "AF",
      gid: "flyertalk_af",
      operator: "Air France",
      fleetOperator: null,
      evidence: "community",
      gateLabel: "t",
      gate: () => ({ aircraftType: "Embraer E190LR", operator: "Air France HOP" }),
    });
    expect(stamps(db, "F-HBLA")).toEqual({
      starlink_status: "confirmed",
      uf_wifi: null,
      uf_at: 0,
      operated_by: null,
      sp_wifi: null,
      OperatedBy: "Air France HOP",
      sheet_gid: "flyertalk_af",
    });
    db.close();
  });
});

const guide = (stars: number, updatedAt = "2026-09-12", tail = "F-HTYA"): ParsedGuide => ({
  updatedAt,
  sections: 20,
  legendMismatch: 0,
  tails: Array.from({ length: stars }, (_, i) => ({
    tail:
      i === 0
        ? tail
        : `F-G${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}A`,
    mark: "starlink" as const,
    section: "A350-941",
    programType: "A350",
    operator: null,
  })),
});

describe("residential-sync AF validation", () => {
  const NOW = Date.parse("2026-09-19T00:00:00Z");
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: number }).code;
    }
    return undefined;
  };

  test("refuses malformed tails, a thin list, a runaway list and a future date", () => {
    expect(refusal(() => validateAf(guide(120, "2026-09-12", "N123AF"), undefined, NOW))).toBe(2);
    expect(refusal(() => validateAf(guide(50), undefined, NOW))).toBe(2);
    expect(refusal(() => validateAf(guide(120), 50, NOW))).toBe(2);
    expect(refusal(() => validateAf(guide(120, "2026-10-30"), undefined, NOW))).toBe(2);
    expect(validateAf(guide(120), 136, NOW)).toEqual([]);
  });

  test("an old guide ships with a warning", () => {
    expect(validateAf(guide(120, "2026-07-01"), undefined, NOW).length).toBe(1);
  });

  test("a prod image without AF preflight state skips AF instead of shipping", async () => {
    const skipped: unknown[] = [];
    expect(await fetchAfSource(undefined, (e) => skipped.push(e))).toBeUndefined();
    expect(skipped.length).toBe(1);
  });
});

describe("AF flight numbers and slug", () => {
  test("slug is hyphenated; existing slugs unchanged", () => {
    expect(airlineSlug(AIRLINES.AF)).toBe("air-france");
    expect(["UA", "HA", "AS", "QR"].map((c) => airlineSlug(AIRLINES[c]))).toEqual([
      "united",
      "hawaiian",
      "alaska",
      "qatar",
    ]);
  });

  test.each([
    ["AF10", "AF"],
    ["AFR10", "AF"],
    ["HOP123", null],
  ])("detectMarketingCarrier(%s) → %p", (fn, code) => {
    expect(detectMarketingCarrier(fn)?.code ?? null).toBe(code);
  });

  test("variants carry no duplicates", () => {
    for (const cfg of Object.values(AIRLINES)) {
      const v = buildAirlineFlightNumberVariants(cfg, `${cfg.iata}100`);
      expect(v.length).toBe(new Set(v).size);
    }
  });

  test("programme exclusions and freighters are outside every denominator", () => {
    expect(isOutsideProgramme("AF", "A330")).toBe(true);
    expect(isOutsideProgramme("AF", "B777F")).toBe(true);
    expect(isOutsideProgramme("AF", "A350")).toBe(false);
    expect(isOutsideProgramme("QR", "A330")).toBe(false);
    expect(AIRLINES.AF.rollout.rosterIsProgramScope).toBe(true);
  });
});

describe("untracked demand tag", () => {
  test.each([
    ["DL100", "DL"],
    ["dl 100", "DL"],
    ["ZZ100", "other"],
    ["", "other"],
    ["QR1", "QR"],
  ])("%s → %s", (fn, prefix) => {
    expect(normalizeCarrierPrefix(fn)).toBe(prefix);
  });
});

describe("UA host contract", () => {
  test("an AF number on the United host stays a 404 not_tracked", async () => {
    const app = createApp(openSnapshot());
    const r = await app.dispatch(
      req("/api/check-flight?flight_number=AF10&date=2026-09-20", "unitedstarlinktracker.com")
    );
    expect(r.status).toBe(404);
    expect(typeof (await r.json()).error).toBe("string");
  });
});
