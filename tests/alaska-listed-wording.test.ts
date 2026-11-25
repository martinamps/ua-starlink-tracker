// A listed tail is "not yet verified" only where a check can come. Alaska's
// check sees which aircraft flies a flight and never its Wi-Fi, so every
// surface that speaks of a listed Alaska tail says that instead, and United's
// wording (pinned by the contract goldens) stays as it was.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AIRLINES, verifierReadsWifi } from "../src/airlines/registry";
import {
  listedWording,
  resolveFlightVerdict,
  siteShowsAircraftNotWifi,
} from "../src/api/check-flight-core";
import { renderCheckFlightVerdict } from "../src/api/mcp-server";
import { renderFlightAnswer } from "../src/client/flight-answer";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { addFlight, addPlane, makeSyntheticDb, postMcp, req } from "./helpers";

const AS = AIRLINES.AS;
const UA = AIRLINES.UA;
const AS_HOST = "alaskastarlinktracker.com";
const UA_HOST = "unitedstarlinktracker.com";
const DATE = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
// Evening UTC: the same calendar day at every US departure airport.
const DEP = Math.floor(Date.parse(`${DATE}T20:00:00Z`) / 1000);
const TAIL = "N801AS";
const PROMISE = /not yet|24h out to confirm|spreadsheet/i;
const bodyOf = async (app: ReturnType<typeof createApp>, path: string, host: string) =>
  (await app.dispatch(req(path, host))).text();

