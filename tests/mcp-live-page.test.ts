/**
 * The live-page line that ends an MCP flight or route answer. What this pins:
 * the line is the text's last, it names the airline's own site and is
 * tagged utm_source=mcp, the page it names renders 200 and indexable (or is
 * the planner's own search), and an answer with no such page gets no line.
 * Flights and routes are picked from the snapshot, so data drift moves the
 * picks, not the assertions.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAssignmentFetcher, setRouteFetcher } from "../src/api/flight-verdict";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { mcpTool, openSnapshot, req } from "./helpers";

const UA = "unitedstarlinktracker.com";
const HUB = "airlinestarlinktracker.com";
const LINE = /\n\n(Live (?:answer|route page|route planner)[^:\n]*): (https:\/\/\S+)$/;

let app: ReturnType<typeof createApp>;
let flight: string;
let pair: { origin: string; destination: string } | undefined;

// No live lookups leave the test: the answers come from the snapshot alone.
afterAll(() => {
  setAssignmentFetcher(null);
  setRouteFetcher(null);
});

beforeAll(() => {
  setAssignmentFetcher(() => Promise.resolve([]));
  setRouteFetcher(() => Promise.resolve([]));
  const db = openSnapshot();
  app = createApp(db);
  const reader = createReaderFactory(db)("UA");
  const popular = reader.getPopularFlights();
  flight = popular[0].flight_number;
  for (const f of popular) {
    pair = reader
      .getFlightRoutePairs([f.flight_number])
      .map((r) => ({ origin: r.departure_airport, destination: r.arrival_airport }))
      .find(
        (r) =>
          /^[A-Z]{3}$/.test(r.origin) &&
          /^[A-Z]{3}$/.test(r.destination) &&
          reader.routeHasData(r.origin, r.destination) &&
          reader.routeIsRecent(r.origin, r.destination)
      );
    if (pair) break;
  }
});

const today = () => new Date().toISOString().slice(0, 10);

/** The line's URL, after checking it is the text's last line. */
function linkOf(text: string): URL | null {
  const m = text.match(LINE);
  return m ? new URL(m[2]) : null;
}

async function expectServedPage(url: URL) {
  const res = await app.dispatch(req(`${url.pathname}${url.search}`, url.hostname));
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain("noindex");
}

describe("MCP answers end with their live page", () => {
  test("check_flight links the dated flight page on the airline's own site", async () => {
    const { text, isError } = await mcpTool(app, UA, "check_flight", {
      flight_number: flight,
      date: today(),
    });
    expect(isError).toBeFalsy();
    const url = linkOf(text);
    expect(url).not.toBeNull();
    if (!url) return;
    expect(url.hostname).toBe(UA);
    expect(url.pathname).toBe(`/check-flight/${flight}/${today()}`);
    expect(url.searchParams.get("utm_source")).toBe("mcp");
    expect(text.match(/https?:\/\/\S*utm_source=mcp/g)?.length).toBe(1);
    await expectServedPage(url);
  });

  test("the hub's answer links the airline's site, never the hub", async () => {
    const { text } = await mcpTool(app, HUB, "check_flight", {
      flight_number: flight,
      date: today(),
    });
    expect(linkOf(text)?.hostname).toBe(UA);
  });

  test("predict_flight_starlink without a date links the undated page", async () => {
    const { text } = await mcpTool(app, UA, "predict_flight_starlink", { flight_number: flight });
    const url = linkOf(text);
    expect(url?.pathname).toBe(`/check-flight/${flight}`);
    if (url) await expectServedPage(url);
  });

  test("a date well past drops to the undated page", async () => {
    const { text } = await mcpTool(app, UA, "check_flight", {
      flight_number: flight,
      date: "2020-01-01",
    });
    expect(linkOf(text)?.pathname).toBe(`/check-flight/${flight}`);
  });

  test("a flight with no page, an error and an untracked carrier get no line", async () => {
    const unknown = await mcpTool(app, UA, "check_flight", {
      flight_number: "UA9876",
      date: today(),
    });
    expect(unknown.text).not.toContain("utm_source=mcp");
    const bad = await mcpTool(app, UA, "check_flight", { flight_number: flight, date: "nope" });
    expect(bad.isError).toBe(true);
    expect(bad.text).not.toContain("utm_source=mcp");
    const other = await mcpTool(app, UA, "check_flight", {
      flight_number: "DL100",
      date: today(),
    });
    expect(other.text).not.toContain("utm_source=mcp");
  });

  test("route tools link the route page, the planner its own search", async () => {
    expect(pair).toBeDefined();
    if (!pair) return;
    for (const tool of ["predict_route_starlink", "search_starlink_flights"]) {
      const { text } = await mcpTool(app, UA, tool, pair);
      const url = linkOf(text);
      if (tool === "predict_route_starlink") expect(url).not.toBeNull();
      if (!url) continue;
      expect(url.pathname).toBe(`/route-planner/${pair.origin}/${pair.destination}`);
      expect(url.searchParams.get("utm_source")).toBe("mcp");
      await expectServedPage(url);
    }
    const plan = await mcpTool(app, UA, "plan_starlink_itinerary", pair);
    const url = linkOf(plan.text);
    expect(url?.pathname).toBe("/route-planner");
    expect(url?.searchParams.get("origin")).toBe(pair.origin);
    expect(url?.searchParams.get("destination")).toBe(pair.destination);
    if (url) await expectServedPage(url);
  });

  test("one-sided searches, the hub's route comparison and fleet tools get no line", async () => {
    if (!pair) return;
    const oneSided = await mcpTool(app, UA, "predict_route_starlink", { origin: pair.origin });
    expect(oneSided.text).not.toContain("utm_source=mcp");
    const hub = await mcpTool(app, HUB, "plan_starlink_itinerary", pair);
    expect(hub.text).not.toContain("utm_source=mcp");
    const stats = await mcpTool(app, UA, "get_fleet_stats");
    expect(stats.text).not.toContain("utm_source=mcp");
  });
});
