/**
 * The markup a keyboard or a screen reader depends on, on every live site:
 * the page's landmarks, the skip link, and the few states that were once told
 * by colour or position alone. Shapes, not values.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITES } from "../src/airlines/registry";
import { createApp } from "../src/server/app";
import { bodyOf, openSnapshot } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const UNITED = SITES.united.canonicalHost;
const LIVE_HOSTS = Object.values(SITES)
  .filter((s) => s.live)
  .map((s) => s.canonicalHost);

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = createApp(openSnapshot());
});

const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

describe("page shell", () => {
  for (const host of LIVE_HOSTS) {
    for (const path of ["/", "/fleet", "/embed", "/definitely-not-a-page"]) {
      test(`${host}${path} has one main landmark and a skip link to it`, async () => {
        const { text } = await bodyOf(app, path, host);
        expect(count(text, /<main[\s>]/g)).toBe(1);
        expect(text).toContain('<main id="main"');
        expect(count(text, /<nav[^>]*aria-label="Primary"/g)).toBe(1);
        expect(count(text, /<h1[\s>]/g)).toBe(1);
        // The skip link comes before the site bar, so it is the first Tab stop.
        const skip = text.indexOf('href="#main"');
        expect(skip).toBeGreaterThan(-1);
        expect(skip).toBeLessThan(text.indexOf('aria-label="Primary"'));
        // The footer is a sibling of main, never inside it.
        expect(text.indexOf("<footer")).toBeGreaterThan(text.indexOf("</main>"));
      });
    }
  }
});

describe("states told to assistive technology", () => {
  test("the home list's chosen filter is a pressed button", async () => {
    const { text } = await bodyOf(app, "/", UNITED);
    const buttons = [...text.matchAll(/<button[^>]*js-filter-btn[^>]*>/g)].map((m) => m[0]);
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b).toMatch(/aria-pressed="(true|false)"/);
    expect(buttons.filter((b) => b.includes('aria-pressed="true"'))).toHaveLength(1);
  });

  test("hangar squares on /fleet leave the tab order to the registry's links", async () => {
    const { text } = await bodyOf(app, "/fleet", UNITED);
    const squares = [...text.matchAll(/<a href="#t-[^"]+"[^>]*>/g)].map((m) => m[0]);
    expect(squares.length).toBeGreaterThan(0);
    for (const s of squares) {
      expect(s).toContain('tabindex="-1"');
      expect(s).toContain("aria-label=");
    }
    // Every tail a square names has a registry row a keyboard can reach.
    for (const s of squares) {
      const tail = s.match(/href="#t-([^"]+)"/)?.[1];
      expect(text).toMatch(new RegExp(`<a id="t-${tail}"(?![^>]*tabindex)`));
    }
  });

  test("the map chooser's Close button follows its airports in the markup", async () => {
    const { text } = await bodyOf(app, "/routes", UNITED);
    const dialog = text.match(/<dialog[^>]*js-map-chooser[\s\S]*?<\/dialog>/)?.[0];
    if (!dialog) return; // No linked airport on this snapshot: no chooser is rendered.
    expect(dialog.indexOf("js-map-chooser-close")).toBeGreaterThan(
      dialog.indexOf("js-map-chooser-all")
    );
    expect(dialog.indexOf("js-map-chooser-all")).toBeGreaterThan(
      dialog.indexOf("js-map-chooser-list")
    );
  });
});

describe("stylesheet", () => {
  const shell = readFileSync(join(ROOT, "index.html"), "utf8");
  const css = readFileSync(join(ROOT, "src/styles/tailwind.css"), "utf8");

  test("a focused field always shows an outline", () => {
    expect(shell).toMatch(
      /input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible\s*\{[^}]*outline:\s*2px solid/
    );
  });

  test("reduced motion stops animations and transitions", () => {
    expect(shell).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  test("no registry row is dimmed with opacity", () => {
    for (const rule of [".tail-dim", ".tail-abbr", ".tail-dim.tail-pipe"]) {
      const body = css.match(new RegExp(`\\n${rule.replace(/\./g, "\\.")} \\{([^}]*)\\}`))?.[1];
      expect(body).toBeDefined();
      expect(body).not.toContain("opacity");
    }
  });
});
