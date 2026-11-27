/**
 * The markup a keyboard or a screen reader depends on, on every live site:
 * the page's landmarks, the skip link, and the few states that were once told
 * by colour or position alone. Shapes, not values.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITES } from "../src/airlines/registry";
import { FILTER_INACTIVE } from "../src/client/aircraft-list";
import { buttonClass } from "../src/components/layout";
import { pillColors, toneColor } from "../src/components/ui/tone-classes";
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
      expect(s).toMatch(/ title="[^"]+"/);
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

describe("long lists", () => {
  const ALASKA = SITES.alaska.canonicalHost;

  for (const host of [UNITED, ALASKA]) {
    test(`${host}: a type page's squares leave the tab order to its tail list`, async () => {
      const fleet = (await bodyOf(app, "/fleet", host)).text;
      const types = [
        ...new Set([...fleet.matchAll(/href="(\/fleet\/[a-z0-9-]+)"/g)].map((m) => m[1])),
      ];
      expect(types.length).toBeGreaterThan(0);
      let squares = 0;
      for (const path of types) {
        const { text } = await bodyOf(app, path, host);
        for (const [tag, tail] of text.matchAll(/<a href="#t-([^"]+)"[^>]*>/g)) {
          expect(tag).toContain('tabindex="-1"');
          // An empty link is named by its title.
          expect(tag).toMatch(/ title="[^"]+"/);
          // Its row: a link a keyboard reaches, named with the tail and its Wi-Fi.
          const row = text.match(new RegExp(`<a id="t-${tail}"[^>]*>`))?.[0];
          expect(row, `${path} #t-${tail}`).toBeDefined();
          expect(row).not.toContain("tabindex");
          expect(row).toMatch(/class="tail-(sl|dim)"/);
          expect(row).toContain(`aria-label="${tail} · `);
          squares++;
        }
        // No square is left pointing at another page's list.
        expect(text).not.toMatch(/<a href="\/fleet#t-[^"]+"[^>]*class="wifi-/);
      }
      expect(squares).toBeGreaterThan(0);
    });
  }

  const skips: Array<[string, string, string, string]> = [
    ["/", "aircraft-list-end", "js-aircraft-row", "the home list"],
    ["/fleet", "tail-registry-end", 'class="tail-', "the tail registry"],
  ];
  for (const host of LIVE_HOSTS) {
    for (const [path, target, row, what] of skips) {
      test(`${host}${path}: a skip link stands before ${what} and lands after it`, async () => {
        const { text } = await bodyOf(app, path, host);
        if (!text.includes(row)) return; // Nothing listed on this snapshot: nothing to skip.
        const link = text.indexOf(`href="#${target}"`);
        const end = text.indexOf(`id="${target}"`);
        expect(link).toBeGreaterThan(-1);
        expect(link).toBeLessThan(text.indexOf(row));
        expect(end).toBeGreaterThan(text.lastIndexOf(row));
        expect(end).toBeLessThan(text.indexOf("</main>"));
        // Focusable by the jump alone, so the next Tab starts from it.
        expect(text).toMatch(new RegExp(`<p id="${target}" tabindex="-1"`));
      });
    }
  }
});

describe("names told to assistive technology", () => {
  test('a "+N" flight button says what it opens', async () => {
    const { text } = await bodyOf(app, "/", UNITED);
    const buttons = [...text.matchAll(/<button[^>]*expand-flights[\s\S]*?<\/button>/g)].map(
      (m) => m[0]
    );
    if (buttons.length === 0) return; // No row with hidden flights on this snapshot.
    for (const b of buttons) {
      expect(b).toContain('<span class="sr-only"> more flights</span>');
      expect(b).toContain('<span class="sr-only">Show fewer flights</span>');
    }
  });

  test("a registry row's name carries its Wi-Fi system", async () => {
    const { text } = await bodyOf(app, "/fleet", UNITED);
    const rows = [...text.matchAll(/<a id="t-([^"]+)"[^>]*>/g)];
    expect(rows.length).toBeGreaterThan(0);
    for (const [tag, tail] of rows) {
      // Starts with what the row shows, then says what colour alone showed.
      expect(tag).toMatch(new RegExp(`aria-label="${tail} [^"]*· [^"]+"`));
    }
  });

  test("a hangar block's spec card describes its trigger and stays out of the heading's name", async () => {
    const { text } = await bodyOf(app, "/fleet", UNITED);
    const cards = [...text.matchAll(/<span id="(spec-[^"]+)"[^>]*>/g)];
    expect(cards.length).toBeGreaterThan(0);
    expect(new Set(cards.map((c) => c[1])).size).toBe(cards.length);
    for (const [tag, id] of cards) {
      expect(tag).toContain('aria-hidden="true"');
      expect(text).toContain(`aria-describedby="${id}"`);
    }
  });

  test("the hangar shows every block open, with no fold to tap and no inline script", async () => {
    const { text } = await bodyOf(app, "/fleet", UNITED);
    const start = text.indexOf('class="fam-container');
    const end = text.indexOf("</section>", start);
    expect(start).toBeGreaterThan(-1);
    const hangar = text.slice(start, end);
    expect(hangar).not.toContain("<details");
    expect(hangar).not.toContain("<script");
    expect(hangar).toContain('class="fam-grid ');
    // Each type link is drawn twice, one copy for each width; the stylesheet
    // hides the head copy from 768px and the foot copy below it.
    const head = count(hangar, /class="fam-details-head /g);
    expect(head).toBeGreaterThan(0);
    expect(count(hangar, /class="fam-details-foot /g)).toBe(head);
    const css = readFileSync(join(ROOT, "src/styles/tailwind.css"), "utf8");
    expect(css).toMatch(/\.fam-details-head \{\s*display: none;/);
    expect(css).toMatch(/min-width: 768px\)[^@]*\.fam-details-foot \{\s*display: block;/);
    expect(css).toMatch(/max-width: 767px\)[^@]*\.fam-details-foot \{\s*display: none;/);
  });

  test("the fleet page's 1.6k squares and rows carry no markup the stylesheet can draw", async () => {
    const { text } = await bodyOf(app, "/fleet", UNITED);
    const squares = [...text.matchAll(/<a href="#t-[^"]+"[^>]*>/g)].map((m) => m[0]);
    expect(squares.length).toBeGreaterThan(0);
    for (const tag of squares) {
      // Named by the title alone; size, corners and hover from `.fam-grid > a`.
      expect(tag).toMatch(/ title="[^"]+"/);
      expect(tag).not.toContain("aria-label=");
      expect(tag).toMatch(/ class="wifi-[a-z-]+( pipe-(mod|verif))?"/);
    }
    const rows = [...text.matchAll(/<a id="t-[^"]+"[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(rows.length).toBe(squares.length);
    for (const row of rows) {
      // The glyph comes from data-dot through ::before, not an element per row.
      expect(row).not.toContain('tail-dot"');
      expect(row).toMatch(/<span class="tail-num">[^<]+<\/span> <span class="tail-abbr">/);
    }
    expect(text).toContain('data-dot="');
    const css = readFileSync(join(ROOT, "src/styles/tailwind.css"), "utf8");
    expect(css).toMatch(/\.fam-grid > a \{\s*width: 8px;\s*height: 8px;/);
    expect(css).toMatch(/\.tail-registry > a::before \{\s*content: attr\(data-dot\);/);
  });

  test("a hidden spec card takes no room, so it can't widen the page", () => {
    const css = readFileSync(join(ROOT, "src/styles/tailwind.css"), "utf8");
    expect(css).toMatch(/\n\.spec-card \{\s*display: none;/);
    expect(css).toMatch(/\.spec-trigger:focus-within \.spec-card \{\s*display: block;/);
  });
});

describe("controls", () => {
  test("no field or bordered button is drawn with the panel's own faint edge", async () => {
    const pages: Array<[string, string]> = [
      ["/", UNITED],
      ["/check-flight", UNITED],
      ["/route-planner", UNITED],
      ["/", SITES.airline.canonicalHost],
    ];
    let fields = 0;
    for (const [path, host] of pages) {
      const { text } = await bodyOf(app, path, host);
      for (const [tag] of text.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
        if (/type="(hidden|checkbox|radio)"/.test(tag)) continue;
        expect(tag, `${host}${path}`).not.toContain("border-subtle");
        expect(tag, `${host}${path}`).toContain("border-neutral");
        fields++;
      }
    }
    expect(fields).toBeGreaterThan(0);
    for (const size of ["sm", "md", "lg"] as const) {
      expect(buttonClass("secondary", size)).toContain("border-neutral");
      expect(buttonClass("secondary", size)).not.toContain("border-subtle");
    }
    expect(FILTER_INACTIVE).toContain("border-neutral");
  });

  test("a hovered button keeps a full-strength edge and readable text", () => {
    // The accent on its own deepened tint was 3.8:1; white is the hover text.
    for (const size of ["sm", "md", "lg"] as const) {
      expect(buttonClass("primary", size)).toContain("hover:text-primary");
    }
    // A half-strength accent edge was 2.5:1 against the panel.
    expect(FILTER_INACTIVE).toContain("hover:border-accent ");
    expect(FILTER_INACTIVE).not.toMatch(/hover:border-accent\/\d/);
  });

  test("a neutral pill's words are not the muted grey on its own tint", () => {
    const neutral = pillColors(toneColor("neutral"));
    expect(neutral.color).not.toBe(toneColor("neutral"));
    expect(neutral.background).toContain(toneColor("neutral"));
    // Every other tone keeps its own colour for its words.
    expect(pillColors(toneColor("success")).color).toBe(toneColor("success"));
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
