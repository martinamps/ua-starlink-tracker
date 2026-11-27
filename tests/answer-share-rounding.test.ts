/**
 * A share inside a flight or route answer is the fleet page's percent.
 *
 * Every fleet percent rounds down (tests/one-percent.test.ts). One family
 * still rounded to the nearest: a flight or route answered by its subfleet's
 * share. "~5% Starlink probability: 12 of 255 mainline aircraft have
 * Starlink" stood beside a fleet page that printed 4% for the same 12 of 255.
 * A number with no flight history behind it is a share of aircraft, and these
 * tests hold it to the rule wherever it is printed: the server's sentences,
 * the MCP's answers, the cards a browser draws, and the extension's badge.
 * Odds from a flight's own history stay rounded to the nearest.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import extLib from "../chrome-extension/lib.js";
import { hubGridCards } from "../scripts/generate-og-images";
import { AIRLINES, SITES, publicAirlines, siteForAirline } from "../src/airlines/registry";
import { renderFlightAnswer } from "../src/client/flight-answer";
import { checkAnyHtml } from "../src/client/flight-search";
import {
  approxShare,
  coldShare,
  flightLabel,
  flightPhrase,
  pct,
  pctWhole,
  probLabel,
  shareLabel,
  sharePhrase,
  shareWhole,
} from "../src/components/ui/format";
import { createApp } from "../src/server/app";
import { denominatorIsPublishable } from "../src/utils/share-cards";
import { jsonOf, makeFreshDb, mcpTool, openSnapshot } from "./helpers";

const HUB = SITES.airline.canonicalHost;

describe("a share given as a ratio is the rule's percent", () => {
  test("the same number and the same label as the counts give, for every fleet to 1,500", () => {
    for (let total = 1; total <= 1500; total++) {
      for (let n = 0; n <= total; n++) {
        const p = n / total;
        if (shareWhole(p) !== pctWhole(n, total) || shareLabel(p) !== pct(n, total)) {
          expect({ n, total, whole: shareWhole(p), label: shareLabel(p) }).toEqual({
            n,
            total,
            whole: pctWhole(n, total),
            label: pct(n, total),
          });
        }
      }
    }
  });

  test("12 of 255 reads 4%, never the 5% it rounds to", () => {
    const p = 12 / 255;
    expect(shareLabel(p)).toBe("4%");
    expect(sharePhrase(p)).toBe("about 4%");
    expect(approxShare(p)).toBe("~4%");
    expect(probLabel(p)).toBe("5%");
  });

  test("the edges take no hedge, and nothing reads all or none short of it", () => {
    expect(approxShare(1 / 300)).toBe("<1%");
    expect(sharePhrase(1 / 300)).toBe("under 1%");
    expect(approxShare(299 / 300)).toBe(">99%");
    expect(sharePhrase(299 / 300)).toBe("over 99%");
    expect(approxShare(1)).toBe("~100%");
    expect(sharePhrase(1)).toBe("100%");
    expect(approxShare(0)).toBe("~0%");
    expect(sharePhrase(0)).toBe("0%");
    expect(shareLabel(Number.NaN)).toBe("0%");
  });

  test("history decides: odds to the nearest, a share down", () => {
    expect(flightLabel(0.047, 12)).toBe("5%");
    expect(flightLabel(0.047, 0)).toBe("4%");
    expect(flightLabel(0.047, undefined)).toBe("4%");
    expect(flightPhrase(0.326, 9)).toBe("about 33%");
    expect(flightPhrase(0.326, 0)).toBe("about 32%");
    expect(coldShare(0.326, "UA100", "mainline")).toContain("about 32% is our estimate");
  });
});

/** "~4% Starlink probability: 12 of 255 …": the lead, and the counts behind it. */
const SAID = /((?:~\d+|<1|>99)%) Starlink probability: (\d[\d,]*) of (\d[\d,]*) /;
const num = (s: string) => Number(s.replace(/,/g, ""));

/** One flight number in each of an airline's number bands. */
const BAND_NUMBERS = [1, 50, 118, 300, 500, 850, 950, 1100, 1500, 2100, 3400, 5000];

