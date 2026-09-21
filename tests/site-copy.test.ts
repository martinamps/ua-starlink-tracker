/**
 * Site copy that must agree with the data (or with itself) across pages.
 * Shapes, not values: every assertion survives snapshot drift.
 */

import { afterAll, describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import { getContent } from "../src/airlines/content";
import { AIRLINES, SITES, publicAirlines, wifiPhaseFamilies } from "../src/airlines/registry";
import { factsBySlug } from "../src/airlines/rollout-facts";
import { renderFlightAnswer } from "../src/client/flight-answer";
import CheckFlightPage, { type FlightFacts } from "../src/components/check-flight-page";
import { monthLabel } from "../src/components/install-rate-page";
import { LIVE_TV_TARGET_FACT } from "../src/components/live-tv-page";
import {
  flyertalkFirstSyncDays,
  getDailyInstalls,
  getFleetPageData,
  getRecentInstalls,
  isBulkRow,
} from "../src/database/database";
import {
  type CarrierPrediction,
  carrierPrediction,
  describeCarrierPrediction,
} from "../src/scripts/starlink-predictor";
import { createApp, notTrackedMessage } from "../src/server/app";
import { createReaderFactory } from "../src/server/context";
import { computeInstallRate } from "../src/utils/install-rate";
import { bodyOf, makeSyntheticDb, openSnapshot, postMcp } from "./helpers";

const db = openSnapshot();
const app = createApp(db);
const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
afterAll(() => db.close());

describe("install-rate dates", () => {
  test("month labels carry a four-digit year", () => {
    expect(monthLabel("2027-05")).toBe("May 2027");
  });
});

describe("check-flight permalink", () => {
  test("departure times render in the departure airport's zone", () => {
    // 2026-01-15 15:00 UTC is 07:00 in Los Angeles, 10:00 in New York.
    const dep = Date.UTC(2026, 0, 15, 15, 0) / 1000;
    const answer = renderFlightAnswer(
      {
        hasStarlink: true,
        confidence: "verified",
        flights: [
          {
            tail_number: "N1",
            flight_number: "UA1",
            departure_airport: "SFO",
            arrival_airport: "EWR",
            departure_time: dep,
          },
        ],
      },
      {
        flightNumber: "UA1",
        date: "2026-01-15",
        daysOut: 0,
        nowSec: dep,
        airlineName: "United Airlines",
        zoneFor: (c) => (c === "SFO" ? "America/Los_Angeles" : undefined),
        liveTv: null,
        watchEnabled: false,
        routePlannerEnabled: false,
        host: UA,
      }
    );
    expect(answer.html).toMatch(/7:00\sAM PST/);
    expect(answer.headline).toContain("UA1 on Jan 15");
  });

  test("the observed tally is labelled as Wi-Fi checks, not departures", () => {
    const flight: FlightFacts = {
      flightNumber: "UA2638",
      airlineName: "United Airlines",
      observedTotal: 29,
      observedStarlink: 13,
      aircraftTypes: [],
      lastStarlink: null,
      routes: [],
      upcoming: [],
      siblings: [],
    };
    const html = ReactDOMServer.renderToString(
      React.createElement(CheckFlightPage, { site: SITES.united, flight })
    )
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, "");
    expect(html).toContain("13 of 29 Wi-Fi checks");
    expect(html).not.toMatch(/\d+ of \d+ [a-z ]*departures/);
  });
});

describe("/live-tv fleet figure", () => {
  test("comes from a cited rollout fact, never typed into the page", async () => {
    expect(LIVE_TV_TARGET_FACT).not.toBeNull();
    const united = factsBySlug("united");
    expect(united?.facts).toContain(LIVE_TV_TARGET_FACT);
    const { status, text } = await bodyOf(app, "/live-tv", UA);
    expect(status).toBe(200);
    expect(text).not.toContain("nearly 700 aircraft");
    expect(text).toContain(LIVE_TV_TARGET_FACT?.source.url ?? "missing");
  });
});

describe("fleet totals", () => {
  test("totalFleet counts exactly the tails the page lists", () => {
    for (const cfg of publicAirlines()) {
      const d = getFleetPageData(db, [cfg.code]);
      expect(d.totalFleet, cfg.code).toBe(d.allTails.length);
    }
    const hub = getFleetPageData(db, undefined);
    expect(hub.totalFleet).toBe(hub.allTails.length);
  });
});

describe("FlyerTalk installs after the backfill", () => {
  test("only the gid's first sync day is bulk; later tails are organic installs", () => {
    const sdb = makeSyntheticDb();
    const ins = sdb.query(
      `INSERT INTO starlink_planes (TailNumber, aircraft, wifi, OperatedBy, fleet, airline, sheet_gid, DateFound)
       VALUES (?, 'B737', 'Starlink', 'Test', 'mainline', 'AS', 'flyertalk_as', date('now', ?))`
    );
    ins.run("N801BF", "-20 days");
    ins.run("N802BF", "-20 days");
    ins.run("N803LT", "-2 days");

    const tails = getRecentInstalls(sdb, "AS", 50).map((r) => r.TailNumber);
    expect(tails).toEqual(["N803LT"]);
    expect(getDailyInstalls(sdb, "AS").reduce((s, d) => s + d.installs, 0)).toBe(1);

    const first = flyertalkFirstSyncDays(sdb);
    const rows = sdb
      .query("SELECT TailNumber AS t, sheet_gid AS g, DateFound AS d FROM starlink_planes")
      .all() as Array<{ t: string; g: string; d: string }>;
    for (const r of rows) {
      expect(isBulkRow(r.g, r.d, first), r.t).toBe(!tails.includes(r.t));
    }
    sdb.close();
  });
});

