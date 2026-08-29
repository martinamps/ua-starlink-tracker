/**
 * /rankings — bounded leaderboard pages, plus the pagination they share with
 * /api/routes.
 *
 * The slug set is static per airline, so the URL space can't grow with the
 * data; on top of that each board is gated on having rows *right now*, and the
 * sitemap applies the same test. The snapshot's departure window is normally
 * empty (its rows are historical), so the live-data half runs against a
 * synthetic DB seeded inside the window — otherwise these tests would pass by
 * asserting nothing.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIRLINES, SITES } from "../src/airlines/registry";
import type { RouteLeaderboardRow } from "../src/database/database";
import { createApp } from "../src/server/app";
import { leaderboardDefs } from "../src/server/rankings";
import { addFlight, addPlane, makeSyntheticDb, openSnapshot, req } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;

const row = (
  origin: string,
  destination: string,
  departures: number,
  equipped: number
): RouteLeaderboardRow => ({
  origin,
  destination,
  departures,
  equipped,
  flight_numbers: departures,
  next_departure: 1_800_000_000,
});

describe("leaderboardDefs", () => {
  const defs = leaderboardDefs(AIRLINES.UA);

  test("slugs are unique, lowercase and URL-safe — the URL space is static", () => {
    const slugs = defs.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
    // One board per hub, plus the two network-wide boards.
    expect(defs.length).toBe(AIRLINES.UA.hubAirports.length + 2);
  });

  test("every board carries the copy the page and its meta need", () => {
    for (const d of defs) {
      for (const field of [d.heading, d.metaTitle, d.metaDescription, d.lede, d.note]) {
        expect(field.length, d.slug).toBeGreaterThan(10);
      }
    }
  });

  test("the 100% board claims only what the counts support", () => {
    const select = defs.find((d) => d.slug === "100-percent-starlink-routes")?.select;
    if (!select) throw new Error("100% board missing");
    const picked = select([
      row("EWR", "SFO", 4, 4), // qualifies
      row("ORD", "DEN", 3, 2), // partial — the claim would be false
      row("IAH", "AUS", 1, 1), // 1-for-1 says more about the schedule
      row("LAX", "LAX", 2, 2), // self-pair, corrupt row
      row("DEN", "IAH", 2, 0), // nothing equipped
    ]).map((r) => `${r.origin}-${r.destination}`);
    expect(picked).toEqual(["EWR-SFO"]);
  });

  test("the transcon board is coast-to-coast in both directions only", () => {
    const select = defs.find((d) => d.slug === "best-transcon-starlink-routes")?.select;
    if (!select) throw new Error("transcon board missing");
    const picked = select([
      row("EWR", "SFO", 4, 4),
      row("LAX", "JFK", 3, 2), // west → east counts too
      row("ORD", "DEN", 5, 5), // not a coast pair
      row("BOS", "LGA", 5, 5), // both east
      row("IAD", "SEA", 2, 0), // coast pair with nothing equipped
    ]).map((r) => `${r.origin}-${r.destination}`);
    expect(picked.sort()).toEqual(["EWR-SFO", "LAX-JFK"]);
  });

  test("a hub board is that hub's departures only", () => {
    const select = defs.find((d) => d.slug === "hub-ewr")?.select;
    if (!select) throw new Error("hub-EWR board missing");
    const picked = select([
      row("EWR", "SFO", 4, 4),
      row("EWR", "BOS", 2, 1),
      row("SFO", "EWR", 4, 4), // arrivals into the hub are a different page
      row("ORD", "DEN", 4, 4),
    ]).map((r) => `${r.origin}-${r.destination}`);
    expect(picked).toEqual(["EWR-SFO", "EWR-BOS"]);
  });

  test("every board is row-capped and reports a sane share", () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      row("EWR", `A${String(i).padStart(2, "0")}`.slice(0, 3), 4, 4)
    );
    for (const d of defs) {
      const picked = d.select(many);
      expect(picked.length, d.slug).toBeLessThanOrEqual(100);
      for (const r of picked) {
        expect(r.pct).toBeGreaterThanOrEqual(0);
        expect(r.pct).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("/rankings against an empty schedule window", () => {
  let app: ReturnType<typeof createApp>;
  let db: Database;

  beforeAll(() => {
    db = openSnapshot();
    app = createApp(db);
  });
  afterAll(() => db.close());

  const get = (path: string, host = UA) =>
    app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

  test("the index still renders — it carries the empty story", async () => {
    expect((await get("/rankings")).status).toBe(200);
  });

  test("a board with no rows 404s rather than serving a thin page", async () => {
    // Whatever the snapshot holds, index links and resolving pages agree.
    const body = await (await get("/rankings")).text();
    const linked = [...body.matchAll(/href="\/rankings\/([a-z0-9-]+)"/g)].map((m) => m[1]);
    for (const d of leaderboardDefs(AIRLINES.UA)) {
      const expected = linked.includes(d.slug) ? 200 : 404;
      expect((await get(`/rankings/${d.slug}`)).status, d.slug).toBe(expected);
    }
  });

  test("unknown slugs and the bare prefix never open a new URL space", async () => {
    expect((await get("/rankings/nope")).status).toBe(404);
    expect((await get("/rankings/hub-zzz")).status).toBe(404);
    const bare = await get("/rankings/");
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe(`https://${UA}/rankings`);
  });

  test("the hub has no rankings pages", async () => {
    expect((await get("/rankings", HUB)).status).toBe(404);
    expect((await get("/rankings/hub-ewr", HUB)).status).toBe(404);
  });
});

describe("/rankings against a live schedule window", () => {
  let app: ReturnType<typeof createApp>;
  let db: Database;

  beforeAll(() => {
    db = makeSyntheticDb();
    const soon = Math.floor(Date.now() / 1000) + 3600;
    // Equipped tails carry a starlink_planes row; bare tails don't, which is
    // exactly how an unequipped departure looks in the live data.
    addPlane(db, "N1EQ", "Starlink");
    addPlane(db, "N2EQ", "Starlink");
    const seed: Array<[string, string, string, string]> = [
      ["N1EQ", "UA9101", "EWR", "SFO"],
      ["N2EQ", "UA9102", "EWR", "SFO"],
      ["N1EQ", "UA9103", "EWR", "ORD"],
      ["N9NO", "UA9104", "EWR", "ORD"],
      ["N1EQ", "UA9105", "LAX", "JFK"],
      ["N2EQ", "UA9106", "LAX", "JFK"],
      ["N9NO", "UA9107", "MCO", "MIA"],
      ["N9NO", "UA9108", "MCO", "MIA"],
    ];
    seed.forEach(([tail, flight, origin, destination], i) =>
      addFlight(db, tail, flight, origin, soon + i * 60, { arrivalAirport: destination })
    );
    app = createApp(db);
  });
  afterAll(() => db.close());

  const get = (path: string) => app.dispatch(req(path, UA, { headers: { Accept: "text/html" } }));

  test("boards with rows resolve; boards without still 404", async () => {
    expect((await get("/rankings/100-percent-starlink-routes")).status).toBe(200);
    expect((await get("/rankings/hub-ewr")).status).toBe(200);
    expect((await get("/rankings/best-transcon-starlink-routes")).status).toBe(200);
    // No departures from these hubs in the fixture.
    expect((await get("/rankings/hub-iad")).status).toBe(404);
    expect((await get("/rankings/hub-den")).status).toBe(404);
  });

  test("a board only lists routes its own claim covers", async () => {
    const body = await (await get("/rankings/100-percent-starlink-routes")).text();
    const pairs = [...body.matchAll(/href="\/route-planner\/([A-Z]{3})\/([A-Z]{3})"/g)].map(
      (m) => `${m[1]}-${m[2]}`
    );
    // EWR-ORD is half-equipped and MCO-MIA has none: neither is 100%.
    expect(pairs.sort()).toEqual(["EWR-SFO", "LAX-JFK"]);
  });

  test("case variants 301 to the canonical slug", async () => {
    const res = await get("/rankings/HUB-EWR");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://${UA}/rankings/hub-ewr`);
  });

  test("sitemap advertises exactly the boards that resolve", async () => {
    const body = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const advertised = [...body.matchAll(/<loc>[^<]*\/rankings\/([a-z0-9-]+)<\/loc>/g)].map(
      (m) => m[1]
    );
    expect(advertised.length).toBeGreaterThan(0);
    expect(new Set(advertised).size).toBe(advertised.length);
    for (const slug of advertised) {
      expect((await get(`/rankings/${slug}`)).status, slug).toBe(200);
    }
    const unadvertised = leaderboardDefs(AIRLINES.UA)
      .map((d) => d.slug)
      .filter((s) => !advertised.includes(s));
    for (const slug of unadvertised) {
      expect((await get(`/rankings/${slug}`)).status, slug).toBe(404);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/routes pagination — additive params on a frozen response shape
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/routes pagination", () => {
  let app: ReturnType<typeof createApp>;
  let db: Database;

  beforeAll(() => {
    db = makeSyntheticDb();
    const soon = Math.floor(Date.now() / 1000) + 3600;
    addPlane(db, "N1EQ", "Starlink");
    for (let i = 0; i < 8; i++) {
      addFlight(db, "N1EQ", `UA92${String(i).padStart(2, "0")}`, "EWR", soon + i * 60, {
        arrivalAirport: `X${String.fromCharCode(65 + i)}Y`,
      });
    }
    app = createApp(db);
  });
  afterAll(() => db.close());

  const routes = async (query = "") => {
    const res = await app.dispatch(req(`/api/routes${query}`, UA));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      rows: Array<{ origin: string; destination: string }>;
      totalDepartures: number;
      totalRoutes: number;
      windowLabel: string;
    };
  };

  test("no params keeps the original page, now with a route denominator", async () => {
    const body = await routes();
    expect(body.rows.length).toBe(8);
    expect(body.rows.length).toBeLessThanOrEqual(60);
    expect(body.totalDepartures).toBe(8);
    expect(body.totalRoutes).toBe(8);
    expect(typeof body.windowLabel).toBe("string");
  });

  test("limit and offset page through the same ordering without overlap", async () => {
    const first = await routes("?limit=3");
    const second = await routes("?limit=3&offset=3");
    expect(first.rows.length).toBe(3);
    expect(second.rows.length).toBe(3);
    const key = (r: { origin: string; destination: string }) => `${r.origin}-${r.destination}`;
    expect(first.rows.map(key).some((k) => second.rows.map(key).includes(k))).toBe(false);
    // Totals are window-wide, so they must not move as the reader pages.
    expect(second.totalDepartures).toBe(first.totalDepartures);
    expect(second.totalRoutes).toBe(first.totalRoutes);
  });

  test("hostile params stay inside the cap, never a full-table dump", async () => {
    for (const q of ["?limit=abc", "?limit=-5", "?offset=-10", "?limit=0", "?limit=999999"]) {
      const body = await routes(q);
      expect(body.rows.length, q).toBeGreaterThan(0);
      expect(body.rows.length, q).toBeLessThanOrEqual(200);
    }
    // Past the end is an empty page, not an error.
    expect((await routes("?offset=500")).rows.length).toBe(0);
  });
});
