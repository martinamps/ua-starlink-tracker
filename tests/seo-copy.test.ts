/**
 * SEO copy and routing defects found live in production:
 *  - "All 1 scheduled ABQ → PDX departures" on ~10% of route pages
 *  - "Enter a Alaska flight number" in the AS check-flight description
 *  - "Tracked Fleets Fleet Starlink Rollout" on the hub /fleet title
 *  - the hub homepage's only broken internal link (href="/route-planner",
 *    which 404s on the hub host)
 *  - /mcp answering 405 to any GET without Accept: text/html, despite being
 *    sitemap-advertised
 *  - /route-planner case/trailing-slash variants answering 200 instead of 301
 *  - ~43% of route pages leading with the 48h-window negative even when the
 *    route has durable history
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { routeVerdict } from "../src/components/route-page";
import { getSitemapRoutes } from "../src/database/database";
import type { RouteSummary } from "../src/database/database";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;
beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const AS = SITES.alaska.canonicalHost;

const summary = (over: Partial<RouteSummary>): RouteSummary => ({
  origin: "ABQ",
  destination: "PDX",
  flightNumbers: [],
  durationSec: null,
  equippedDepartures: 0,
  totalDepartures: 0,
  windowLabel: "next 48 hours",
  ...over,
});

describe("routeVerdict", () => {
  test("a single departure is never pluralized", () => {
    const one = summary({ totalDepartures: 1, equippedDepartures: 1 });
    expect(routeVerdict(one, "United Airlines")).toContain("The only scheduled");
    expect(routeVerdict(one, "United Airlines")).not.toContain("All 1");
    const none = summary({ totalDepartures: 1, equippedDepartures: 0 });
    expect(routeVerdict(none, "United Airlines")).toContain("is not on a Starlink-equipped");
    expect(routeVerdict(none, "United Airlines")).not.toContain("None of the 1");
  });

  test("an empty window with history leads with the history, not the negative", () => {
    const v = routeVerdict(
      summary({
        flightNumbers: [
          { flight_number: "UA123", times: 9, scheduled: 0 },
          { flight_number: "UA456", times: 3, scheduled: 0 },
        ],
      }),
      "United Airlines"
    );
    expect(v).toMatch(/^United Airlines flies ABQ → PDX/);
    expect(v).toContain("UA123");
    expect(v).not.toMatch(/^No United Airlines departures/);
  });

  test("an empty window with no history keeps the honest no-data copy", () => {
    expect(routeVerdict(summary({}), "United Airlines")).toMatch(/^No United Airlines departures/);
  });

  test("plural branches unchanged", () => {
    expect(
      routeVerdict(summary({ totalDepartures: 4, equippedDepartures: 4 }), "United Airlines")
    ).toContain("All 4 scheduled");
    expect(
      routeVerdict(summary({ totalDepartures: 4, equippedDepartures: 2 }), "United Airlines")
    ).toContain("2 of 4 scheduled");
  });
});

describe("page copy", () => {
  test("AS check-flight description uses 'an Alaska', not 'a Alaska'", async () => {
    const body = await (
      await app.dispatch(req("/check-flight", AS, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).not.toContain("Enter a Alaska");
    expect(body).toContain("Enter an Alaska");
  });

  test("hub /fleet title does not read 'Fleets Fleet'", async () => {
    const body = await (
      await app.dispatch(req("/fleet", HUB, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).not.toContain("Fleets Fleet");
    expect(body).not.toContain("every tracked airlines aircraft");
  });

  test("the hub homepage has no relative /route-planner link (it 404s there)", async () => {
    const body = await (
      await app.dispatch(req("/", HUB, { headers: { Accept: "text/html" } }))
    ).text();
    expect(body).not.toContain('href="/route-planner"');
  });
});

describe("/mcp content negotiation", () => {
  test("plain GET (curl, link checkers) gets the page, not 405", async () => {
    const res = await app.dispatch(req("/mcp", UA, { headers: { Accept: "*/*" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("an MCP-protocol GET still reaches the protocol handler", async () => {
    const res = await app.dispatch(req("/mcp", UA, { headers: { Accept: "text/event-stream" } }));
    expect((res.headers.get("content-type") ?? "").includes("text/html")).toBe(false);
  });
});

describe("/route-planner canonical spelling", () => {
  test("lowercase and trailing-slash variants 301 to the canonical form", async () => {
    const r = getSitemapRoutes(db, "UA")[0];
    const canonical = `https://${UA}/route-planner/${r.origin}/${r.destination}`;
    const lower = await app.dispatch(
      req(`/route-planner/${r.origin.toLowerCase()}/${r.destination.toLowerCase()}`, UA)
    );
    expect(lower.status).toBe(301);
    expect(lower.headers.get("location")).toBe(canonical);
    const slash = await app.dispatch(req(`/route-planner/${r.origin}/${r.destination}/`, UA));
    expect(slash.status).toBe(301);
    expect(slash.headers.get("location")).toBe(canonical);
  });

  test("the canonical spelling still renders 200 directly", async () => {
    const r = getSitemapRoutes(db, "UA")[0];
    const res = await app.dispatch(req(`/route-planner/${r.origin}/${r.destination}`, UA));
    expect(res.status).toBe(200);
  });
});
