/**
 * One flight, one figure: the flight's own page (dated and undated), the
 * planner, the route board, /api/predict-flight and the MCP tools all print
 * the same odds for it, by one rule (predictLegOrFlight). A leg on a plane
 * that is assigned and verified reads "Yes" in the planner, as its page does.
 *
 * The seed gives each number a long run of old checks beside a short leg log,
 * so the number's own model and its leg disagree: a surface that asks the
 * other one prints another figure, and fails here.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher } from "../src/api/flight-verdict";
import { renderResults } from "../src/client/route-planner";
import { probLabel } from "../src/components/ui/format";
import { departureLocalDate } from "../src/database/assignment-log";
import { createReaderFactory } from "../src/database/reader";
import { DAY_SEC, unixNow } from "../src/database/sql/windows";
import { predictFlight, predictLegOrFlight } from "../src/scripts/starlink-predictor";
import { createApp } from "../src/server/app";
import { addFleet, addFlight, addPlane, makeFreshDb, mcpReq, req } from "./helpers";

const UA = "unitedstarlinktracker.com";
const HUB = "airlinestarlinktracker.com";
const STARLINK = ["N801UA", "N802UA", "N803UA", "N804UA"];
const OTHER = ["N901UA", "N902UA", "N903UA", "N904UA"];

describe("one figure per flight (synthetic)", () => {
  const now = unixNow();
  const dayStart = Math.floor(now / DAY_SEC) * DAY_SEC;
  const at = (offsetDays: number, hourZ: number) => dayStart + offsetDays * DAY_SEC + hourZ * 3600;
  let db: Database;
  let app: ReturnType<typeof createApp>;

  const flown = (fn: string, tail: string, dep: number, pair: [string, string], hours: number) =>
    db
      .query(
        `INSERT INTO flight_assignment_log
           (airline, flight_number, dep_date, departure_airport, arrival_airport, tail_number,
            starlink, departure_time, arrival_time, first_seen, last_seen)
         VALUES ('UA', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`
      )
      .run(
        fn,
        departureLocalDate(pair[0], dep),
        pair[0],
        pair[1],
        tail,
        dep,
        dep + hours * 3600,
        dep,
        dep
      );
  const checked = (fn: string, tail: string, t: number, yes: boolean) =>
    db
      .query(
        `INSERT INTO starlink_verification_log (tail_number, source, checked_at, has_starlink, wifi_provider, flight_number, tail_confirmed, airline)
         VALUES (?, 'united', ?, ?, ?, ?, 1, 'UA')`
      )
      .run(tail, t, yes ? 1 : 0, yes ? "Starlink" : "Viasat", fn);
  const route = (fn: string, o: string, d: string, hours: number) =>
    db
      .query(
        `INSERT OR REPLACE INTO flight_routes (flight_number, origin, destination, duration_sec, first_seen_at, last_seen_at, seen_count)
         VALUES (?, ?, ?, ?, ?, ?, 20)`
      )
      .run(fn, o, d, hours * 3600, now - 30 * DAY_SEC, now - 3600);

  /** A number on one pair: `share` of 12 logged days on a Starlink plane, and
   * 20 checks a month and more ago that mostly say the opposite. */
  function oneLeg(fn: string, pair: [string, string], hourZ: number, share: number, hours = 2.5) {
    route(fn, pair[0], pair[1], hours);
    for (let d = 1; d <= 12; d++) {
      const yes = d <= Math.round(share * 12);
      flown(fn, (yes ? STARLINK : OTHER)[d % 4], at(-d, hourZ), pair, hours);
      checked(fn, (yes ? STARLINK : OTHER)[d % 4], at(-d, hourZ) - 6 * 3600, yes);
    }
    for (let k = 0; k < 20; k++)
      checked(
        fn,
        (k < 18 !== share > 0.5 ? STARLINK : OTHER)[k % 4],
        now - (40 + k) * DAY_SEC,
        k < 18 !== share > 0.5
      );
  }

  beforeAll(() => {
    setAssignmentFetcher(async () => []);
    db = makeFreshDb();
    for (const t of STARLINK) {
      addPlane(db, t, "Starlink", { aircraft: "Airbus A321-271NX" });
      addFleet(db, t, "confirmed", { aircraftType: "Airbus A321-271NX", verifiedWifi: "Starlink" });
    }
    for (const t of OTHER)
      addFleet(db, t, "negative", { aircraftType: "Boeing 757-224", verifiedWifi: "Viasat" });
    oneLeg("UA4421", ["DEN", "ORD"], 23, 0.75);
    oneLeg("UA640", ["DEN", "ORD"], 18, 0.25);
    // A through flight: SFO-DEN on Starlink planes, DEN-IAD never.
    route("UA488", "SFO", "DEN", 2.5);
    route("UA488", "DEN", "IAD", 3.5);
    for (let d = 1; d <= 12; d++) {
      flown("UA488", STARLINK[d % 4], at(-d, 15), ["SFO", "DEN"], 2.5);
      flown("UA488", OTHER[d % 4], at(-d, 19), ["DEN", "IAD"], 3.5);
      checked("UA488", OTHER[d % 4], at(-d, 13), false);
    }
    // Tomorrow: UA4421 on a verified Starlink plane, UA488's first leg too.
    addFlight(db, STARLINK[0], "UA4421", "DEN", at(1, 23), {
      arrivalAirport: "ORD",
      lastUpdated: now,
    });
    addFlight(db, STARLINK[1], "UA488", "SFO", at(1, 15), {
      arrivalAirport: "DEN",
      lastUpdated: now,
    });
    app = createApp(db);
  });
  afterAll(() => setAssignmentFetcher(null));

  const ask = (path: string) =>
    app.dispatch(
      req(path, UA, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
    );
  const json = async (path: string) => (await ask(path)).json() as Promise<any>;
  const html = async (path: string) => (await ask(path)).text();
  /** The page's own figure, in the sentence it prints wherever it quotes the
   * odds (the lead, or "On other dates:" under an assigned departure). */
  const metaFigure = (page: string) =>
    page.match(/((?:\d{1,3}|>99|<1)%) Starlink odds, weighted to recent UA\d+ flights/)?.[1];
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await app.dispatch(mcpReq(UA, "tools/call", { name, arguments: args }));
    const body = (await r.json()) as { result: { content: Array<{ text: string }> } };
    return body.result.content.map((c) => c.text).join("\n");
  };
  const far = () => departureLocalDate("DEN", now + 12 * DAY_SEC);
  const reader = () => createReaderFactory(db)("UA");

  test("the seed makes the number's own model and its leg disagree", () => {
    for (const fn of ["UA4421", "UA640"]) {
      expect(probLabel(predictFlight(reader(), fn).probability), fn).not.toBe(
        probLabel(predictLegOrFlight(reader(), fn, "DEN", "ORD").probability)
      );
    }
  });

  test("a number that flies one leg prints its leg's figure everywhere", async () => {
    for (const fn of ["UA4421", "UA640"]) {
      const want = probLabel(predictLegOrFlight(reader(), fn, "DEN", "ORD").probability);
      const seen: Record<string, string | undefined> = {};
      seen.page = metaFigure(await html(`/check-flight/${fn}`));
      seen.page_leg = metaFigure(await html(`/check-flight/${fn}?origin=DEN&destination=ORD`));
      seen.api_predict = probLabel(
        (await json(`/api/predict-flight?flight_number=${fn}`)).probability
      );
      const dated = await json(`/api/check-flight?flight_number=${fn}&date=${far()}`);
      seen.dated = probLabel(dated.prediction.probability);
      const hub = await app.dispatch(
        req(`/api/check-any-flight?flight_number=${fn}&date=${far()}`, HUB)
      );
      seen.any_flight = probLabel(((await hub.json()) as { probability: number }).probability);
      const board = await json("/api/route-flights?origin=DEN&destination=ORD");
      seen.board = board.flights.find((r: any) => r.flight_number === fn)?.odds_label;
      const plan = await json("/api/plan-route?origin=DEN&destination=ORD");
      const leg = plan.itineraries
        .flatMap((it: any) => it.legs)
        .find((l: any) => l.flight_number === fn);
      // The planner keeps one nonstop per pair, its best.
      if (fn === "UA4421") seen.planner = probLabel(leg.probability);
      else expect(leg).toBeUndefined();
      const routeLine = (
        await tool("predict_route_starlink", { origin: "DEN", destination: "ORD" })
      )
        .split("\n")
        .find((l) => l.includes(fn));
      // predict_route lists the numbers its route history holds.
      if (routeLine) seen.mcp_route = routeLine.match(/((?:\d{1,3}|>99|<1)%)/)?.[1];
      else expect(fn).not.toBe("UA4421");
      seen.mcp_predict = (await tool("predict_flight_starlink", { flight_number: fn })).match(
        /\*\*UA\d+\*\*: ~?(\S+%)/
      )?.[1];
      for (const [surface, figure] of Object.entries(seen))
        expect(figure, `${fn} ${surface}`).toBe(want);
    }
  });

  test("a through flight's leg prints the leg's figure where a leg is named", async () => {
    const want = probLabel(predictLegOrFlight(reader(), "UA488", "SFO", "DEN").probability);
    expect(want).not.toBe(probLabel(predictLegOrFlight(reader(), "UA488").probability));
    const board = await json("/api/route-flights?origin=SFO&destination=DEN");
    const row = board.flights.find((r: any) => r.flight_number === "UA488");
    expect(row.odds_label).toBe(want);
    // Its row opens the page on this leg, where the page prints the row's figure.
    expect(row.page).toBe("/check-flight/UA488?origin=SFO&destination=DEN");
    expect(metaFigure(await html(row.page))).toBe(want);
    const plan = await json("/api/plan-route?origin=SFO&destination=DEN");
    const leg = plan.itineraries[0].legs[0];
    expect(leg.flight_number).toBe("UA488");
    expect(probLabel(leg.probability)).toBe(want);
    expect(leg.page).toBe("/check-flight/UA488?origin=SFO&destination=DEN");
    // The undated page of the whole number answers for every leg it flies.
    expect(metaFigure(await html("/check-flight/UA488"))).toBe(
      probLabel(predictLegOrFlight(reader(), "UA488").probability)
    );
  });

  test("a leg on an assigned verified plane says Yes in the planner, as its page does", async () => {
    const tomorrow = departureLocalDate("DEN", at(1, 23));
    const answer = await json(`/api/check-flight?flight_number=UA4421&date=${tomorrow}`);
    expect(answer.hasStarlink).toBe(true);
    const plan = await json(`/api/plan-route?origin=DEN&destination=ORD&date=${tomorrow}`);
    const i = plan.itineraries.findIndex((it: any) => it.legs[0].flight_number === "UA4421");
    expect(plan.itineraries[i].legs[0].confirmed).toBe(true);
    const box = { innerHTML: "" };
    renderResults(box, plan, false);
    const card = box.innerHTML.split('<div class="itin-card').slice(1)[i];
    expect(card).toContain('">Yes</span>');
    expect(card).toContain("Starlink plane assigned");
    expect(card).not.toMatch(/>9\d%</);
    const mcp = await tool("plan_starlink_itinerary", {
      origin: "DEN",
      destination: "ORD",
      date: tomorrow,
    });
    const line = mcp.split("\n").find((l) => /Leg 1: UA4421/.test(l));
    expect(line).toContain("— Yes, assigned to a verified Starlink aircraft");
  });

  test("the planner's card shows the figure it ranks by", async () => {
    const plan = await json("/api/plan-route?origin=SFO&destination=ORD");
    expect(plan.itineraries.length).toBeGreaterThan(0);
    const box = { innerHTML: "" };
    renderResults(box, plan, false);
    const cards = box.innerHTML.split('<div class="itin-card').slice(1);
    plan.itineraries.forEach((it: any, i: number) => {
      if (it.total_flight_hours === null || it.expected_starlink_hours === null) return;
      expect(cards[i]).toContain(
        `flying expected on Starlink (${probLabel(it.expected_starlink_hours / it.total_flight_hours)})`
      );
    });
  });
});
