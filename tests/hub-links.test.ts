/**
 * Internal linking. Most hub sitemap URLs (every /compare/* page, most
 * /airlines/*) were discovered but never crawled because nothing on the hub
 * homepage linked them; the bare /route-planner and most subpages linked to few
 * permalinks and had no site-wide nav.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot } from "./helpers";

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

async function sitemapPaths(host: string): Promise<string[]> {
  const { text } = await bodyOf(app, "/sitemap.xml", host);
  return [...text.matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)].map((m) => m[1] || "/");
}

const hrefs = (html: string) => new Set([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));

describe("hub homepage", () => {
  test("links every sitemapped /airlines/* and /compare/* URL", async () => {
    const targets = (await sitemapPaths(HUB)).filter((p) => /^\/(airlines|compare)\/./.test(p));
    expect(targets.some((p) => p.startsWith("/airlines/"))).toBe(true);
    expect(targets.some((p) => p.startsWith("/compare/"))).toBe(true);
    const { status, text } = await bodyOf(app, "/", HUB);
    expect(status).toBe(200);
    const links = hrefs(text);
    expect(targets.filter((p) => !links.has(p))).toEqual([]);
  });

  test("carriers with a live tracker link to their brand host", async () => {
    const links = hrefs((await bodyOf(app, "/", HUB)).text);
    expect(links.has(`https://${SITES.united.canonicalHost}/`)).toBe(true);
    expect(links.has(`https://${SITES.alaska.canonicalHost}/`)).toBe(true);
  });

  test("every grid link serves", async () => {
    const { text } = await bodyOf(app, "/", HUB);
    const grid = text.slice(text.indexOf('aria-label="Airlines"'));
    const local = [...hrefs(grid.slice(0, grid.indexOf("</nav>")))].filter((h) =>
      h.startsWith("/")
    );
    expect(local.length).toBeGreaterThan(0);
    for (const h of local)
      expect({ h, status: (await bodyOf(app, h, HUB)).status }).toEqual({ h, status: 200 });
  });
});

describe("route planner", () => {
  test("server-renders at least 30 route permalinks, each of which serves", async () => {
    const { text } = await bodyOf(app, "/route-planner", UA);
    const routes = [...hrefs(text)].filter((h) => /^\/route-planner\/[A-Z]{3}\/[A-Z]{3}$/.test(h));
    expect(routes.length).toBeGreaterThanOrEqual(30);
    const sitemap = new Set(await sitemapPaths(UA));
    expect(routes.filter((r) => !sitemap.has(r))).toEqual([]);
  });
});

describe("footer nav", () => {
  const NAV = ["/check-flight", "/route-planner", "/routes", "/fleet", "/timeline", "/methodology"];

  test("each enabled nav page links to every other one", async () => {
    const sitemap = new Set(await sitemapPaths(UA));
    const enabled = NAV.filter((p) => sitemap.has(p));
    expect(enabled.length).toBeGreaterThan(2);
    for (const page of enabled) {
      const { status, text } = await bodyOf(app, page, UA);
      expect(status).toBe(200);
      const links = hrefs(text);
      const missing = enabled.filter((other) => other !== page && !links.has(other));
      expect({ page, missing }).toEqual({ page, missing: [] });
    }
  });

  test("the hub never links a tool page it 404s", async () => {
    const links = hrefs((await bodyOf(app, "/", HUB)).text);
    for (const p of ["/check-flight", "/route-planner", "/routes"]) {
      if (links.has(p)) expect((await bodyOf(app, p, HUB)).status).toBe(200);
    }
  });
});
