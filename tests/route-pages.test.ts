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
import {
  CANONICAL_FLIGHT_PERMALINK,
  buildFlightLookupVariants,
} from "../src/airlines/flight-number";
import { AIRLINES, SITES } from "../src/airlines/registry";
import { getRouteSummary, getSitemapRoutes, routeHasData } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { createApp, parseRoutePath } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

/** Route pages actually rendered by the link sweep; the rest is DB-checked. */
const ROUTE_PAGE_SAMPLE = 40;

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openSnapshot>;

beforeAll(() => {
  db = openSnapshot();
  app = createApp(db);
});

const UA = SITES.united.canonicalHost;
// x-forwarded-for localhost: /check-flight/{fn} is a metered page surface and
// the sweeps below exceed the per-IP page budget, so an unidentified client
// would collect 429s instead of the statuses under test.
const get = (path: string, host = UA) =>
  app.dispatch(
    req(path, host, { headers: { Accept: "text/html", "x-forwarded-for": "127.0.0.1" } })
  );

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

  // The exhaustive half of the link check above. Rendering all 2,200 route
  // pages is too slow to do per-run, but the flight numbers each page links to
  // come straight out of getRouteSummary, so the same invariant can be pinned
  // over EVERY route in the corpus purely against the DB — shape the router
  // accepts, plus a row behind it. This is what catches a single bad link on a
  // route the render sample happens to skip.
  test("no route in the corpus would link a permalink the router rejects", () => {
    const cfg = AIRLINES.UA;
    const reader = createReaderFactory(db)("UA");
    // flight number → the first route page that links it, for the message.
    const linked = new Map<string, string>();
    for (const r of getSitemapRoutes(db, "UA")) {
      const page = `/route-planner/${r.origin}/${r.destination}`;
      for (const f of getRouteSummary(db, r.origin, r.destination, "UA").flightNumbers) {
        expect(f.flight_number, page).toMatch(CANONICAL_FLIGHT_PERMALINK);
        if (!linked.has(f.flight_number)) linked.set(f.flight_number, page);
      }
    }
    expect(linked.size, "no route page links any flight number").toBeGreaterThan(0);
    for (const [fn, page] of linked) {
      expect(
        reader.flightNumberHasData(buildFlightLookupVariants(cfg, fn)),
        `${page} links ${fn} with no data behind it`
      ).toBe(true);
    }
  }, 60_000);

  test("every permalink a route page links to actually resolves", async () => {
    // upcoming_flights also carries operating-carrier numbers (SKW4726 for a
    // United Express leg) which have no /check-flight permalink. Linking one
    // would put a broken internal link on the page — the exact failure these
    // route pages exist to clean up.
    //
    // 2,200 route pages × ~6ms each plus ~4,500 distinct permalinks is a
    // ~40s sweep that only grows with the corpus, so the route pages are
    // sampled by a fixed stride (never at random: a failure must name a URL
    // the next run visits again). The permalinks harvested from that sample
    // are then checked exhaustively — that is the assertion with the teeth.
    const routes = getSitemapRoutes(db, "UA");
    const stride = Math.max(1, Math.ceil(routes.length / ROUTE_PAGE_SAMPLE));
    const sampled = routes.filter((_, i) => i % stride === 0);
    const seen = new Set<string>();
    for (const r of sampled) {
      const body = await (await get(`/route-planner/${r.origin}/${r.destination}`)).text();
      for (const m of body.matchAll(/href="\/check-flight\/([^"]+)"/g)) seen.add(m[1]);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const fn of seen) {
      // The permalink router's own shape. `UA\d+` would accept UA63986, a
      // 5-digit number the router 404s — the shape check has to be the one
      // the router applies, or it cannot catch the link it was written for.
      expect(fn, "non-marketing flight number linked").toMatch(CANONICAL_FLIGHT_PERMALINK);
      expect((await get(`/check-flight/${fn}`)).status, `/check-flight/${fn}`).toBe(200);
    }
  }, 60_000);

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
    const links = [...body.matchAll(linkRe)];
    // A correctly linked pair renders the SAME "ORD<!-- -->–<!-- -->DEN" text,
    // just inside the anchor, so the label pattern has to be looked for in
    // what is left AFTER anchors are removed or every good row reads as a
    // violation. This is why the assertion has to strip first, not just count.
    const outsideLinks = body.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, "");
    const bare = [...outsideLinks.matchAll(bareLabelRe)];
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
