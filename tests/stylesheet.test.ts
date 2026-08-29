/**
 * Compiled-Tailwind invariants.
 *
 * Dropping the browser JIT traded "any class works at runtime" for "the CSS is
 * compiled from what the scanner can see in the sources". These tests pin the
 * two halves of that trade: pages must load exactly one same-origin, content-
 * hashed stylesheet and nothing third-party, and no class may reach the browser
 * that the compiler had no way to find.
 *
 * The page list comes from the live sitemap, so a branch that adds a page gets
 * covered without touching this file.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyticsOrigins } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot, req } from "./helpers";

const HOST = "unitedstarlinktracker.com";
const ROOT = join(import.meta.dir, "..");
// Analytics is the one sanctioned off-origin script. Read from the registry so
// self-hosting it (or dropping it) can't turn this into a false failure.
const ALLOWED_SCRIPT_ORIGINS = analyticsOrigins().scriptOrigins;

let app: ReturnType<typeof createApp>;

/** Everything Tailwind's `@source` directives scan (src/styles/tailwind.css). */
function scannedSources(): string {
  const parts: string[] = [readFileSync(join(ROOT, "index.html"), "utf8")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|css|html)$/.test(entry)) parts.push(readFileSync(full, "utf8"));
    }
  };
  walk(join(ROOT, "src"));
  return parts.join("\n");
}

/** One representative URL per top-level path shape the sitemap advertises. */
async function sitemapPageShapes(): Promise<string[]> {
  const { status, text } = await bodyOf(app, "/sitemap.xml", HOST);
  expect(status).toBe(200);
  const paths = [...text.matchAll(/<loc>https?:\/\/[^/]+([^<]*)<\/loc>/g)].map((m) => m[1] || "/");
  expect(paths.length).toBeGreaterThan(0);
  const byShape = new Map<string, string>();
  for (const p of paths) {
    const shape = p.split("/").slice(0, 2).join("/") || "/";
    if (!byShape.has(shape)) byShape.set(shape, p);
  }
  return [...byShape.values()];
}

/** Class names any inline <style> in the response defines itself. */
function inlineStyleClasses(html: string): Set<string> {
  const out = new Set<string>();
  for (const block of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const m of block[1].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}

function classTokens(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sclass="([^"]*)"/g)) {
    for (const t of m[1].split(/\s+/)) if (t) out.add(t);
  }
  return out;
}

beforeAll(() => {
  app = createApp(openSnapshot());
});

describe("stylesheet delivery", () => {
  test("every page links exactly one same-origin, content-hashed stylesheet", async () => {
    for (const path of await sitemapPageShapes()) {
      const { status, text } = await bodyOf(app, path, HOST);
      expect(status).toBe(200);
      const links = [...text.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
      const local = links.filter((l) => l.includes("/static/tailwind."));
      expect({ path, count: local.length }).toEqual({ path, count: 1 });
      expect(local[0]).toMatch(/href="\/static\/tailwind\.[a-z0-9]+\.css"/);
    }
  });

  test("no page loads script or style from a third-party origin", async () => {
    for (const path of await sitemapPageShapes()) {
      const { text } = await bodyOf(app, path, HOST);
      const scriptSrcs = [...text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
      const foreign = scriptSrcs.filter(
        (s) => /^https?:\/\//.test(s) && !ALLOWED_SCRIPT_ORIGINS.includes(new URL(s).origin)
      );
      expect({ path, foreign }).toEqual({ path, foreign: [] });
      expect(text).not.toContain("unpkg.com");
    }
  });

  test("the hashed URL serves immutable CSS and is content-addressed", async () => {
    const { text: home } = await bodyOf(app, "/", HOST);
    const href = home.match(/href="(\/static\/tailwind\.[a-z0-9]+\.css)"/)?.[1];
    expect(href).toBeTruthy();

    const res = await app.dispatch(req(href as string, HOST));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    const css = await res.text();
    expect(css.length).toBeGreaterThan(1000);
    expect(css).toContain("@layer");

    // A different fingerprint must not resolve — the URL names one build, so a
    // deploy can never be served the previous build's CSS from a cache.
    const stale = href?.replace(/tailwind\.[a-z0-9]+\./, "tailwind.deadbeef.");
    expect((await app.dispatch(req(stale as string, HOST))).status).toBe(404);
  });

  test("CSP allows no third-party script origin beyond analytics", async () => {
    const res = await app.dispatch(req("/", HOST));
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toContain("unpkg.com");
    const scriptSrc = csp.match(/script-src ([^;]+)/)?.[1] ?? "";
    const remoteOrigins = scriptSrc.split(/\s+/).filter((s) => s.startsWith("http"));
    expect(remoteOrigins).toEqual(ALLOWED_SCRIPT_ORIGINS);
  });
});

describe("compiler coverage", () => {
  test("no rendered class is invisible to the source scanner", async () => {
    const sources = scannedSources();
    const misses: string[] = [];
    for (const path of await sitemapPageShapes()) {
      const { text } = await bodyOf(app, path, HOST);
      const local = inlineStyleClasses(text);
      for (const token of classTokens(text)) {
        // A class is safe if Tailwind's scanner can find it verbatim in a file
        // it reads, or if the page ships its own rule for it. A class built at
        // runtime (`text-${x}-500`) satisfies neither and would silently lose
        // its styling — that is exactly what this catches.
        if (!sources.includes(token) && !local.has(token)) misses.push(`${path}: ${token}`);
      }
    }
    expect(misses).toEqual([]);
  });
});
