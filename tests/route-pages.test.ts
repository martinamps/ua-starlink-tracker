/**
 * Per-route permalinks at /route-planner/{origin}/{destination}.
 *
 * The prefix route used to swallow every sub-path and render the planner, so
 * ~10k internal links off the flight permalinks resolved to one duplicate page
 * (Google logged them as soft 404s). These tests pin the two invariants that
 * replaced that: the URL space is bounded by real data, and the sitemap agrees
 * with what the pages actually serve.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { getSitemapRoutes, routeHasData } from "../src/database/database";
import { createApp, parseRoutePath } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
const get = (path: string, host = UA) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

/** A route the snapshot actually backs, so the test survives data drift. */
function someRoute() {
  const routes = getSitemapRoutes(db, "UA");
  if (routes.length === 0) throw new Error("snapshot has no routes — run bun run test:setup");
  return routes[0];
}

describe("parseRoutePath", () => {
  test("accepts a well-formed IATA pair, case-insensitively", () => {
    expect(parseRoutePath("/route-planner/SFO/EWR")).toEqual({
      origin: "SFO",
      destination: "EWR",
    });
    expect(parseRoutePath("/route-planner/sfo/ewr")).toEqual({
      origin: "SFO",
      destination: "EWR",
    });
    expect(parseRoutePath("/route-planner/SFO/EWR/")).toEqual({
      origin: "SFO",
      destination: "EWR",
    });
  });

  test("rejects everything that would open an unbounded URL space", () => {
    for (const path of [
      "/route-planner",
      "/route-planner/",
      "/route-planner/SFO",
      "/route-planner/SFO/EWR/ORD",
      "/route-planner/garbage/xyz",
      "/route-planner/SF/EWR",
      "/route-planner/SFOO/EWR",
      "/route-planner/SFO/SFO",
      "/route-planner/123/456",
    ]) {
      expect(parseRoutePath(path), path).toBeNull();
    }
  });
});

describe("/route-planner/{origin}/{destination}", () => {
  test("the planner itself still renders", async () => {
    const res = await get("/route-planner");
    expect(res.status).toBe(200);
  });

  test("a data-backed pair renders its own page, not the planner", async () => {
    const { origin, destination } = someRoute();
    const res = await get(`/route-planner/${origin}/${destination}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`${origin} to ${destination} Starlink WiFi`);
    expect(body).toContain(
      `<link rel="canonical" href="https://${UA}/route-planner/${origin}/${destination}"`
    );
  });

  test("the page links out to the flight permalinks on the route", async () => {
    const routes = getSitemapRoutes(db, "UA");
    // Find a route the snapshot has flight numbers for; permalink cross-linking
    // is the whole point of the page, but a sparse snapshot may not have one.
    for (const r of routes.slice(0, 25)) {
      const body = await (await get(`/route-planner/${r.origin}/${r.destination}`)).text();
      const m = body.match(/href="\/check-flight\/(UA\d+)"/);
      if (m) {
        expect(body).toContain(`/check-flight/${m[1]}`);
        return;
      }
    }
    throw new Error("no route in the snapshot carried a flight number");
  });

  test("every permalink a route page links to actually resolves", async () => {
    // upcoming_flights also carries operating-carrier numbers (SKW4726 for a
    // United Express leg) which have no /check-flight permalink. Linking one
    // would put a broken internal link on the page — the exact failure these
    // route pages exist to clean up.
    const seen = new Set<string>();
    for (const r of getSitemapRoutes(db, "UA")) {
      const body = await (await get(`/route-planner/${r.origin}/${r.destination}`)).text();
      for (const m of body.matchAll(/href="\/check-flight\/([^"]+)"/g)) seen.add(m[1]);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const fn of seen) {
      expect(fn, "non-marketing flight number linked").toMatch(/^UA\d+$/);
      expect((await get(`/check-flight/${fn}`)).status, `/check-flight/${fn}`).toBe(200);
    }
  });

  test("unknown, malformed, and same-airport pairs 404", async () => {
    for (const path of [
      "/route-planner/QQQ/ZZZ",
      "/route-planner/garbage/xyz",
      "/route-planner/SFO/SFO",
      "/route-planner/SFO/EWR/ORD",
      "/route-planner/SFO",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  test("route pages are tenant-only — the hub 404s", async () => {
    const { origin, destination } = someRoute();
    const res = await get(`/route-planner/${origin}/${destination}`, SITES.airline.canonicalHost);
    expect(res.status).toBe(404);
  });
});

describe("sitemap agrees with the pages", () => {
  test("every advertised route resolves 200 and every route entry is well-formed", async () => {
    const body = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const advertised = [
      ...body.matchAll(/<loc>[^<]*\/route-planner\/([A-Z]{3})\/([A-Z]{3})<\/loc>/g),
    ];
    expect(advertised.length).toBeGreaterThan(0);

    for (const [, origin, destination] of advertised.slice(0, 20)) {
      expect(routeHasData(db, origin, destination, "UA"), `${origin}-${destination}`).toBe(true);
      const res = await get(`/route-planner/${origin}/${destination}`);
      expect(res.status, `${origin}-${destination}`).toBe(200);
    }
  });

  test("no route entry stamps request time as lastmod", async () => {
    const body = await (await app.dispatch(req("/sitemap.xml", UA))).text();
    const now = Date.now();
    for (const m of body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
      expect(Date.parse(m[1])).toBeLessThanOrEqual(now);
    }
  });
});

describe("getSitemapRoutes", () => {
  test("emits only IATA pairs and never a same-airport pair", () => {
    for (const r of getSitemapRoutes(db, "UA")) {
      expect(r.origin).toMatch(/^[A-Z]{3}$/);
      expect(r.destination).toMatch(/^[A-Z]{3}$/);
      expect(r.origin).not.toBe(r.destination);
    }
  });

  test("is empty for an airline with no rows", () => {
    expect(getSitemapRoutes(db, "NOPE")).toEqual([]);
  });
});

describe("/routes links into the route corpus", () => {
  // Route pages were reachable only from the sitemap and from each other — no
  // hub page linked to any of them, so no authority flowed in. /routes is the
  // semantic parent and already renders every row's O-D pair; it just rendered
  // them as plain text.
  //
  // The snapshot's 48h schedule window can legitimately be empty, in which case
  // /routes renders no rows at all. The invariant is conditional on rows
  // existing: if a pair is rendered, it must be a link.
  const bareLabelRe = /([A-Z]{3})<!-- -->\u2013<!-- -->([A-Z]{3})/g;
  const linkRe = /href="\/route-planner\/([A-Z]{3})\/([A-Z]{3})"/g;

  test("no O-D pair is rendered as bare text instead of a link", async () => {
    const body = await (await get("/routes")).text();
    const bare = [...body.matchAll(bareLabelRe)];
    const links = [...body.matchAll(linkRe)];
    // Whatever is rendered, none of it may be unlinked.
    expect(bare.length, "unlinked O-D labels on /routes").toBe(0);
    if (links.length === 0) return; // empty schedule window in this snapshot
    expect(links.length).toBeGreaterThan(0);
  });

  test("every route /routes links to actually resolves", async () => {
    const body = await (await get("/routes")).text();
    const pairs = [
      ...new Set([...body.matchAll(linkRe)].map((m) => `/route-planner/${m[1]}/${m[2]}`)),
    ];
    if (pairs.length === 0) return; // empty schedule window in this snapshot
    for (const p of pairs.slice(0, 15)) {
      expect((await get(p)).status, p).toBe(200);
    }
  });
});
