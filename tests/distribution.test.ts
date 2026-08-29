/**
 * Distribution surfaces: the newly-equipped Atom feed and page. Shape
 * assertions only — entry counts and dates ride the live snapshot and must
 * survive data drift.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot, req } from "./helpers";

// (SITES is iterated for the badge sweep; tenant pages are covered by the
// tenant-matrix ROUTES table.)

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(openSnapshot());
});

const UA = SITES.united.canonicalHost;
const HUB = SITES.airline.canonicalHost;
const QR = SITES.qatar.canonicalHost;

// ─────────────────────────────────────────────────────────────────────────────
// /feed.xml — newly-equipped Atom feed
// ─────────────────────────────────────────────────────────────────────────────

describe("newly-equipped Atom feed", () => {
  test("UA host serves valid Atom shape with entries", async () => {
    const res = await app.dispatch(req("/feed.xml", UA));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/atom+xml");
    expect(res.headers.get("Cache-Control")).toContain("public");
    const xml = await res.text();
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(`<link href="https://${UA}/feed.xml" rel="self"/>`);
    // Snapshot always carries organic UA installs (sheet-scraped rows).
    expect(xml).toContain("<entry>");
    // Required Atom elements per entry.
    expect(xml).toMatch(/<entry>[\s\S]*?<title>[\s\S]*?<id>[\s\S]*?<updated>/);
  });

  test("entry ids and links stay on the serving host", async () => {
    for (const host of [UA, HUB]) {
      const { status, text } = await bodyOf(app, "/feed.xml", host);
      expect(status).toBe(200);
      const ids = [...text.matchAll(/<id>([^<]+)<\/id>/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(new URL(id).host, `${host} feed id ${id}`).toBe(host);
      }
    }
  });

  test("feed <updated> derives from data, not the request clock", async () => {
    const first = await (await app.dispatch(req("/feed.xml", UA))).text();
    await new Promise((r) => setTimeout(r, 5));
    const second = await (await app.dispatch(req("/feed.xml", UA))).text();
    expect(second).toBe(first);
    const stamps = [...first.matchAll(/<updated>([^<]+)<\/updated>/g)].map((m) => m[1]);
    const now = Date.now();
    for (const s of stamps) {
      const t = Date.parse(s);
      expect(Number.isNaN(t), `unparseable <updated> ${s}`).toBe(false);
      expect(t).toBeLessThanOrEqual(now);
    }
  });

  test("404 where the feature is off (qatar)", async () => {
    const res = await app.dispatch(req("/feed.xml", QR));
    expect(res.status).toBe(404);
  });

  test("POST is not a feed method", async () => {
    const res = await app.dispatch(req("/feed.xml", UA, { method: "POST" }));
    expect(res.status).toBe(405);
  });
});

describe("feed autodiscovery link", () => {
  test("advertised in <head> only where the feed serves", async () => {
    const ua = await bodyOf(app, "/", UA);
    expect(ua.text).toContain('type="application/atom+xml"');
    expect(ua.text).toContain(`https://${UA}/feed.xml`);
    const qr = await bodyOf(app, "/", QR);
    expect(qr.text).not.toContain('type="application/atom+xml"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /badge.svg + /embed
// ─────────────────────────────────────────────────────────────────────────────

describe("/badge.svg", () => {
  test("every site serves a cacheable SVG with its own live stat", async () => {
    for (const site of Object.values(SITES)) {
      const res = await app.dispatch(req("/badge.svg", site.canonicalHost));
      expect(res.status, site.key).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
      expect(res.headers.get("Cache-Control")).toContain("public");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const svg = await res.text();
      expect(svg).toContain("<svg");
      // "N of M aircraft" with real numbers — shape, not values.
      expect(svg).toMatch(/\d+ of \d+ aircraft/);
      expect(svg).toContain(site.brand.accentColor);
    }
  });

  test("tenant badge names its airline; hub badge stays generic", async () => {
    const ua = await bodyOf(app, "/badge.svg", UA);
    expect(ua.text).toContain("United Starlink");
    const hub = await bodyOf(app, "/badge.svg", HUB);
    expect(hub.text).toContain("Airline Starlink");
    expect(hub.text).not.toContain("United Starlink");
  });

  test("POST → 405", async () => {
    const res = await app.dispatch(req("/badge.svg", UA, { method: "POST" }));
    expect(res.status).toBe(405);
  });
});

describe("/embed page", () => {
  test("documents the badge with host-correct snippets", async () => {
    const { status, text } = await bodyOf(app, "/embed", UA);
    expect(status).toBe(200);
    expect(text).toContain(`https://${UA}/badge.svg`);
    expect(text).toContain('src="/badge.svg"'); // live preview
  });

  test("hub /embed uses the hub host in snippets", async () => {
    const { status, text } = await bodyOf(app, "/embed", HUB);
    expect(status).toBe(200);
    expect(text).toContain(`https://${HUB}/badge.svg`);
  });
});

describe("/newly-equipped page", () => {
  test("UA host renders install rows linking the feed", async () => {
    const { status, text } = await bodyOf(app, "/newly-equipped", UA);
    expect(status).toBe(200);
    expect(text).toContain("Newly Equipped Aircraft");
    expect(text).toContain('href="/feed.xml"');
  });

  test("hub renders (aggregate across airlines)", async () => {
    const { status } = await bodyOf(app, "/newly-equipped", HUB);
    expect(status).toBe(200);
  });
});
