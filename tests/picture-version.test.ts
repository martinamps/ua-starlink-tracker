/**
 * The daily pictures (og card, share card) carry a content version in their
 * address, so a redraw reaches link previews past the edge's copy; their bare
 * names keep answering under an hour's cache.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import {
  DAILY_PICTURE_CACHE,
  isDailyPicture,
  versionedPicture,
} from "../src/server/picture-version";
import { bodyOf, makeSyntheticDb, req } from "./helpers";

const STATIC = join(import.meta.dir, "..", "static");
const HUB = "airlinestarlinktracker.com";
const UA = "unitedstarlinktracker.com";

describe("versionedPicture", () => {
  test("version follows the bytes; a missing file keeps the bare address", () => {
    const dir = mkdtempSync(join(tmpdir(), "pv-"));
    try {
      expect(versionedPicture(dir, "/static/share-card-ua.png")).toBe("/static/share-card-ua.png");
      writeFileSync(join(dir, "share-card-ua.png"), "first");
      const a = versionedPicture(dir, "/static/share-card-ua.png");
      expect(a).toMatch(/^\/static\/share-card-ua\.png\?v=[0-9a-z]+$/);
      expect(versionedPicture(dir, "/static/share-card-ua.png")).toBe(a);
      writeFileSync(join(dir, "share-card-ua.png"), "second, longer");
      const b = versionedPicture(dir, "/static/share-card-ua.png");
      expect(b).toMatch(/\?v=[0-9a-z]+$/);
      expect(b).not.toBe(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only the picture job's files are daily pictures", () => {
    for (const n of ["social-image.webp", "social-image-hub.webp", "share-card-ha.png"]) {
      expect(isDailyPicture(n), n).toBe(true);
    }
    for (const n of [
      "fonts/x.woff2",
      "share/tail/N1.png",
      "tailwind.abc.css",
      "social-image.png",
    ]) {
      expect(isDailyPicture(n), n).toBe(false);
    }
  });
});

describe("served addresses", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp(makeSyntheticDb());
  });

  test("og:image is the hub card's current version, and both addresses answer", async () => {
    const { text } = await bodyOf(app, "/", HUB);
    const og = text.match(/property="og:image" content="([^"]+)"/)?.[1] ?? "";
    const url = new URL(og);
    expect(url.pathname).toBe("/static/social-image-hub.webp");
    expect(url.searchParams.get("v")).toBe(
      Bun.hash(readFileSync(join(STATIC, "social-image-hub.webp"))).toString(36)
    );
    for (const path of [url.pathname, `${url.pathname}${url.search}`]) {
      const res = await app.dispatch(req(path, HUB));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe(DAILY_PICTURE_CACHE);
      expect(res.headers.get("content-type"), path).toBe("image/webp");
    }
  });

  test("share-card link is versioned; bare and versioned addresses answer under an hour", async () => {
    const { text } = await bodyOf(app, "/", UA);
    const href = text.match(/href="(\/static\/share-card-ua\.png[^"]*)"/)?.[1];
    expect(href).toMatch(/^\/static\/share-card-ua\.png\?v=[0-9a-z]+$/);
    for (const path of ["/static/share-card-ua.png", href ?? ""]) {
      const res = await app.dispatch(req(path, UA));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe(DAILY_PICTURE_CACHE);
    }
  });

  test("other static files keep a day", async () => {
    const res = await app.dispatch(req("/static/chrome-og.webp", UA));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});
