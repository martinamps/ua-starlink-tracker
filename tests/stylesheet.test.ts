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
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

async function stylesheetHref(): Promise<string> {
  const { text: home } = await bodyOf(app, "/", HOST);
  const href = home.match(/href="(\/static\/tailwind\.[a-z0-9]+\.css)"/)?.[1];
  expect(href).toBeTruthy();
  return href as string;
}

/** The stylesheet the pages actually link, fetched over the app the way a
 * browser would — not read off disk, so this pins what is delivered. */
async function servedCss(): Promise<string> {
  const res = await app.dispatch(req(await stylesheetHref(), HOST));
  expect(res.status).toBe(200);
  return await res.text();
}

/** Tailwind escapes every character outside [A-Za-z0-9_-] in a class selector:
 * `md:grid-cols-3` → `.md\:grid-cols-3`, `w-1/2` → `.w-1\/2`,
 * `bg-[var(--color-accent)]` → `.bg-\[var\(--color-accent\)\]`. */
const escapedSelector = (token: string) => `.${token.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`)}`;

const SCALED = "(p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|gap|w|h|max-w|min-h|space-x|space-y|rounded)";
const STOCK_UTILITY = [
  new RegExp(`^${SCALED}-(\\d+(\\.5)?|auto|full|px)$`),
  /^(grid-cols|col-span|order|z)-\d+$/,
  /^(flex|grid|block|hidden|inline-flex|inline-block|relative|absolute|border|underline|uppercase|truncate|italic)$/,
  /^text-(xs|sm|base|lg|xl|[2-9]xl)$/,
  /^font-(bold|semibold|medium|normal|mono)$/,
  /^[a-z-]+-\[[^\]]+\]$/,
];

/**
 * Utilities Tailwind is guaranteed to emit when extraction works, recognised by
 * shape rather than from a hardcoded list — new markup widens the sample instead
 * of dating this file.
 *
 * Custom color and font names (text-primary, bg-accent/20, font-display) are
 * deliberately outside the set: they name tokens Tailwind has never had, they
 * compile to nothing on purpose (see src/styles/tailwind.css), and index.html
 * defines them itself.
 */
function isStockUtility(token: string): boolean {
  const bare = token.replace(/^(sm|md|lg|xl|2xl|hover|focus):/, "");
  return STOCK_UTILITY.some((re) => re.test(bare));
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

  // `bun run dev` compiles the CSS in a different process from the `bun --watch`
  // server, and nothing sequences them: the server restarts on the source edit
  // while the compile is still debounced, so it routinely boots on the previous
  // build. A fingerprint captured once at boot would then serve the pre-edit CSS
  // until the *next* save — a new utility appearing one save late.
  test("outside production a recompile is served without a restart", async () => {
    const cssPath = join(ROOT, "static", "tailwind.css");
    const original = readFileSync(cssPath);
    const before = await stylesheetHref();
    try {
      writeFileSync(cssPath, `${original}\n.compiled-css-refresh-probe{color:red}\n`);
      const after = await stylesheetHref();
      expect(after).not.toBe(before);

      const fresh = await app.dispatch(req(after, HOST));
      expect(fresh.status).toBe(200);
      expect(await fresh.text()).toContain(".compiled-css-refresh-probe");

      // The superseded fingerprint stops resolving, so nothing can be handed
      // the build its markup no longer matches.
      expect((await app.dispatch(req(before, HOST))).status).toBe(404);
    } finally {
      writeFileSync(cssPath, original);
    }
    expect(await stylesheetHref()).toBe(before);
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
  /**
   * The delivery tests above pass on a stylesheet that styles nothing: a build
   * scoped to no sources (`@import "tailwindcss" source(none)`) is 4,165 bytes
   * and contains `@layer`, clearing every length, hashing and CSP assertion
   * while every page renders unstyled. This is the assertion that fails on it —
   * a dropped `@source`, a broken extractor or a theme-only build all land here.
   */
  test("the served CSS carries rules for the utilities the pages render", async () => {
    const css = await servedCss();
    const sampled: string[] = [];
    const misses: string[] = [];
    for (const path of await sitemapPageShapes()) {
      const { text } = await bodyOf(app, path, HOST);
      const inline = inlineStyleClasses(text);
      const stock = [...classTokens(text)].filter((t) => !inline.has(t) && isStockUtility(t));
      // An empty sample would make the miss check vacuous, and a page that
      // renders no stock utility at all is itself the regression.
      expect({ path, sampledUtilities: stock.length > 0 }).toEqual({
        path,
        sampledUtilities: true,
      });
      sampled.push(...stock);
      for (const t of stock) {
        if (!css.includes(escapedSelector(t))) misses.push(`${path}: ${t}`);
      }
    }
    expect(misses).toEqual([]);

    // Three compilation paths that break independently — plain utilities,
    // responsive variants, arbitrary values — must each stay in the sample, or
    // shrinking markup could quietly narrow what the check above proves.
    expect({
      plain: sampled.some((t) => !t.includes(":") && !t.includes("[")),
      variant: sampled.some((t) => /^(sm|md|lg|xl|2xl):/.test(t)),
      arbitrary: sampled.some((t) => t.includes("[")),
    }).toEqual({ plain: true, variant: true, arbitrary: true });
  });

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