/** A fleet whose shares all round up, so a nearest-whole answer cannot pass. */
function seedRoundsUp() {
  const db = makeFreshDb();
  const now = Math.floor(Date.now() / 1000);
  const add = (tail: string, type: string, fleet: string, op: string, fitted: boolean) => {
    db.query(
      `INSERT INTO united_fleet (tail_number, aircraft_type, fleet, operated_by, first_seen_source,
         first_seen_at, last_seen_at, starlink_status, verified_wifi, verified_at, airline)
       VALUES (?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, 'AS')`
    ).run(
      tail,
      type,
      fleet,
      op,
      now - 90 * 86400,
      now - 3600,
      fitted ? "confirmed" : "negative",
      fitted ? "Starlink" : "None",
      now - 86400
    );
    if (!fitted) return;
    db.query(
      `INSERT INTO starlink_planes (aircraft, wifi, sheet_gid, sheet_type, DateFound, TailNumber,
         OperatedBy, fleet, verified_wifi, airline)
       VALUES (?, 'StrLnk', 'g', ?, '2026-06-01', ?, ?, ?, 'Starlink', 'AS')`
    ).run(type, `AS-${fleet}`, tail, op, fleet);
  };
  // 12 of 255 is 4.7%, and 59 of 76 is 77.6%.
  for (let i = 0; i < 255; i++) {
    add(`N${200 + i}AK`, "Boeing 737-9 MAX", "mainline", "Alaska Airlines", i < 12);
  }
  for (let i = 0; i < 76; i++) {
    add(`N${600 + i}QX`, "Embraer ERJ-175LR", "horizon", "Horizon Air", i < 59);
  }
  for (const [fn, o, d] of [
    ["AS300", "PDX", "SFO"],
    ["AS2100", "SEA", "GEG"],
  ]) {
    db.query(
      `INSERT INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at,
         last_seen_at, seen_count) VALUES (?, ?, ?, 7200, ?, ?, 20)`
    ).run(fn, o, d, now - 30 * 86400, now - 3600);
  }
  return db;
}

