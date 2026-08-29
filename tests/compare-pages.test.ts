/**
 * Hub /compare/{a}-vs-{b}: bounded to tracked-airline pairs in one canonical
 * slug order. Coverage derives from the registry (every enabled pair), shapes
 * only — counts come from the snapshot and must survive data drift.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES, airlineSlug, enabledAirlines } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

const hub = SITES.airline;
const get = (path: string, host: string) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

// Canonical pairs mirror app.ts comparePairs: enabled airlines, alphabetical
// by slug — a newly enabled airline is covered by construction.
function pairs() {
  const list = [...enabledAirlines()].sort((a, b) => airlineSlug(a).localeCompare(airlineSlug(b)));
  const out: Array<[(typeof list)[number], (typeof list)[number]]> = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  }
  return out;
}

describe("hub /compare/{a}-vs-{b}", () => {
  test("every canonical pair serves and names both airlines", async () => {
    for (const [a, b] of pairs()) {
      const path = `/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}`;
      const res = await get(path, hub.canonicalHost);
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, `${path} missing ${a.name}`).toContain(a.name);
      expect(body, `${path} missing ${b.name}`).toContain(b.name);
      // Both sides link down to their rollout detail pages.
      expect(body, path).toContain(`/airlines/${airlineSlug(a)}`);
      expect(body, path).toContain(`/airlines/${airlineSlug(b)}`);
    }
  });

  test("reverse order 301s to the canonical spelling", async () => {
    for (const [a, b] of pairs()) {
      const canonical = `/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}`;
      const res = await get(`/compare/${airlineSlug(b)}-vs-${airlineSlug(a)}`, hub.canonicalHost);
      expect(res.status, canonical).toBe(301);
      expect(res.headers.get("Location")).toBe(`https://${hub.canonicalHost}${canonical}`);
    }
  });

  test("case and trailing-slash variants 301 to the canonical spelling", async () => {
    const [a, b] = pairs()[0];
    const canonical = `https://${hub.canonicalHost}/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}`;
    for (const variant of [
      `/compare/${airlineSlug(a).toUpperCase()}-vs-${airlineSlug(b)}`,
      `/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}/`,
    ]) {
      const res = await get(variant, hub.canonicalHost);
      expect(res.status, variant).toBe(301);
      expect(res.headers.get("Location"), variant).toBe(canonical);
    }
  });

  test("unknown combos, self-pairs, and junk 404 — the space stays bounded", async () => {
    const first = airlineSlug(enabledAirlines()[0]);
    for (const path of [
      "/compare/delta-vs-united", // facts-only airline: no per-tail data, no page
      "/compare/ryanair-vs-united",
      `/compare/${first}-vs-${first}`,
      "/compare/united",
      "/compare/united-vs-alaska-vs-hawaiian",
      "/compare/united-vs-alaska/extra",
    ] as const) {
      const res = await get(path, hub.canonicalHost);
      expect(res.status, path).toBe(404);
    }
  });

  test("bare /compare 301s to the comparison index (/airlines)", async () => {
    for (const path of ["/compare", "/compare/"]) {
      const res = await get(path, hub.canonicalHost);
      expect(res.status, path).toBe(301);
      expect(res.headers.get("Location")).toBe(`https://${hub.canonicalHost}/airlines`);
    }
  });

  test("404s on every airline-scoped site (hub-only feature)", async () => {
    const [a, b] = pairs()[0];
    const path = `/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}`;
    for (const site of Object.values(SITES).filter((s) => s.scope !== "ALL")) {
      const res = await get(path, site.canonicalHost);
      expect(res.status, site.key).toBe(404);
      expect((await get("/compare", site.canonicalHost)).status, site.key).toBe(404);
    }
  });
});

describe("compare pages in meta surfaces", () => {
  test("hub sitemap advertises every canonical pair; airline sitemaps none", async () => {
    const xml = await (await get("/sitemap.xml", hub.canonicalHost)).text();
    for (const [a, b] of pairs()) {
      expect(xml).toContain(
        `<loc>https://${hub.canonicalHost}/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}</loc>`
      );
    }
    for (const site of Object.values(SITES).filter((s) => s.scope !== "ALL")) {
      const other = await (await get("/sitemap.xml", site.canonicalHost)).text();
      expect(other, site.key).not.toContain("/compare/");
    }
  });

  test("the /airlines index links every pair — no sitemap-only orphans", async () => {
    const body = await (await get("/airlines", hub.canonicalHost)).text();
    for (const [a, b] of pairs()) {
      expect(body, `${a.code}/${b.code}`).toContain(
        `/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}`
      );
    }
  });

  test("hub llms.txt links the head-to-head pages", async () => {
    const txt = await (await get("/llms.txt", hub.canonicalHost)).text();
    const [a, b] = pairs()[0];
    expect(txt).toContain(`/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}`);
  });
});
