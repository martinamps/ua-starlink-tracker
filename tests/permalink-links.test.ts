/**
 * Permalink link integrity against the real snapshot. Shape assertions only:
 * which flights and routes exist drifts with the data, but a rendered
 * /route-planner link must always resolve, and the sitemap must only list
 * flights that are scheduled or seen recently relative to the newest data.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SITEMAP_STALE_DAYS, getObservationAnchor } from "../src/database/database";
import { createReaderFactory } from "../src/database/reader";
import { metrics } from "../src/observability/metrics";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

const HOST = "unitedstarlinktracker.com";

describe("flight permalink route links", () => {
  let app: ReturnType<typeof createApp>;
  let reader: ReturnType<ReturnType<typeof createReaderFactory>>;
  beforeAll(() => {
    const db = openSnapshot();
    app = createApp(db);
    reader = createReaderFactory(db)("UA");
  });

  test("every /route-planner href on sampled sitemap permalinks serves 200", async () => {
    const sample = reader.getSitemapFlights().slice(0, 20);
    expect(sample.length).toBeGreaterThan(0);
    let checked = 0;
    for (const { flight_number } of sample) {
      const html = await (await app.dispatch(req(`/check-flight/${flight_number}`, HOST))).text();
      for (const m of html.matchAll(/href="(\/route-planner\/[A-Z0-9]{3,4}\/[A-Z0-9]{3,4})"/g)) {
        const res = await app.dispatch(req(m[1], HOST));
        expect(res.status, `${flight_number} → ${m[1]}`).toBe(200);
        checked++;
        const page = await res.text();
        for (const rev of page.matchAll(/href="(\/route-planner\/[A-Z0-9]{3}\/[A-Z0-9]{3})"/g)) {
          expect((await app.dispatch(req(rev[1], HOST))).status, `${m[1]} → ${rev[1]}`).toBe(200);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("sitemap staleness", () => {
  test("every sitemap flight is scheduled or seen within SITEMAP_STALE_DAYS of the anchor", () => {
    const db = openSnapshot();
    const reader = createReaderFactory(db)("UA");
    const anchor = getObservationAnchor(db, "UA");
    expect(anchor).toBeGreaterThan(0);
    const scheduled = new Set(
      (
        db
          .query("SELECT DISTINCT flight_number FROM upcoming_flights WHERE airline = 'UA'")
          .all() as { flight_number: string }[]
      ).map((r) => r.flight_number.replace(/^(UA|UAL)0*/, "UA"))
    );
    const cutoff = anchor - SITEMAP_STALE_DAYS * 86400;
    for (const f of reader.getSitemapFlights()) {
      if (scheduled.has(f.flight_number) || f.last_touched === 0) continue;
      expect(f.last_touched, f.flight_number).toBeGreaterThanOrEqual(cutoff);
    }
  });
});

describe("http.request airline tag", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  test("a /route-planner 404 is tagged with the site's airline", async () => {
    const app = createApp(openSnapshot());
    const calls: Array<{ name: string; tags: Record<string, unknown> }> = [];
    const original = metrics.increment;
    metrics.increment = (name, tags) => {
      calls.push({ name, tags: (tags ?? {}) as Record<string, unknown> });
      original(name, tags);
    };
    restore = () => {
      metrics.increment = original;
    };
    const res = await app.dispatch(req("/route-planner/ZZZ/QQQ", HOST));
    expect(res.status).toBe(404);
    const http = calls.filter((c) => c.name === "http.request");
    expect(http.length).toBe(1);
    expect(http[0].tags.airline).toBe("united");
  });
});

describe("permalink-only readers", () => {
  // One sanctioned reader: lookupFlightRoutes' L4 stale fallback, which wants
  // the tenant-scoped pairs (never Alaska's OO rows on a UA answer) and marks
  // the result stale. Any other API/MCP use needs a deliberate exemption here.
  const ROUTE_PAIR_READERS: Record<string, number> = { "mcp-server.ts": 1 };

  test("only sanctioned API readers use getFlightRoutePairs; none use flightNumberHasData", () => {
    const apiDir = join(import.meta.dir, "..", "src", "api");
    for (const f of readdirSync(apiDir).filter((n) => /\.tsx?$/.test(n))) {
      const src = readFileSync(join(apiDir, f), "utf8");
      const pairReads = src.split("getFlightRoutePairs").length - 1;
      expect(pairReads, f).toBe(ROUTE_PAIR_READERS[f] ?? 0);
      expect(src.includes("flightNumberHasData"), f).toBe(false);
    }
  });
});

describe("aircraft-type page links", () => {
  const LINK_RE = /href="(\/(?:fleet|route-planner|check-flight)(?:\/[^"#?]*)?)(#t-[^"]+)?"/g;

  test("/fleet, every type page and sampled permalinks link only to URLs that serve", async () => {
    const db = openSnapshot();
    const app = createApp(db);
    const reader = createReaderFactory(db)("UA");
    const fleetHtml = await (await app.dispatch(req("/fleet", HOST))).text();
    const tailIds = new Set([...fleetHtml.matchAll(/id="t-([^"]+)"/g)].map((m) => m[1]));
    const typePages = [
      ...new Set([...fleetHtml.matchAll(/href="(\/fleet\/[a-z0-9-]+)"/g)].map((m) => m[1])),
    ];
    expect(typePages.length).toBeGreaterThan(0);
    const pages = [
      "/fleet",
      ...typePages,
      ...reader
        .getSitemapFlights()
        .slice(0, 25)
        .map((f) => `/check-flight/${f.flight_number}`),
    ];
    const status = new Map<string, number>();
    let anchors = 0;
    for (const page of pages) {
      // Rendered anchors only — inline scripts build hrefs from user input.
      const html = (
        page === "/fleet" ? fleetHtml : await (await app.dispatch(req(page, HOST))).text()
      ).replace(/<script[\s\S]*?<\/script>/g, "");
      const typeLinks = new Map<string, number>();
      for (const [, href, anchor] of html.matchAll(LINK_RE)) {
        if (anchor) {
          expect(href, `${page}: tail anchor base`).toBe("/fleet");
          expect(tailIds.has(anchor.slice(3)), `${page} → ${href}${anchor}`).toBe(true);
          anchors++;
          continue;
        }
        if (!status.has(href)) status.set(href, (await app.dispatch(req(href, HOST))).status);
        expect(status.get(href), `${page} → ${href}`).toBe(200);
        if (/^\/fleet\/[a-z0-9-]+$/.test(href)) typeLinks.set(href, (typeLinks.get(href) ?? 0) + 1);
      }
      if (page.startsWith("/check-flight/")) {
        for (const [href, n] of typeLinks) expect(n, `${page} links ${href} ${n}×`).toBe(1);
      }
    }
    expect(anchors).toBeGreaterThan(0);
  });
});