describe("a flight answered by its subfleet's share", () => {
  let snapshot: ReturnType<typeof createApp>;
  let seeded: ReturnType<typeof createApp>;
  const AS_HOST = siteForAirline("AS")?.canonicalHost as string;

  beforeAll(() => {
    snapshot = createApp(openSnapshot());
    seeded = createApp(seedRoundsUp());
  });

  const modelLess = () => publicAirlines().filter((cfg) => !cfg.flightHistoryModel);

  test("every sentence that states a share beside its counts states the rule's", async () => {
    let seen = 0;
    for (const app of [snapshot, seeded]) {
      for (const cfg of modelLess()) {
        for (const n of BAND_NUMBERS) {
          const fn = `${cfg.iata}${n}`;
          const rest = await jsonOf(app, `/api/predict-flight?flight_number=${fn}`, HUB);
          const any = await jsonOf(
            app,
            `/api/check-any-flight?flight_number=${fn}&date=2099-01-01`,
            HUB
          );
          const tool = await mcpTool(app, `${HUB}`, "predict_flight_starlink", {
            flight_number: fn,
          });
          for (const text of [rest.message, any.reason, tool.text]) {
            const m = SAID.exec(String(text ?? ""));
            if (!m) continue;
            seen++;
            expect({ fn, lead: m[1], text: m[0] }).toEqual({
              fn,
              lead: approxShare(num(m[2]) / num(m[3])),
              text: m[0],
            });
            // And it is the fleet page's label for those counts.
            expect(m[1].replace("~", "")).toBe(pct(num(m[2]), num(m[3])));
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  test("12 of 255 is said as 4% in the sentence, the page, the card and the MCP", async () => {
    const rest = await jsonOf(seeded, "/api/predict-flight?flight_number=AS300", AS_HOST);
    // The number in the answer is the exact share, as it always was.
    expect(rest.probability).toBe(12 / 255);
    expect(rest.message).toStartWith("~4% Starlink probability: 12 of 255 ");

    const any = await jsonOf(
      seeded,
      "/api/check-any-flight?flight_number=AS300&date=2099-01-01",
      HUB
    );
    expect(any.probability).toBe(12 / 255);
    expect(any.confidence).toBe("type");
    expect(any.reason).toStartWith("~4% Starlink probability: 12 of 255 ");
    // The hub's search row, beside that sentence.
    expect(checkAnyHtml(any as never, false)).toContain(">4% Starlink<");

    const tool = await mcpTool(seeded, AS_HOST, "predict_flight_starlink", {
      flight_number: "AS300",
    });
    expect(tool.text).toContain("~4% Starlink probability: 12 of 255 ");

    // The card a browser draws from the airline site's own answer.
    const dated = await jsonOf(
      seeded,
      "/api/check-flight?flight_number=AS300&date=2099-01-01",
      AS_HOST
    );
    expect(dated.prediction.probability).toBe(12 / 255);
    const card = renderFlightAnswer(
      dated as never,
      {
        flightNumber: "AS300",
        date: "2099-01-01",
        daysOut: 30,
        nowSec: Math.floor(Date.now() / 1000),
        airlineName: "Alaska Airlines",
        zoneFor: () => undefined,
        liveTv: null,
        watchEnabled: false,
        routePlannerEnabled: false,
        tailPages: false,
        host: AS_HOST,
      } as never
    );
    expect(card.headline).toStartWith("About 4% chance AS300 ");
    expect(card.html).toContain("4% chance of Starlink");
    // The API's lead is dropped from the card's sentence, whatever its edge.
    expect(card.html).not.toContain("Starlink probability:");
  });

  test("a route answered by a subfleet's share says the same percent", async () => {
    const compare = await jsonOf(seeded, "/api/compare-route?origin=PDX&destination=SFO", HUB);
    const alaska = (
      compare.results as Array<{
        airline: string;
        probability: number;
        breakdown: Array<{ equipped?: number; total?: number }>;
      }>
    ).find((a) => a.airline === "AS");
    expect(alaska?.probability).toBe(12 / 255);

    const hub = await mcpTool(seeded, HUB, "predict_route_starlink", {
      origin: "PDX",
      destination: "SFO",
    });
    expect(hub.text).toContain("**Alaska Airlines**: ~4% Starlink");
    const own = await mcpTool(seeded, AS_HOST, "predict_route_starlink", {
      origin: "PDX",
      destination: "SFO",
    });
    expect(own.text).toContain("~4% Starlink");
    expect(own.text).not.toContain("5%");
    const plan = await jsonOf(seeded, "/api/plan-route?origin=PDX&destination=SFO", AS_HOST);
    expect(plan.message).toStartWith("~4% Starlink");
  });

  test("the client strips the lead at its edges too", () => {
    const body = {
      hasStarlink: null,
      confidence: "type",
      prediction: { probability: 1 / 300 },
      message: "<1% Starlink probability: 1 of 300 mainline 737/787 aircraft have Starlink.",
    };
    const card = renderFlightAnswer(
      body as never,
      {
        flightNumber: "AS300",
        date: "2099-01-01",
        daysOut: 30,
        nowSec: Math.floor(Date.now() / 1000),
        airlineName: "Alaska Airlines",
        zoneFor: () => undefined,
        liveTv: null,
        watchEnabled: false,
        routePlannerEnabled: false,
        tailPages: false,
        host: AS_HOST,
      } as never
    );
    expect(card.headline).toStartWith("Under 1% chance AS300 ");
    expect(card.html).toContain("1 of 300 mainline 737/787 aircraft have Starlink.");
    expect(card.html).not.toContain("Starlink probability:");
  });
});

describe("a flight number with no history is answered by its fleet's share", () => {
  test("the hub's search row rounds as the sentence beside it", () => {
    const row = (reason: string, confidence = "low") =>
      checkAnyHtml({ hasStarlink: null, probability: 0.326, confidence, reason } as never, false);
    expect(
      row(
        "No schedule data for this date. No history for UA100 yet; about 32% is our estimate for new mainline flight numbers."
      )
    ).toContain(">32% Starlink<");
    // History behind it: odds, to the nearest.
    expect(
      row(
        "No schedule data for this date; about 33% Starlink odds, weighted to recent UA100 flights (9 tracked).",
        "medium"
      )
    ).toContain(">33% Starlink<");
  });
});

describe("the extension's badge prints the percent the site prints", () => {
  const lib = extLib;
  const united = (probability: number, n: number) =>
    lib.normalizeClaim({
      hasStarlink: null,
      confidence: "predicted",
      prediction: { probability, confidence: n > 0 ? "high" : "low", n_observations: n },
      flights: [],
    });
  const alaska = (probability: number) =>
    lib.normalizeClaim({
      hasStarlink: null,
      airline: "Alaska Airlines",
      confidence: "type",
      probability,
      flights: [],
    });

  test("a subfleet's share and a no-history estimate round down; history odds do not", () => {
    expect(lib.badgeLabel(alaska(12 / 255))).toBe("Starlink ~4%");
    expect(lib.badgeTitle(alaska(12 / 255))).toStartWith("About 4% of the Alaska Airlines");
    expect(lib.badgeLabel(united(0.326, 0))).toBe("Starlink ~32%");
    expect(lib.badgeTitle(united(0.326, 0))).toStartWith("~32% chance");
    expect(lib.badgeLabel(united(0.326, 9))).toBe("Starlink ~33%");
  });

  test("it agrees with the site's label for every whole-fleet share to 400 aircraft", () => {
    for (let total = 1; total <= 400; total++) {
      for (let n = 1; n < total; n++) {
        const p = n / total;
        const want = shareLabel(p);
        const got = lib.badgeLabel(alaska(p)).replace("Starlink ", "").replace("~", "");
        // The badge keeps "~99%" where the site says ">99%"; its tooltip says "Over 99%".
        if (want === ">99%") {
          expect(got).toBe("99%");
          expect(lib.badgeTitle(alaska(p))).toStartWith("Over 99% of");
        } else if (got !== want) {
          expect({ n, total, got }).toEqual({ n, total, got: want });
        }
      }
    }
    expect(lib.badgeLabel(alaska(1 / 300))).toBe("Starlink <1%");
    expect(lib.badgeTitle(alaska(1 / 300))).toStartWith("Under 1% of");
  });
});

describe("the fleet summary and the hub pictures refuse what the pages refuse", () => {
  test("/api/fleet-summary gives no percent where the pages give no share", async () => {
    const app = createApp(openSnapshot());
    const { airlines } = (await jsonOf(app, "/api/fleet-summary", HUB)) as {
      airlines: Array<{ code: string; installed: number; total: number; percentage: unknown }>;
    };
    let refused = 0;
    for (const a of airlines) {
      const shared = denominatorIsPublishable(
        a.installed,
        a.total,
        AIRLINES[a.code].rollout.rosterIsProgramScope
      );
      // The key stays, with the counts beside it.
      expect("percentage" in a).toBe(true);
      if (shared) expect(a.percentage).toBe(pctWhole(a.installed, a.total));
      else {
        refused++;
        expect(a.percentage).toBeNull();
      }
    }
    // Hawaiian's roster holds the 717s, which the programme leaves out.
    expect(refused).toBeGreaterThan(0);
  });

  test("a hub picture draws a count, not a share, for such a roster and for a count above its total", () => {
    const row = (code: string, installed: number, total: number) => ({
      code,
      name: AIRLINES[code].name,
      installed,
      total,
      percentage: 100,
    });
    const cards = hubGridCards({
      airlines: [row("UA", 736, 1636), row("HA", 42, 61), row("AS", 400, 348)],
    });
    expect(cards.map((c) => ("pct" in c ? `${c.pct}%` : c.count))).toEqual(["44%", 42, 400]);
  });

  test("the card page draws the count card", () => {
    const og = readFileSync(join(import.meta.dir, "..", "static", "og.html"), "utf8");
    expect(og).toContain("c.pct == null");
    expect(og).toContain("AIRCRAFT");
  });
});
