/**
 * Hub /compare/{a}-vs-{b}: bounded to pairs where BOTH sides have real per-tail
 * data, in one canonical slug order. Coverage derives from the registry's hub
 * content population filtered by that same data gate, so a newly enabled
 * airline is covered by construction — and stays 404 until it has tails.
 * Shapes only; counts come from the snapshot and must survive data drift.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  type AirlineConfig,
  SITES,
  airlineSlug,
  hubContentAirlines,
  wifiPhaseFamilies,
} from "../src/airlines/registry";
import { createReaderFactory } from "../src/database/reader";
import { createApp } from "../src/server/app";
import { makeSyntheticDb, openSnapshot, req } from "./helpers";

let app: ReturnType<typeof createApp>;
let comparable: AirlineConfig[];

beforeAll(() => {
  const db = openSnapshot();
  app = createApp(db);
  const getReader = createReaderFactory(db);
  // Mirrors app.ts compareAirlines: a pair page exists only where BOTH sides
  // have real rows, so the expected URL space is read off the same data the
  // app reads rather than off `enabled`.
  comparable = hubContentAirlines().filter(
    (cfg) => (getReader(cfg.code).getPerAirlineStats()[0]?.total ?? 0) > 0
  );
});

const hub = SITES.airline;
const get = (path: string, host: string) =>
  app.dispatch(req(path, host, { headers: { Accept: "text/html" } }));

/** Canonical pairs, alphabetical by slug — mirrors app.ts comparePairs. */
function pairs() {
  const list = [...comparable].sort((a, b) => airlineSlug(a).localeCompare(airlineSlug(b)));
  const out: Array<[AirlineConfig, AirlineConfig]> = [];
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

  // A type-determined program's full-fleet denominator counts families the
  // program excludes by design, so a blended "x% of fleet" is wrong for every
  // passenger on it. Those airlines publish the per-type table INSTEAD — on
  // the compare panel and on their own /airlines page.
  test("type-determined programs publish a per-type table, never a blended percentage", async () => {
    const isTyped = (cfg: { code: string }) => Boolean(wifiPhaseFamilies(cfg.code));
    const typed = comparable.filter(isTyped);
    expect(typed.length, "no type-determined airline to exercise").toBeGreaterThan(0);

    // "% of fleet" appears only in the blended stat block, once per side that
    // prints one. A typed side must never contribute one, so the count can
    // never exceed the number of untyped sides on the page.
    const blendedCount = (body: string) => body.split("% of fleet").length - 1;

    for (const cfg of typed) {
      const families = Object.keys(wifiPhaseFamilies(cfg.code) as Record<string, unknown>).filter(
        (f) => !f.endsWith("F")
      );
      const surfaces: Array<{ path: string; sides: Array<{ code: string }> }> = [
        { path: `/airlines/${airlineSlug(cfg)}`, sides: [cfg] },
        ...pairs()
          .filter(([a, b]) => a === cfg || b === cfg)
          .map(([a, b]) => ({
            path: `/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}`,
            sides: [a, b],
          })),
      ];
      for (const { path, sides } of surfaces) {
        const body = await (await get(path, hub.canonicalHost)).text();
        expect(body, `${path} missing per-type table`).toContain("By aircraft type");
        for (const family of families) {
          expect(body, `${path} missing family ${family}`).toContain(family);
        }
        expect(blendedCount(body), `${path} blends a type-determined fleet`).toBeLessThanOrEqual(
          sides.filter((s) => !isTyped(s)).length
        );
      }
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
    const first = airlineSlug(comparable[0]);
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

  // The gate that keeps this family bounded, exercised against a database with
  // no tails at all — the state a newly enabled airline is in on day one.
  // Without the gate, `enabled` alone minted a page per pair (O(n²) of them),
  // each advertised in the sitemap and llms.txt with nothing behind it.
  test("an airline with no tail data mints no pair pages, links, or sitemap entries", async () => {
    const empty = createApp(makeSyntheticDb());
    const emptyGet = (path: string) =>
      empty.dispatch(req(path, hub.canonicalHost, { headers: { Accept: "text/html" } }));

    const [a, b] = pairs()[0];
    const path = `/compare/${airlineSlug(a)}-vs-${airlineSlug(b)}`;
    expect((await emptyGet(path)).status, `${path} served with no data behind it`).toBe(404);

    const xml = await (await emptyGet("/sitemap.xml")).text();
    expect(xml, "sitemap advertises a data-less pair").not.toContain("/compare/");
    const txt = await (await emptyGet("/llms.txt")).text();
    expect(txt, "llms.txt advertises a data-less pair").not.toContain("/compare/");
    const index = await (await emptyGet("/airlines")).text();
    expect(index, "/airlines links a data-less pair").not.toContain("/compare/");
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