describe("homepage install pace", () => {
  test("is the /install-rate pace, not a hardcoded figure", async () => {
    const { text } = await bodyOf(app, "/", UA);
    expect(text).not.toContain("40+");
    const pace = computeInstallRate({
      daily: getDailyInstalls(db, ["UA"]),
      equipped: 0,
      total: 0,
      targets: [],
      nowMs: Date.now(),
    }).paceMonthly;
    if (pace) {
      expect(text.replace(/<!-- -->/g, "")).toContain(`~${Math.round(pace)}</span> installs/mo`);
    }
    expect(text).not.toContain("Starlink jets by type");
  });

  test("the stat strip states the pace it is given, and omits it when there is none", () => {
    const strip = getContent(AIRLINES.UA).headerStats;
    if (typeof strip !== "function") throw new Error("UA header stats must derive from data");
    const base = { starlinkCount: 1, totalCount: 2, percentage: "50.00" };
    const render = (installsPerMonth: number | null) =>
      ReactDOMServer.renderToString(
        React.createElement(React.Fragment, null, ...strip({ ...base, installsPerMonth }))
      ).replace(/<!-- -->/g, "");
    expect(render(54.7)).toContain("~55</span> installs/mo");
    expect(render(null)).not.toContain("installs/mo");
  });
});

describe("grammar", () => {
  test("article before an airline name on compare pages", async () => {
    const { status, text } = await bodyOf(app, "/compare/alaska-vs-united", HUB);
    if (status !== 200) return;
    expect(text).not.toContain("Check a Alaska");
  });

  test("hub newly-equipped lead never says 'tracked airlines aircraft'", async () => {
    const { text } = await bodyOf(app, "/newly-equipped", HUB);
    expect(text).not.toContain("tracked airlines aircraft");
  });

  test("a dated type-split answer does not ask for a date", () => {
    const factory = createReaderFactory(db);
    const answer = carrierPrediction(AIRLINES.HA, factory("HA"), "HA50");
    if (answer.kind !== "type_split") return;
    const dated = describeCarrierPrediction(AIRLINES.HA, answer, { date: "2026-09-22" });
    expect(dated).not.toContain("Check a specific flight and date");
    expect(describeCarrierPrediction(AIRLINES.HA, answer)).toContain(
      "Check a specific flight and date"
    );
  });

  test("MCP check_flight's dated type-split answer does not ask for a date either", async () => {
    const answer = carrierPrediction(AIRLINES.HA, createReaderFactory(db)("HA"), "HA50");
    if (answer.kind !== "type_split") return;
    const res = await postMcp(app, HUB, "tools/call", {
      name: "check_flight",
      arguments: { flight_number: "HA50", date: "2026-09-22" },
    });
    const text: string = res.result?.content?.[0]?.text ?? "";
    expect(text).not.toContain("Check a specific flight and date");
  });

  test("subfleet hints are not a second parenthetical", () => {
    const sf = AIRLINES.AS.subfleets.find((s) => s.flightNumberHint && s.label.endsWith(")"));
    if (!sf) throw new Error("expected an AS subfleet with a parenthesised label and a hint");
    const answer = {
      kind: "penetration",
      sf,
      pen: { synthetic: false, equipped: 10, total: 20, pct: 0.5 },
    } as CarrierPrediction;
    const text = describeCarrierPrediction(AIRLINES.AS, answer);
    expect(text).toContain(sf.flightNumberHint ?? "missing");
    expect(text).not.toMatch(/\) \(/);
  });
});

describe("rollout status agrees with the type table", () => {
  test("no airline is labelled Complete while a family is still rolling", () => {
    for (const cfg of Object.values(AIRLINES)) {
      const phases = Object.values(wifiPhaseFamilies(cfg.code) ?? {});
      if (phases.includes("rolling")) {
        expect(cfg.rollout.statusLabel, cfg.code).not.toBe("Complete");
      }
    }
  });
});

describe("not-tracked message on a single-airline host", () => {
  test("points another tracked airline's number at its own site", () => {
    const tracked = publicAirlines();
    const msg = notTrackedMessage(AIRLINES.UA, tracked, "AS100");
    expect(msg.startsWith("Airline not tracked.")).toBe(true);
    expect(msg).toContain("alaskastarlinktracker.com");
    expect(msg).not.toContain("Tracked: UA");
    expect(notTrackedMessage(AIRLINES.UA, tracked, "DL100")).not.toContain("Tracked:");
    expect(notTrackedMessage(null, tracked, "DL100")).toContain("Tracked:");
  });

  test("the UA host's check-flight 404 carries it", async () => {
    const { status, text } = await bodyOf(
      app,
      "/api/check-flight?flight_number=AS100&date=2026-09-22",
      UA
    );
    expect(status).toBe(404);
    expect(JSON.parse(text).error).toContain("alaskastarlinktracker.com");
  });
});