function seeded(): Database {
  const db = makeSyntheticDb();
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
     VALUES (?, 'Boeing 737 MAX 8', 'fr24', ?, ?, 'mainline', 'unknown', 'AS')`
  ).run(TAIL, now, now);
  addPlane(db, TAIL, null, { airline: "AS", aircraft: "Boeing 737 MAX 8" });
  addFlight(db, TAIL, "AS330", "SEA", DEP, { airline: "AS", arrivalAirport: "SFO" });
  addPlane(db, "N3002", null);
  addFlight(db, "N3002", "UA1002", "SFO", DEP, { arrivalAirport: "DEN" });
  return db;
}

async function toolText(
  db: Database,
  cfg: typeof AS,
  fn: string,
  deps: Parameters<typeof resolveFlightVerdict>[4] = { lookupTail: null }
) {
  const reader = createReaderFactory(db)(cfg.code);
  const v = await resolveFlightVerdict(cfg, reader, fn, DATE, deps);
  if (v.kind === "invalid_date" || v.kind === "invalid_flight_number") throw new Error(v.kind);
  const r = await renderCheckFlightVerdict(cfg, reader, v, DATE);
  return { kind: v.kind, text: r.content[0].text };
}

describe("the wording follows what the airline's check can see", () => {
  test("only a check that reads Wi-Fi may say 'not yet verified'", () => {
    expect(verifierReadsWifi(UA)).toBe(true);
    expect(verifierReadsWifi(AS)).toBe(false);
    expect(listedWording(UA)).toEqual({ status: "listed, not yet verified", siteLimit: null });
    const as = listedWording(AS);
    expect(as.status).not.toMatch(/yet/);
    expect(as.siteLimit).toBe(siteShowsAircraftNotWifi(AS));
    expect(as.siteLimit).toContain("alaskaair.com");
    // Hawaiian's check reads Alaska's site, so that is the site it may speak of.
    expect(listedWording(AIRLINES.HA).siteLimit).toBe(as.siteLimit);
  });

  test("an airline with no check of its site says nothing about that site", () => {
    for (const cfg of Object.values(AIRLINES)) {
      if (cfg.verifierBackend) continue;
      const w = listedWording(cfg);
      expect(w.siteLimit).toBeNull();
      expect(w.status).not.toMatch(/yet/);
    }
  });
});

describe("MCP check_flight, a listed Alaska mainline tail", () => {
  test("scheduled: on our list, and why Alaska's site can't confirm it", async () => {
    const db = seeded();
    const { kind, text } = await toolText(db, AS, "AS330");
    expect(kind).toBe("scheduled");
    expect(text.startsWith("Likely yes — AS330")).toBe(true);
    expect(text).toContain(TAIL);
    expect(text).toContain("on our list of Starlink aircraft");
    expect(text).toContain(siteShowsAircraftNotWifi(AS));
    expect(text).not.toMatch(PROMISE);
    db.close();
  });

  test("live tail lookup: the same reason, no promised check", async () => {
    const db = seeded();
    const { kind, text } = await toolText(db, AS, "AS440", {
      lookupTail: async () => [
        {
          tail_number: TAIL,
          aircraft_model: "Boeing 737 MAX 8",
          origin: "SEA",
          destination: "LAX",
          departure_time: DEP,
          arrival_time: DEP + 3 * 3600,
          hasStarlink: true,
          confidence: "spreadsheet" as const,
        },
      ],
    });
    expect(kind).toBe("fr24");
    expect(text.startsWith("Likely yes — AS440")).toBe(true);
    expect(text).toContain(siteShowsAircraftNotWifi(AS));
    expect(text).not.toMatch(PROMISE);
    db.close();
  });

  test("United's sentence is the pinned one, word for word", async () => {
    const db = seeded();
    const { kind, text } = await toolText(db, UA, "UA1002");
    expect(kind).toBe("scheduled");
    expect(text).toContain(
      "is assigned to a tail tracked as Starlink in the fleet spreadsheet (not yet verified against united.com):"
    );
    expect(text).toContain(
      "Spreadsheet data is usually accurate but unverified. Check united.com or the flight status 24h out to confirm."
    );
    db.close();
  });

  test("the tool list keeps its names; only Alaska's description drops 'yet'", async () => {
    const app = createApp(seeded());
    const list = async (host: string) =>
      (await postMcp(app, host, "tools/list")).result.tools as {
        name: string;
        description: string;
        inputSchema: unknown;
      }[];
    const [as, ua] = [await list(AS_HOST), await list(UA_HOST)];
    expect(as.map((t) => t.name)).toEqual(ua.map((t) => t.name));
    const check = (tools: typeof as) => tools.find((t) => t.name === "check_flight");
    expect(Object.keys(check(as)?.inputSchema as object)).toEqual(
      Object.keys(check(ua)?.inputSchema as object)
    );
    expect(check(as)?.description).toContain("listed as Starlink-equipped but not confirmed");
    expect(check(as)?.description).not.toContain("not yet verified");
    expect(check(ua)?.description).toContain("listed as Starlink-equipped but not yet verified");
  });
});

describe("the other surfaces that show a listed Alaska tail", () => {
  test("the API bodies keep their keys and values", async () => {
    const app = createApp(seeded());
    const body = JSON.parse(
      await bodyOf(app, `/api/check-flight?flight_number=AS330&date=${DATE}`, AS_HOST)
    );
    expect(Object.keys(body)).toEqual(["hasStarlink", "confidence", "flights"]);
    expect(body.hasStarlink).toBe(true);
    expect(body.confidence).toBe("likely");
  });

  test("the calendar feed and the answer card say listed, not confirmed", async () => {
    const app = createApp(seeded());
    const ics = (await bodyOf(app, `/cal/AS330/${DATE}.ics`, AS_HOST))
      .replace(/\r\n[ \t]/g, "")
      .replace(/\\,/g, ",");
    expect(ics).toContain("Starlink listed, not confirmed.");
    expect(ics).not.toContain("not yet verified");
    const html = await bodyOf(app, `/check-flight/AS330/${DATE}`, AS_HOST);
    expect(html).toContain(`${TAIL}, listed, not confirmed)`);
    expect(html).not.toContain("listed, not yet verified");
  });

  test("United's feed and card keep 'not yet verified'", async () => {
    const app = createApp(seeded());
    const ics = (await bodyOf(app, `/cal/UA1002/${DATE}.ics`, UA_HOST))
      .replace(/\r\n[ \t]/g, "")
      .replace(/\\,/g, ",");
    expect(ics).toContain("Starlink listed, not yet verified.");
    const html = await bodyOf(app, `/check-flight/UA1002/${DATE}`, UA_HOST);
    expect(html).toContain("N3002, listed, not yet verified)");
  });

  test("a card rendered without the airline's wording falls back to United's", () => {
    const answer = renderFlightAnswer(
      { hasStarlink: true, confidence: "likely", flights: [{ tail_number: "N3002" }] } as never,
      {
        flightNumber: "UA1002",
        date: DATE,
        daysOut: 1,
        nowSec: DEP - 86400,
        airlineName: "United Airlines",
        zoneFor: () => undefined,
        liveTv: null,
        watchEnabled: false,
        routePlannerEnabled: false,
        tailPages: false,
        host: UA_HOST,
      }
    );
    expect(answer.headline).toContain("listed, not yet verified");
  });

  test("the type page calls a listed square listed, never confirmed", async () => {
    const db = seeded();
    // Level with Alaska's own count of 12, so the note is the plain one and
    // not the "Alaska counts more" one.
    const now = Math.floor(Date.now() / 1000);
    for (let i = 10; i < 21; i++) {
      const tail = `N8${i}AS`;
      db.query(
        `INSERT INTO united_fleet (tail_number, aircraft_type, first_seen_source, first_seen_at, last_seen_at, fleet, starlink_status, airline)
         VALUES (?, 'Boeing 737 MAX 8', 'fr24', ?, ?, 'mainline', 'unknown', 'AS')`
      ).run(tail, now, now);
      addPlane(db, tail, null, { airline: "AS", aircraft: "Boeing 737 MAX 8" });
    }
    const html = (await bodyOf(createApp(db), "/fleet/737-max-8", AS_HOST)).replace(/&#x27;/g, "'");
    expect(html).toContain('data-equipped="12"');
    expect(html).toContain("Starlink (listed, not confirmed)");
    expect(html).toContain("so the 12 listed tails are on our list from reports, not confirmed.");
    expect(html).not.toContain("only tails we've confirmed are lit");
    expect(html).not.toContain("not yet verified");
  });

  test("the Dataset description claims a Wi-Fi cross-check only for United", async () => {
    const app = createApp(seeded());
    const as = await bodyOf(app, "/methodology", AS_HOST);
    expect(as).not.toContain("cross-referenced against alaskaair.com,");
    expect(as).toContain("which aircraft flies a flight, not its Wi-Fi");
    const ua = await bodyOf(app, "/methodology", UA_HOST);
    expect(ua).toContain("cross-referenced against united.com, fleet and schedule data");
  });
});
